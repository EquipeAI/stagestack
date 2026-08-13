import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import {
  blockers,
  candidateConflicts,
  conflictsFor,
  overlaps,
  type Conflict,
  type ScheduledThing,
} from "../shared/agenda";
import { mailFromAddress } from "../emails";
import { logAudit } from "./audit";
import { routeParticipant } from "./audiences";
import { emailShell, escapeHtml, notifyOrganizers, siteUrl } from "./comms";
import { formatLabel, loadFormats, resolveDurationMinutes } from "./library";
import { renderTemplate } from "./templates";
import { assertEventActive, assertText, takeAll } from "./validation";

// ─────────────────────────────────────────────────────────────────────────
// Agenda builder (M6).
//
// THE RULE THAT SHAPES THIS WHOLE FILE: "Schedule placement and edits are
// internal drafts and never trigger communication merely because an organizer
// changes the board." So the board writes (`scheduleSession`, agenda items,
// virtual links) send NOTHING — they only touch draft fields. Everything
// external happens in ONE explicit capability, `releaseSlots`, which is also
// the only place `sessions.releasedSlot` is written.
//
// Two placements per session, deliberately:
//   • draft  — sessions.startsAt / endsAt / roomId. What the board shows.
//   • released — sessions.releasedSlot. What the speakers were TOLD. The .ics
//     SEQUENCE that makes a calendar update replace rather than duplicate
//     comes from sessions.icsSequence, a per-session counter that only ever
//     increments (see nextIcsSequence) — never from releasedSlot alone.
//
// Conflicts are DERIVED, never stored (same posture as readiness): a pure
// function over the scheduled rows, so the board, the release gate and the
// readiness dashboard can never disagree about what collides.
// ─────────────────────────────────────────────────────────────────────────

// Read ceilings. Conflicts are derived from a WHOLE-event read, so every one
// of these is enforced with `takeAll` (refuse) rather than a bare `.take`
// (silently drop rows and report "no conflict") — H5.
const SESSION_SCAN = 1000;
const PARTICIPANT_SCAN = 5000;
const CONTACT_SCAN = 2000;
const ITEM_SCAN = 1000;
const LIBRARY_SCAN = 200;
/** Release fans out per participant (patch + template + scheduled invite); 100
 * sessions per transaction stays well inside Convex limits and the UI batches
 * bigger selections across calls (same bound as the decision release). */
const MAX_BULK = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Placement slack around the event window: the organizer's setup block at
 * 07:00 the day before is legitimate; a talk three weeks out is a typo. */
const WINDOW_SLACK_MS = DAY_MS;
const MAX_BLOCK_MS = DAY_MS;

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;
const MAX_URL = 500;

/** The address the .ics ORGANIZER property carries. Derived from `MAIL_FROM`
 * (convex/emails.ts) rather than hardcoded: an invite whose organizer differs
 * from the sending domain gets flagged by some clients, so a self-host that
 * sends as its own domain must not advertise ours here. */

export type Slot = {
  startsAt: number;
  endsAt: number;
  roomId?: Id<"rooms">;
};

export type AckResponse = "acknowledged" | "conflict";

// ── Shared lookups ───────────────────────────────────────────────────────

function invalidSlot(message: string): never {
  throw new ConvexError({ code: "invalid_slot", message });
}

function fullName(contact: Doc<"eventContacts"> | undefined): string {
  return contact === undefined
    ? ""
    : `${contact.firstName} ${contact.lastName}`.trim();
}

function portalLink(eventSlug: string): string {
  return `${siteUrl()}/portal/${eventSlug}`;
}

function assertBulkSize(ids: ReadonlyArray<unknown>): void {
  if (ids.length === 0) {
    throw new ConvexError({
      code: "empty_selection",
      message: "Select at least one session.",
    });
  }
  if (ids.length > MAX_BULK) {
    throw new ConvexError({
      code: "too_many",
      message: `At most ${MAX_BULK} sessions at a time.`,
    });
  }
}

async function requireSession(
  ctx: QueryCtx,
  event: Doc<"events">,
  sessionId: Id<"sessions">,
): Promise<Doc<"sessions">> {
  const session = await ctx.db.get("sessions", sessionId);
  if (session === null || session.eventId !== event._id) {
    notFound("session", "No such session on this event.");
  }
  return session;
}

/** Times must be sane and roughly inside the event; the room must be ours. */
async function validateSlot(
  ctx: QueryCtx,
  event: Doc<"events">,
  slot: Slot,
): Promise<Slot> {
  if (!Number.isFinite(slot.startsAt) || !Number.isFinite(slot.endsAt)) {
    invalidSlot("That start/end time isn't a valid moment.");
  }
  if (slot.endsAt <= slot.startsAt) {
    invalidSlot("The end time must be after the start time.");
  }
  if (slot.endsAt - slot.startsAt > MAX_BLOCK_MS) {
    invalidSlot("A single block can't be longer than 24 hours.");
  }
  if (
    slot.startsAt < event.startsAt - WINDOW_SLACK_MS ||
    slot.endsAt > event.endsAt + WINDOW_SLACK_MS
  ) {
    invalidSlot("That time is outside the event's dates.");
  }
  if (slot.roomId !== undefined) {
    const room = await ctx.db.get("rooms", slot.roomId);
    if (room === null || room.eventId !== event._id) {
      notFound("room", "No such room on this event.");
    }
  }
  return { startsAt: slot.startsAt, endsAt: slot.endsAt, roomId: slot.roomId };
}

// ── Conflicts (pure) ─────────────────────────────────────────────────────
//
// The engine itself — `conflictsFor`, `overlaps`, `blockers`,
// `candidateConflicts` and the `Conflict`/`ScheduledThing` types — moved to
// `convex/shared/agenda.ts` (W13) so the phone board can ask the SAME function
// whether an empty cell would be legal. Nothing about it changed; what changed
// is who can call it. Re-exported here because this module is still the
// server's front door to the schedule (`model/readiness.ts` imports from the
// shared module directly).

export type {
  Conflict,
  ConflictKind,
  ConflictLevel,
  ScheduledKind,
  ScheduledThing,
} from "../shared/agenda";
export { blockers, conflictsFor, overlaps } from "../shared/agenda";

/** Participants that can be double-booked or owed an invitation. */
function counts(participant: Doc<"sessionParticipants">): boolean {
  return participant.state !== "withdrawn" && participant.state !== "declined";
}

/**
 * Flatten the schedule into comparable blocks. Sessions contribute their DRAFT
 * placement: the board is what the organizer is editing, and release compares
 * the draft against every other placed block before it lets anything out.
 */
export function toScheduledThings(args: {
  sessions: Array<Doc<"sessions">>;
  agendaItems: Array<Doc<"agendaItems">>;
  participantsBySession: Map<Id<"sessions">, Array<Doc<"sessionParticipants">>>;
}): ScheduledThing[] {
  const things: ScheduledThing[] = [];
  for (const session of args.sessions) {
    if (session.status !== "planned") continue;
    if (session.startsAt === undefined || session.endsAt === undefined)
      continue;
    things.push({
      type: "session",
      id: session._id,
      title: session.title,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      roomId: session.roomId,
      trackId: session.trackId,
      speakerIds: (args.participantsBySession.get(session._id) ?? [])
        .filter(counts)
        .map((p) => p.eventContactId),
    });
  }
  for (const item of args.agendaItems) {
    things.push({
      type: "agendaItem",
      id: item._id,
      title: item.title,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      roomId: item.roomId,
      speakerIds: [],
    });
  }
  return things;
}

// ── Board ────────────────────────────────────────────────────────────────

export type BoardParticipant = {
  participantId: Id<"sessionParticipants">;
  eventContactId: Id<"eventContacts">;
  firstName: string;
  lastName: string;
  state: Doc<"sessionParticipants">["state"];
  ack?: NonNullable<Doc<"sessionParticipants">["ack"]>;
};

export type BoardReleasedSlot = NonNullable<Doc<"sessions">["releasedSlot"]>;

export type BoardSession = {
  sessionId: Id<"sessions">;
  title: string;
  /** Rendered format label: library name, else the free text. */
  format?: string;
  /** Resolved block length — override → format default → 60. */
  durationMinutes: number;
  trackId?: Id<"tracks">;
  startsAt?: number;
  endsAt?: number;
  roomId?: Id<"rooms">;
  releasedSlot?: BoardReleasedSlot;
  /** True when the draft placement differs from what speakers were told. */
  pendingRelease: boolean;
  virtualLinks?: NonNullable<Doc<"sessions">["virtualLinks"]>;
  participants: BoardParticipant[];
  conflicts: Conflict[];
};

export type BoardAgendaItem = {
  itemId: Id<"agendaItems">;
  title: string;
  startsAt: number;
  endsAt: number;
  roomId?: Id<"rooms">;
  description?: string;
  conflicts: Conflict[];
};

export type BoardData = {
  event: {
    slug: string;
    name: string;
    startsAt: number;
    endsAt: number;
    timezone: string;
  };
  rooms: Array<{
    roomId: Id<"rooms">;
    name: string;
    capacity?: number;
    order: number;
  }>;
  tracks: Array<{
    trackId: Id<"tracks">;
    name: string;
    color?: string;
    order: number;
  }>;
  sessions: BoardSession[];
  agendaItems: BoardAgendaItem[];
};

