import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { requireOrganizer } from "../lib/functions";
import { amount, plural } from "./controlCenter";
import { takeCapped } from "./validation";

// ─────────────────────────────────────────────────────────────────────────
// Turnaround analytics (W4). FOUR INTERVALS, DERIVED ON READ, NEVER STORED.
//
// This whole module is a READ over rows other capabilities already wrote.
// There is no new write path, no new table, no schema change — which is what
// makes it safe to ship in a week, and what keeps the numbers honest: nothing
// here can drift from the audit trail, because the audit trail IS the source.
//
// The intervals and the rows that anchor them:
//
//   decision      cfp.submit                 → decision.release      (proposal)
//   confirmation  decision.release           → participation.setState confirmed
//   task          taskInstance creation      → task.markProvided / upload /
//                                              approve               (instance)
//   publish       sessions.setContentStatus  → publish.session       (session)
//                 (to "approved")
//
// Two of those needed a DOCUMENT timestamp because the audit trail alone
// cannot answer, and both fallbacks are named at their call site below:
//   • task instances are GENERATED, not commanded, so no audit row records the
//     assignment — `_creationTime` is the assignment moment.
//   • a BULK publish writes one event-wide audit row without session ids
//     (convex/model/publishBulk.ts), so a session published that way has no
//     per-session row — its `publicationFlags.updatedAt` is the publish moment.
//
// HONESTY RULES, which are the point of the panel:
//   • An interval that never closed is NOT a data point. It is counted in
//     `openCount` and said out loud ("5 proposals are still undecided"), never
//     folded into the median as a zero or as "so far".
//   • An empty population produces an empty-state SENTENCE, never a zero. A
//     median of 0 days across 0 proposals is a lie with a number on it.
//   • Every sentence states its population size, and a capped read renders as
//     "at least N" — the same vocabulary the control center already uses.
//
// No `now`. Medians over CLOSED intervals need no clock, and a ticking
// argument would re-run this panel every minute for an answer that changes
// when the history changes, not when the second hand moves.
// ─────────────────────────────────────────────────────────────────────────

/** Newest-first, so a truncated history drops a pair's START and the pair
 * simply vanishes — it never turns into a phantom "still open". */
const AUDIT_SCAN = 4000;
const SESSION_SCAN = 500;
const PARTICIPANT_SCAN = 1000;
const INSTANCE_SCAN = 2000;
const FLAG_SCAN = 2000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type TurnaroundId = "decision" | "confirmation" | "task" | "publish";

export type TurnaroundStat = {
  /** Stable id — tests and the client key on this, never on the label. */
  id: TurnaroundId;
  label: string;
  /** Closed intervals only. The population the median describes. */
  count: number;
  /** Started and not finished. Never a data point; always spoken. */
  openCount: number;
  /** Milliseconds, or null when the population is empty. */
  p50: number | null;
  p90: number | null;
  /** True when a read hit its ceiling, so the counts above are floors. */
  capped: boolean;
  /** Composed here. Printed verbatim. */
  sentence: string;
};

export type TurnaroundPanel = {
  stats: TurnaroundStat[];
  capped: boolean;
  /** One sentence about the panel itself — printed verbatim too. */
  summary: string;
};

// ── Duration, said in whole units ────────────────────────────────────────

/**
 * "3 days" / "5 hours" / "12 minutes". Coarse on purpose: an organizer asks
 * "are decisions taking too long", and "2 days 7 hours 14 minutes" answers a
 * question nobody asked while reading worse in a sentence.
 */
export function durationPhrase(ms: number): string {
  // The unit is chosen from the ROUNDED value, not the raw one. A hair under
  // a day is "1 day", never "24 hours" — and a hair under an hour is "1 hour",
  // never "60 minutes". Picking the unit first and rounding after is how those
  // two nonsense strings get printed.
  const hours = Math.round(ms / HOUR);
  if (hours >= 24) {
    const days = Math.round(ms / DAY);
    return `${days} ${plural(days, "day", "days")}`;
  }
  if (hours >= 1) return `${hours} ${plural(hours, "hour", "hours")}`;
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  return `${minutes} ${plural(minutes, "minute", "minutes")}`;
}

/**
 * Nearest-rank percentile over an already-sorted ascending array.
 *
 * Nearest-rank rather than interpolation because every value here is an
 * OBSERVED interval: p50 of three proposals should be one of those three
 * proposals' turnarounds, not an average of two that never happened.
 */
export function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

// ── Audit-row helpers ────────────────────────────────────────────────────

type Audit = Doc<"auditLog">;

function metaField(row: Audit, key: string): unknown {
  const meta = row.meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  return (meta as Record<string, unknown>)[key];
}

/**
 * Earliest timestamp per target id, for the rows an action code marks.
 *
 * EARLIEST, not latest, everywhere: a re-release, a re-approval or a second
 * upload is a correction to a decision already taken, and timing the
 * correction would flatter every number on the panel.
 */
