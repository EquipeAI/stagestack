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
//   decision      cfp.submit / cfp.manualAdd → decision.release      (proposal)
//   confirmation  decision.release           → participation.setState confirmed
//   task          taskInstance creation      → task.markProvided / upload /
//                                              approve               (instance)
//   publish       sessions.setContentStatus  → publish.session       (session)
//                 (to "approved")
//
// A proposal reaches an event two ways and BOTH are an arrival: the speaker
// submits it (`cfp.submit`), or an organizer records one that came to them
// outside the CFP (`cfp.manualAdd`, convex/model/cfp.ts). The manual-add row is
// written in the same mutation as the insert, so it is the exact moment the
// proposal started existing for the organizer who now owes it a decision —
// which is what "after the proposal arrived" has always meant here. Timing only
// `cfp.submit` left every hand-added proposal out of the population, and an
// event whose proposals were ALL hand-added then printed "No proposal has been
// submitted yet" while the control center counted those same proposals waiting
// for a decision. Two panels, one history, opposite claims: the empty state was
// the false one.
//
// Two of those needed a DOCUMENT timestamp because the audit trail alone
// cannot answer, and both fallbacks are named at their call site below:
//   • task instances are GENERATED, not commanded, so no audit row records the
//     assignment — `_creationTime` is the assignment moment.
//   • a BULK publish writes one event-wide audit row without session ids
//     (convex/model/publishBulk.ts), so a session published that way has no
//     per-session row — its `publicationFlags.updatedAt` is the publish moment,
//     but ONLY while nothing can have moved that field since. `updatedAt` is
//     the LAST flip, not the first: a session that was unpublished and
//     published again carries the re-publication there, and pairing that with
//     the approval that governs it can make a nine-day wait read as an hour.
//     So the flag is trusted only when this event's history records no
//     unpublish for that session; otherwise the session's publication moment is
//     unknowable and it leaves the population, which makes the count a FLOOR
//     (the stat is marked capped, so it says "at least N" — the same admission
//     a truncated read makes). Excluding is the only move that cannot invent a
//     number: no start, no end, no data point.
//
// HONESTY RULES, which are the point of the panel:
//   • An interval that never closed is NOT a data point. It is counted in
//     `openCount` and said out loud ("5 proposals are still undecided"), never
//     folded into the median as a zero or as "so far".
//   • An empty population produces an empty-state SENTENCE, never a zero. A
//     median of 0 days across 0 proposals is a lie with a number on it.
//   • "Nothing has started" is a claim about the WORLD, not about this read.
//     A row that exists but cannot be timed is counted in `untimeableCount` and
//     said out loud, so the empty state can only ever be printed when the thing
//     it denies really is absent.
//   • Every sentence states its population size, and a capped read renders as
//     "at least N" — the same vocabulary the control center already uses.
//     CAPPED IS PER STATISTIC, not per panel: a session ceiling says nothing
//     about whether the decision figures are complete, and marking them all
//     would turn one truncated read into four hedged answers.
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
const PROPOSAL_SCAN = 2000;
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
  /** Exists, but nothing in the history says when its clock started. Never a
   * data point, never silent: it is what stops an empty median from claiming
   * the thing itself never happened. */
  untimeableCount: number;
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

/**
 * EVERY timestamp per target id, for the rows an action code marks.
 *
 * The one interval that needs more than the earliest occurrence: a publish is
 * governed by the approval that was standing when it happened, and an event
 * that approved, reverted and re-approved has several to choose between.
 */
function allByTarget(
  rows: Audit[],
  match: (row: Audit) => boolean,
  targetOf: (row: Audit) => string | undefined = (row) => row.targetId,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const row of rows) {
    if (!match(row)) continue;
    const target = targetOf(row);
    if (target === undefined) continue;
    const at = out.get(target);
    if (at === undefined) out.set(target, [row._creationTime]);
    else at.push(row._creationTime);
  }
  return out;
}

/**
 * The latest of `times` that is at or before `end` — the one that GOVERNED the
 * thing that happened at `end`.
 *
 * With no end there is nothing to govern yet, so the latest one standing is the
 * one still waiting. With nothing at or before the end, no approval governed
 * that publish at all: the earliest is returned so `interval` refuses the pair
 * outright rather than inventing a start after the finish.
 */
