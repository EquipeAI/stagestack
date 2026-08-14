import { ConvexError, v } from "convex/values";
import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import { eventMutation, eventQuery } from "./lib/functions";
import { vParticipantState, vv } from "./lib/validators";
import * as Tasks from "./model/tasks";
import * as Readiness from "./model/readiness";
import { vControlRow } from "./readiness";

// ─────────────────────────────────────────────────────────────────────────
// Public surface for speaker ops (M4). Thin wrappers; the rules live in
// convex/model/tasks.ts and convex/model/readiness.ts.
//
// Everything here rides `eventMutation`/`eventQuery`, so the caller is an
// event member — and every model function re-checks organizer-only where the
// milestone says only organizers may act (approve, request changes, waive).
//
// The speaker/manager side of the same capabilities is convex/portal.ts.
// ─────────────────────────────────────────────────────────────────────────

const vScope = v.union(v.literal("participant"), v.literal("session"));
const vEvidence = v.union(
  v.literal("file"),
  v.literal("profileField"),
  v.literal("manual"),
);
const vTaskStatus = v.union(
  v.literal("pending"),
  v.literal("provided"),
  v.literal("changesRequested"),
  v.literal("approved"),
  v.literal("complete"),
  v.literal("notApplicable"),
);

// ── Requirements ─────────────────────────────────────────────────────────

export const createRequirement = eventMutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    scope: vScope,
    evidence: vEvidence,
    /** Required iff evidence is "profileField": "bio" | "headshot" | "tagline". */
    fieldKey: v.optional(v.string()),
    reviewRequired: v.boolean(),
    dueAt: v.number(),
  },
  returns: v.object({
    requirementId: vv.id("requirements"),
    /** How many obligations the backfill created right now. */
    instances: v.number(),
  }),
  handler: async (ctx, args) => {
    return await Tasks.createRequirement(ctx, ctx.caller, args);
  },
});

export const updateRequirement = eventMutation({
  args: {
    requirementId: v.id("requirements"),
    patch: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      dueAt: v.optional(v.number()),
      reviewRequired: v.optional(v.boolean()),
      /** false stops instantiation for future sessions; existing work stays. */
      active: v.optional(v.boolean()),
      /** M5: per-requirement cadence override; null inherits the event default. */
      reminderCadenceDays: v.optional(v.union(v.number(), v.null())),
      /** M5: silence reminders for this requirement only. */
      remindersDisabled: v.optional(v.boolean()),
    }),
  },
  returns: v.object({ repropagated: v.number() }),
  handler: async (ctx, args) => {
    return await Tasks.updateRequirement(
      ctx,
      ctx.caller,
      args.requirementId,
      args.patch,
    );
  },
});

export const listRequirements = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      requirementId: vv.id("requirements"),
      title: v.string(),
      description: v.optional(v.string()),
      scope: vScope,
      evidence: vEvidence,
      fieldKey: v.optional(v.string()),
      reviewRequired: v.boolean(),
      dueAt: v.number(),
      active: v.boolean(),
      reminderCadenceDays: v.optional(v.number()),
      remindersDisabled: v.optional(v.boolean()),
      instanceCount: v.number(),
      openCount: v.number(),
    }),
  ),
  handler: async (ctx) => {
    return await Tasks.listRequirements(ctx, ctx.caller);
  },
});

// ── Instances ────────────────────────────────────────────────────────────

export const listInstances = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      instanceId: vv.id("taskInstances"),
      requirementId: vv.id("requirements"),
      requirementTitle: v.string(),
      scope: vScope,
      evidence: vEvidence,
      reviewRequired: v.boolean(),
      sessionId: vv.id("sessions"),
      sessionTitle: v.string(),
      participantId: v.optional(vv.id("sessionParticipants")),
      eventContactId: v.optional(vv.id("eventContacts")),
      speakerName: v.optional(v.string()),
      participantState: v.optional(vParticipantState),
      status: vTaskStatus,
      dueAt: v.number(),
      naReason: v.optional(v.string()),
      reviewNote: v.optional(v.string()),
      uploadCount: v.number(),
      completedBy: v.optional(vv.id("users")),
      completedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    return await Tasks.listInstances(ctx, ctx.caller);
  },
});

/** Organizer completes a manual task on someone's behalf. The instance keeps
 * its participant; `completedBy` records who actually did it (M4). */
