import { v } from "convex/values";
import { eventQuery } from "./lib/functions";
import { vParticipantState, vv } from "./lib/validators";
import { vPublicationReason } from "./readiness";
import * as Workspaces from "./model/workspaces";

// ─────────────────────────────────────────────────────────────────────────
// The per-record workspaces' read surface (W9). Thin wrappers; every rule and
// every rendered string lives in convex/model/workspaces.ts, and the
// publication sentences come from convex/model/readiness.ts unchanged.
//
// Both are organizer-only. The workspaces are organizer surfaces: a reviewer's
// world is Reviews, and a speaker's is the portal.
// ─────────────────────────────────────────────────────────────────────────

const vAck = v.union(
  v.literal("awaitingAck"),
  v.literal("acknowledged"),
  v.literal("conflict"),
);

const vPublication = v.object({
  inLineup: v.boolean(),
  inAgenda: v.boolean(),
  toBeAnnounced: v.boolean(),
  // One producer for the wire shape too (convex/readiness.ts).
  reasons: v.array(vPublicationReason),
  summary: v.string(),
});

/** One speaker's whole event footprint — the Speaker workspace's spine. */
export const speaker = eventQuery({
  args: { eventContactId: v.id("eventContacts") },
  returns: v.object({
    eventContactId: vv.id("eventContacts"),
    firstName: v.string(),
    lastName: v.string(),
    email: v.optional(v.string()),
    tagline: v.optional(v.string()),
    jobTitle: v.optional(v.string()),
    company: v.optional(v.string()),
    bio: v.optional(v.string()),
    links: v.optional(
      v.object({
        website: v.optional(v.string()),
        twitter: v.optional(v.string()),
        linkedin: v.optional(v.string()),
        github: v.optional(v.string()),
      }),
    ),
    headshotUrl: v.union(v.string(), v.null()),
    claimed: v.boolean(),
    customValues: v.record(v.string(), v.union(v.string(), v.array(v.string()))),
    sessions: v.array(
      v.object({
        participantId: vv.id("sessionParticipants"),
        sessionId: vv.id("sessions"),
        title: v.string(),
        format: v.optional(v.string()),
        role: v.string(),
        state: vParticipantState,
        ack: v.optional(vAck),
        status: v.union(v.literal("planned"), v.literal("cancelled")),
        contentStatus: v.union(v.literal("draft"), v.literal("approved")),
        startsAt: v.optional(v.number()),
        endsAt: v.optional(v.number()),
        released: v.boolean(),
      }),
    ),
    sessionsTruncated: v.boolean(),
    readiness: v.object({
      missingBio: v.boolean(),
      missingHeadshot: v.boolean(),
      missingTagline: v.boolean(),
      reasons: v.array(v.string()),
    }),
  }),
  handler: async (ctx, args) => {
    return await Workspaces.speakerWorkspace(ctx, ctx.caller, args.eventContactId);
  },
});

/** One session's spine: source proposal, speakers, placement, publication. */
export const session = eventQuery({
  args: { sessionId: v.id("sessions") },
  returns: v.object({
    session: vv.doc("sessions"),
    roomName: v.union(v.string(), v.null()),
    participants: v.array(
      v.object({
        participantId: vv.id("sessionParticipants"),
        eventContactId: vv.id("eventContacts"),
        firstName: v.string(),
        lastName: v.string(),
        email: v.optional(v.string()),
        tagline: v.optional(v.string()),
        headshotUrl: v.union(v.string(), v.null()),
        role: v.string(),
        state: vParticipantState,
        ack: v.optional(vAck),
      }),
    ),
    proposal: v.union(
      v.null(),
      v.object({
        proposalId: vv.id("proposals"),
        title: v.string(),
        status: v.string(),
        submittedAt: v.optional(v.number()),
        submitterName: v.union(v.string(), v.null()),
        submitterEmail: v.union(v.string(), v.null()),
      }),
    ),
    publication: vPublication,
  }),
  handler: async (ctx, args) => {
    return await Workspaces.sessionWorkspace(ctx, ctx.caller, args.sessionId);
  },
});