function governing(
  times: number[] | undefined,
  end: number | undefined,
): number | undefined {
  if (times === undefined || times.length === 0) return undefined;
  if (end === undefined) return Math.max(...times);
  const before = times.filter((at) => at <= end);
  return before.length === 0 ? Math.min(...times) : Math.max(...before);
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
  /** What a row that exists but cannot be timed is MISSING. Said instead of
   * `nothingStarted`, which would deny the row itself. */
  noStart: string;
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
    noStart: "no arrival this history can time",
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
    noStart: "no released decision this history can time",
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
    noStart: "no assignment this history can time",
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
    noStart: "no publication moment this history can time",
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
  untimeableCount = 0,
): TurnaroundStat {
  const word = WORDING[id];
  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);
  const count = sorted.length;
  // Said wherever there is a sentence to hang it on. A row nobody can time is
  // still a row that EXISTS, and every number beside it is a floor because of
  // it — so it is never dropped in silence.
  const untimeableClause =
    untimeableCount === 0
      ? ""
      : `; ${amount(untimeableCount, capped)} ` +
        `${plural(untimeableCount, word.one, word.many)} ` +
        `${plural(untimeableCount, "carries", "carry")} ${word.noStart}`;

  let sentence: string;
  if (count === 0 && openCount === 0) {
    // "Nothing has started" is a claim about the WHOLE history. A stat whose
    // inputs were truncated, or whose rows could not be timed, has not read the
    // whole history and must not make it.
    if (untimeableCount > 0) {
      // The rows EXIST. Denying them — "no proposal has been submitted yet"
      // while the control center counts one waiting for a decision — is the one
      // thing this panel may never say, and it outranks the capped wording
      // below because it is the more specific admission of the two.
      sentence =
        `This event records ${amount(untimeableCount, capped)} ` +
        `${plural(untimeableCount, word.one, word.many)} with ` +
        `${word.noStart}, so there is no median to report.`;
    } else if (capped) {
      sentence = `No ${word.one} here could be timed from the history that could be read.`;
    } else {
      sentence = word.nothingStarted;
    }
  } else if (count === 0) {
    sentence = `Nothing has completed this step yet, so there is no median to report; ${openClause(word, openCount, capped)}${untimeableClause}.`;
  } else {
    const population = `${amount(count, capped)} ${plural(count, word.one, word.many)}`;
    const tail =
      openCount === 0
        ? `none are ${word.openState}`
        : openClause(word, openCount, capped);
    sentence =
      `${word.achievement} in a median of ${durationPhrase(p50 as number)} ` +
      `${word.since}, across ${population}; the slowest tenth took ` +
      `${durationPhrase(p90 as number)}; ${tail}${untimeableClause}.`;
  }

  return {
    id,
    label: word.label,
    count,
    openCount,
    untimeableCount,
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

  const [audit, proposals, sessions, participants, instances, flags] =
    await Promise.all([
      takeCapped(
        ctx.db
          .query("auditLog")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
          .order("desc"),
        AUDIT_SCAN,
      ),
      takeCapped(
        ctx.db
          .query("proposals")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        PROPOSAL_SCAN,
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
  // Each statistic is a floor only if one of the reads IT is computed from hit
  // a ceiling. The panel-level flag is for the panel's own sentence, and is
  // simply "is any figure on it a floor".
  const decisionReadCapped = audit.capped || proposals.capped;
  const confirmCapped = audit.capped || sessions.capped || participants.capped;
  const taskCapped = audit.capped || instances.capped;
  const publishReadCapped = audit.capped || sessions.capped || flags.capped;

  // ── Decision: arrival → decision.release, per proposal ──
  // The population is the PROPOSALS TABLE, not the submission rows: a proposal
  // the history cannot time is still a proposal, and the control center counts
  // it waiting for a decision on the same screen. Iterating the audit rows made
  // those proposals invisible here, which is how this panel came to deny them.
  //
  // A withdrawn proposal is neither timed nor chased: nobody owes it a
  // decision, so counting it as "still undecided" would invent a backlog.
  const submitted = firstByTarget(rows, (r) => r.action === "cfp.submit");
  const manuallyAdded = firstByTarget(rows, (r) => r.action === "cfp.manualAdd");
  const released = firstByTarget(rows, (r) => r.action === "decision.release");
  const withdrawn = firstByTarget(rows, (r) => r.action === "cfp.withdraw");

  const decisionDurations: number[] = [];
  let decisionOpen = 0;
  let decisionUntimeable = 0;
  for (const proposal of proposals.rows) {
    // A draft has not arrived anywhere: it is a speaker's private wizard state
    // until they submit, and nobody owes it a decision.
    if (proposal.status === "draft") continue;
    const proposalId = proposal._id;
    if (
      (proposal.status === "withdrawn" || withdrawn.has(proposalId)) &&
      !released.has(proposalId)
    ) {
      continue;
    }
    // Both arrivals count, earliest wins — a proposal recorded by hand and then
    // resubmitted through the form arrived when it was first recorded.
    const submittedAt = submitted.get(proposalId);
    const addedAt = manuallyAdded.get(proposalId);
    const start =
      submittedAt === undefined
        ? addedAt
        : addedAt === undefined
          ? submittedAt
          : Math.min(submittedAt, addedAt);
    if (start === undefined) {
      // It exists and it is not a draft, but nothing readable says when it
      // arrived. Counted and spoken; never silently dropped, and never allowed
      // to leave the empty state claiming no proposal was ever submitted.
      decisionUntimeable += 1;
      continue;
    }
    const closed = interval(start, released.get(proposalId));
    if (closed === null) decisionOpen += 1;
    else decisionDurations.push(closed);
  }
  // Untimeable proposals make every decision figure a floor, in the same words
  // a truncated read uses.
  const decisionCapped = decisionReadCapped || decisionUntimeable > 0;

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
  // ALL approvals, not the first: approve, revert to draft, re-approve, publish
  // is one day of latency governed by the SECOND approval, and timing it from
  // the first would report the fortnight the content spent in draft.
  const approvals = allByTarget(
    rows,
    (r) =>
      r.action === "sessions.setContentStatus" &&
      metaField(r, "to") === "approved",
  );
  const sessionIdMeta = (r: Audit) => {
    const id = metaField(r, "sessionId");
    return typeof id === "string" ? id : undefined;
  };
  const publishedRow = firstByTarget(
    rows,
    (r) => r.action === "publish.session" && metaField(r, "published") === true,
    sessionIdMeta,
  );
  // An explicit unpublish is the one thing that can have moved a flag's
  // `updatedAt` off the first publication. Bulk publishing only ever sets
  // flags true (convex/model/publishBulk.ts), so this is the whole list.
  //
  // Every one of them, not the earliest: an unpublish is also the boundary
  // between publication CYCLES, and the pair below has to be checked against
  // whichever one falls between its two ends.
  const unpublished = allByTarget(
    rows,
    (r) => r.action === "publish.session" && metaField(r, "published") === false,
    sessionIdMeta,
  );
  // FALLBACK (documented at the top): a bulk publish writes ONE event-wide
  // audit row with no session ids, so the flag it flipped is the only record
  // that this session in particular went public — and only while no unpublish
  // can have rewritten `updatedAt` since.
  const flagPublishedAt = new Map<string, number>();
  for (const flag of flags.rows) {
    if (flag.targetType !== "session" || !flag.published) continue;
    flagPublishedAt.set(flag.targetId, flag.updatedAt);
  }

  const publishDurations: number[] = [];
  let publishOpen = 0;
  let publishUntimeable = 0;
  for (const session of sessions.rows) {
    if (session.status === "cancelled") continue;
    let end = publishedRow.get(session._id);
    if (end === undefined) {
      const flagged = flagPublishedAt.get(session._id);
      if (flagged !== undefined && unpublished.has(session._id)) {
        // Published (the flag says so), re-published after an unpublish, and
        // no per-session row of the FIRST time. Nothing here can time it.
        publishUntimeable += 1;
        continue;
      }
      end = flagged;
    }
    // Legacy rows carry no contentStatus (they were already being served) and
    // therefore no approval moment. No start, no data point, no invented one.
    const approvedAt =
      governing(approvals.get(session._id), end) ??
      (session.contentStatus === "approved"
        ? session.contentStatusSetAt
        : undefined);
    if (approvedAt === undefined) continue;
    // The pair must belong to ONE publication cycle. `governing` picks the
    // latest approval at or before this publish, which is right whenever the
    // two ends live in the same cycle — re-approve on day 9, republish on day
    // 10 is a real ten-hour interval and is counted. But an unpublish BETWEEN
    // them says this approval was already standing while the session was
    // public, so the publication it actually governed is an earlier one this
    // history cannot time, and `end` belongs to the cycle after it. Measuring
    // across that boundary would print the first cycle's wait plus however
    // long the session sat withdrawn.
    const publishedAt = end;
    if (
      publishedAt !== undefined &&
      (unpublished.get(session._id) ?? []).some(
        (at) => at > approvedAt && at < publishedAt,
      )
    ) {
      publishUntimeable += 1;
      continue;
    }
    const closed = interval(approvedAt, end);
    if (closed === null) publishOpen += 1;
    else publishDurations.push(closed);
  }
  // A session dropped for want of a publication moment makes the population a
  // floor, in the same words a truncated read uses.
  const publishCapped = publishReadCapped || publishUntimeable > 0;
  const panelCapped =
    decisionCapped || confirmCapped || taskCapped || publishCapped;

  return {
    stats: [
      statSentence(
        "decision",
        decisionDurations,
        decisionOpen,
        decisionCapped,
        decisionUntimeable,
      ),
      statSentence("confirmation", confirmDurations, confirmOpen, confirmCapped),
      statSentence("task", taskDurations, taskOpen, taskCapped),
      statSentence(
        "publish",
        publishDurations,
        publishOpen,
        publishCapped,
        publishUntimeable,
      ),
    ],
    capped: panelCapped,
    summary: audit.capped
      ? `Read from the most recent ${AUDIT_SCAN} recorded actions on this event, so these are floors from a sample rather than the whole history.`
      : panelCapped
        ? "This event holds more rows than one pass reads, so the figures that say “at least” are floors; the others were computed from everything they need."
        : "Measured from this event's own history. Only intervals that actually closed are counted; anything still running is named, never averaged in.",
  };
}
