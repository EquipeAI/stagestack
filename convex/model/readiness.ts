import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { requireOrganizer } from "../lib/functions";
import { toScheduledThings } from "./agenda";
import { conflictsFor, type Conflict } from "../shared/agenda";
import { stagedDecisions } from "./controlCenter";
import type { ControlRow } from "./controlCenter";
import { isPublished, publicationFlags } from "./publish";
import { isOpen, isOverdue } from "./tasks";
import { takeAll, takeCapped } from "./validation";

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

// Read ceilings. The dashboard is an ASSERTION about readiness, so each read
// refuses (`takeAll` → `event_too_large`) rather than truncating: a dropped
// task or participant row would report a session as Ready that nobody
// verified, which is worse than an error the organizer can escalate (H5).
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

/**
 * The control center's "what is blocked" counts (W8).
 *
 * They live on the dashboard rather than in a new query on purpose: this pass
 * is ALREADY reading every session, participation and agenda item, and it
 * already refuses rather than truncating — which is the right policy for a
 * blocker count too (a dropped session is a blocker nobody is told about).
 * Adding a second refusing whole-event scan would double the cost to say the
 * same thing.
 */
export type DashboardBlockers = {
  /** Planned sessions whose content is Draft — publication is held back. */
  contentDrafts: number;
  /** Planned sessions with no released slot. */
  unscheduled: number;
  /** Sessions carrying at least one impossible-schedule (blocker) conflict. */
  scheduleConflicts: number;
  /** Sessions whose derived readiness is Blocked. */
  blockedSessions: number;
  /**
   * The control center's "what is blocked" rows, composed HERE (W4: one
   * explanation, one producer). The counts above stay for tests and the
   * badge; the rows are what every surface renders.
   */
  rows: ControlRow[];
};

