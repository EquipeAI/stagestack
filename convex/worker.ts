import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";

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

// Dev/test helper: enqueue a job from the CLI or dashboard.
// Internal: a public unauthenticated enqueue would let anyone burn worker
// compute and LLM credits (hello-agent jobs hit OpenRouter).
// `npx convex run worker:enqueueTest '{"type":"ping"}'` still works.
export const enqueueTest = internalMutation({
  args: { type: v.optional(v.string()) },
  returns: v.id("jobs"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("jobs", {
      type: args.type ?? "ping",
      payload: { sentAt: Date.now() },
      status: "queued",
    });
  },
});
