import { internalMutation, mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { isJobType } from "./shared/jobTypes";
import { enqueueJob } from "./model/jobs";
import * as Imports from "./model/imports";
import { listLibrary } from "./model/library";
import { vPlannedRecord } from "./shared/importPlan";

// Worker-facing functions, guarded by a shared secret (WORKER_SECRET env var on
// the deployment). V1 judgment call per docs/ARCHITECTURE.md; upgrade path is a
// Custom JWT service identity.
// Constant-time comparison: a `!==` short-circuits on the first differing
// char, leaking prefix length to a timing attacker.
function assertWorker(secret: string) {
  const expected = process.env.WORKER_SECRET;
  if (!expected) {
    throw new Error("Unauthorized worker");
  }
  let diff = secret.length ^ expected.length;
  const len = Math.max(secret.length, expected.length);
  for (let i = 0; i < len; i++) {
    // charCodeAt is NaN out of range; NaN || 0 keeps the XOR well-defined.
    diff |= (secret.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  if (diff !== 0) {
    throw new Error("Unauthorized worker");
  }
}

// Lease: a claim is only a lease on the job. If the worker dies mid-job the
// sweep (cron, every 5 min) requeues it after the TTL; after MAX_ATTEMPTS
// expired leases the job fails instead of looping forever.
export const WORKER_LEASE_TTL_MS = 10 * 60 * 1000;
export const WORKER_MAX_ATTEMPTS = 3;

export const pending = query({
  args: { secret: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("jobs"),
      type: v.string(),
      payload: v.any(),
    }),
  ),
  handler: async (ctx, args) => {
    assertWorker(args.secret);
    const queued = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(10);
    return queued.map((j) => ({ _id: j._id, type: j.type, payload: j.payload }));
  },
});

export const claim = mutation({
  args: { secret: v.string(), jobId: v.id("jobs") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertWorker(args.secret);
    const job = await ctx.db.get("jobs", args.jobId);
    if (job === null || job.status !== "queued") {
      return false; // already claimed or gone — compare-and-set semantics
    }
    await ctx.db.patch("jobs", args.jobId, {
      status: "claimed",
      claimedAt: Date.now(),
    });
    return true;
  },
});

export const finish = mutation({
  args: {
    secret: v.string(),
    jobId: v.id("jobs"),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertWorker(args.secret);
    const job = await ctx.db.get("jobs", args.jobId);
    // Only a claimed job can finish: a stale worker whose lease already
    // expired (job requeued/failed by the sweep, or re-claimed and finished
    // by another worker) must not flip the row out from under the new owner.
    if (job === null || job.status !== "claimed") {
      return null;
    }
    await ctx.db.patch("jobs", args.jobId, {
      status: args.error === undefined ? "done" : "failed",
      result: args.result,
      error: args.error,
      finishedAt: Date.now(),
    });
    return null;
  },
});

// Requeue jobs whose claim outlived the lease TTL (worker died or hung).
// Runs from crons.ts; attempts counts expired leases, and at the cap the job
// fails with a readable error instead of cycling.
export const sweepExpiredLeases = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - WORKER_LEASE_TTL_MS;
    const claimed = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "claimed"))
      .take(100);
    for (const job of claimed) {
      // A claimed job always has claimedAt; treat a missing one as expired.
      if (job.claimedAt !== undefined && job.claimedAt > cutoff) continue;
      const attempts = (job.attempts ?? 0) + 1;
      if (attempts >= WORKER_MAX_ATTEMPTS) {
        await ctx.db.patch("jobs", job._id, {
          status: "failed",
          attempts,
          error: `The worker's lease on this job expired ${attempts} times; giving up.`,
          finishedAt: Date.now(),
        });
      } else {
        await ctx.db.patch("jobs", job._id, {
          status: "queued",
          attempts,
          claimedAt: undefined,
        });
      }
    }
    return null;
  },
});