export type Dashboard = {
  speakers: SpeakerRow[];
  sessions: SessionReadinessRow[];
  totals: DashboardTotals;
  blockers: DashboardBlockers;
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
      takeAll(
        ctx.db
          .query("sessions")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        SESSION_SCAN,
        "sessions",
      ),
      takeAll(
        ctx.db
          .query("sessionParticipants")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        PARTICIPANT_SCAN,
        "speaker participations",
      ),
      takeAll(
        ctx.db
          .query("taskInstances")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        INSTANCE_SCAN,
        "tasks",
      ),
      takeAll(
        ctx.db
          .query("eventContacts")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        CONTACT_SCAN,
        "speaker profiles",
      ),
      takeAll(
        ctx.db
          .query("agendaItems")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        ITEM_SCAN,
        "agenda items",
      ),
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
  // Grouped ONCE, in the pass that is already walking every instance (M6).
  // The per-session rows below used to run `instances.filter(...)` per session,
  // which is sessions × instances comparisons — 8M at the read caps — on every
  // reactive invalidation of a query the whole dashboard subscribes to.
  const instancesBySession = new Map<
    Id<"sessions">,
    Array<Doc<"taskInstances">>
  >();
  let overdueTotal = 0;
  for (const instance of instances) {
    const forSession = instancesBySession.get(instance.sessionId) ?? [];
    forSession.push(instance);
    instancesBySession.set(instance.sessionId, forSession);
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

  const planned = sessions.filter((session) => session.status === "planned");
  const sessionRows: SessionReadinessRow[] = planned.map((session) => ({
    sessionId: session._id,
    title: session.title,
    readiness: sessionReadiness({
      participants: participantsBySession.get(session._id) ?? [],
      instances: instancesBySession.get(session._id) ?? [],
      now,
      conflicts: conflicts.get(session._id) ?? [],
    }),
  }));

  // Same pass, same rows: the blocker counts cannot disagree with the readiness
  // list above them because they are derived from it.
  const contentDrafts = planned.filter(
    (s) => s.contentStatus === "draft",
  ).length;
  const unscheduled = planned.filter(
    (s) => s.releasedSlot === undefined,
  ).length;
  const scheduleConflicts = planned.filter((s) =>
    (conflicts.get(s._id) ?? []).some((c) => c.level === "blocker"),
  ).length;
  const blockers: DashboardBlockers = {
    contentDrafts,
    unscheduled,
    scheduleConflicts,
    blockedSessions: sessionRows.filter(
      (row) => row.readiness.status === "blocked",
    ).length,
    // W4: the sentences the control center prints. Composed here so no route
    // re-words a blocker; `ControlCenter.tsx` renders these verbatim.
    rows: [
      {
        id: "contentDrafts",
        label: "Content still in Draft",
        count: contentDrafts,
        capped: false,
        sentence:
          contentDrafts === 0
            ? "No session is held back by unapproved content."
            : `${contentDrafts} ${contentDrafts === 1 ? "session is" : "sessions are"} held out of the public program until the content is approved.`,
        tone: contentDrafts === 0 ? "success" : "blocked",
        link: { tab: "sessions", search: { content: "draft" } },
      },
      {
        id: "unscheduled",
        label: "Sessions unscheduled",
        count: unscheduled,
        capped: false,
        sentence:
          unscheduled === 0
            ? "Every planned session has a released slot."
            : `${unscheduled} planned ${unscheduled === 1 ? "session has" : "sessions have"} no released slot, so they cannot appear on the public schedule.`,
        tone: unscheduled === 0 ? "success" : "attention",
        link: { tab: "agenda", search: { view: "list" } },
      },
      {
        id: "scheduleConflicts",
        label: "Schedule conflicts",
        count: scheduleConflicts,
        capped: false,
        sentence:
          scheduleConflicts === 0
            ? "No session collides with another."
            : `${scheduleConflicts} ${scheduleConflicts === 1 ? "session is" : "sessions are"} in an impossible schedule state — a room or a speaker is double-booked.`,
        tone: scheduleConflicts === 0 ? "success" : "blocked",
        link: { tab: "agenda", search: { view: "room" } },
      },
    ],
  };

  return { speakers, sessions: sessionRows, totals, blockers };
}

// ─────────────────────────────────────────────────────────────────────────
// Publication vocabulary (W4). ONE PRODUCER.
//
// "Is this session public?" has six moving parts (content approval, the
// per-session publish flag, the public-page/lineup toggle, slot release, the
// agenda toggle, and whether the session is still planned at all), and every
// surface that answered it in TSX answered it slightly differently. From here
// on the answer — the machine code, the rendered sentence and where to go to
// fix it — is composed HERE and rendered verbatim. A surface that re-words
// publication state in TSX is a bug.
//
// Derived, never stored, exactly like the readiness above it: these reasons
// mirror the gates in model/publish.ts `computeProgram` line for line, so they
// cannot disagree with what publishing would actually do.
// ─────────────────────────────────────────────────────────────────────────

/** Repair targets, using the app shell's tab ids
 * (apps/web/src/routes/app.e.$eventSlug.tsx `TAB_PATHS`) as the vocabulary, so
 * a UI can deep-link a blocker without inventing routes. */
export type PublicationTab = "sessions" | "agenda" | "publish";

/**
 * The session WORKSPACE tab a per-session repair is actually made on (W10).
 *
 * W9 shipped the workspace (`…/sessions/$id?tab=…`) after this vocabulary was
 * written, so a session-scoped repair could only say "go to Sessions" and hand
 * over an id with nowhere to put it. It now names the destination properly, and
 * it names only destinations that can REPAIR the blocker: content approval
 * lives on the content tab, so `content_draft` points there. A cancelled
 * session's status is on the overview tab. `slot_not_released` deliberately
 * keeps pointing at the agenda board — the workspace's schedule tab reports the
 * placement, it does not make it — and the two publish-toggle codes keep
 * pointing at the publish center, which is where their switches are.
 */
export type SessionWorkspaceTab = "overview" | "content";

export type PublicationReasonCode =
  /** Cancelled sessions never reach public output. */
  | "session_cancelled"
  /** Content approval (W5/CNT-12) holds the session back. */
  | "content_draft"
  /** The per-session publish toggle is off (defaults off). */
  | "session_not_published"
  /** The public event page — which gates the whole lineup — is off. */
  | "lineup_not_published"
  /** No released slot, so nothing to place on the public agenda. */
  | "slot_not_released"
  /** The schedule as a whole has not been published. */
  | "agenda_not_published";

export type PublicationReason = {
  code: PublicationReasonCode;
  /**
   * Which public surface this blocks. The two publish INDEPENDENTLY (decision
   * log #13), and `computeProgram` proves it: turning the public page off
   * empties the lineup while a released session stays in a published agenda.
   * So "the public page is off" blocks the lineup ONLY — anything else here
   * would be a sentence that disagrees with what publishing does.
   */
  blocks: "both" | "lineup" | "agenda";
  /** Rendered here, printed verbatim by every surface. */
  sentence: string;
  repair: {
    tab: PublicationTab;
    params?: { sessionId?: Id<"sessions"> };
    /** Present only with a `sessionId`: the workspace tab that repairs it. */
    sessionTab?: SessionWorkspaceTab;
  };
};

export type Publication = {
  /** In the lineup a publish would serve right now. */
  inLineup: boolean;
  /** In the agenda a publish would serve right now. */
  inAgenda: boolean;
  /** What the public speaker line would say — mirrors `computeProgram`. */
  toBeAnnounced: boolean;
  /** Blocking reasons, dependency order. Empty ⇒ fully public. */
  reasons: PublicationReason[];
  /** The one-line summary surfaces print. Composed from the same reasons. */
  summary: string;
};

/** Each code's clause, in mid-sentence form. The standalone `sentence` is this
 * capitalized — one string per code, never two that can drift. */
const CLAUSE: Record<PublicationReasonCode, string> = {
  session_cancelled: "the session is cancelled",
  content_draft: "content is Draft",
  session_not_published: "its publish toggle is off",
  lineup_not_published: "the public page is off",
  slot_not_released: "the slot has not been released",
  agenda_not_published: "the schedule is not published",
};

const BLOCKS: Record<PublicationReasonCode, "both" | "lineup" | "agenda"> = {
  session_cancelled: "both",
  content_draft: "both",
  session_not_published: "both",
  lineup_not_published: "lineup",
  slot_not_released: "agenda",
  agenda_not_published: "agenda",
};

/** Where an organizer goes to clear the blocker. Session-scoped repairs carry
 * the id so the target can open on the right row. */
const REPAIR: Record<PublicationReasonCode, PublicationTab> = {
  session_cancelled: "sessions",
  content_draft: "sessions",
  session_not_published: "publish",
  lineup_not_published: "publish",
  slot_not_released: "agenda",
  agenda_not_published: "publish",
};

/** Codes whose repair concerns one session rather than the whole event. */
const PER_SESSION: ReadonlySet<PublicationReasonCode> = new Set([
  "session_cancelled",
  "content_draft",
  "session_not_published",
  "slot_not_released",
]);

/** Of those, the ones the session workspace itself can repair, and where. */
const WORKSPACE_TAB: Partial<
  Record<PublicationReasonCode, SessionWorkspaceTab>
> = {
  session_cancelled: "overview",
  content_draft: "content",
};

function capitalize(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

function reasonFor(
  code: PublicationReasonCode,
  sessionId: Id<"sessions">,
): PublicationReason {
  return {
    code,
    blocks: BLOCKS[code],
    sentence: `${capitalize(CLAUSE[code])}.`,
    repair: {
      tab: REPAIR[code],
      ...(PER_SESSION.has(code) ? { params: { sessionId } } : {}),
      ...(WORKSPACE_TAB[code] === undefined
        ? {}
        : { sessionTab: WORKSPACE_TAB[code] }),
    },
  };
}

function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? "";
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

/** The rows a publication answer depends on, read by the caller — same shape
 * whether it comes from a per-page scan or the capped counts query. */
export type PublicationDeps = {
  /** `event.publicPageEnabled === true` — the lineup gate. */
  lineupPublished: boolean;
  /** The `agenda:event` publication flag. */
  agendaPublished: boolean;
  /** This session's `session:<id>` publication flag (defaults false). */
  sessionPublished: boolean;
  /** This session's participations, for the to-be-announced line. */
  participants: ReadonlyArray<Pick<Doc<"sessionParticipants">, "state">>;
};

/**
 * Why this session is not fully public, in dependency order.
 *
 * Mirrors `computeProgram` exactly: a session enters the lineup when it is
 * planned, its content is not Draft, its own flag is on and the public page is
 * enabled; it additionally enters the agenda when it has a released slot and
 * the schedule is published. Empty ⇒ a publish would serve it in both.
 *
 * Speaker confirmation is deliberately NOT a blocker: publish.ts serves a
 * session with no confirmed speaker as "speaker to be announced". It shows up
 * in `toBeAnnounced` and in the summary's ready clause instead, so this list
 * can never claim a session is held back when publishing would serve it.
 */
export function whyNotPublic(
  session: Doc<"sessions">,
  deps: PublicationDeps,
): PublicationReason[] {
  const reasons: PublicationReason[] = [];
  const push = (code: PublicationReasonCode) =>
    reasons.push(reasonFor(code, session._id));

  if (session.status !== "planned") push("session_cancelled");
  // Legacy rows carry no contentStatus; they were always served, so absence
  // reads as approved (same fallback as computeProgram and the sessions table).
  if (session.contentStatus === "draft") push("content_draft");
  if (!deps.sessionPublished) push("session_not_published");
  if (!deps.lineupPublished) push("lineup_not_published");

  if (session.releasedSlot === undefined) push("slot_not_released");
  if (!deps.agendaPublished) push("agenda_not_published");

  return reasons;
}

/** The all-clear summary. Exported so tests and surfaces name the same string. */
export const PUBLIC_EVERYWHERE_SUMMARY = "Public in lineup and agenda.";

/**
 * One session's publication state, reasons and rendered summary.
 *
 * The summary has exactly four shapes, because lineup and agenda publish
 * independently:
 *   • nowhere public — "Not public: <blockers>." plus what IS ready;
 *   • lineup only — "Public in lineup, not agenda: … but <blockers>.";
 *   • agenda only — "Public in agenda, not lineup: <blockers>." (a released
 *     session stays in a published schedule while the public page is off);
 *   • fully public — the all-clear, plus the to-be-announced note when that is
 *     what the public page would actually print.
 */
export function publicationState(
  session: Doc<"sessions">,
  deps: PublicationDeps,
): Publication {
  const reasons = whyNotPublic(session, deps);
  const blocking = (surface: "lineup" | "agenda") =>
    reasons.filter((r) => r.blocks === "both" || r.blocks === surface);
  const lineupBlockers = blocking("lineup");
  const agendaBlockers = blocking("agenda");
  const inLineup = lineupBlockers.length === 0;
  const inAgenda = agendaBlockers.length === 0;

  const confirmed = deps.participants.filter(
    (p) => p.state === "confirmed",
  ).length;
  // Byte-identical to computeProgram's rule, so the badge and the public page
  // agree about who is named.
  const toBeAnnounced =
    confirmed === 0 || deps.participants.some((p) => p.state === "awaiting");

  const clauses = (list: PublicationReason[]) =>
    joinClauses(list.map((r) => CLAUSE[r.code]));

  let summary: string;
  if (!inLineup && !inAgenda) {
    // Name what is already done: "content is Draft" alone reads as if nothing
    // else were ready, and the organizer then re-checks work that is finished.
    const speakerReady = confirmed > 0;
    const scheduleReady = session.releasedSlot !== undefined;
    const ready =
      speakerReady && scheduleReady
        ? " Speaker and schedule are ready."
        : speakerReady
          ? " Speaker is ready."
          : scheduleReady
            ? " Schedule is ready."
            : "";
    // Shared blockers first and ALONE when present: while content is Draft,
    // "and the slot has not been released" is noise the organizer cannot act
    // on usefully yet. Only when nothing shared remains do the per-surface
    // blockers become the story.
    const shared = reasons.filter((r) => r.blocks === "both");
    summary = `Not public: ${clauses(shared.length > 0 ? shared : reasons)}.${ready}`;
  } else if (!inAgenda) {
    summary =
      "Public in lineup, not agenda: its session is approved and lineup-enabled, but " +
      `${clauses(agendaBlockers)}.`;
  } else if (!inLineup) {
    summary = `Public in agenda, not lineup: ${clauses(lineupBlockers)}.`;
  } else {
    summary = toBeAnnounced
      ? `${PUBLIC_EVERYWHERE_SUMMARY} Speakers are shown as to be announced until they confirm.`
      : PUBLIC_EVERYWHERE_SUMMARY;
  }

  return { inLineup, inAgenda, toBeAnnounced, reasons, summary };
}

export type SessionPublicationRow = {
  sessionId: Id<"sessions">;
  title: string;
  publication: Publication;
};

/**
 * Every session's publication state for one event — what the sessions table and
 * the publish console render.
 *
 * Reads with `takeAll` (refuse, never truncate) for the same reason
 * model/publish.ts does: this is an ASSERTION about what the public can see,
 * and a dropped row would report a session as public that nobody checked. The
 * cheap, truncating version is `attentionCounts` below.
 */
export async function publicationBoard(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<SessionPublicationRow[]> {
  requireOrganizer(caller);
  const eventId = caller.event._id;
  const [sessions, participants, flags] = await Promise.all([
    takeAll(
      ctx.db
        .query("sessions")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      SESSION_SCAN,
      "sessions",
    ),
    takeAll(
      ctx.db
        .query("sessionParticipants")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      PARTICIPANT_SCAN,
      "speaker participations",
    ),
    publicationFlags(ctx, eventId),
  ]);
  const participantsBySession = new Map<
    Id<"sessions">,
    Array<Doc<"sessionParticipants">>
  >();
  for (const participant of participants) {
    const list = participantsBySession.get(participant.sessionId) ?? [];
    list.push(participant);
    participantsBySession.set(participant.sessionId, list);
  }
  const lineupPublished = caller.event.publicPageEnabled === true;
  const agendaPublished = isPublished(flags, "agenda", "event", false);

  return sessions.map((session) => ({
    sessionId: session._id,
    title: session.title,
    publication: publicationState(session, {
      lineupPublished,
      agendaPublished,
      sessionPublished: isPublished(flags, "session", session._id, false),
      participants: participantsBySession.get(session._id) ?? [],
    }),
  }));
}

// ── Nav-rail attention counts (W4, consumed by W7) ───────────────────────
//
// COST. One indexed range read per table, no `get` per row, no N+1, and every
// read is `takeCapped` — this query is subscribed from the shell on every page,
// so it TRUNCATES and reports `capped` rather than throwing `event_too_large`
// and taking the whole navigation down with it. Worst case it reads
// 500 sessions + 1000 participations + 2000 task instances + 500 pending
// proposals + 500 of the caller's reviews + 1000 publication flags = 5500
// documents; a normal event is a small fraction of that. It takes NO `now`
// argument, so nothing here ticks and the subscription stays cache-friendly:
// overdue tasks are a subset of the open ones already counted.

const COUNT_SESSION_SCAN = 500;
const COUNT_PARTICIPANT_SCAN = 1000;
const COUNT_INSTANCE_SCAN = 2000;
const COUNT_PROPOSAL_SCAN = 500;
const COUNT_REVIEW_SCAN = 500;
const COUNT_FLAG_SCAN = 1000;

/** Per-tab counts, keyed by the shell's tab ids. */
export type AttentionCounts = {
  /** Proposals waiting for a decision. */
  proposals: number;
  /**
   * Decisions staged but not released (W8). Additive: the Decisions nav entry
   * is a saved view of Proposals, and until now it was the one lifecycle step
   * with no badge, so a staged queue nobody released was invisible from the
   * rail. Shares `stagedDecisions` with the control center's own row.
   */
  decisions: number;
  /** Reviews assigned to YOU that are not submitted yet. */
  reviews: number;
  /** Sessions whose next publication blocker is fixed on the Sessions tab. */
  sessions: number;
  /** Speakers who have not answered their invitation. */
  speakers: number;
  /** Sessions whose next publication blocker is fixed on the Agenda tab. */
  agenda: number;
  /** Open speaker tasks. */
  tasks: number;
  /** Sessions whose next publication blocker is a publish toggle. */
  publish: number;
};

export type Attention = {
  counts: AttentionCounts;
  /** True when any read hit its ceiling: the numbers are floors, not totals. */
  capped: boolean;
};

/**
 * Cheap per-module counts for the navigation rail.
 *
 * The three publication counts are derived from `whyNotPublic` — the SAME
 * producer as the summary sentences — by charging each session to the repair
 * tab of its FIRST unresolved blocker. One session is therefore counted once,
 * against the next thing that would actually move it forward, and the badge can
 * never disagree with the sentence the session's row prints.
 */
export async function attentionCounts(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<Attention> {
  requireOrganizer(caller);
  const eventId = caller.event._id;
  const [sessions, participants, instances, proposals, staged, reviews, flags] =
    await Promise.all([
      takeCapped(
        ctx.db
          .query("sessions")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        COUNT_SESSION_SCAN,
      ),
      takeCapped(
        ctx.db
          .query("sessionParticipants")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        COUNT_PARTICIPANT_SCAN,
      ),
      takeCapped(
        ctx.db
          .query("taskInstances")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        COUNT_INSTANCE_SCAN,
      ),
      // Indexed on the status itself: the rail never scans decided proposals.
      takeCapped(
        ctx.db
          .query("proposals")
          .withIndex("by_eventId_and_status", (q) =>
            q.eq("eventId", eventId).eq("status", "pending"),
          ),
        COUNT_PROPOSAL_SCAN,
      ),
      // Two more indexed range reads, not a scan: the staged queues are their
      // own status values, so this costs what it counts.
      stagedDecisions(ctx, eventId),
      // The caller's OWN queue — organizers review too, and an event-wide
      // review count would be somebody else's work in your badge.
      takeCapped(
        ctx.db
          .query("reviews")
          .withIndex("by_eventId_and_reviewerUserId", (q) =>
            q.eq("eventId", eventId).eq("reviewerUserId", caller.user._id),
          ),
        COUNT_REVIEW_SCAN,
      ),
      takeCapped(
        ctx.db
          .query("publicationFlags")
          .withIndex("by_eventId_and_target", (q) => q.eq("eventId", eventId)),
        COUNT_FLAG_SCAN,
      ),
    ]);

  const flagMap = new Map<string, boolean>();
  for (const f of flags.rows) {
    flagMap.set(`${f.targetType}:${f.targetId}`, f.published);
  }
  const participantsBySession = new Map<
    Id<"sessions">,
    Array<Doc<"sessionParticipants">>
  >();
  let awaitingSpeakers = 0;
  for (const participant of participants.rows) {
    const list = participantsBySession.get(participant.sessionId) ?? [];
    list.push(participant);
    participantsBySession.set(participant.sessionId, list);
    if (participant.state === "awaiting") awaitingSpeakers += 1;
  }

  const lineupPublished = caller.event.publicPageEnabled === true;
  const agendaPublished = isPublished(flagMap, "agenda", "event", false);
  const counts: AttentionCounts = {
    proposals: proposals.rows.length,
    decisions: staged.count,
    reviews: reviews.rows.filter(
      (r) => r.status === "assigned" || r.status === "draft",
    ).length,
    sessions: 0,
    speakers: awaitingSpeakers,
    agenda: 0,
    tasks: instances.rows.filter(isOpen).length,
    publish: 0,
  };
  for (const session of sessions.rows) {
    // A cancelled session is not work in progress; it is off the board.
    if (session.status !== "planned") continue;
    const [next] = whyNotPublic(session, {
      lineupPublished,
      agendaPublished,
      sessionPublished: isPublished(flagMap, "session", session._id, false),
      participants: participantsBySession.get(session._id) ?? [],
    });
    if (next === undefined) continue;
    counts[next.repair.tab] += 1;
  }

  return {
    counts,
    capped:
      sessions.capped ||
      participants.capped ||
      instances.capped ||
      proposals.capped ||
      staged.capped ||
      reviews.capped ||
      flags.capped,
  };
}
