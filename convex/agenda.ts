import { v } from "convex/values";
import { eventMutation, eventQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Agenda from "./model/agenda";

// ─────────────────────────────────────────────────────────────────────────
// Public surface for the agenda builder (M6). Thin wrappers; the rules live in
// convex/model/agenda.ts.
//
// The whole board is ONE query (`board`): the list/day/week/track/room views
// are projections of the same rows, so a second server shape would only invite
// the two to disagree. Every mutation here is draft-only EXCEPT `release`,
// `cancelRelease` and `setAck` — the three that speakers can feel.
// ─────────────────────────────────────────────────────────────────────────

const vSlot = v.object({
  startsAt: v.number(),
  endsAt: v.number(),
  roomId: v.optional(v.id("rooms")),
});

const vParticipantState = v.union(
  v.literal("awaiting"),
  v.literal("confirmed"),
  v.literal("declined"),
  v.literal("withdrawn"),
);

const vAck = v.union(
  v.literal("awaitingAck"),
  v.literal("acknowledged"),
  v.literal("conflict"),
);

const vAckResponse = v.union(
  v.literal("acknowledged"),
  v.literal("conflict"),
);

const vConflict = v.object({
  kind: v.union(v.literal("room"), v.literal("speaker"), v.literal("track")),
  /** Speaker/room = non-overridable for release; track = acceptable warning. */
  level: v.union(v.literal("blocker"), v.literal("warning")),
  withType: v.union(v.literal("session"), v.literal("agendaItem")),
  withId: v.string(),
  withTitle: v.string(),
  message: v.string(),
});

const vVirtualLinks = v.object({
  attendee: v.optional(v.string()),
  backstage: v.optional(v.string()),
  host: v.optional(v.string()),
});

const vBoard = v.object({
  event: v.object({
    slug: v.string(),
    name: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    timezone: v.string(),
  }),
  rooms: v.array(
    v.object({
      roomId: vv.id("rooms"),
      name: v.string(),
      capacity: v.optional(v.number()),
      order: v.number(),
    }),
  ),
  tracks: v.array(
    v.object({
      trackId: vv.id("tracks"),
      name: v.string(),
      color: v.optional(v.string()),
      order: v.number(),
    }),
  ),
  sessions: v.array(
    v.object({
      sessionId: vv.id("sessions"),
      title: v.string(),
      format: v.optional(v.string()),
      trackId: v.optional(vv.id("tracks")),
      // Absent = unscheduled, i.e. a card in the tray.
      startsAt: v.optional(v.number()),
      endsAt: v.optional(v.number()),
      roomId: v.optional(vv.id("rooms")),
      releasedSlot: v.optional(
        v.object({
          startsAt: v.number(),
          endsAt: v.number(),
          roomId: v.optional(vv.id("rooms")),
          releasedAt: v.number(),
          sequence: v.number(),
        }),
      ),
      pendingRelease: v.boolean(),
      virtualLinks: v.optional(vVirtualLinks),
      participants: v.array(
        v.object({
          participantId: vv.id("sessionParticipants"),
          eventContactId: vv.id("eventContacts"),
          firstName: v.string(),
          lastName: v.string(),
          state: vParticipantState,
          ack: v.optional(vAck),
        }),
      ),
      conflicts: v.array(vConflict),
    }),
  ),
  agendaItems: v.array(
    v.object({
      itemId: vv.id("agendaItems"),
      title: v.string(),
      startsAt: v.number(),
      endsAt: v.number(),
      roomId: v.optional(vv.id("rooms")),
      description: v.optional(v.string()),
      conflicts: v.array(vConflict),
    }),
  ),
});

const vSlotResults = v.array(
  v.object({
    sessionId: vv.id("sessions"),
    ok: v.boolean(),
    /** "not_found" | "invalid_status" | "not_scheduled" | "conflict" |
     * "unchanged". */
    error: v.optional(v.string()),
  }),
);

/** Everything the board renders — placed sessions, the unscheduled tray,
 * agenda items, rooms, tracks and derived conflicts — in one query. */
export const board = eventQuery({
  args: {},
  returns: vBoard,
  handler: async (ctx) => {
    return await Agenda.boardData(ctx, ctx.caller);
  },
});

/** Drag-and-drop placement. `slot: null` sends the session back to the tray.
 * Never notifies anyone: board edits are internal drafts (M6). */
export const scheduleSession = eventMutation({
  args: { sessionId: v.id("sessions"), slot: v.union(vSlot, v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Agenda.scheduleSession(ctx, ctx.caller, args.sessionId, args.slot);
    return null;
  },
});

export const createAgendaItem = eventMutation({
  args: {
    title: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    roomId: v.optional(v.id("rooms")),
    description: v.optional(v.string()),
  },
  returns: vv.id("agendaItems"),
  handler: async (ctx, args) => {
    return await Agenda.createAgendaItem(ctx, ctx.caller, args);
  },
});

export const updateAgendaItem = eventMutation({
  args: {
    itemId: v.id("agendaItems"),
    patch: v.object({
      title: v.optional(v.string()),
      startsAt: v.optional(v.number()),
      endsAt: v.optional(v.number()),
      // null = explicitly clear the room; absent = leave unchanged.
      roomId: v.optional(v.union(v.id("rooms"), v.null())),
      description: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Agenda.updateAgendaItem(ctx, ctx.caller, args.itemId, args.patch);
    return null;
  },
});

export const removeAgendaItem = eventMutation({
  args: { itemId: v.id("agendaItems") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Agenda.removeAgendaItem(ctx, ctx.caller, args.itemId);
    return null;
  },
});

/** All three audiences at once; an omitted link is cleared (M6). */
export const setVirtualLinks = eventMutation({
  args: {
    sessionId: v.id("sessions"),
    links: v.object({
      attendee: v.optional(v.string()),
      backstage: v.optional(v.string()),
      host: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Agenda.setVirtualLinks(ctx, ctx.caller, args.sessionId, args.links);
    return null;
  },
});

/**
 * The explicit external step: tell the speakers, individually or in a batch.
 * Per-id results — one blocked session must not lose the whole wave. Speaker
 * and room collisions are non-overridable, so there is no `force` flag.
 * Re-releasing an unchanged slot resends only to participants whose last
 * invite failed to send; otherwise it comes back "unchanged".
 */
export const release = eventMutation({
  args: { sessionIds: v.array(v.id("sessions")) },
  returns: vSlotResults,
  handler: async (ctx, args) => {
    return await Agenda.releaseSlots(ctx, ctx.caller, args.sessionIds);
  },
});

/** Take a released slot back: every holder gets a calendar cancellation. The
 * draft placement stays on the board. Returns how many were notified. */
export const cancelRelease = eventMutation({
  args: { sessionId: v.id("sessions") },
  returns: v.number(),
  handler: async (ctx, args) => {
    return await Agenda.cancelRelease(ctx, ctx.caller, args.sessionId);
  },
});

/** Record an acknowledgement on a speaker's behalf. The speaker's and the
 * manager's own path is `portal.acknowledgeSlot`. */
export const setAck = eventMutation({
  args: {
    participantId: v.id("sessionParticipants"),
    response: vAckResponse,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Agenda.organizerSetAck(
      ctx,
      ctx.caller,
      args.participantId,
      args.response,
    );
    return null;
  },
});
