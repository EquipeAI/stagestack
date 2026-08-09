import { ConvexError, v } from "convex/values";
import { eventMutation, eventQuery } from "./lib/functions";
import * as Imports from "./model/imports";
import { enqueueJob } from "./model/jobs";
import { logAudit } from "./model/audit";
import { assertEventActive } from "./model/reviews";
import { IMPORT_LIMITS, vPlannedRecord } from "./shared/importPlan";

// Import with AI (M2): upload → agent plans → organizer confirms → execute.
// The plan/execution runs on the worker VM; see apps/worker/src/import-agent.ts
// and convex/model/imports.ts for the authority model.

export const generateUploadUrl = eventMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    assertEventActive(ctx.caller.event);
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

// Poll/subscribe to an import job. Scoped to the caller's event.
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