export const markProvided = eventMutation({
  args: { instanceId: v.id("taskInstances") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Tasks.markProvided(
      ctx,
      ctx.caller.user,
      ctx.caller.event,
      args.instanceId,
    );
    return null;
  },
});

export const approve = eventMutation({
  args: { instanceId: v.id("taskInstances") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Tasks.approveInstance(ctx, ctx.caller, args.instanceId);
    return null;
  },
});

/** A change request needs an explanatory note and notifies whoever owes the
 * work (MILESTONES M4). */
export const requestChanges = eventMutation({
  args: { instanceId: v.id("taskInstances"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Tasks.requestChanges(ctx, ctx.caller, args.instanceId, args.note);
    return null;
  },
});

export const markNotApplicable = eventMutation({
  args: { instanceId: v.id("taskInstances"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Tasks.markNotApplicable(
      ctx,
      ctx.caller,
      args.instanceId,
      args.reason,
    );
    return null;
  },
});

export const reopen = eventMutation({
  args: { instanceId: v.id("taskInstances") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Tasks.reopenInstance(ctx, ctx.caller, args.instanceId);
    return null;
  },
});

/** Per-participant / per-session due date override. */
export const setInstanceDue = eventMutation({
  args: { instanceId: v.id("taskInstances"), dueAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Tasks.setInstanceDue(ctx, ctx.caller, args.instanceId, args.dueAt);
    return null;
  },
});

// ── File evidence ────────────────────────────────────────────────────────

// Minting an upload URL is a free write into storage the moment the holder
// uses it, so an uncapped mint is a storage hole rather than mere load. Same
// shape and reasoning as `imports.ts`'s `importUploadPerUser` (and the CFP /
// portal mint caps): per-user rather than per-event, so one account can't fan
// the same spend out across every event it belongs to. 20/hour matches the
// import cap — far above an organizer attaching evidence by hand, including
// retries.
const uploadLimiter = new RateLimiter(components.rateLimiter, {
  taskUploadPerUser: { kind: "token bucket", rate: 20, period: HOUR },
});

export const generateUploadUrl = eventMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const limit = await uploadLimiter.limit(ctx, "taskUploadPerUser", {
      key: ctx.caller.user._id,
    });
    if (!limit.ok) {
      throw new ConvexError({
        code: "rate_limited",
        message: "Too many uploads — try again in a little while.",
      });
    }
    return await ctx.storage.generateUploadUrl();
  },
});

export const attachUpload = eventMutation({
  args: {
    instanceId: v.id("taskInstances"),
    storageId: v.id("_storage"),
    filename: v.string(),
  },
  returns: v.object({ uploadId: vv.id("uploads"), version: v.number() }),
  handler: async (ctx, args) => {
    return await Tasks.attachUpload(ctx, ctx.caller.user, ctx.caller.event, {
      instanceId: args.instanceId,
      storageId: args.storageId,
      filename: args.filename,
    });
  },
});

