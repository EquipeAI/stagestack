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
function assertWorker(secret: string) {
  const expected = process.env.WORKER_SECRET;
  if (!expected || secret !== expected) {
    throw new Error("Unauthorized worker");
  }
}

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
    if (job === null) {
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
    if (job.status !== "claimed" && job.status !== "running") {
      throw new ConvexError({
        code: "invalid_status",
        message: "Job is not being executed.",
      });
    }
    const payload = job.payload as { eventId: string };
    const caller = await Imports.resolveJobCaller(
      ctx,
      job,
      payload.eventId as never,
    );
    return await Imports.executeRecords(ctx, caller, args.records);
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