function firstByTarget(
  rows: Audit[],
  match: (row: Audit) => boolean,
  targetOf: (row: Audit) => string | undefined = (row) => row.targetId,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (!match(row)) continue;
    const target = targetOf(row);
    if (target === undefined) continue;
    const at = out.get(target);
    if (at === undefined || row._creationTime < at) {
      out.set(target, row._creationTime);
    }
  }
  return out;
}

/** One closed interval, or nothing. An end before its start is not a
 * measurement — it is a clock or an ordering we do not trust, and a negative
 * duration in a median is worse than a smaller population. */
function interval(start: number, end: number | undefined): number | null {
  if (end === undefined || end < start) return null;
  return end - start;
}

// ── The sentences ────────────────────────────────────────────────────────

type Wording = {
  label: string;
  /** "Decisions released" — the subject and its verb, already in the past. */
  achievement: string;
  /** "after the decision reached them" — how the clock started, or "". */
  since: string;
  /** The unit the population is counted in. */
  one: string;
  many: string;
  /** "still undecided" — what the open ones are still waiting on. */
  openState: string;
  /** Said when nothing has even STARTED — the honest empty state. */
  nothingStarted: string;
};

const WORDING: Record<TurnaroundId, Wording> = {
  decision: {
    label: "Decision turnaround",
    achievement: "Decisions released",
    since: "after the proposal arrived",
    one: "proposal",
    many: "proposals",
    openState: "still undecided",
    nothingStarted:
      "No proposal has been submitted yet, so there is no decision turnaround to report.",
  },
  confirmation: {
    label: "Speaker confirmation",
    achievement: "Speakers confirmed",
    since: "after the decision was released",
    one: "speaker",
    many: "speakers",
    openState: "still to answer",
    nothingStarted:
      "No decision has reached a speaker yet, so there is no confirmation turnaround to report.",
  },
  task: {
    label: "Task completion",
    achievement: "Tasks completed",
    since: "after they were assigned",
    one: "task",
    many: "tasks",
    openState: "still open",
    nothingStarted:
      "No task has been assigned yet, so there is no completion turnaround to report.",
  },
  publish: {
    label: "Publish latency",
    achievement: "Sessions published",
    since: "after their content was approved",
    one: "session",
    many: "sessions",
    openState: "approved but not published",
    nothingStarted:
      "No session content has been approved yet, so there is no publish latency to report.",
  },
};

function openClause(word: Wording, open: number, capped: boolean): string {
  const noun = plural(open, word.one, word.many);
  const verb = plural(open, "is", "are");
  return `${amount(open, capped)} ${noun} ${verb} ${word.openState}`;
}

/**
 * The whole stat as ONE sentence, population size always stated.
 *
 * The empty cases get their own words rather than a median of nothing: the
 * review's objection to KPI grids is really an objection to numbers that do
 * not say what they are, and "0" is the worst of those.
 */
export function statSentence(
  id: TurnaroundId,
  durations: number[],
  openCount: number,
  capped: boolean,
): TurnaroundStat {
  const word = WORDING[id];
  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);
  const count = sorted.length;

  let sentence: string;
  if (count === 0 && openCount === 0) {
    sentence = word.nothingStarted;
  } else if (count === 0) {
    sentence = `Nothing has completed this step yet, so there is no median to report; ${openClause(word, openCount, capped)}.`;
  } else {
    const population = `${amount(count, capped)} ${plural(count, word.one, word.many)}`;
    const tail =
      openCount === 0
        ? `none are ${word.openState}`
        : openClause(word, openCount, capped);
    sentence =
      `${word.achievement} in a median of ${durationPhrase(p50 as number)} ` +
      `${word.since}, across ${population}; the slowest tenth took ` +
      `${durationPhrase(p90 as number)}; ${tail}.`;
  }

  return {
    id,
    label: word.label,
    count,
    openCount,
    p50,
    p90,
    capped,
    sentence,
  };
}

// ── The producer ─────────────────────────────────────────────────────────

const COMPLETES_TASK: ReadonlySet<string> = new Set([
  "task.markProvided",
  "task.upload",
  "task.approve",
]);

/**
 * Every turnaround this event's own history can answer for, as sentences.
 *
 * Organizer-only, like every other control-center panel: turnaround times are
 * an operational read across the whole event, and a reviewer's window is their
 * own assignments.
 */