function groupParticipants(
  participants: Array<Doc<"sessionParticipants">>,
): Map<Id<"sessions">, Array<Doc<"sessionParticipants">>> {
  const bySession = new Map<
    Id<"sessions">,
    Array<Doc<"sessionParticipants">>
  >();
  for (const participant of participants) {
    const list = bySession.get(participant.sessionId) ?? [];
    list.push(participant);
    bySession.set(participant.sessionId, list);
  }
  return bySession;
}

type EventSchedule = {
  sessions: Array<Doc<"sessions">>;
  agendaItems: Array<Doc<"agendaItems">>;
  participants: Array<Doc<"sessionParticipants">>;
  contacts: Array<Doc<"eventContacts">>;
  participantsBySession: Map<Id<"sessions">, Array<Doc<"sessionParticipants">>>;
  contactById: Map<Id<"eventContacts">, Doc<"eventContacts">>;
  conflicts: Map<string, Conflict[]>;
};

/**
 * One bounded pass over everything the schedule depends on. Shared by the
 * board query and the release mutation so both see identical conflicts.
 *
 * REFUSES (`event_too_large`) instead of truncating: conflict detection is a
 * whole-graph answer, and a dropped session or participant turns "no conflict"
 * into a real double-booking that the board draws green and the release gate
 * waves through. An error an organizer can act on beats a wrong answer nobody
 * can see (H5).
 */
export async function loadSchedule(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<EventSchedule> {
  const [sessions, agendaItems, participants, contacts] = await Promise.all([
    takeAll(
      ctx.db
        .query("sessions")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      SESSION_SCAN,
      "sessions",
    ),
    takeAll(
      ctx.db
        .query("agendaItems")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      ITEM_SCAN,
      "agenda items",
    ),
    takeAll(
      ctx.db
        .query("sessionParticipants")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      PARTICIPANT_SCAN,
      "speaker participations",
    ),
    takeAll(
      ctx.db
        .query("eventContacts")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      CONTACT_SCAN,
      "speaker profiles",
    ),
  ]);
  const participantsBySession = groupParticipants(participants);
  return {
    sessions,
    agendaItems,
    participants,
    contacts,
    participantsBySession,
    contactById: new Map(contacts.map((c) => [c._id, c])),
    conflicts: conflictsFor(
      toScheduledThings({ sessions, agendaItems, participantsBySession }),
    ),
  };
}

function isPendingRelease(session: Doc<"sessions">): boolean {
  const released = session.releasedSlot;
  if (released === undefined) {
    return session.startsAt !== undefined && session.endsAt !== undefined;
  }
  return (
    session.startsAt !== released.startsAt ||
    session.endsAt !== released.endsAt ||
    session.roomId !== released.roomId
  );
}

/**
 * Everything the agenda board renders in one query: rooms and tracks to lay
 * the grid out, placed AND unplaced sessions (the tray) with their speakers,
 * acknowledgement state and derived conflicts, plus the non-session blocks.
 *
 * Organizer-only: the board carries backstage/host links and unreleased
 * placements, neither of which a reviewer may see.
 */
export async function boardData(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<BoardData> {
  requireOrganizer(caller);
  const event = caller.event;
  const [schedule, rooms, tracks, formats] = await Promise.all([
    loadSchedule(ctx, event),
    // Also refuse: a dropped room is a missing grid column, so placed sessions
    // would silently vanish from the board they are placed on.
    takeAll(
      ctx.db
        .query("rooms")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      LIBRARY_SCAN,
      "rooms",
    ),
    takeAll(
      ctx.db
        .query("tracks")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      LIBRARY_SCAN,
      "tracks",
    ),
    // One formats read policy everywhere (model/library.ts): refuse rather
    // than truncate, so a board can never render a stale free-text label
    // because the row that replaced it fell off the end of a slice.
    loadFormats(ctx, event._id),
  ]);
  const formatById = new Map(formats.map((f) => [f._id, f]));

  const sessions: BoardSession[] = schedule.sessions
    // Cancelled sessions leave active scheduling (MILESTONES M2) — they are
    // history, not tray cards.
    .filter((session) => session.status === "planned")
    .map((session) => ({
      sessionId: session._id,
      title: session.title,
      // The library label when the session is linked, what was typed
      // otherwise — resolved here so no board surface re-derives it.
      format: formatLabel(session, formatById),
      durationMinutes: resolveDurationMinutes(session, formatById),
      trackId: session.trackId,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      roomId: session.roomId,
      releasedSlot: session.releasedSlot,
      pendingRelease: isPendingRelease(session),
      virtualLinks: session.virtualLinks,
      participants: (schedule.participantsBySession.get(session._id) ?? []).map(
        (participant) => {
          const contact = schedule.contactById.get(participant.eventContactId);
          return {
            participantId: participant._id,
            eventContactId: participant.eventContactId,
            firstName: contact?.firstName ?? "",
            lastName: contact?.lastName ?? "",
            state: participant.state,
            ack: participant.ack,
          };
        },
      ),
      conflicts: schedule.conflicts.get(session._id) ?? [],
    }));

  return {
    event: {
      slug: event.slug,
      name: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timezone: event.timezone,
    },
    rooms: [...rooms]
      .sort((a, b) => a.order - b.order)
      .map((room) => ({
        roomId: room._id,
        name: room.name,
        capacity: room.capacity,
        order: room.order,
      })),
    tracks: [...tracks]
      .sort((a, b) => a.order - b.order)
      .map((track) => ({
        trackId: track._id,
        name: track.name,
        color: track.color,
        order: track.order,
      })),
    sessions,
    agendaItems: schedule.agendaItems.map((item) => ({
      itemId: item._id,
      title: item.title,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      roomId: item.roomId,
      description: item.description,
      conflicts: schedule.conflicts.get(item._id) ?? [],
    })),
  };
}

// ── Drafting: placement, agenda items, virtual links ─────────────────────

/**
 * Place a session on the board, or send it back to the unscheduled tray with
 * `slot === null`. DRAFT ONLY: this never emails anyone and never touches
 * `releasedSlot`, because "schedule placement and edits are internal drafts and
 * never trigger communication merely because an organizer changes the board".
 */
export async function scheduleSession(
  ctx: MutationCtx,
  caller: EventCaller,
  sessionId: Id<"sessions">,
  slot: Slot | null,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const session = await requireSession(ctx, caller.event, sessionId);
  if (session.status !== "planned") {
    throw new ConvexError({
      code: "invalid_status",
      message: "Only a planned session can be scheduled.",
    });
  }

  if (slot === null) {
    if (
      session.startsAt === undefined &&
      session.endsAt === undefined &&
      session.roomId === undefined
    ) {
      return;
    }
    await ctx.db.patch("sessions", sessionId, {
      startsAt: undefined,
      endsAt: undefined,
      roomId: undefined,
    });
    await logAudit(ctx, {
      orgId: caller.org._id,
      eventId: caller.event._id,
      actorUserId: caller.user._id,
      action: "agenda.unschedule",
      targetType: "session",
      targetId: sessionId,
      // A released session dragged back to the tray keeps its releasedSlot:
      // speakers were told something, and only an explicit cancellation
      // (agenda.cancelRelease) may take that back.
      meta: { stillReleased: session.releasedSlot !== undefined },
    });
    return;
  }

  const valid = await validateSlot(ctx, caller.event, slot);
  await ctx.db.patch("sessions", sessionId, {
    startsAt: valid.startsAt,
    endsAt: valid.endsAt,
    roomId: valid.roomId,
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "agenda.place",
    targetType: "session",
    targetId: sessionId,
    meta: {
      startsAt: valid.startsAt,
      endsAt: valid.endsAt,
      roomId: valid.roomId,
    },
  });
}

export type AgendaItemInput = {
  title: string;
  startsAt: number;
  endsAt: number;
  roomId?: Id<"rooms">;
  description?: string;
};

function optionalText(
  value: string | undefined,
  label: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = assertText(value, { label, max, min: 0 });
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Breaks, registration, meals, ceremonies (decision log #7): they share
 * drafting and overlap checks, and bypass speakers, tasks and invitations. */
export async function createAgendaItem(
  ctx: MutationCtx,
  caller: EventCaller,
  input: AgendaItemInput,
): Promise<Id<"agendaItems">> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const title = assertText(input.title, { label: "Title", max: MAX_TITLE });
  const slot = await validateSlot(ctx, caller.event, input);
  const itemId = await ctx.db.insert("agendaItems", {
    eventId: caller.event._id,
    title,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    roomId: slot.roomId,
    description: optionalText(
      input.description,
      "Description",
      MAX_DESCRIPTION,
    ),
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "agenda.itemCreate",
    targetType: "agendaItem",
    targetId: itemId,
    meta: { title },
  });
  return itemId;
}

export async function updateAgendaItem(
  ctx: MutationCtx,
  caller: EventCaller,
  itemId: Id<"agendaItems">,
  // `roomId: null` explicitly CLEARS the room; absent leaves it unchanged.
  patch: Omit<Partial<AgendaItemInput>, "roomId"> & {
    roomId?: Id<"rooms"> | null;
  },
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const item = await ctx.db.get("agendaItems", itemId);
  if (item === null || item.eventId !== caller.event._id) {
    notFound("agenda item", "No such agenda item on this event.");
  }
  const update: {
    title?: string;
    startsAt?: number;
    endsAt?: number;
    roomId?: Id<"rooms">;
    description?: string;
  } = {};
  if (patch.title !== undefined) {
    update.title = assertText(patch.title, { label: "Title", max: MAX_TITLE });
  }
  if (patch.description !== undefined) {
    update.description = optionalText(
      patch.description,
      "Description",
      MAX_DESCRIPTION,
    );
  }
  // Times and room are validated together — a new start with the old end must
  // still be a legal block. `roomId: null` clears the room (stored as
  // undefined); an absent roomId keeps the item's current room.
  const roomChanging = patch.roomId !== undefined;
  if (
    patch.startsAt !== undefined ||
    patch.endsAt !== undefined ||
    roomChanging
  ) {
    const slot = await validateSlot(ctx, caller.event, {
      startsAt: patch.startsAt ?? item.startsAt,
      endsAt: patch.endsAt ?? item.endsAt,
      roomId: roomChanging ? (patch.roomId ?? undefined) : item.roomId,
    });
    update.startsAt = slot.startsAt;
    update.endsAt = slot.endsAt;
    // Present-but-undefined removes the field on patch → an explicit clear.
    update.roomId = slot.roomId;
  }
  await ctx.db.patch("agendaItems", itemId, update);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "agenda.itemUpdate",
    targetType: "agendaItem",
    targetId: itemId,
    meta: { fields: Object.keys(update) },
  });
}

export async function removeAgendaItem(
  ctx: MutationCtx,
  caller: EventCaller,
  itemId: Id<"agendaItems">,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const item = await ctx.db.get("agendaItems", itemId);
  if (item === null || item.eventId !== caller.event._id) {
    notFound("agenda item", "No such agenda item on this event.");
  }
  await ctx.db.delete("agendaItems", itemId);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "agenda.itemRemove",
    targetType: "agendaItem",
    targetId: itemId,
    meta: { title: item.title },
  });
}

