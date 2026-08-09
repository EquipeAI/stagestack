import { ConvexError, v } from "convex/values";
import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { eventMutation, eventQuery, requireOrganizer } from "./lib/functions";
import { enqueueJob } from "./model/jobs";
import { logAudit } from "./model/audit";
import { assertEventActive } from "./model/validation";
import { IMPORT_LIMITS, vPlannedRecord } from "./shared/importPlan";

// Import with AI (M2): upload → agent plans → organizer confirms → execute.
// The plan/execution runs on the worker VM; see apps/worker/src/import-agent.ts
// and convex/model/imports.ts for the authority model.

// Each plan job spends real OpenRouter credit on the worker (~$0.05–0.25 per
// import session, see docs/ARCHITECTURE.md), so an unbounded queue is a
// billing hole, not just load. Keyed per user rather than per event so one
// account can't fan the same spend out across every event it organizes.
// 10 plans/hour is far above a real organizer importing a few spreadsheets
// (with retries), and 20 upload URLs/hour matches the CFP/portal mint caps.
const importLimiter = new RateLimiter(components.rateLimiter, {
  importPlanPerUser: { kind: "token bucket", rate: 10, period: HOUR },
  importUploadPerUser: { kind: "token bucket", rate: 20, period: HOUR },
});

function rateLimited(message: string): never {
  throw new ConvexError({ code: "rate_limited", message });
}

export const generateUploadUrl = eventMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    assertEventActive(ctx.caller.event);
    const limit = await importLimiter.limit(ctx, "importUploadPerUser", {
      key: ctx.caller.user._id,
    });
    if (!limit.ok) {
      rateLimited("Too many import uploads — try again in a little while.");
    }
    return await ctx.storage.generateUploadUrl();
  },
});

export const start = eventMutation({
  args: {
    storageId: v.id("_storage"),
    filename: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.id("jobs"),
  handler: async (ctx, args) => {
    assertEventActive(ctx.caller.event);
    // Queueing a plan job commissions LLM work on the worker, so cap the rate
    // before anything is enqueued. Token consumption is transactional: if this
    // mutation later fails, the organizer doesn't lose the token either.
    const limit = await importLimiter.limit(ctx, "importPlanPerUser", {
      key: ctx.caller.user._id,
    });
    if (!limit.ok) {
      rateLimited(
        "Too many imports queued — wait a little before starting another.",
      );
    }
    const jobId = await enqueueJob(
      ctx,
      "import-plan",
      {
        eventId: ctx.caller.event._id,
        storageId: args.storageId,
        filename: args.filename,
        description: args.description,
      },
      ctx.caller.user._id,
    );
    // Denormalized queue metadata: payload is v.any() and can't be indexed,
    // so listJobs needs eventId on the row itself.
    await ctx.db.patch("jobs", jobId, { eventId: ctx.caller.event._id });
    await logAudit(ctx, {
      orgId: ctx.caller.org._id,
      eventId: ctx.caller.event._id,
      actorUserId: ctx.caller.user._id,
      action: "import.start",
      targetType: "jobs",
      targetId: jobId,
      meta: { filename: args.filename },
    });
    return jobId;
  },
});

// Recent import jobs for this event, newest first — the import page resumes
// from this instead of holding job ids only in client state (an in-flight
// plan must survive navigating away). Organizer-only, matching the rest of
// the import surface.
export const listJobs = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("jobs"),
      _creationTime: v.number(),
      type: v.string(),
      status: v.string(),
      error: v.optional(v.string()),
      // From the import-plan payload, for display.
      filename: v.optional(v.string()),
      // From the import-execute payload, linking back to its plan.
      planJobId: v.optional(v.id("jobs")),
    }),
  ),
  handler: async (ctx) => {
    requireOrganizer(ctx.caller);
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_eventId", (q) => q.eq("eventId", ctx.caller.event._id))
      .order("desc")
      .take(10);
    return jobs
      .filter((j) => j.type === "import-plan" || j.type === "import-execute")
      .map((j) => {
        const payload = j.payload as { filename?: string; planJobId?: string };
        return {
          _id: j._id,
          _creationTime: j._creationTime,
          type: j.type,
          status: j.status,
          error: j.error,
          filename: j.type === "import-plan" ? payload.filename : undefined,
          planJobId:
            j.type === "import-execute"
              ? (payload.planJobId as Id<"jobs"> | undefined)
              : undefined,
        };
      });
  },
});

// Poll/subscribe to an import job. Scoped to the caller's event, and
// organizer-only like the rest of the import surface: a done import-plan job's
// `result` is the raw plan, i.e. speaker names, emails and phone numbers, and
// reviewers must never see contact details (convex/model/reviews.ts projects
// their view precisely to avoid this).
export const getJob = eventQuery({
  args: { jobId: v.id("jobs") },
  returns: v.union(
    v.object({
      _id: v.id("jobs"),
      type: v.string(),
      status: v.string(),
      result: v.optional(v.any()),
      error: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    requireOrganizer(ctx.caller);
    const job = await ctx.db.get("jobs", args.jobId);
    if (
      job === null ||
      (job.type !== "import-plan" && job.type !== "import-execute") ||
      (job.payload as { eventId?: string })?.eventId !== ctx.caller.event._id
    ) {
      return null;
    }
    return {
      _id: job._id,
      type: job.type,
      status: job.status,
      result: job.result,
      error: job.error,
    };
  },
});

export const confirm = eventMutation({
  args: {
    planJobId: v.id("jobs"),
    // The approved subset of the plan's records, exactly as returned by the
    // planner (the UI may exclude rows the organizer deselected).
    records: v.array(vPlannedRecord),
  },
  returns: v.id("jobs"),
  handler: async (ctx, args) => {
    assertEventActive(ctx.caller.event);
    const planJob = await ctx.db.get("jobs", args.planJobId);
    if (
      planJob === null ||
      planJob.type !== "import-plan" ||
      (planJob.payload as { eventId?: string })?.eventId !==
        ctx.caller.event._id ||
      planJob.status !== "done"
    ) {
      throw new ConvexError({
        code: "invalid_plan_job",
        message: "That import plan isn't ready to confirm.",
      });
    }
    if (args.records.length === 0) {
      throw new ConvexError({
        code: "empty_plan",
        message: "Select at least one record to import.",
      });
    }
    if (args.records.length > IMPORT_LIMITS.maxRecords) {
      throw new ConvexError({
        code: "invalid_plan",
        message: `Plans are limited to ${IMPORT_LIMITS.maxRecords} records.`,
      });
    }
    // The confirming organizer becomes the execution authority.
    const jobId = await enqueueJob(
      ctx,
      "import-execute",
      {
        eventId: ctx.caller.event._id,
        planJobId: args.planJobId,
        records: args.records,
      },
      ctx.caller.user._id,
    );
    await ctx.db.patch("jobs", jobId, { eventId: ctx.caller.event._id });
    await logAudit(ctx, {
      orgId: ctx.caller.org._id,
      eventId: ctx.caller.event._id,
      actorUserId: ctx.caller.user._id,
      action: "import.confirm",
      targetType: "jobs",
      targetId: jobId,
      meta: { planJobId: args.planJobId, records: args.records.length },
    });
    return jobId;
  },
});
