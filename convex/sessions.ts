import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { eventMutation, eventQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Sessions from "./model/sessions";
import * as Portal from "./model/portal";
import { vPortalContext } from "./portal";

// ─────────────────────────────────────────────────────────────────────────
// Public surface for the decision pipeline and sessions (M2). Thin wrappers;
// the rules live in convex/model/sessions.ts.
//
// The bulk mutations return PER-ID results — one stale row in the organizer's
// selection must not abort the whole wave.
// ─────────────────────────────────────────────────────────────────────────

const vBulkResults = v.array(
  v.object({
    proposalId: vv.id("proposals"),
    ok: v.boolean(),
    /** Stable code: "not_found" | "invalid_status". */
    error: v.optional(v.string()),
  }),
);

const vParticipantState = v.union(
  v.literal("awaiting"),
  v.literal("confirmed"),
  v.literal("declined"),
  v.literal("withdrawn"),
);

export const setStatus = eventMutation({
  args: {
    proposalIds: v.array(v.id("proposals")),
    to: v.union(
      v.literal("pending"),
      v.literal("acceptQueue"),
      v.literal("declineQueue"),
    ),
  },
  returns: vBulkResults,
  handler: async (ctx, args) => {
    return await Sessions.setProposalStatus(
      ctx,
      ctx.caller,
      args.proposalIds,
      args.to,
    );
  },
});

export const sendDirectInvitation = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    eventContactId: v.id("eventContacts"),
    sentByUserId: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Sessions.sendDirectInvitation(ctx, args);
    return null;
  },
});

/** Internal half of an accepted-proposal resubmission. The public CFP
 * mutation owns submitter authorization and the active reopen grant; this
 * function only reconciles the already-accepted session in the same logical
 * operation without exposing a second public write surface. */
export const syncAcceptedProposalRevision = internalMutation({
  args: {
    proposalId: v.id("proposals"),
    submittedByUserId: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get("proposals", args.proposalId);
    if (proposal === null) {
      throw new ConvexError({
        code: "not_found",
        message: "The accepted proposal no longer exists.",
      });
    }
    const event = await ctx.db.get("events", proposal.eventId);
    if (event === null) {
      throw new ConvexError({
        code: "not_found",
        message: "The proposal's event no longer exists.",
      });
    }
    await Sessions.syncAcceptedProposalRevision(
      ctx,
      event,
      proposal,
      args.submittedByUserId,
    );
    return null;
  },
});

export const updateContent = eventMutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    format: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { sessionId, ...patch } = args;
    await Sessions.updateContent(ctx, ctx.caller, sessionId, patch);
    return null;
  },
});

const vContentFields = v.object({
  title: v.string(),
  description: v.optional(v.string()),
  format: v.optional(v.string()),
});

export const listRevisions = eventQuery({
  args: { sessionId: v.id("sessions") },
  returns: v.array(
    v.object({
      revisionId: vv.id("sessionRevisions"),
      editedAt: v.number(),
      editorName: v.union(v.string(), v.null()),
      editorEmail: v.union(v.string(), v.null()),
      before: vContentFields,
      after: vContentFields,
    }),
  ),
  handler: async (ctx, args) => {
    return await Sessions.listRevisions(ctx, ctx.caller, args.sessionId);
  },
});

export const restoreRevision = eventMutation({
  args: { revisionId: v.id("sessionRevisions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Sessions.restoreRevision(ctx, ctx.caller, args.revisionId);
    return null;
  },
});

export const setContentStatus = eventMutation({
  args: {
    sessionId: v.id("sessions"),
    to: v.union(v.literal("draft"), v.literal("approved")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Sessions.setContentStatus(ctx, ctx.caller, args.sessionId, args.to);
    return null;
  },
});

export const release = eventMutation({
  args: { proposalIds: v.array(v.id("proposals")) },
  returns: vBulkResults,
  handler: async (ctx, args) => {
    return await Sessions.releaseDecisions(ctx, ctx.caller, args.proposalIds);
  },
});

export const correct = eventMutation({
  args: {
    proposalId: v.id("proposals"),
    to: v.union(v.literal("accepted"), v.literal("declined")),
    note: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Sessions.correctDecision(
      ctx,
      ctx.caller,
      args.proposalId,
      args.to,
      args.note,
    );
    return null;
  },
});

export const createDirect = eventMutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    format: v.optional(v.string()),
    trackId: v.optional(v.id("tracks")),
    speaker: v.object({
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
      phone: v.optional(v.string()),
      tagline: v.optional(v.string()),
      bio: v.optional(v.string()),
    }),
  },
  returns: v.object({
    sessionId: vv.id("sessions"),
    eventContactId: vv.id("eventContacts"),
  }),
  handler: async (ctx, args) => {
    return await Sessions.createDirectSession(ctx, ctx.caller, args);
  },
});

export const list = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      session: vv.doc("sessions"),
      participants: v.array(
        v.object({
          participantId: vv.id("sessionParticipants"),
          eventContactId: vv.id("eventContacts"),
          firstName: v.string(),
          lastName: v.string(),
          role: v.string(),
          state: vParticipantState,
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    return await Sessions.listSessions(ctx, ctx.caller);
  },
});

// ── Organizer side of the speaker portal (M3) ────────────────────────────
// The portal's own surface is convex/portal.ts (signed-in speakers and
// managers). These are the organizer's controls over it, so they ride the
// event-scoped wrappers.

/** Record a participation decision for a speaker. Organizers may also reset
 * one to Awaiting Response; speakers and managers cannot. */
export const setParticipationState = eventMutation({
  args: {
    participantId: v.id("sessionParticipants"),
    to: v.union(
      v.literal("awaiting"),
      v.literal("confirmed"),
      v.literal("declined"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Portal.organizerSetParticipationState(
      ctx,
      ctx.caller,
      args.participantId,
      args.to,
    );
    return null;
  },
});

/** Invite a speaker to claim their own portal access. */
export const invitePortal = eventMutation({
  args: { eventContactId: v.id("eventContacts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Portal.invitePortal(ctx, ctx.caller, args.eventContactId);
    return null;
  },
});

export const startManagerHandoff = eventMutation({
  args: { sessionId: v.id("sessions"), email: v.string() },
  returns: vv.id("managerHandoffs"),
  handler: async (ctx, args) => {
    return await Portal.startManagerHandoff(ctx, ctx.caller, args);
  },
});

export const revokeHandoff = eventMutation({
  args: { handoffId: v.id("managerHandoffs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Portal.revokeHandoff(ctx, ctx.caller, args.handoffId);
    return null;
  },
});

/** Read-only "Preview speaker portal" (M3). Organizer-only; the banner name
 * comes back with the data so the preview can never be mistaken for the real
 * thing. */
export const previewPortalContext = eventQuery({
  args: { eventContactId: v.id("eventContacts") },
  returns: vPortalContext.extend({ contactName: v.string() }),
  handler: async (ctx, args) => {
    return await Portal.previewPortalContext(
      ctx,
      ctx.caller,
      args.eventContactId,
    );
  },
});