export type VirtualLinksInput = {
  attendee?: string;
  backstage?: string;
  host?: string;
};

const URL_RE = /^https?:\/\/\S+$/i;

function optionalUrl(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_URL || !URL_RE.test(trimmed)) {
    throw new ConvexError({
      code: "invalid_url",
      message: `${label} must be a http(s) link.`,
    });
  }
  return trimmed;
}

/**
 * Manually entered virtual/hybrid links with explicit audiences (M6 +
 * decision log #8). StageStack stores them; it provisions nothing. WHO may
 * READ each one is enforced by the queries that expose them: attendee links
 * are publishable, backstage reaches confirmed participants and their primary
 * managers (convex/model/portal.ts), host links never leave the organizer
 * surface (`boardData`).
 *
 * The form submits all three, so an omitted field CLEARS that link.
 */
export async function setVirtualLinks(
  ctx: MutationCtx,
  caller: EventCaller,
  sessionId: Id<"sessions">,
  links: VirtualLinksInput,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  await requireSession(ctx, caller.event, sessionId);
  const next = {
    attendee: optionalUrl(links.attendee, "Attendee link"),
    backstage: optionalUrl(links.backstage, "Backstage link"),
    host: optionalUrl(links.host, "Host link"),
  };
  const empty =
    next.attendee === undefined &&
    next.backstage === undefined &&
    next.host === undefined;
  await ctx.db.patch("sessions", sessionId, {
    virtualLinks: empty ? undefined : next,
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "agenda.setVirtualLinks",
    targetType: "session",
    targetId: sessionId,
    // Never log the URLs themselves: the audit log is broadly readable inside
    // the org and a host link is a privileged credential.
    meta: {
      attendee: next.attendee !== undefined,
      backstage: next.backstage !== undefined,
      host: next.host !== undefined,
    },
  });
}

// ── Release (the one external step) ──────────────────────────────────────

/** Stable per (session, participant): the same UID makes a later REQUEST an
 * update of the existing calendar entry rather than a second one. */
export function slotUid(
  sessionId: Id<"sessions">,
  participantId: Id<"sessionParticipants">,
): string {
  return `session-${sessionId}-${participantId}@stagestack.dev`;
}

/**
 * Next .ics SEQUENCE for this session's UIDs. RFC 5546 requires SEQUENCE to be
 * monotonic per UID: Outlook/Exchange keep a cancelled UID as a tombstone and
 * silently drop any later REQUEST that doesn't exceed the CANCEL's number, so
 * every send — REQUEST or CANCEL, session-wide or per-participant — must draw
 * from (and persist) `sessions.icsSequence`. Gaps are fine; going backwards is
 * not. Rows that predate the counter fall back to releasedSlot.sequence.
 */
function nextIcsSequence(session: Doc<"sessions">): number {
  const last = session.icsSequence ?? session.releasedSlot?.sequence;
  return last === undefined ? 0 : last + 1;
}

function formatMoment(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    // A bad IANA zone must degrade the wording, never break a send.
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

/** Event time, explicitly labelled (M6: "organizer scheduling, emails, and
 * public views use and explicitly label event time"). */
export function describeSlot(
  slot: { startsAt: number; endsAt: number },
  timezone: string,
): string {
  return `${formatMoment(slot.startsAt, timezone)} – ${formatMoment(slot.endsAt, timezone)} (${timezone})`;
}

export type SlotResult = {
  sessionId: Id<"sessions">;
  ok: boolean;
  /** Stable code: "not_found" | "invalid_status" | "not_scheduled" |
   * "conflict" | "unchanged". */
  error?: string;
};

type ReleaseMode = "first" | "reset" | "update" | "resend";

type InviteArgs = {
  event: Doc<"events">;
  session: Doc<"sessions">;
  participant: Doc<"sessionParticipants">;
  contact: Doc<"eventContacts"> | undefined;
  managerUser: Doc<"users"> | null | undefined;
  slot: { startsAt: number; endsAt: number; roomId?: Id<"rooms"> };
  roomName?: string;
  sequence: number;
  method: "REQUEST" | "CANCEL";
  templateKey: string;
  context: Record<string, unknown>;
};

/**
 * Queue one speaker's schedule email WITH its calendar attachment.
 *
 * The .ics rides the same message rather than a second email: the speaker gets
 * one notice they can accept from. It goes through the scheduler because
 * attachments need the raw Resend API (see convex/emails.ts), which is an
 * action — the mutation stays transactional and the network call happens after
 * it commits.
 *
 * Returns false when we have no address at all for this speaker (no own email,
 * no manager) — the release still happens, the organizer sees the count.
 */
async function queueSlotEmail(
  ctx: MutationCtx,
  args: InviteArgs,
): Promise<boolean> {
  const recipient = routeParticipant({
    contact: args.contact,
    managerUser: args.managerUser,
    // Schedule notices and calendar invitations reach the SPEAKER directly
    // (M4/M5 routing rule); the manager is only the fallback address.
    mode: "personal",
  });
  if (recipient === null) return false;

  const event = args.event;
  const when = describeSlot(args.slot, event.timezone);
  const location = args.roomName ?? event.location;
  const link = portalLink(event.slug);
  const rendered = await renderTemplate(ctx, event, args.templateKey, {
    event: { name: event.name, timezone: event.timezone },
    session: { title: args.session.title },
    speaker: {
      firstName: recipient.firstName,
      lastName: recipient.lastName,
      fullName: fullName(args.contact),
    },
    slot: { when, room: args.roomName ?? "" },
    link,
  });

  await ctx.scheduler.runAfter(0, internal.emails.sendCalendarInvite, {
    orgId: event.orgId,
    eventId: event._id,
    contactId: args.contact?.contactId,
    toEmail: recipient.email,
    subject: rendered.subject,
    html: rendered.html,
    kind: args.templateKey,
    replyTo: event.replyTo,
    ics: {
      method: args.method,
      uid: slotUid(args.session._id, args.participant._id),
      sequence: args.sequence,
      startMs: args.slot.startsAt,
      endMs: args.slot.endsAt,
      summary: args.session.title,
      description: `${event.name} — ${when}`,
      ...(location === undefined ? {} : { location }),
      url: link,
      organizerName: event.name,
      organizerEmail: mailFromAddress(),
      attendeeName: fullName(args.contact),
      attendeeEmail: recipient.email,
    },
    context: {
      sessionId: args.session._id,
      participantId: args.participant._id,
      sequence: args.sequence,
      ...args.context,
    },
  });
  return true;
}

async function loadManagers(
  ctx: QueryCtx,
  participants: Array<Doc<"sessionParticipants">>,
): Promise<Map<Id<"users">, Doc<"users"> | null>> {
  const ids = [
    ...new Set(
      participants
        .map((p) => p.managerUserId)
        .filter((id): id is Id<"users"> => id !== undefined),
    ),
  ];
  const docs = await Promise.all(ids.map((id) => ctx.db.get("users", id)));
  return new Map(ids.map((id, i) => [id, docs[i]]));
}

/**
 * Bring only genuinely new accepted-proposal participants onto an already
 * released slot. Existing participants are never reset or re-emailed here;
 * their acknowledgement and calendar history belong to the original release.
 */
export async function inviteAddedParticipants(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    session: Doc<"sessions">;
    participants: Array<Doc<"sessionParticipants">>;
    actorUserId: Id<"users">;
  },
): Promise<void> {
  assertEventActive(args.event);
  if (args.session.eventId !== args.event._id) {
    throw new ConvexError({
      code: "not_found",
      message: "The released session does not belong to this event.",
    });
  }
  const released = args.session.releasedSlot;
  if (released === undefined || args.participants.length === 0) return;

  const seen = new Set<string>();
  const participants: Array<Doc<"sessionParticipants">> = [];
  for (const participant of args.participants) {
    if (
      participant.sessionId !== args.session._id ||
      participant.eventId !== args.event._id
    ) {
      throw new ConvexError({
        code: "not_found",
        message: "A new participant does not belong to the released session.",
      });
    }
    const key = String(participant._id);
    if (seen.has(key)) continue;
    seen.add(key);
    // A pre-existing acknowledgement proves this was not a newly materialized
    // participant. Refuse to touch it even if an upstream caller passes it.
    if (participant.ack !== undefined || !counts(participant)) continue;
    participants.push(participant);
  }
  if (participants.length === 0) return;

  const [managers, rooms] = await Promise.all([
    loadManagers(ctx, participants),
    roomNames(ctx, args.event),
  ]);
  const sequence = nextIcsSequence(args.session);
  const now = Date.now();
  await ctx.db.patch("sessions", args.session._id, { icsSequence: sequence });

  let notified = 0;
  let unreachable = 0;
  for (const participant of participants) {
    const contact = await ctx.db.get(
      "eventContacts",
      participant.eventContactId,
    );
    if (contact === null || contact.eventId !== args.event._id) {
      throw new ConvexError({
        code: "not_found",
        message: "A new participant's event contact no longer exists.",
      });
    }
    await ctx.db.patch("sessionParticipants", participant._id, {
      ack: "awaitingAck",
      ackSetBy: args.actorUserId,
      ackSetAt: now,
    });
    const sent = await queueSlotEmail(ctx, {
      event: args.event,
      session: args.session,
      participant,
      contact,
      managerUser:
        participant.managerUserId === undefined
          ? undefined
          : managers.get(participant.managerUserId),
      slot: released,
      roomName:
        released.roomId === undefined ? undefined : rooms.get(released.roomId),
      sequence,
      method: "REQUEST",
      templateKey: "schedule.released",
      context: { mode: "participant_added" },
    });
    if (sent) notified += 1;
    else unreachable += 1;
  }

  await logAudit(ctx, {
    orgId: args.event.orgId,
    eventId: args.event._id,
    actorUserId: args.actorUserId,
    action: "agenda.participantAddedToReleasedSlot",
    targetType: "session",
    targetId: args.session._id,
    meta: {
      participantIds: participants.map((participant) => participant._id),
      sequence,
      notified,
      unreachable,
    },
  });
}

