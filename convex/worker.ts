import { internalMutation, mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import { isJobType } from "./shared/jobTypes";
import { enqueueJob } from "./model/jobs";
import * as Imports from "./model/imports";
import { listLibrary } from "./model/library";
import { IMPORT_LIMITS, type PlannedRecord } from "./shared/importPlan";

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

// The worker endpoints are public and unauthenticated (secret-guarded), so
// they are reachable by anyone who can guess the secret and hammerable by
// anyone who can't. One shared bucket for all of them: the shared secret is a
// single identity, so per-endpoint buckets would add tuning surface without
// adding protection.
//
// Sizing (the worker is push-based — `onUpdate(pending)`, no poll interval —
// so volume is per job, not per second): a job costs 1 `claim` + 1 `finish`,
// a heartbeat every WORKER_HEARTBEAT_MS while it runs (~25 for a 50-minute
// import plan), and up to IMPORT_LIMITS.maxRecords / executeBatch = 20
// `importExecuteBatch` calls. `pending` hands out at most 10 jobs at a time,
// so the worst honest burst is ~10 × 45 ≈ 450 calls, mostly spread over
// minutes. 600/minute with a two-minute burst allowance clears that with room
// while capping an attacker (or a runaway worker loop) at ~10 calls/second.
//
// Caveat worth knowing: a mutation that throws rolls its rate-limit
// consumption back (the component is transactional), so this does NOT
// throttle wrong-secret guesses — those are bounded by the secret's entropy
// and the constant-time compare above. What it bounds is the volume an
// accepted caller can push.
const workerLimiter = new RateLimiter(components.rateLimiter, {
  workerCalls: {
    kind: "token bucket",
    rate: 600,
    period: MINUTE,
    capacity: 1200,
  },
});

const rateLimited = () =>
  new ConvexError({
    code: "rate_limited",
    message: "Too many worker calls — slow down.",
  });

// Lease: a claim is only a lease on the job. A live worker renews it with
// `touch` every WORKER_HEARTBEAT_MS; if the worker dies mid-job the renewals
// stop and the sweep (cron, every 5 min) requeues it once the TTL passes.
// After MAX_ATTEMPTS expired leases the job fails instead of looping forever.
export const WORKER_LEASE_TTL_MS = 10 * 60 * 1000;
export const WORKER_MAX_ATTEMPTS = 3;
// Renewal interval the worker process uses (apps/worker/src/index.ts keeps its
// own copy — importing this module would pull the Convex function registry
// into the Node process). Comfortably below the TTL so a couple of missed
// renewals (transport blip) still don't lose the lease.
export const WORKER_HEARTBEAT_MS = 2 * 60 * 1000;

/** Opaque fencing token for one claim. Randomness in a mutation is fine on
 * Convex (each execution gets its own seeded generator) and the token never
 * leaves the claiming worker. */
function mintClaimToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when `token` is the token of the job's *current* claim. Rows claimed
 * before fencing existed have no token and are refused. */
function ownsClaim(
  job: { status: string; claimToken?: string },
  token: string,
): boolean {
  return (
    job.status === "claimed" &&
    job.claimToken !== undefined &&
    job.claimToken === token
  );
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
    // A query can't consume tokens (no writes), but it can refuse to feed a
    // caller that has already burned the shared mutation budget.
    if (!(await workerLimiter.check(ctx, "workerCalls")).ok) {
      throw rateLimited();
    }
    const queued = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(10);
    return queued.map((j) => ({ _id: j._id, type: j.type, payload: j.payload }));
  },
});

/** Take the lease on a queued job. Returns the claim's fencing token — the
 * worker must present it on every later call about this job — or null when
 * the job is gone or somebody else got there first. */
export const claim = mutation({
  args: { secret: v.string(), jobId: v.id("jobs") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    assertWorker(args.secret);
    if (!(await workerLimiter.limit(ctx, "workerCalls")).ok) {
      throw rateLimited();
    }
    const job = await ctx.db.get("jobs", args.jobId);
    if (job === null || job.status !== "queued") {
      return null; // already claimed or gone — compare-and-set semantics
    }
    const claimToken = mintClaimToken();
    await ctx.db.patch("jobs", args.jobId, {
      status: "claimed",
      claimedAt: Date.now(),
      claimToken,
      // Fresh claim: the previous owner's renewals must not count for this one.
      heartbeatAt: undefined,
    });
    return claimToken;
  },
});

/** Renew the lease on a job this worker still owns. Returns false when the
 * lease is gone (swept, re-claimed, or already finished) — the caller has lost
 * the job and should stop working on it. Never resurrects a job: only a row
 * still in `claimed` with this exact token is touched. */
export const touch = mutation({
  args: { secret: v.string(), jobId: v.id("jobs"), claimToken: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertWorker(args.secret);
    if (!(await workerLimiter.limit(ctx, "workerCalls")).ok) {
      throw rateLimited();
    }
    const job = await ctx.db.get("jobs", args.jobId);
    if (job === null || !ownsClaim(job, args.claimToken)) return false;
    await ctx.db.patch("jobs", args.jobId, { heartbeatAt: Date.now() });
    return true;
  },
});