/** Every stored version, newest first — prior files are never erased (M4). */
export const listUploads = eventQuery({
  args: { instanceId: v.id("taskInstances") },
  returns: v.array(
    v.object({
      uploadId: vv.id("uploads"),
      filename: v.string(),
      version: v.number(),
      uploadedBy: vv.id("users"),
      uploadedAt: v.number(),
      url: v.union(v.string(), v.null()),
      approvedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    return await Tasks.listUploads(
      ctx,
      ctx.caller.user,
      ctx.caller.event,
      args.instanceId,
    );
  },
});

// ── Readiness ────────────────────────────────────────────────────────────

const vReadiness = v.object({
  status: v.union(
    v.literal("ready"),
    v.literal("needsAttention"),
    v.literal("blocked"),
  ),
  reasons: v.array(v.string()),
});

/**
 * The speaker-tracking dashboard (M4). `now` is an argument, not a clock read:
 * Convex queries are not re-run because time advanced, so overdue state has to
 * come from the client's ticking value to stay honest.
 */
export const dashboard = eventQuery({
  args: { now: v.number() },
  returns: v.object({
    speakers: v.array(
      v.object({
        eventContactId: vv.id("eventContacts"),
        name: v.string(),
        state: vParticipantState,
        claimed: v.boolean(),
        missingBio: v.boolean(),
        missingHeadshot: v.boolean(),
        outstandingTasks: v.number(),
        overdueTasks: v.number(),
      }),
    ),
    sessions: v.array(
      v.object({
        sessionId: vv.id("sessions"),
        title: v.string(),
        readiness: vReadiness,
      }),
    ),
    totals: v.object({
      confirmed: v.number(),
      awaiting: v.number(),
      declined: v.number(),
      withdrawn: v.number(),
      acceptedSpeakers: v.number(),
      missingProfile: v.number(),
      overdue: v.number(),
    }),
    // W8's "what is blocked" counts, derived in the SAME pass as the readiness
    // rows above so the panel's headline can never disagree with its list.
    // `rows` carries the sentences the control center prints, composed in the
    // model (W4: one explanation, one producer).
    blockers: v.object({
      contentDrafts: v.number(),
      unscheduled: v.number(),
      scheduleConflicts: v.number(),
      blockedSessions: v.number(),
      rows: v.array(vControlRow),
    }),
  }),
  handler: async (ctx, args) => {
    return await Readiness.dashboard(ctx, ctx.caller, args.now);
  },
});

// ── Files library & bulk export (W5: CNT-13/CNT-14) ──────────────────────

export const filesLibrary = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      instanceId: vv.id("taskInstances"),
      requirementTitle: v.string(),
      sessionId: vv.id("sessions"),
      sessionTitle: v.string(),
      speakerName: v.union(v.string(), v.null()),
      filename: v.string(),
      version: v.number(),
      versionCount: v.number(),
      uploadedAt: v.number(),
      url: v.union(v.string(), v.null()),
      commentCount: v.number(),
    }),
  ),
  handler: async (ctx) => {
    return Tasks.legacyLibraryFileRows(
      await Tasks.filesLibrary(ctx, ctx.caller, { includeHeadshots: false }),
    );
  },
});

export const exportBundle = eventQuery({
  args: { instanceIds: v.array(v.id("taskInstances")) },
  returns: v.array(
    v.object({
      filename: v.string(),
      url: v.union(v.string(), v.null()),
      sessionTitle: v.string(),
      speakerName: v.union(v.string(), v.null()),
      requirementTitle: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    return await Tasks.exportBundle(
      ctx,
      ctx.caller,
      args.instanceIds.map((id) => `task:${id}`),
      true,
    );
  },
});

// Expanded files API. Versioned names keep Convex-first deployments safe for
// an older web bundle that still consumes the task-only contracts above.

export const filesLibraryV2 = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      fileId: v.string(),
      kind: v.union(v.literal("task"), v.literal("headshot")),
      instanceId: v.union(vv.id("taskInstances"), v.null()),
      requirementTitle: v.string(),
      sessionId: v.union(vv.id("sessions"), v.null()),
      sessionTitle: v.string(),
      speakerName: v.union(v.string(), v.null()),
      sourceFilename: v.union(v.string(), v.null()),
      filename: v.string(),
      version: v.union(v.number(), v.null()),
      versionCount: v.union(v.number(), v.null()),
      uploadedByName: v.union(v.string(), v.null()),
      uploadedByNote: v.union(v.string(), v.null()),
      uploadedAt: v.union(v.number(), v.null()),
      url: v.union(v.string(), v.null()),
      commentCount: v.number(),
    }),
  ),
  handler: async (ctx) => {
    return await Tasks.filesLibrary(ctx, ctx.caller);
  },
});

export const exportBundleV2 = eventQuery({
  args: { fileIds: v.array(v.string()) },
  returns: v.array(
    v.object({
      filename: v.string(),
      url: v.union(v.string(), v.null()),
      sessionTitle: v.string(),
      speakerName: v.union(v.string(), v.null()),
      requirementTitle: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    return await Tasks.exportBundle(ctx, ctx.caller, args.fileIds);
  },
});

// Organizer-side comment thread (same rows the portal reads).

export const taskComments = eventQuery({
  args: { instanceId: v.id("taskInstances") },
  returns: v.array(
    v.object({
      commentId: vv.id("uploadComments"),
      authorName: v.union(v.string(), v.null()),
      authorEmail: v.union(v.string(), v.null()),
      body: v.string(),
      createdAt: v.number(),
      mine: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    return await Tasks.listTaskComments(
      ctx,
      ctx.caller.user,
      ctx.caller.event,
      args.instanceId,
    );
  },
});

export const commentOnTask = eventMutation({
  args: { instanceId: v.id("taskInstances"), body: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Tasks.addTaskComment(
      ctx,
      ctx.caller.user,
      ctx.caller.event,
      args.instanceId,
      args.body,
    );
    return null;
  },
});