/** The comms-log kinds queueSlotEmail sends under — nothing else writes them,
 * so they identify a session's invite trail among the event's messages. */
const CALENDAR_KINDS = [
  "schedule.released",
  "schedule.updated",
  "schedule.cancelled",
] as const;
/** Newest-first comms-log rows examined PER KIND when building the calendar
 * trail. A trail buried deeper than this simply isn't resent — bounded read
 * over recovery. */
const MESSAGE_SCAN = 2000;

/** One participant's most recent calendar message. */
type LastCalendarMessage = { kind: string; failed: boolean };

/**
 * Every participant's MOST RECENT calendar message on this event, keyed by
 * session then participant.
 *
 * ONE read per calendar kind for the whole release wave (M5). This used to be
 * a per-session pass over the event's entire `messages` trail, so a 100-session
 * bulk re-release read ~100 × MESSAGE_SCAN docs — the same rows, a hundred
 * times. `by_eventId_and_kind` narrows the read to the calendar trail itself
 * (an event's log is mostly CFP/task/reminder mail) and hoisting it out of the
 * loop makes the cost independent of how many sessions are being released.
 *
 * Deliberately NOT denormalized onto `sessionParticipants`: the delivery
 * status this depends on is written by the Resend webhook
 * (convex/emails.ts → handleEmailEvent patches `messages.deliveryStatus` by
 * resendEmailId), so a copy on the participant would need a second writer in
 * the webhook path and could disagree with the log it was copied from. The
 * comms log stays the single source of truth; only the way we FIND rows in it
 * changed.
 */