export const finish = mutation({
  args: {
    secret: v.string(),
    jobId: v.id("jobs"),
    // Fencing token from `claim`. Without it, "is this row still claimed?"
    // can't distinguish *my* claim from a successor's.
    claimToken: v.string(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertWorker(args.secret);
    if (!(await workerLimiter.limit(ctx, "workerCalls")).ok) {
      throw rateLimited();
    }
    const job = await ctx.db.get("jobs", args.jobId);
    // Refuse (without touching the row) unless this caller holds the *current*
    // claim. Status alone is not enough: after the sweep requeues a job and
    // another worker claims it, the row is `claimed` again, and the stale
    // worker would otherwise flip somebody else's job. Refusing is a no-op
    // rather than an error so an honest duplicate finish stays idempotent;
    // the boolean tells the caller its work was discarded.
    if (job === null || !ownsClaim(job, args.claimToken)) return false;
    if (args.error === undefined && job.type === "import-plan") {
      // Validate the planner's output server-side before any organizer sees
      // it: the plan comes out of an LLM on the worker VM, and `imports.confirm`
      // only revalidates the records the organizer selected from it.
      try {
        Imports.assertPlanShape(args.result);
      } catch (err) {
        const message =
          err instanceof ConvexError
            ? String((err.data as { message?: string })?.message ?? "Bad plan")
            : "The planner returned an unusable plan.";
        await ctx.db.patch("jobs", args.jobId, {
          status: "failed",
          error: message,
          finishedAt: Date.now(),
        });
        return true;
      }
    }
    await ctx.db.patch("jobs", args.jobId, {
      status: args.error === undefined ? "done" : "failed",
      result: args.result,
      error: args.error,
      finishedAt: Date.now(),
    });
    return true;
  },
});

// Requeue jobs whose lease went stale (worker died or hung). The lease is
// measured from the last sign of life — the heartbeat if the worker sent one,
// otherwise the claim — so a job that is genuinely still running is left
// alone. Runs from crons.ts; attempts counts expired leases, and at the cap
// the job fails with a readable error instead of cycling.
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
      // A claimed job always has claimedAt; treat a missing one (and a missing
      // heartbeat) as expired.
      const lastSeen = Math.max(job.heartbeatAt ?? 0, job.claimedAt ?? 0);
      if (lastSeen > cutoff) continue;
      const attempts = (job.attempts ?? 0) + 1;
      if (attempts >= WORKER_MAX_ATTEMPTS) {
        await ctx.db.patch("jobs", job._id, {
          status: "failed",
          attempts,
          error: `The worker's lease on this job expired ${attempts} times; giving up.`,
          finishedAt: Date.now(),
          claimToken: undefined,
          heartbeatAt: undefined,
        });
      } else {
        await ctx.db.patch("jobs", job._id, {
          status: "queued",
          attempts,
          claimedAt: undefined,
          // Retiring the token fences the old worker out even if the row
          // happens to be `claimed` again by the time it calls back.
          claimToken: undefined,
          heartbeatAt: undefined,
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

// Execute one slice of the plan the organizer approved. The worker names a
// batch; it does not supply its contents. The records come from the job's own
// payload — written by `imports.confirm` from the organizer's selection — so a
// prompt-injected agent or a compromised worker cannot smuggle records the
// organizer never saw into the initiator's authority. That is what makes the
// confirmation boundary structural rather than client-side.
export const importExecuteBatch = mutation({
  args: {
    secret: v.string(),
    jobId: v.id("jobs"),
    claimToken: v.string(),
    // Position of this batch within the approved plan, in units of
    // IMPORT_LIMITS.executeBatch. Also the idempotency key: a batch that
    // committed but whose response was lost (worker died between mutation and
    // ack) replays its recorded results instead of re-running.
    batchIndex: v.number(),
  },
  returns: v.array(
    v.object({ id: v.string(), ok: v.boolean(), detail: v.string() }),
  ),
  handler: async (ctx, args) => {
    assertWorker(args.secret);
    if (!(await workerLimiter.limit(ctx, "workerCalls")).ok) {
      throw rateLimited();
    }
    const job = await ctx.db.get("jobs", args.jobId);
    if (job === null || job.type !== "import-execute") {
      throw new ConvexError({ code: "not_found", message: "No such job." });
    }
    if (!ownsClaim(job, args.claimToken)) {
      // Includes the stale-worker case: the lease was swept and re-claimed, so
      // this caller is no longer the executor. Refuse before reading anything.
      throw new ConvexError({
        code: "invalid_status",
        message: "Job is not being executed by this worker.",
      });
    }
    if (!Number.isInteger(args.batchIndex) || args.batchIndex < 0) {
      throw new ConvexError({
        code: "invalid_batch",
        message: "batchIndex must be a non-negative integer.",
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
    const payload = job.payload as { eventId: string; records?: unknown };
    if (!Array.isArray(payload.records)) {
      throw new ConvexError({
        code: "invalid_payload",
        message: "This job has no approved records to execute.",
      });
    }
    // Server-side slicing: batch size and contents are derived here, never
    // taken from the caller.
    const approved = payload.records as PlannedRecord[];
    const start = args.batchIndex * IMPORT_LIMITS.executeBatch;
    const batch = approved.slice(start, start + IMPORT_LIMITS.executeBatch);
    if (batch.length === 0) {
      throw new ConvexError({
        code: "invalid_batch",
        message: "That batch is past the end of the approved plan.",
      });
    }
    const caller = await Imports.resolveJobCaller(
      ctx,
      job,
      payload.eventId as never,
    );
    const results = await Imports.executeRecords(ctx, caller, batch);
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
