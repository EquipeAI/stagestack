import { v } from "convex/values";
import { eventMutation, eventQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Sessions from "./model/sessions";

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