async function calendarTrail(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Map<Id<"sessions">, Map<string, LastCalendarMessage>>> {
  const perKind = await Promise.all(
    CALENDAR_KINDS.map((kind) =>
      ctx.db
        .query("messages")
        .withIndex("by_eventId_and_kind", (q) =>
          q.eq("eventId", eventId).eq("kind", kind),
        )
        .order("desc")
        .take(MESSAGE_SCAN),
    ),
  );
  // Newest first across kinds: the first row seen for a participant is their
  // latest calendar message, so later (older) rows are skipped.
  const messages = perKind
    .flat()
    .sort((a, b) => b._creationTime - a._creationTime);

  const trail = new Map<Id<"sessions">, Map<string, LastCalendarMessage>>();
  for (const message of messages) {
    const context: unknown = message.context;
    if (typeof context !== "object" || context === null) continue;
    const { sessionId, participantId } = context as {
      sessionId?: unknown;
      participantId?: unknown;
    };
    if (typeof sessionId !== "string" || typeof participantId !== "string") {
      continue;
    }
    const forSession =
      trail.get(sessionId as Id<"sessions">) ??
      new Map<string, LastCalendarMessage>();
    trail.set(sessionId as Id<"sessions">, forSession);
    if (forSession.has(participantId)) continue;
    forSession.set(participantId, {
      kind: message.kind,
      failed: message.deliveryStatus === "failed",
    });
  }
  return trail;
}

/**
 * Participants whose MOST RECENT calendar message failed to send, mapped to
 * the kind they missed. convex/emails.ts logs every calendar send and patches
 * the row `failed` when the Resend call dies; that row is what lets an
 * unchanged release resend the invite instead of demanding cancel +
 * re-release. Only send failures count — a bounce is a bad address, and a
 * failed CANCEL is skipped because that participant no longer holds an
 * invitation (their ack was cleared when the cancellation went out).
 */
function failedLastInvites(
  trail: Map<Id<"sessions">, Map<string, LastCalendarMessage>>,
  sessionId: Id<"sessions">,
  participants: Array<Doc<"sessionParticipants">>,
): Map<Id<"sessionParticipants">, string> {
  const failed = new Map<Id<"sessionParticipants">, string>();
  const forSession = trail.get(sessionId);
  if (forSession === undefined) return failed;
  for (const participant of participants) {
    const last = forSession.get(participant._id);
    if (last === undefined || !last.failed) continue;
    if (last.kind === "schedule.cancelled") continue;
    failed.set(participant._id, last.kind);
  }
  return failed;
}

async function roomNames(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<Map<Id<"rooms">, string>> {
  // Refuse rather than truncate: a missing room name would send a speaker a
  // calendar invite with no location on it.
  const rooms = await takeAll(
    ctx.db
      .query("rooms")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
    LIBRARY_SCAN,
    "rooms",
  );
  return new Map(rooms.map((room) => [room._id, room.name]));
}

/**
 * THE explicit external step (MILESTONES M6): "an organizer explicitly
 * releases initial slots or later schedule changes to speakers, individually or
 * in a batch; release triggers the speaker notification and calendar
 * invitation/update".
 *
 * Per-id results, like the decision release — one conflicting session must not
 * abort the whole wave.
 *
 * Acknowledgement follows the milestone exactly: the first released slot and
 * any change to its DATE OR START TIME reset every speaker to Awaiting
 * Acknowledgement; a room or end-time change notifies and updates the calendar
 * entry without resetting it.
 *
 * An unchanged slot is normally refused ("unchanged") — EXCEPT for
 * participants whose most recent calendar message failed to send (comms log,
 * convex/emails.ts): those get their missed invite resent at a fresh
 * SEQUENCE, so a failed send doesn't force cancel + re-release.
 *
 * Speaker/room collisions are NON-OVERRIDABLE here — there is deliberately no
 * `force` argument.
 */
export async function releaseSlots(
  ctx: MutationCtx,
  caller: EventCaller,
  sessionIds: Array<Id<"sessions">>,
): Promise<SlotResult[]> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  assertBulkSize(sessionIds);
  const event = caller.event;

  const schedule = await loadSchedule(ctx, event);
  const [managers, rooms] = await Promise.all([
    loadManagers(ctx, schedule.participants),
    roomNames(ctx, event),
  ]);
  const sessionById = new Map(schedule.sessions.map((s) => [s._id, s]));

  const results: SlotResult[] = [];
  const now = Date.now();
  // The event's calendar trail, read at most once per call (see calendarTrail).
  let trail: Map<Id<"sessions">, Map<string, LastCalendarMessage>> | undefined;
  // Deduped: the rows below are read once up front, so releasing the same id
  // twice in one call would re-send against a stale `releasedSlot`.
  for (const sessionId of new Set(sessionIds)) {
    const session = sessionById.get(sessionId);
    if (session === undefined) {
      results.push({ sessionId, ok: false, error: "not_found" });
      continue;
    }
    if (session.status !== "planned") {
      results.push({ sessionId, ok: false, error: "invalid_status" });
      continue;
    }
    if (session.startsAt === undefined || session.endsAt === undefined) {
      results.push({ sessionId, ok: false, error: "not_scheduled" });
      continue;
    }
    if (blockers(schedule.conflicts.get(sessionId) ?? []).length > 0) {
      results.push({ sessionId, ok: false, error: "conflict" });
      continue;
    }

    const slot = {
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      roomId: session.roomId,
    };
    const participants = (
      schedule.participantsBySession.get(sessionId) ?? []
    ).filter(counts);
    const released = session.releasedSlot;
    let mode: ReleaseMode;
    // participant → the kind they missed; only consulted for mode "resend".
    let failedInvites = new Map<Id<"sessionParticipants">, string>();
    if (released === undefined) {
      mode = "first";
    } else if (released.startsAt !== slot.startsAt) {
      mode = "reset";
    } else if (
      released.endsAt !== slot.endsAt ||
      released.roomId !== slot.roomId
    ) {
      mode = "update";
    } else {
      // Read the trail lazily and ONCE: only an unchanged slot needs it, and
      // every unchanged session in this wave shares the same read.
      trail ??= await calendarTrail(ctx, event._id);
      failedInvites = failedLastInvites(trail, sessionId, participants);
      if (failedInvites.size === 0) {
        results.push({ sessionId, ok: false, error: "unchanged" });
        continue;
      }
      mode = "resend";
    }

    const sequence = nextIcsSequence(session);
    if (mode === "resend") {
      // The released placement stands; only the counter moves, so the resent
      // REQUEST can't fall behind a CANCEL already out under this session.
      await ctx.db.patch("sessions", sessionId, { icsSequence: sequence });
    } else {
      await ctx.db.patch("sessions", sessionId, {
        releasedSlot: { ...slot, releasedAt: now, sequence },
        icsSequence: sequence,
      });
    }

    const templateKey =
      mode === "first" ? "schedule.released" : "schedule.updated";
    let notified = 0;
    let unreachable = 0;
    for (const participant of participants) {
      // A resend only reaches the participants whose last invite failed.
      if (mode === "resend" && !failedInvites.has(participant._id)) continue;
      // Room/end-only changes and resends do NOT reset an existing
      // acknowledgement (the speaker may have acknowledged via the portal
      // despite the failed email); a participant who has never seen a slot
      // still starts at awaitingAck.
      if (
        mode === "first" ||
        mode === "reset" ||
        participant.ack === undefined
      ) {
        await ctx.db.patch("sessionParticipants", participant._id, {
          ack: "awaitingAck",
          ackSetBy: caller.user._id,
          ackSetAt: now,
        });
      }
      const sent = await queueSlotEmail(ctx, {
        event,
        session,
        participant,
        contact: schedule.contactById.get(participant.eventContactId),
        managerUser:
          participant.managerUserId === undefined
            ? undefined
            : managers.get(participant.managerUserId),
        slot,
        roomName:
          slot.roomId === undefined ? undefined : rooms.get(slot.roomId),
        sequence,
        method: "REQUEST",
        // A resend re-delivers the exact notice that failed to send.
        templateKey: failedInvites.get(participant._id) ?? templateKey,
        context: { mode },
      });
      if (sent) notified += 1;
      else unreachable += 1;
    }

    await logAudit(ctx, {
      orgId: caller.org._id,
      eventId: event._id,
      actorUserId: caller.user._id,
      action: "agenda.release",
      targetType: "session",
      targetId: sessionId,
      meta: {
        mode,
        sequence,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        roomId: slot.roomId,
        ackReset: mode === "first" || mode === "reset",
        notified,
        unreachable,
      },
    });
    results.push({ sessionId, ok: true });
  }
  return results;
}

/**
 * Take a released slot back: every speaker who holds an invitation gets a
 * METHOD:CANCEL so the entry disappears from their calendar.
 *
 * Called explicitly by an organizer (`agenda.cancelRelease`) and automatically
 * when a distributed session is cancelled by a corrected decision
 * (convex/model/sessions.ts) — MILESTONES M2: "send calendar cancellations if
 * invitations were already distributed".
 *
 * The DRAFT placement survives: cancelling what speakers were told is not the
 * same as clearing the board.
 */
export async function cancelReleasedSlot(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    session: Doc<"sessions">;
    actorUserId: Id<"users">;
    reason: string;
  },
): Promise<number> {
  const released = args.session.releasedSlot;
  if (released === undefined) return 0;

  // Refuse rather than truncate: a participant dropped here keeps a cancelled
  // session on their calendar forever, and nothing would ever retry them.
  const participants = await takeAll(
    ctx.db
      .query("sessionParticipants")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.session._id)),
    PARTICIPANT_SCAN,
    "speakers on one session",
  );
  const managers = await loadManagers(ctx, participants);
  const rooms = await roomNames(ctx, args.event);
  const sequence = nextIcsSequence(args.session);

  let notified = 0;
  for (const participant of participants) {
    // `ack` is set for everyone the release addressed, and cleared when an
    // individual cancellation already went out — so it is exactly the set of
    // people still holding an invitation.
    if (participant.ack === undefined) continue;
    if (participant.state === "withdrawn") continue;
    const contact = await ctx.db.get(
      "eventContacts",
      participant.eventContactId,
    );
    const sent = await queueSlotEmail(ctx, {
      event: args.event,
      session: args.session,
      participant,
      contact: contact ?? undefined,
      managerUser:
        participant.managerUserId === undefined
          ? undefined
          : managers.get(participant.managerUserId),
      slot: released,
      roomName:
        released.roomId === undefined ? undefined : rooms.get(released.roomId),
      sequence,
      method: "CANCEL",
      templateKey: "schedule.cancelled",
      context: { reason: args.reason },
    });
    if (sent) notified += 1;
    await ctx.db.patch("sessionParticipants", participant._id, {
      ack: undefined,
      ackSetBy: undefined,
      ackSetAt: undefined,
    });
  }

  // Clearing releasedSlot is what makes the board honest again ("not
  // released") — but icsSequence stays and keeps counting: Outlook/Exchange
  // keep the cancelled UID as a tombstone at this CANCEL's SEQUENCE and
  // silently drop any later REQUEST that doesn't exceed it (RFC 5546), so a
  // re-release must continue ABOVE the CANCEL, never restart at 0.
  await ctx.db.patch("sessions", args.session._id, {
    releasedSlot: undefined,
    icsSequence: sequence,
  });
  await logAudit(ctx, {
    orgId: args.event.orgId,
    eventId: args.event._id,
    actorUserId: args.actorUserId,
    action: "agenda.cancelRelease",
    targetType: "session",
    targetId: args.session._id,
    meta: { reason: args.reason, sequence, notified },
  });
  return notified;
}

/** Organizer capability form of the above. */
export async function cancelRelease(
  ctx: MutationCtx,
  caller: EventCaller,
  sessionId: Id<"sessions">,
): Promise<number> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const session = await requireSession(ctx, caller.event, sessionId);
  if (session.releasedSlot === undefined) {
    throw new ConvexError({
      code: "invalid_status",
      message: "This session's slot hasn't been released.",
    });
  }
  return await cancelReleasedSlot(ctx, {
    event: caller.event,
    session,
    actorUserId: caller.user._id,
    reason: "unreleased",
  });
}

/**
 * ONE person's calendar entry is cancelled — the session goes ahead.
 *
 * MILESTONES M3: withdrawal "cancels only that person's calendar
 * participation". Called from the portal's withdrawal and from any transition
 * to Declined (convex/model/sessions.ts), so a speaker who drops out never
 * keeps a stale invite.
 */
export async function cancelParticipantSlot(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    participant: Doc<"sessionParticipants">;
    actorUserId: Id<"users">;
    reason: string;
  },
): Promise<boolean> {
  const participant = args.participant;
  // No acknowledgement state means no invitation ever reached them.
  if (participant.ack === undefined) return false;
  const session = await ctx.db.get("sessions", participant.sessionId);
  if (session === null || session.releasedSlot === undefined) return false;

  const [contact, managerUser, rooms] = await Promise.all([
    ctx.db.get("eventContacts", participant.eventContactId),
    participant.managerUserId === undefined
      ? Promise.resolve(null)
      : ctx.db.get("users", participant.managerUserId),
    roomNames(ctx, args.event),
  ]);
  const released = session.releasedSlot;
  const sequence = nextIcsSequence(session);
  // Persisted: without this the next session-wide release would reuse this
  // exact number, and the resent REQUEST would tie the CANCEL instead of
  // exceeding it — Outlook/Exchange would silently drop it.
  await ctx.db.patch("sessions", session._id, { icsSequence: sequence });
  const sent = await queueSlotEmail(ctx, {
    event: args.event,
    session,
    participant,
    contact: contact ?? undefined,
    managerUser,
    slot: released,
    roomName:
      released.roomId === undefined ? undefined : rooms.get(released.roomId),
    sequence,
    method: "CANCEL",
    templateKey: "schedule.cancelled",
    context: { reason: args.reason, participantOnly: true },
  });
  await ctx.db.patch("sessionParticipants", participant._id, {
    ack: undefined,
    ackSetBy: undefined,
    ackSetAt: undefined,
  });
  await logAudit(ctx, {
    orgId: args.event.orgId,
    eventId: args.event._id,
    actorUserId: args.actorUserId,
    action: "agenda.participantCancel",
    targetType: "sessionParticipant",
    targetId: participant._id,
    meta: {
      reason: args.reason,
      sessionId: session._id,
      sequence,
      notified: sent,
    },
  });
  return sent;
}