// ── Import agent endpoints (secret-guarded; authority resolved from the
// job's initiating user server-side — the worker never names a user) ──────

export const importContext = query({
  args: { secret: v.string(), jobId: v.id("jobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    assertWorker(args.secret);
    const job = await ctx.db.get("jobs", args.jobId);
    if (job === null || job.type !== "import-plan") {
      throw new ConvexError({ code: "not_found", message: "No such job." });
    }
    const payload = job.payload as {
      eventId: string;
      storageId: string;
      filename: string;
      description?: string;
    };
    const caller = await Imports.resolveJobCaller(
      ctx,
      job,
      payload.eventId as never,
    );
    const [fileUrl, library, contacts, proposals] = await Promise.all([
      ctx.storage.getUrl(payload.storageId as never),
      listLibrary(ctx, caller.event._id),
      ctx.db
        .query("contacts")
        .withIndex("by_orgId", (q) => q.eq("orgId", caller.org._id))
        .take(500),
      ctx.db
        .query("proposals")
        .withIndex("by_eventId_and_status", (q) =>
          q.eq("eventId", caller.event._id),
        )
        .take(500),
    ]);
    return {
      event: {
        name: caller.event.name,
        slug: caller.event.slug,
        timezone: caller.event.timezone,
      },
      filename: payload.filename,
      description: payload.description ?? null,
      fileUrl,
      tracks: library.tracks.map((t) => t.name),
      tags: library.tags.map((t) => t.name),
      contacts: contacts.map((c) => ({
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email ?? null,
      })),
      proposalTitles: proposals.map((p) => p.title),
    };
  },
});

export const importExecuteBatch = mutation({
  args: {
    secret: v.string(),
    jobId: v.id("jobs"),
    // Position of this batch within the approved plan. Idempotency key: a
    // batch that committed but whose response was lost (worker died between
    // mutation and ack) replays its recorded results instead of re-running.
    batchIndex: v.number(),
    records: v.array(vPlannedRecord),
  },
  returns: v.array(
    v.object({ id: v.string(), ok: v.boolean(), detail: v.string() }),
  ),
  handler: async (ctx, args) => {
    assertWorker(args.secret);
    const job = await ctx.db.get("jobs", args.jobId);
    if (job === null || job.type !== "import-execute") {
      throw new ConvexError({ code: "not_found", message: "No such job." });
    }
    if (job.status !== "claimed") {
      throw new ConvexError({
        code: "invalid_status",
        message: "Job is not being executed.",
      });
    }
    const completed = job.completedBatches ?? [];
    const already = completed.find((b) => b.batchIndex === args.batchIndex);
    if (already !== undefined) {
      return already.results as Array<{
        id: string;
        ok: boolean;
        detail: string;
      }>;
    }
    const payload = job.payload as { eventId: string };
    const caller = await Imports.resolveJobCaller(
      ctx,
      job,
      payload.eventId as never,
    );
    const results = await Imports.executeRecords(ctx, caller, args.records);
    // Same transaction as the batch's writes: either both commit or neither.
    await ctx.db.patch("jobs", args.jobId, {
      completedBatches: [
        ...completed,
        { batchIndex: args.batchIndex, results },
      ],
    });
    return results;
  },
});

// Dev/test helper: enqueue a job from the CLI or dashboard.
// Internal: a public unauthenticated enqueue would let anyone burn worker
// compute and LLM credits (hello-agent jobs hit OpenRouter).
// `npx convex run worker:enqueueTest '{"type":"ping"}'` still works.
export const enqueueTest = internalMutation({
  args: { type: v.optional(v.string()) },
  returns: v.id("jobs"),
  handler: async (ctx, args) => {
    const type = args.type ?? "ping";
    if (!isJobType(type)) {
      throw new ConvexError({
        code: "unknown_job_type",
        message: `Unknown job type: ${type}`,
      });
    }
    return await enqueueJob(ctx, type, { sentAt: Date.now() });
  },
});