export async function turnaround(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<TurnaroundPanel> {
  requireOrganizer(caller);
  const eventId = caller.event._id;

  const [audit, sessions, participants, instances, flags] = await Promise.all([
    takeCapped(
      ctx.db
        .query("auditLog")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .order("desc"),
      AUDIT_SCAN,
    ),
    takeCapped(
      ctx.db
        .query("sessions")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      SESSION_SCAN,
    ),
    takeCapped(
      ctx.db
        .query("sessionParticipants")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      PARTICIPANT_SCAN,
    ),
    takeCapped(
      ctx.db
        .query("taskInstances")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      INSTANCE_SCAN,
    ),
    takeCapped(
      ctx.db
        .query("publicationFlags")
        .withIndex("by_eventId_and_target", (q) => q.eq("eventId", eventId)),
      FLAG_SCAN,
    ),
  ]);

  const rows = audit.rows;
  const capped =
    audit.capped ||
    sessions.capped ||
    participants.capped ||
    instances.capped ||
    flags.capped;

  // ── Decision: cfp.submit → decision.release, per proposal ──
  // A withdrawn proposal is neither timed nor chased: nobody owes it a
  // decision, so counting it as "still undecided" would invent a backlog.
  const submitted = firstByTarget(rows, (r) => r.action === "cfp.submit");
  const released = firstByTarget(rows, (r) => r.action === "decision.release");
  const withdrawn = firstByTarget(rows, (r) => r.action === "cfp.withdraw");

  const decisionDurations: number[] = [];
  let decisionOpen = 0;
  for (const [proposalId, at] of submitted) {
    if (withdrawn.has(proposalId) && !released.has(proposalId)) continue;
    const closed = interval(at, released.get(proposalId));
    if (closed === null) decisionOpen += 1;
    else decisionDurations.push(closed);
  }

  // ── Confirmation: decision.release → participation.setState confirmed ──
  // The join is document-shaped (participant → session → proposal) but every
  // TIMESTAMP is an audit row: the documents only say who belongs to what.
  const sessionProposal = new Map<Id<"sessions">, Id<"proposals">>();
  const cancelled = new Set<Id<"sessions">>();
  for (const session of sessions.rows) {
    if (session.status === "cancelled") cancelled.add(session._id);
    if (session.proposalId !== undefined) {
      sessionProposal.set(session._id, session.proposalId);
    }
  }
  const confirmed = firstByTarget(
    rows,
    (r) =>
      r.action === "participation.setState" && metaField(r, "to") === "confirmed",
  );

  const confirmDurations: number[] = [];
  let confirmOpen = 0;
  for (const participant of participants.rows) {
    if (cancelled.has(participant.sessionId)) continue;
    const proposalId = sessionProposal.get(participant.sessionId);
    if (proposalId === undefined) continue;
    const releasedAt = released.get(proposalId);
    if (releasedAt === undefined) continue;
    const closed = interval(releasedAt, confirmed.get(participant._id));
    if (closed !== null) {
      confirmDurations.push(closed);
    } else if (participant.state === "awaiting") {
      // Declined and withdrawn speakers ANSWERED. They are not a confirmation
      // time and they are not an outstanding one either.
      confirmOpen += 1;
    }
  }

  // ── Task: instance creation → the row that settled it ──
  // FALLBACK (documented at the top): task instances are generated by a
  // requirement, not by a command, so nothing audits the assignment.
  // `_creationTime` is the moment the task started existing for its owner.
  const taskDone = firstByTarget(rows, (r) => COMPLETES_TASK.has(r.action));

  const taskDurations: number[] = [];
  let taskOpen = 0;
  for (const instance of instances.rows) {
    // "Not applicable" is settled, not completed — timing it would reward
    // waiving work as if it had been done.
    if (instance.status === "notApplicable") continue;
    const end = taskDone.get(instance._id) ?? instance.completedAt;
    const closed = interval(instance._creationTime, end);
    if (closed === null) taskOpen += 1;
    else taskDurations.push(closed);
  }

  // ── Publish: content approved → session published ──
  const approved = firstByTarget(
    rows,
    (r) =>
      r.action === "sessions.setContentStatus" &&
      metaField(r, "to") === "approved",
  );
  const publishedRow = firstByTarget(
    rows,
    (r) => r.action === "publish.session" && metaField(r, "published") === true,
    (r) => {
      const id = metaField(r, "sessionId");
      return typeof id === "string" ? id : undefined;
    },
  );
  // FALLBACK (documented at the top): a bulk publish writes ONE event-wide
  // audit row with no session ids, so the flag it flipped is the only record
  // that this session in particular went public.
  const flagPublishedAt = new Map<string, number>();
  for (const flag of flags.rows) {
    if (flag.targetType !== "session" || !flag.published) continue;
    flagPublishedAt.set(flag.targetId, flag.updatedAt);
  }

  const publishDurations: number[] = [];
  let publishOpen = 0;
  for (const session of sessions.rows) {
    if (session.status === "cancelled") continue;
    // Legacy rows carry no contentStatus (they were already being served) and
    // therefore no approval moment. No start, no data point, no invented one.
    const approvedAt =
      approved.get(session._id) ??
      (session.contentStatus === "approved"
        ? session.contentStatusSetAt
        : undefined);
    if (approvedAt === undefined) continue;
    const end = publishedRow.get(session._id) ?? flagPublishedAt.get(session._id);
    const closed = interval(approvedAt, end);
    if (closed === null) publishOpen += 1;
    else publishDurations.push(closed);
  }

  return {
    stats: [
      statSentence("decision", decisionDurations, decisionOpen, capped),
      statSentence("confirmation", confirmDurations, confirmOpen, capped),
      statSentence("task", taskDurations, taskOpen, capped),
      statSentence("publish", publishDurations, publishOpen, capped),
    ],
    capped,
    summary: capped
      ? `Read from the most recent ${AUDIT_SCAN} recorded actions on this event, so these are floors from a sample rather than the whole history.`
      : "Measured from this event's own history. Only intervals that actually closed are counted; anything still running is named, never averaged in.",
  };
}