// ── Acknowledgement ──────────────────────────────────────────────────────

/**
 * Record a schedule acknowledgement (M6). Tracked SEPARATELY from
 * participation: a reported Conflict "flags the speaker and session for
 * organizer action but does not decline participation".
 *
 * Authorization happens in the caller — the claimed speaker or their primary
 * manager (convex/model/portal.ts), or an organizer on their behalf
 * (`organizerSetAck`) — so this function only knows the rules.
 */
export async function setAcknowledgement(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    participant: Doc<"sessionParticipants">;
    actorUserId: Id<"users">;
    response: AckResponse;
  },
): Promise<void> {
  assertEventActive(args.event);
  const participant = args.participant;
  if (participant.state === "withdrawn") {
    throw new ConvexError({
      code: "invalid_state",
      message: "This speaker withdrew; their schedule can't be acknowledged.",
    });
  }
  const session = await ctx.db.get("sessions", participant.sessionId);
  if (session === null || session.releasedSlot === undefined) {
    throw new ConvexError({
      code: "no_released_slot",
      message: "This session's slot hasn't been released yet.",
    });
  }

  // Idempotent: re-asserting the SAME response is a no-op. Without this a
  // repeated `conflict` ack would re-patch, re-audit, and re-email organizers
  // on every call; organizers are notified only on a transition INTO conflict.
  if (participant.ack === args.response) return;

  const now = Date.now();
  await ctx.db.patch("sessionParticipants", participant._id, {
    ack: args.response,
    ackSetBy: args.actorUserId,
    ackSetAt: now,
  });

  const contact = await ctx.db.get("eventContacts", participant.eventContactId);
  await logAudit(ctx, {
    orgId: args.event.orgId,
    eventId: args.event._id,
    actorUserId: args.actorUserId,
    action: "agenda.ack",
    targetType: "sessionParticipant",
    targetId: participant._id,
    meta: {
      response: args.response,
      sessionId: session._id,
      from: participant.ack,
      // True when a manager or organizer answered for the speaker.
      onBehalf: contact?.userId !== args.actorUserId,
    },
  });

  if (args.response === "conflict") {
    // A conflict needs a human, now — readiness turns the session red, and the
    // organizers hear about it separately from the scheduled reminder digest
    // (M5: "send urgent change requests, cancellations, and released schedule
    // changes separately").
    const speakerName = fullName(contact ?? undefined) || "A speaker";
    await notifyOrganizers(ctx, args.event, {
      kind: "schedule.conflictReported",
      subject: `Schedule conflict: ${speakerName} — ${session.title}`,
      html: emailShell(
        [
          `<p><strong>${escapeHtml(speakerName)}</strong> reported a conflict with the released slot for <strong>${escapeHtml(session.title)}</strong> at ${escapeHtml(args.event.name)}.</p>`,
          `<p>${escapeHtml(describeSlot(session.releasedSlot, args.event.timezone))}</p>`,
          `<p>Their participation is unchanged — the session is flagged for you to reschedule or resolve.</p>`,
        ].join("\n"),
      ),
      context: { sessionId: session._id, participantId: participant._id },
    });
  }
}

/** Organizer-side acknowledgement on a speaker's behalf (M6: "the speaker,
 * their primary manager, or an organizer may respond on their behalf, with
 * actor and time audited"). */
export async function organizerSetAck(
  ctx: MutationCtx,
  caller: EventCaller,
  participantId: Id<"sessionParticipants">,
  response: AckResponse,
): Promise<void> {
  requireOrganizer(caller);
  const participant = await ctx.db.get("sessionParticipants", participantId);
  if (participant === null || participant.eventId !== caller.event._id) {
    notFound("participation", "No such participation on this event.");
  }
  await setAcknowledgement(ctx, {
    event: caller.event,
    participant,
    actorUserId: caller.user._id,
    response,
  });
}

// ── Assisted placement (W7: AIA-08; rebuilt in W2) ───────────────────────
//
// ONE planner, two callers. `suggestSchedule` (a query) and `applySchedule`
// (a mutation) both go through `buildPlan`, so the preview an organizer reads
// and the placement the mutation writes cannot be produced by different code.
// The mutation re-runs the planner against current state and refuses anything
// that no longer matches, rather than quietly placing something else.
//
// Every sentence the UI shows about a placement or a leftover is composed
// here and rendered verbatim (the plan's one-explanation-one-producer rule).

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** The board's own droppable lattice — the plan snaps to what a drag can. */
const LATTICE_MS = 15 * MINUTE_MS;
/** Schedulable window per day, from the event's own start time-of-day. */
const WORKING_DAY_MS = 9 * HOUR_MS;
/** Breathing room a speaker gets between two of their own blocks. */
const SPEAKER_GAP_MS = 30 * MINUTE_MS;
/**
 * How many conflict-free candidates the scorer looks at before settling. The
 * walk is earliest-first, so this is "consider the next few legal slots and
 * pick the best one" rather than "take the first hole" — bounded on purpose,
 * because scoring every cell of a multi-day, multi-room grid for every session
 * is quadratic work inside one transaction for a preference, not a rule.
 */
const CANDIDATE_BUDGET = 24;
/** Hard ceiling on cells inspected per session, so a pathological board can
 * still not blow the transaction's CPU budget. */
const MAX_CELLS_PER_SESSION = 4000;

export type UnplacedReasonCode =
  | "outside_event_bounds"
  | "speaker_double_booked"
  | "no_free_room";

export type PlannedPlacement = {
  sessionId: Id<"sessions">;
  title: string;
  startsAt: number;
  endsAt: number;
  roomId?: Id<"rooms">;
  /** The block length the planner resolved (override → format → default). */
  durationMinutes: number;
  /** Rendered reason this slot was chosen. Shown verbatim. */
  why: string;
};

export type UnplacedSession = {
  sessionId: Id<"sessions">;
  title: string;
  reason: UnplacedReasonCode;
  /** Rendered explanation. Shown verbatim. */
  message: string;
};

export type PlacementPlan = {
  placements: PlannedPlacement[];
  unplaced: UnplacedSession[];
  /**
   * Digest of everything the plan was computed from. The apply mutation
   * refuses a plan whose fingerprint no longer matches, which is what makes
   * "review then apply" safe against a second organizer editing the board.
   */
  fingerprint: string;
};

type PlannerInput = {
  event: Doc<"events">;
  sessions: Array<Doc<"sessions">>;
  agendaItems: Array<Doc<"agendaItems">>;
  participantsBySession: Map<Id<"sessions">, Array<Doc<"sessionParticipants">>>;
  rooms: Array<Doc<"rooms">>;
  tracks: Array<Doc<"tracks">>;
  formats: Array<Doc<"formats">>;
};

/** FNV-1a, 32-bit. Not a security hash — a cheap, stable, order-sensitive
 * digest of the planner's inputs. */
