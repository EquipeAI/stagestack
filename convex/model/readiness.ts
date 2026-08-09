import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { requireOrganizer } from "../lib/functions";
import { conflictsFor, toScheduledThings, type Conflict } from "./agenda";
import { isOpen, isOverdue } from "./tasks";

// ─────────────────────────────────────────────────────────────────────────
// Readiness & the speaker-tracking dashboard (M4).
//
// Readiness is DERIVED, never stored: "derive session readiness rather than
// allowing a manual status ... always expose the contributing reasons". There
// is no readiness column anywhere in the schema, so there is nothing to drift.
//
// Everything here is a QUERY, so nothing reads the wall clock (Convex
// guidelines: a query is not re-run merely because time advanced). `now` comes
// in as an argument and the client refreshes it — that is what makes "overdue"
// reactive instead of quietly stale.
// ─────────────────────────────────────────────────────────────────────────

const SESSION_SCAN = 1000;
const PARTICIPANT_SCAN = 5000;
const INSTANCE_SCAN = 8000;
const CONTACT_SCAN = 2000;
const ITEM_SCAN = 1000;

export type ReadinessStatus = "ready" | "needsAttention" | "blocked";

export type Readiness = {
  status: ReadinessStatus;
  /** Human-readable contributing reasons, blocking ones first. Empty only
   * when the session is Ready. */
  reasons: string[];
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Derive one session's readiness from the rows that describe it. Pure: the
 * caller does the reading, which keeps the dashboard to a single bounded pass
 * over the event.
 *
 * Blocked = an unresolved withdrawal still sitting on the session, nobody left
 * to present, a speaker who reported a schedule conflict, or an impossible
 * schedule collision. Needs Attention = outstanding/overdue work, an unanswered
 * participation, or an unacknowledged slot. Ready = everyone confirmed and
 * every obligation settled.
 */
export function sessionReadiness(args: {
  participants: Array<Doc<"sessionParticipants">>;
  instances: Array<Doc<"taskInstances">>;
  now: number;
  /** Derived room/speaker/track collisions for this session (M6). */
  conflicts?: ReadonlyArray<Conflict>;
}): Readiness {
  const { participants, instances, now } = args;
  const conflicts = args.conflicts ?? [];
  const blocking: string[] = [];
  const attention: string[] = [];

  const withdrawn = participants.filter((p) => p.state === "withdrawn");
  const active = participants.filter((p) => p.state !== "withdrawn");
  if (withdrawn.length > 0) {
    blocking.push(
      `${withdrawn.length} ${plural(withdrawn.length, "speaker has", "speakers have")} withdrawn and not been replaced.`,
    );
  }
  if (active.length === 0) {
    blocking.push("No speaker is attached to this session.");
  }

  const awaiting = active.filter((p) => p.state === "awaiting").length;
  if (awaiting > 0) {
    attention.push(
      `${awaiting} ${plural(awaiting, "speaker has", "speakers have")} not answered their invitation.`,
    );
  }
  const declined = active.filter((p) => p.state === "declined").length;
  if (declined > 0) {
    attention.push(
      `${declined} ${plural(declined, "speaker has", "speakers have")} declined.`,
    );
  }

  // ── Schedule (M6) ──
  // A reported conflict blocks only this session and never touches the
  // speaker's participation; Awaiting Acknowledgement warns but does not block.
  const reported = active.filter((p) => p.ack === "conflict").length;
  if (reported > 0) {
    blocking.push(
      `${reported} ${plural(reported, "speaker has", "speakers have")} reported a schedule conflict.`,
    );
  }
  const awaitingAck = active.filter((p) => p.ack === "awaitingAck").length;
  if (awaitingAck > 0) {
    attention.push(
      `${awaitingAck} ${plural(awaitingAck, "speaker has", "speakers have")} not acknowledged their slot.`,
    );
  }
  // Speaker/room collisions are impossible schedule states, not preferences.
  for (const conflict of conflicts) {
    if (conflict.level === "blocker") blocking.push(conflict.message);
    else attention.push(conflict.message);
  }

  const open = instances.filter(isOpen);
  const changes = open.filter((i) => i.status === "changesRequested").length;
  const review = open.filter((i) => i.status === "provided").length;
  const overdue = instances.filter((i) => isOverdue(i, now)).length;
  if (open.length > 0) {
    attention.push(
      `${open.length} ${plural(open.length, "task is", "tasks are")} outstanding.`,
    );
  }
  if (review > 0) {
    attention.push(
      `${review} ${plural(review, "task is", "tasks are")} awaiting review.`,
    );
  }
  if (changes > 0) {
    attention.push(
      `${changes} ${plural(changes, "task needs", "tasks need")} changes.`,
    );
  }
  if (overdue > 0) {
    attention.push(
      `${overdue} ${plural(overdue, "task is", "tasks are")} overdue.`,
    );
  }

  if (blocking.length > 0) {
    return { status: "blocked", reasons: [...blocking, ...attention] };
  }
  if (attention.length > 0) {
    return { status: "needsAttention", reasons: attention };
  }
  return { status: "ready", reasons: [] };
}

// ── Speaker-tracking dashboard ───────────────────────────────────────────

export type SpeakerRow = {
  eventContactId: Id<"eventContacts">;
  name: string;
  /** Aggregate across this speaker's participations (see `rollUpState`). */
  state: Doc<"sessionParticipants">["state"];
  /** True once they've claimed their portal access. */
  claimed: boolean;
  missingBio: boolean;
  missingHeadshot: boolean;
  outstandingTasks: number;
  overdueTasks: number;
};

export type SessionReadinessRow = {
  sessionId: Id<"sessions">;
  title: string;
  readiness: Readiness;
};

export type DashboardTotals = {
  confirmed: number;
  awaiting: number;
  declined: number;
  withdrawn: number;
  acceptedSpeakers: number;
  /** Speakers missing a bio or a headshot — MILESTONES' "2 accepted speakers
   * are missing a bio or headshot" made a single number. */
  missingProfile: number;
  overdue: number;
};

export type Dashboard = {
  speakers: SpeakerRow[];
  sessions: SessionReadinessRow[];
  totals: DashboardTotals;
};

/** A speaker on several sessions has several states. The most engaged one
 * wins, so one confirmation isn't hidden behind an unanswered second invite —
 * the per-session readiness still surfaces that separately. */
function rollUpState(
  states: Array<Doc<"sessionParticipants">["state"]>,
): Doc<"sessionParticipants">["state"] {
  if (states.includes("confirmed")) return "confirmed";
  if (states.includes("awaiting")) return "awaiting";
  if (states.includes("declined")) return "declined";
  return "withdrawn";
}

export async function dashboard(
  ctx: QueryCtx,
  caller: EventCaller,
  now: number,
): Promise<Dashboard> {
  requireOrganizer(caller);
  const eventId = caller.event._id;
  const [sessions, participants, instances, contacts, agendaItems] =
    await Promise.all([
      ctx.db
        .query("sessions")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .take(SESSION_SCAN),
      ctx.db
        .query("sessionParticipants")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .take(PARTICIPANT_SCAN),
      ctx.db
        .query("taskInstances")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .take(INSTANCE_SCAN),
      ctx.db
        .query("eventContacts")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .take(CONTACT_SCAN),
      ctx.db
        .query("agendaItems")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .take(ITEM_SCAN),
    ]);
  const contactById = new Map(contacts.map((c) => [c._id, c]));

  // ── Per speaker ──
  const statesByContact = new Map<
    Id<"eventContacts">,
    Array<Doc<"sessionParticipants">["state"]>
  >();
  for (const participant of participants) {
    const list = statesByContact.get(participant.eventContactId) ?? [];
    list.push(participant.state);
    statesByContact.set(participant.eventContactId, list);
  }

  const openByContact = new Map<Id<"eventContacts">, number>();
  const overdueByContact = new Map<Id<"eventContacts">, number>();
  let overdueTotal = 0;
  for (const instance of instances) {
    if (isOverdue(instance, now)) overdueTotal += 1;
    const contactId = instance.eventContactId;
    if (contactId === undefined) continue;
    if (isOpen(instance)) {
      openByContact.set(contactId, (openByContact.get(contactId) ?? 0) + 1);
    }
    if (isOverdue(instance, now)) {
      overdueByContact.set(
        contactId,
        (overdueByContact.get(contactId) ?? 0) + 1,
      );
    }
  }

  const speakers: SpeakerRow[] = [];
  const totals: DashboardTotals = {
    confirmed: 0,
    awaiting: 0,
    declined: 0,
    withdrawn: 0,
    acceptedSpeakers: 0,
    missingProfile: 0,
    overdue: overdueTotal,
  };
  for (const [eventContactId, states] of statesByContact) {
    const contact = contactById.get(eventContactId);
    if (contact === undefined) continue;
    const state = rollUpState(states);
    const missingBio =
      contact.bio === undefined || contact.bio.trim().length === 0;
    const missingHeadshot = contact.headshotId === undefined;
    speakers.push({
      eventContactId,
      name: `${contact.firstName} ${contact.lastName}`.trim(),
      state,
      claimed: contact.userId !== undefined,
      missingBio,
      missingHeadshot,
      outstandingTasks: openByContact.get(eventContactId) ?? 0,
      overdueTasks: overdueByContact.get(eventContactId) ?? 0,
    });
    totals[state] += 1;
    totals.acceptedSpeakers += 1;
    if (missingBio || missingHeadshot) totals.missingProfile += 1;
  }
  speakers.sort((a, b) => a.name.localeCompare(b.name));

  // ── Per session ──
  // Schedule collisions are derived from the same pure function the agenda
  // board uses (M6), so "Blocked — impossible schedule collision" and the red
  // card on the board can never disagree.
  const participantsBySession = new Map<
    Id<"sessions">,
    Array<Doc<"sessionParticipants">>
  >();
  for (const participant of participants) {
    const list = participantsBySession.get(participant.sessionId) ?? [];
    list.push(participant);
    participantsBySession.set(participant.sessionId, list);
  }
  const conflicts = conflictsFor(
    toScheduledThings({ sessions, agendaItems, participantsBySession }),
  );

  const sessionRows: SessionReadinessRow[] = sessions
    .filter((session) => session.status === "planned")
    .map((session) => ({
      sessionId: session._id,
      title: session.title,
      readiness: sessionReadiness({
        participants: participantsBySession.get(session._id) ?? [],
        instances: instances.filter((i) => i.sessionId === session._id),
        now,
        conflicts: conflicts.get(session._id) ?? [],
      }),
    }));

  return { speakers, sessions: sessionRows, totals };
}
