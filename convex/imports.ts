import { ConvexError, v, type Infer } from "convex/values";
import { validate } from "convex-helpers/validators";
import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { eventMutation, eventQuery, requireOrganizer } from "./lib/functions";
import { enqueueJob } from "./model/jobs";
import { logAudit } from "./model/audit";
import { assertEventActive } from "./model/validation";
import * as Imports from "./model/imports";
import {
  IMPORT_LIMITS,
  type PlannedRecord,
  vExecutionReport,
  vImportPlan,
} from "./shared/importPlan";

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
const vGetJob = v.union(
  v.object({
    _id: v.id("jobs"),
    type: v.literal("import-plan"),
    status: v.string(),
    result: v.optional(vImportPlan),
    error: v.optional(v.string()),
  }),
  v.object({
    _id: v.id("jobs"),
    type: v.literal("import-execute"),
    status: v.string(),
    result: v.optional(vExecutionReport),
    error: v.optional(v.string()),
  }),
  v.null(),
);
type GetJobResult = Infer<typeof vGetJob>;
export const getJob = eventQuery({
  args: { jobId: v.id("jobs") },
  returns: vGetJob,
  handler: async (ctx, args): Promise<GetJobResult> => {
    requireOrganizer(ctx.caller);
    const job = await ctx.db.get("jobs", args.jobId);
    if (
      job === null ||
      (job.type !== "import-plan" && job.type !== "import-execute") ||
      (job.payload as { eventId?: string })?.eventId !== ctx.caller.event._id
    ) {
      return null;
    }
    // `result` is stored as `v.any()`, but served under a strict validator —
    // so a row that does not match would throw at RETURN validation and take
    // the whole query with it, leaving the review page unable to show even the
    // job's own status or error. `worker.finish` validates every plan it
    // writes with the same validator, so this can only be a row that predates
    // that check: degrade it to a readable failure instead of a broken page.
    if (job.type === "import-plan") {
      const usable =
        job.result === undefined || validate(vImportPlan, job.result);
      return {
        _id: job._id,
        type: job.type,
        status: usable ? job.status : "failed",
        result: usable ? job.result : undefined,
        error: usable
          ? job.error
          : (job.error ??
            "This plan was stored in a format this version can no longer read. Start the import again."),
      };
    }
    if (job.type === "import-execute") {
      const usable =
        job.result === undefined || validate(vExecutionReport, job.result);
      return {
        _id: job._id,
        type: job.type,
        status: usable ? job.status : "failed",
        result: usable ? job.result : undefined,
        error: usable
          ? job.error
          : (job.error ??
            "This import's report was stored in a format this version can no longer read."),
      };
    }
    return null;
  },
});

export const confirm = eventMutation({
  args: {
    planJobId: v.id("jobs"),
    // The ids of the plan's records the organizer selected. The records
    // themselves are re-derived server-side from the plan job's result — a
    // tampered client cannot smuggle records the organizer never reviewed.
    recordIds: v.array(v.string()),
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
    if (planJob.result === undefined) {
      throw new ConvexError({
        code: "invalid_plan",
        message: "The planner returned an unusable plan.",
      });
    }
    // `result` is v.any(): treat it as hostile and validate before trusting.
    Imports.assertPlanShape(planJob.result);
    const byId = new Map<string, PlannedRecord>(
      planJob.result.records.map((r) => [r.id, r]),
    );
    const selected: PlannedRecord[] = [];
    const seen = new Set<string>();
    for (const id of args.recordIds) {
      const record = byId.get(id);
      if (record === undefined) {
        throw new ConvexError({
          code: "invalid_plan",
          message: "This plan does not contain one of the selected records.",
        });
      }
      if (!seen.has(id)) {
        seen.add(id);
        selected.push(record);
      }
    }
    if (selected.length === 0) {
      throw new ConvexError({
        code: "empty_plan",
        message: "Select at least one record to import.",
      });
    }
    if (selected.length > IMPORT_LIMITS.maxRecords) {
      throw new ConvexError({
        code: "invalid_plan",
        message: `Plans are limited to ${IMPORT_LIMITS.maxRecords} records.`,
      });
    }
    // The confirming organizer becomes the execution authority. The approved
    // records come from the plan's result, so the confirmation boundary is
    // structural: `importExecuteBatch` later re-slices these exact records.
    const jobId = await enqueueJob(
      ctx,
      "import-execute",
      {
        eventId: ctx.caller.event._id,
        planJobId: args.planJobId,
        records: selected,
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
      meta: { planJobId: args.planJobId, records: selected.length },
    });
    return jobId;
  },
});