function digest(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Deliberately covers only what the plan is COMPUTED from and what the apply
 * WRITES: the event window, room ids and order, format durations, every
 * session's scheduling fields, and the agenda items.
 *
 * Display-only fields are excluded on purpose — titles, room names, track
 * names, format labels. If one of those changed between preview and apply,
 * the placements the mutation writes are byte-identical to the ones the
 * organizer approved; only the words next to them were stale. Refusing that
 * would be a false alarm on a rename, and the plan's own re-derivation is what
 * guarantees the placements themselves are still current.
 */
function fingerprintOf(input: PlannerInput): string {
  const byId = <T extends { _id: string }>(rows: ReadonlyArray<T>): T[] =>
    [...rows].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
  const parts: string[] = [
    `e|${input.event._id}|${input.event.startsAt}|${input.event.endsAt}`,
  ];
  for (const room of byId(input.rooms)) parts.push(`r|${room._id}|${room.order}`);
  for (const format of byId(input.formats)) {
    parts.push(`f|${format._id}|${format.defaultDurationMinutes ?? ""}`);
  }
  for (const session of byId(input.sessions)) {
    const speakers = (input.participantsBySession.get(session._id) ?? [])
      .filter(counts)
      .map((p) => p.eventContactId)
      .sort()
      .join(",");
    parts.push(
      [
        "s",
        session._id,
        session.status,
        session.startsAt ?? "",
        session.endsAt ?? "",
        session.roomId ?? "",
        session.trackId ?? "",
        session.formatId ?? "",
        session.durationMinutes ?? "",
        speakers,
      ].join("|"),
    );
  }
  for (const item of byId(input.agendaItems)) {
    parts.push(
      `i|${item._id}|${item.startsAt}|${item.endsAt}|${item.roomId ?? ""}`,
    );
  }
  return digest(parts.join("\n"));
}

/** Gap between two non-overlapping blocks, in ms. */
function gapBetween(
  a: { startsAt: number; endsAt: number },
  b: { startsAt: number; endsAt: number },
): number {
  return a.endsAt <= b.startsAt ? b.startsAt - a.endsAt : a.startsAt - b.endsAt;
}

type Scored = {
  score: number;
  why: string;
};

/**
 * Preference, not law. Three modest, explainable nudges on top of "earliest
 * legal slot", each worth less than the next slot in the walk only when it
 * genuinely helps:
 *   • a track that already has a home room keeps it, back-to-back if possible;
 *   • a speaker with another block on the board gets 30 minutes either side;
 *   • a same-track overlap (a warning, not a blocker) is avoided when there is
 *     an alternative.
 * Everything else is left to the organizer, who reviews the plan before it is
 * written.
 */
function scoreCandidate(args: {
  candidate: ScheduledThing;
  things: ReadonlyArray<ScheduledThing>;
  conflicts: ReadonlyArray<Conflict>;
  dayIndex: number;
  eventStartsAt: number;
  durationMinutes: number;
  trackName?: string;
  roomName?: string;
}): Scored {
  const { candidate, things, dayIndex, eventStartsAt } = args;
  let score = 0;
  let why: string | null = null;

  // A same-track overlap is legal (warning level) but rarely what anyone
  // wants when a clear slot exists.
  if (args.conflicts.length > 0) score -= 40;

  if (candidate.trackId !== undefined && candidate.roomId !== undefined) {
    const sameTrackRoom = things.filter(
      (thing) =>
        thing.trackId === candidate.trackId &&
        thing.roomId === candidate.roomId,
    );
    const adjacent = sameTrackRoom.find(
      (thing) =>
        thing.endsAt === candidate.startsAt || thing.startsAt === candidate.endsAt,
    );
    if (adjacent !== undefined) {
      score += 30;
      why =
        args.trackName === undefined || args.roomName === undefined
          ? `Runs back-to-back with "${adjacent.title}".`
          : `Runs back-to-back with "${adjacent.title}" — the ${args.trackName} track stays in ${args.roomName}.`;
    } else if (
      sameTrackRoom.some(
        (thing) =>
          Math.floor((thing.startsAt - eventStartsAt) / DAY_MS) === dayIndex,
      )
    ) {
      score += 10;
      if (args.trackName !== undefined && args.roomName !== undefined) {
        why = `Keeps the ${args.trackName} track in ${args.roomName} on the same day.`;
      }
    }
  }

  if (candidate.speakerIds.length > 0) {
    const speakerBlocks = things.filter((thing) =>
      thing.speakerIds.some((id) => candidate.speakerIds.includes(id)),
    );
    const tight = speakerBlocks.some(
      (thing) => gapBetween(thing, candidate) < SPEAKER_GAP_MS,
    );
    if (tight) {
      score -= 20;
    } else if (speakerBlocks.length > 0) {
      score += 15;
      why ??= `Leaves at least 30 minutes around this speaker's other session.`;
    }
  }

  return {
    score,
    why: why ?? `First free ${args.durationMinutes}-minute slot with no conflicts.`,
  };
}

/**
 * The planner. Pure: same inputs, same plan, no reads and no writes — which is
 * what lets the preview query and the apply mutation share it outright.
 *
 * The slot walk is a 15-minute lattice, independent of the block being placed,
 * so a 10-minute lightning talk occupies 10 minutes and the next session can
 * start in the same hour. Block length is the session's own override, else its
 * format's default, else 60 minutes.
 */
export function buildPlan(input: PlannerInput): PlacementPlan {
  const { event } = input;
  const formatById = new Map(input.formats.map((f) => [f._id, f]));
  const trackNameById = new Map(input.tracks.map((t) => [t._id, t.name]));
  const roomNameById = new Map(input.rooms.map((r) => [r._id, r.name]));
  const roomIds: Array<Id<"rooms"> | undefined> =
    input.rooms.length > 0
      ? [...input.rooms].sort((a, b) => a.order - b.order).map((r) => r._id)
      : [undefined];

  const things = toScheduledThings({
    sessions: input.sessions,
    agendaItems: input.agendaItems,
    participantsBySession: input.participantsBySession,
  });

  const unscheduled = input.sessions.filter(
    (s) => s.status === "planned" && s.startsAt === undefined,
  );

  const dayCount = Math.max(
    1,
    Math.ceil((event.endsAt - event.startsAt) / DAY_MS),
  );

  const placements: PlannedPlacement[] = [];
  const unplaced: UnplacedSession[] = [];

  for (const session of unscheduled) {
    const durationMinutes = resolveDurationMinutes(session, formatById);
    const blockMs = durationMinutes * MINUTE_MS;
    const speakerIds = (input.participantsBySession.get(session._id) ?? [])
      .filter(counts)
      .map((p) => p.eventContactId);

    let cellsInspected = 0;
    /** Cells where a block of this length geometrically fits at all. */
    let fittingCells = 0;
    let sawSpeakerBlocker = false;
    let considered = 0;
    let best:
      | { score: number; placement: PlannedPlacement }
      | null = null;

    outer: for (let day = 0; day < dayCount; day += 1) {
      const dayAnchor = event.startsAt + day * DAY_MS;
      for (let step = 0; ; step += 1) {
        const startsAt = dayAnchor + step * LATTICE_MS;
        const endsAt = startsAt + blockMs;
        // Past this day's schedulable window — try the next day.
        if (endsAt > dayAnchor + WORKING_DAY_MS) break;
        // The WHOLE block must sit inside the event, not just its start: a
        // 120-minute session offered the last 60-minute slot would otherwise
        // be written half outside the event's own dates. `startsAt` only ever
        // increases across the walk (a day's anchor is 24h on, its window
        // 9h wide), so the first overrun means every later cell overruns too.
        if (startsAt >= event.endsAt || endsAt > event.endsAt) break outer;
        // Counted only for cells the block actually fits in, which is what
        // makes "no in-bounds cell at all" distinguishable from "every cell
        // was taken" when the leftover reason is chosen.
        fittingCells += 1;
        for (const roomId of roomIds) {
          if (cellsInspected >= MAX_CELLS_PER_SESSION) break outer;
          cellsInspected += 1;
          const candidate: ScheduledThing = {
            type: "session",
            id: session._id,
            title: session.title,
            startsAt,
            endsAt,
            roomId,
            trackId: session.trackId,
            speakerIds,
          };
          const conflicts = candidateConflicts(things, candidate);
          const blocking = blockers(conflicts);
          if (blocking.length > 0) {
            if (blocking.some((c) => c.kind === "speaker")) {
              sawSpeakerBlocker = true;
            }
            continue;
          }
          // A roomless event has no room-clash signal, so a slot is
          // exclusive: skip it when ANY placed block overlaps (otherwise
          // everything stacks onto the first slot).
          if (
            roomId === undefined &&
            things.some((thing) => overlaps(thing, candidate))
          ) {
            continue;
          }
          const scored = scoreCandidate({
            candidate,
            things,
            conflicts,
            dayIndex: day,
            eventStartsAt: event.startsAt,
            durationMinutes,
            trackName:
              session.trackId === undefined
                ? undefined
                : trackNameById.get(session.trackId),
            roomName: roomId === undefined ? undefined : roomNameById.get(roomId),
          });
          // Strictly greater keeps the earliest slot on a tie, so the walk
          // order is still the tiebreak and the plan stays deterministic.
          if (best === null || scored.score > best.score) {
            best = {
              score: scored.score,
              placement: {
                sessionId: session._id,
                title: session.title,
                startsAt,
                endsAt,
                roomId,
                durationMinutes,
                why: scored.why,
              },
            };
          }
          considered += 1;
          if (considered >= CANDIDATE_BUDGET) break outer;
        }
      }
    }

    if (best === null) {
      unplaced.push({
        sessionId: session._id,
        title: session.title,
        ...unplacedReason({
          durationMinutes,
          fittingCells,
          sawSpeakerBlocker,
        }),
      });
      continue;
    }
    placements.push(best.placement);
    things.push({
      type: "session",
      id: session._id,
      title: session.title,
      startsAt: best.placement.startsAt,
      endsAt: best.placement.endsAt,
      roomId: best.placement.roomId,
      trackId: session.trackId,
      speakerIds,
    });
  }

  return { placements, unplaced, fingerprint: fingerprintOf(input) };
}

/** The three things that can go wrong, said plainly. */
function unplacedReason(args: {
  durationMinutes: number;
  fittingCells: number;
  sawSpeakerBlocker: boolean;
}): { reason: UnplacedReasonCode; message: string } {
  if (args.fittingCells === 0) {
    return {
      reason: "outside_event_bounds",
      message: `The event's dates leave no ${args.durationMinutes}-minute window for this session.`,
    };
  }
  if (args.sawSpeakerBlocker) {
    return {
      reason: "speaker_double_booked",
      message: `Every free ${args.durationMinutes}-minute slot collides with a speaker who is already booked elsewhere.`,
    };
  }
  return {
    reason: "no_free_room",
    message: `No room is free for a ${args.durationMinutes}-minute block at any remaining time.`,
  };
}

/**
 * Load EXACTLY what the planner reads. Shared by the preview and the apply.
 *
 * Deliberately not `loadSchedule`: that also fetches every event contact and
 * builds the whole-board conflict map, and the planner needs neither — it
 * scores candidates against `candidateConflicts`, which derives collisions
 * from the overlapping blocks itself. Same `takeAll` refuse policy on every
 * read, because a dropped session is a missed collision either way.
 */
async function plannerInput(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<PlannerInput> {
  const [sessions, agendaItems, participants, rooms, tracks, formats] =
    await Promise.all([
      takeAll(
        ctx.db
          .query("sessions")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        SESSION_SCAN,
        "sessions",
      ),
      takeAll(
        ctx.db
          .query("agendaItems")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        ITEM_SCAN,
        "agenda items",
      ),
      takeAll(
        ctx.db
          .query("sessionParticipants")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        PARTICIPANT_SCAN,
        "speaker participations",
      ),
      takeAll(
        ctx.db
          .query("rooms")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        LIBRARY_SCAN,
        "rooms",
      ),
      takeAll(
        ctx.db
          .query("tracks")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        LIBRARY_SCAN,
        "tracks",
      ),
      loadFormats(ctx, event._id),
    ]);
  return {
    event,
    sessions,
    agendaItems,
    participantsBySession: groupParticipants(participants),
    rooms,
    tracks,
    formats,
  };
}

/** Preview: what "Suggest schedule" would do, written nowhere. */
export async function suggestSchedule(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<PlacementPlan> {
  requireOrganizer(caller);
  return buildPlan(await plannerInput(ctx, caller.event));
}

/** The undo record: exactly what a run wrote, and what was there before. */
export type PlacementRecord = {
  sessionId: Id<"sessions">;
  startsAt: number;
  endsAt: number;
  roomId?: Id<"rooms">;
  previous: {
    startsAt?: number;
    endsAt?: number;
    roomId?: Id<"rooms">;
  };
};

export type ApplyPlanResult = {
  placed: Array<{ sessionId: Id<"sessions">; title: string }>;
  unplaced: UnplacedSession[];
  /** The audit row this run wrote — what `undoPlacement` takes. */
  runId: Id<"auditLog">;
};

function samePlacement(
  a: { startsAt: number; endsAt: number; roomId?: Id<"rooms"> },
  b: { startsAt: number; endsAt: number; roomId?: Id<"rooms"> },
): boolean {
  return (
    a.startsAt === b.startsAt && a.endsAt === b.endsAt && a.roomId === b.roomId
  );
}

function planStale(message: string): never {
  throw new ConvexError({ code: "plan_stale", message });
}

/**
 * Apply exactly one previewed plan.
 *
 * The plan is re-derived from current state first. If the board moved under
 * the organizer — anything the planner reads changed — the write is refused
 * with a message rather than silently placing sessions somewhere the preview
 * never showed. `submitted` is compared against the fresh plan and the FRESH
 * plan is what gets written, so a doctored payload cannot place anything the
 * planner would not.
 */
export async function applySchedule(
  ctx: MutationCtx,
  caller: EventCaller,
  submitted: {
    fingerprint: string;
    placements: Array<{
      sessionId: Id<"sessions">;
      startsAt: number;
      endsAt: number;
      roomId?: Id<"rooms">;
    }>;
  },
): Promise<ApplyPlanResult> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const fresh = buildPlan(await plannerInput(ctx, caller.event));

  const stale =
    "The board changed since this suggestion was made, so it was not applied. Suggest a schedule again to see the current plan.";
  if (fresh.fingerprint !== submitted.fingerprint) planStale(stale);
  if (fresh.placements.length !== submitted.placements.length) planStale(stale);
  for (let i = 0; i < fresh.placements.length; i += 1) {
    const mine = fresh.placements[i];
    const theirs = submitted.placements[i];
    if (mine.sessionId !== theirs.sessionId || !samePlacement(mine, theirs)) {
      planStale(stale);
    }
  }

  const records: PlacementRecord[] = [];
  const placed: ApplyPlanResult["placed"] = [];
  for (const placement of fresh.placements) {
    const session = await ctx.db.get("sessions", placement.sessionId);
    if (session === null || session.eventId !== caller.event._id) {
      planStale(stale);
    }
    records.push({
      sessionId: placement.sessionId,
      startsAt: placement.startsAt,
      endsAt: placement.endsAt,
      roomId: placement.roomId,
      previous: {
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        roomId: session.roomId,
      },
    });
    await ctx.db.patch("sessions", placement.sessionId, {
      startsAt: placement.startsAt,
      endsAt: placement.endsAt,
      roomId: placement.roomId,
    });
    placed.push({ sessionId: placement.sessionId, title: placement.title });
  }

  const runId = await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "agenda.autoPlace",
    targetType: "event",
    targetId: caller.event._id,
    // The placement set is what makes this run undoable — the audit row is
    // the record of what changed, so it carries enough to change it back.
    meta: {
      placed: placed.length,
      unplaced: fresh.unplaced.length,
      placements: records,
    },
  });

  return { placed, unplaced: fresh.unplaced, runId };
}

/**
 * `auditLog.meta` is `v.any()` at rest, so what comes back is untyped data,
 * not a `PlacementRecord[]`. Casting it and indexing straight into a patch
 * would turn a malformed or hand-edited row into a TypeError — or worse, a
 * half-applied undo that patched the well-formed prefix and then threw.
 *
 * So: validate the whole set first, return null on ANYTHING unexpected, and
 * let the caller refuse cleanly. `undefined` (a run recorded before undo
 * existed) is a valid empty set, not a malformed one.
 */
function parsePlacementRecords(
  ctx: MutationCtx,
  meta: unknown,
): PlacementRecord[] | null {
  if (meta === undefined || meta === null) return [];
  if (typeof meta !== "object") return null;
  const raw = (meta as { placements?: unknown }).placements;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;

  const time = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const optionalTime = (value: unknown): number | null | undefined =>
    value === undefined ? undefined : time(value);
  // Ids are validated as ids of the right table, not merely as strings, so a
  // doctored row cannot aim the undo at another table's document.
  const roomId = (value: unknown): Id<"rooms"> | null | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return null;
    return ctx.db.normalizeId("rooms", value);
  };

  const out: PlacementRecord[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.sessionId !== "string") return null;
    const sessionId = ctx.db.normalizeId("sessions", e.sessionId);
    if (sessionId === null) return null;
    const startsAt = time(e.startsAt);
    const endsAt = time(e.endsAt);
    if (startsAt === null || endsAt === null) return null;
    const room = roomId(e.roomId);
    if (room === null) return null;
    if (e.previous !== undefined && typeof e.previous !== "object") return null;
    const previous = (e.previous ?? {}) as Record<string, unknown>;
    if (previous === null) return null;
    const prevStart = optionalTime(previous.startsAt);
    const prevEnd = optionalTime(previous.endsAt);
    if (prevStart === null || prevEnd === null) return null;
    const prevRoom = roomId(previous.roomId);
    if (prevRoom === null) return null;
    out.push({
      sessionId,
      startsAt,
      endsAt,
      roomId: room,
      previous: {
        startsAt: prevStart,
        endsAt: prevEnd,
        roomId: prevRoom,
      },
    });
  }
  // A record naming a session outside this event still can't move anything:
  // the undo loop re-checks `session.eventId` per record before patching.
  return out;
}

export type UndoPlacementResult = {
  reverted: number;
  /** Placements left alone because the session was edited after the run. */
  skipped: number;
  message: string;
};

/**
 * Put back exactly what one assisted-placement run wrote.
 *
 * A session is only reverted while it still holds the values that run gave
 * it: anything an organizer moved by hand afterwards is theirs, and an undo
 * that clobbered a manual edit would be a worse bug than no undo at all.
 */
export async function undoPlacement(
  ctx: MutationCtx,
  caller: EventCaller,
  runId: Id<"auditLog">,
): Promise<UndoPlacementResult> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const row = await ctx.db.get("auditLog", runId);
  if (
    row === null ||
    row.eventId !== caller.event._id ||
    row.action !== "agenda.autoPlace"
  ) {
    notFound("placement run", "No such assisted-placement run on this event.");
  }
  const records = parsePlacementRecords(ctx, row.meta);
  if (records === null) {
    throw new ConvexError({
      code: "not_undoable",
      message:
        "This run's record can't be read back, so nothing was changed. Adjust the placements on the board instead.",
    });
  }
  if (records.length === 0) {
    throw new ConvexError({
      code: "not_undoable",
      message:
        "This run was recorded before placements could be undone, so there is nothing to put back.",
    });
  }

  let reverted = 0;
  let skipped = 0;
  for (const record of records) {
    const session = await ctx.db.get("sessions", record.sessionId);
    if (session === null || session.eventId !== caller.event._id) {
      skipped += 1;
      continue;
    }
    if (
      session.startsAt !== record.startsAt ||
      session.endsAt !== record.endsAt ||
      session.roomId !== record.roomId
    ) {
      skipped += 1;
      continue;
    }
    await ctx.db.patch("sessions", record.sessionId, {
      startsAt: record.previous.startsAt,
      endsAt: record.previous.endsAt,
      roomId: record.previous.roomId,
    });
    reverted += 1;
  }

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "agenda.autoPlace.undo",
    targetType: "event",
    targetId: caller.event._id,
    meta: { runId, reverted, skipped },
  });

  return {
    reverted,
    skipped,
    message:
      skipped === 0
        ? `${reverted} ${reverted === 1 ? "session is" : "sessions are"} back where ${reverted === 1 ? "it" : "they"} started.`
        : `${reverted} ${reverted === 1 ? "session" : "sessions"} put back. ${skipped} left alone — ${skipped === 1 ? "it was" : "they were"} moved by hand after the suggestion was applied.`,
  };
}
