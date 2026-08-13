import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { requireOrganizer } from "../lib/functions";
import { isPublished, publicationFlags } from "./publish";
import { isDraftRound } from "./reviews";
import { isOpen, isOverdue } from "./tasks";
import { eventUserDisplayName } from "./userDisplay";
import { takeCapped } from "./validation";

// ─────────────────────────────────────────────────────────────────────────
// The event control center (W8). FOUR QUESTIONS, FOUR PANELS, FOUR QUERIES.
//
// Shape first, because the shape is the decision: readiness reads REFUSE
// (`event_too_large`) rather than truncate, so one mega-query would let a
// single over-ceiling table blank the entire screen. Each panel therefore has
// its own bounded query and chooses its own read policy DELIBERATELY:
//
//   • `attentionPanel` — takeCapped. This panel is the reason the page exists;
//     it must render. Its counts are prompts to go and look, so a floor ("at
//     least 500") is honest and still actionable.
//   • `recentChanges`  — takeCapped. A feed is latest-N by definition; there is
//     no whole-table answer to truncate.
//   • `upNext`         — bounded single-row reads plus the flags map. Nothing
//     here scales with the event's size except the flags, which already refuse.
//   • the BLOCKED panel is `tasks.dashboard`, which refuses on purpose (a
//     dropped participation would report a session Ready that nobody checked)
//     and is extended below with the counts the review asked for.
//
// Every sentence on the screen is composed HERE and printed verbatim. A route
// that re-words a count is the exact bug this plan exists to remove.
//
// Nothing reads the wall clock: `now` arrives as an argument on the two queries
// that genuinely need it, exactly as the rest of readiness works.
// ─────────────────────────────────────────────────────────────────────────

/** The shell's tab vocabulary (apps/web/src/components/shell/nav.ts). */
export type ControlTab =
  | "cfp"
  | "proposals"
  | "reviews"
  | "sessions"
  | "speakers"
  | "tasks"
  | "agenda"
  | "publish"
  | "comms"
  | "details"
  | "settings"
  | "team"
  | "import";

/**
 * A deep link into ALREADY-FILTERED work.
 *
 * `search` is the destination route's own `validateSearch` vocabulary, spelled
 * exactly as that route parses it — landing on an unfiltered page and asking
 * the organizer to re-apply the filter is what this replaces. The client maps
 * the tab id to a path; it never invents the filter.
 */
export type ControlLink = {
  tab: ControlTab;
  search?: Record<string, string>;
};

/** One counted row: a number, the sentence that explains it, and where to go. */
export type ControlRow = {
  /** Stable id — tests and the client key on this, never on the label. */
  id: string;
  label: string;
  count: number;
  /** True when the count is a floor rather than a total (a capped read). */
  capped: boolean;
  /** Composed here. Printed verbatim. */
  sentence: string;
  tone: "neutral" | "info" | "success" | "attention" | "blocked";
  link: ControlLink;
};

// Exported so W4's analytics panel speaks the SAME count vocabulary: two
// producers with two copies of "at least N" is how a floor starts printing as
// a total on one panel and not the other.
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "3" or "at least 3" — a capped read never prints as an exact total. */
export function amount(n: number, capped: boolean): string {
  return capped ? `at least ${n}` : String(n);
}

// ── Time, said in whole units ────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "in 6 days" / "in 3 hours" / "4 days ago". Deliberately coarse: the control
 * center answers "is this soon", and a live seconds counter is a distraction
 * that also forces a faster tick than the page wants.
 */
export function relativeTime(target: number, now: number): string {
  const delta = target - now;
  const ahead = delta >= 0;
  const abs = Math.abs(delta);
  const [value, unit] =
    abs >= DAY
      ? [Math.floor(abs / DAY), "day"]
      : abs >= HOUR
        ? [Math.floor(abs / HOUR), "hour"]
        : [Math.max(1, Math.floor(abs / MINUTE)), "minute"];
  const phrase = `${value} ${plural(value, unit, `${unit}s`)}`;
  return ahead ? `in ${phrase}` : `${phrase} ago`;
}

// ─────────────────────────────────────────────────────────────────────────
// PANEL 1 — "What needs my attention"
// ─────────────────────────────────────────────────────────────────────────

const PANEL_PROPOSAL_SCAN = 500;
const PANEL_REVIEW_SCAN = 2000;
const PANEL_ROUND_SCAN = 100;
const PANEL_PARTICIPANT_SCAN = 1000;
const PANEL_INSTANCE_SCAN = 2000;
const PANEL_SESSION_SCAN = 500;

/** The lifecycle checklist a first event sees instead of the summary. */
export type ChecklistStep = {
  id: "setup" | "cfp" | "collect" | "select" | "schedule" | "publish";
  label: string;
  state: "done" | "active" | "todo";
  /** What is true right now. */
  sentence: string;
  /** The one next action, or null once the step is done. */
  action: { label: string; link: ControlLink } | null;
};

export type AttentionPanel = {
  rows: ControlRow[];
  /**
   * Measurably a first event: nothing has ever been proposed, nothing has ever
   * been scheduled, and the CFP has never opened. Any one of those makes it a
   * returning event with history, and history gets the collapsed summary.
   */
  firstEvent: boolean;
  /** Always computed, so the client has ONE decision point, not two loads. */
  checklist: ChecklistStep[];
  /** True when any read hit its ceiling — the counts above are floors. */
  capped: boolean;
};

/**
 * Staged decisions: accepted or declined, but not released — the reversible
 * half, and the count W7 noted missing from `api.readiness.attention`.
 *
 * Exported so the nav badge and this panel's row share ONE producer: two
 * numbers derived by two pieces of code is exactly how a badge starts
 * disagreeing with the row it points at.
 */
export async function stagedDecisions(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<{ count: number; capped: boolean }> {
  const [accept, decline] = await Promise.all([
    takeCapped(
      ctx.db
        .query("proposals")
        .withIndex("by_eventId_and_status", (q) =>
          q.eq("eventId", eventId).eq("status", "acceptQueue"),
        ),
      PANEL_PROPOSAL_SCAN,
    ),
    takeCapped(
      ctx.db
        .query("proposals")
        .withIndex("by_eventId_and_status", (q) =>
          q.eq("eventId", eventId).eq("status", "declineQueue"),
        ),
      PANEL_PROPOSAL_SCAN,
    ),
  ]);
  return {
    count: accept.rows.length + decline.rows.length,
    capped: accept.capped || decline.capped,
  };
}

/** The CFP row's sentence — state, submissions, and the close countdown. */
export function cfpSentence(
  event: Doc<"events">,
  now: number,
  submissions: number,
  capped: boolean,
): { sentence: string; tone: ControlRow["tone"] } {
  const count = `${amount(submissions, capped)} ${plural(submissions, "submission is", "submissions are")} waiting for a decision`;
  if (!event.cfpPublished) {
    return {
      sentence:
        submissions === 0
          ? "The call for speakers has never been published."
          : `The call for speakers is not published; ${count}.`,
      tone: submissions === 0 ? "neutral" : "attention",
    };
  }
  const opensAt = event.cfpOpenAt;
  if (opensAt !== undefined && opensAt > now) {
    return {
      sentence: `The call for speakers opens ${relativeTime(opensAt, now)}.`,
      tone: "info",
    };
  }
  const closesAt = event.cfpCloseAt;
  if (closesAt === undefined) {
    return {
      sentence: `The call for speakers is open with no closing date; ${count}.`,
      tone: submissions === 0 ? "info" : "attention",
    };
  }
  if (closesAt <= now) {
    return {
      sentence: `The call for speakers closed ${relativeTime(closesAt, now)}; ${count}.`,
      tone: submissions === 0 ? "neutral" : "attention",
    };
  }
  return {
    sentence: `The call for speakers closes ${relativeTime(closesAt, now)}; ${count}.`,
    tone: submissions === 0 ? "info" : "attention",
  };
}

/**
 * The panel the organizer reads first: everything waiting on a person, each
 * row counted and deep-linked into the already-filtered work.
 */
export async function attentionPanel(
  ctx: QueryCtx,
  caller: EventCaller,
  now: number,
): Promise<AttentionPanel> {
  requireOrganizer(caller);
  const event = caller.event;
  const eventId = event._id;

  const [pending, staged, reviews, rounds, participants, instances, sessions] =
    await Promise.all([
      takeCapped(
        ctx.db
          .query("proposals")
          .withIndex("by_eventId_and_status", (q) =>
            q.eq("eventId", eventId).eq("status", "pending"),
          ),
        PANEL_PROPOSAL_SCAN,
      ),
      stagedDecisions(ctx, eventId),
      takeCapped(
        ctx.db
          .query("reviews")
          .withIndex("by_eventId_and_reviewerUserId", (q) =>
            q.eq("eventId", eventId),
          ),
        PANEL_REVIEW_SCAN,
      ),
      takeCapped(
        ctx.db
          .query("reviewRounds")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        PANEL_ROUND_SCAN,
      ),
      takeCapped(
        ctx.db
          .query("sessionParticipants")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        PANEL_PARTICIPANT_SCAN,
      ),
      takeCapped(
        ctx.db
          .query("taskInstances")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        PANEL_INSTANCE_SCAN,
      ),
      takeCapped(
        ctx.db
          .query("sessions")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        PANEL_SESSION_SCAN,
      ),
    ]);

  const capped =
    pending.capped ||
    staged.capped ||
    reviews.capped ||
    rounds.capped ||
    participants.capped ||
    instances.capped ||
    sessions.capped;

  // ── Reviews: incomplete assignments, and the reviewers who are late ──
  // "Late" is a property of the ROUND (its closesAt), so an event with no
  // round deadlines reports incompleteness without ever calling anyone
  // overdue — which is the truth, not a softened version of it.
  // Rounds the launch flow is still building govern nothing yet (W11), so
  // their windows never make anyone overdue and they never stand in as the
  // default round legacy review rows read through.
  const liveRounds = rounds.rows.filter((r) => !isDraftRound(r));
  const roundClosesAt = new Map<Id<"reviewRounds">, number | undefined>(
    liveRounds.map((r) => [r._id, r.closesAt]),
  );
  const defaultRound = [...liveRounds].sort((a, b) => a.order - b.order)[0];
  let incompleteReviews = 0;
  const overdueReviewers = new Set<Id<"users">>();
  for (const review of reviews.rows) {
    if (review.status !== "assigned" && review.status !== "draft") continue;
    incompleteReviews += 1;
    const closesAt =
      review.roundId === undefined
        ? defaultRound?.closesAt
        : roundClosesAt.get(review.roundId);
    if (closesAt !== undefined && closesAt < now) {
      overdueReviewers.add(review.reviewerUserId);
    }
  }

  // ── Speakers & tasks ──
  const awaiting = participants.rows.filter((p) => p.state === "awaiting");
  const awaitingSpeakers = new Set(
    awaiting.map((p) => p.eventContactId),
  ).size;
  const openInstances = instances.rows.filter(isOpen);
  const overdueInstances = instances.rows.filter((i) => isOverdue(i, now));

  const cfp = cfpSentence(event, now, pending.rows.length, pending.capped);

  const rows: ControlRow[] = [
    {
      id: "cfp",
      label: "Call for speakers",
      count: pending.rows.length,
      capped: pending.capped,
      sentence: cfp.sentence,
      tone: cfp.tone,
      // The count IS the submissions waiting, so the count's destination is
      // the inbox view of proposals, not the CFP builder.
      link: { tab: "proposals", search: { status: "pending" } },
    },
    {
      id: "reviews",
      label: "Reviews outstanding",
      count: incompleteReviews,
      capped: reviews.capped,
      sentence:
        incompleteReviews === 0
          ? reviews.capped
            ? `No outstanding review among the first ${PANEL_REVIEW_SCAN} read — larger events may have more.`
            : "Every assigned review has been submitted."
          : `${amount(incompleteReviews, reviews.capped)} assigned ${plural(incompleteReviews, "review has", "reviews have")} not been submitted` +
            (overdueReviewers.size === 0
              ? "."
              : `, and ${amount(overdueReviewers.size, reviews.capped)} ${plural(overdueReviewers.size, "reviewer is", "reviewers are")} past their round's closing date.`),
      tone:
        overdueReviewers.size > 0
          ? "blocked"
          : incompleteReviews > 0
            ? "attention"
            : reviews.capped
              ? "neutral"
              : "success",
      link: { tab: "reviews", search: { tab: "progress" } },
    },
    {
      id: "decisions",
      label: "Decisions staged",
      count: staged.count,
      capped: staged.capped,
      sentence:
        staged.count === 0
          ? "No decision is waiting to be released."
          : `${amount(staged.count, staged.capped)} staged ${plural(staged.count, "decision has", "decisions have")} not been released, so nobody has been told yet.`,
      tone: staged.count === 0 ? "success" : "attention",
      link: {
        tab: "proposals",
        search: { status: "acceptQueue,declineQueue" },
      },
    },
    {
      id: "speakers",
      label: "Speakers unconfirmed",
      count: awaitingSpeakers,
      capped: participants.capped,
      sentence:
        awaitingSpeakers === 0
          ? participants.capped
            ? `Every invited speaker among the first ${PANEL_PARTICIPANT_SCAN} participations read has answered — larger events may have more.`
            : "Every invited speaker has answered."
          : `${amount(awaitingSpeakers, participants.capped)} ${plural(awaitingSpeakers, "speaker has", "speakers have")} not answered their invitation.`,
      tone:
        awaitingSpeakers === 0
          ? participants.capped
            ? "neutral"
            : "success"
          : "attention",
      link: { tab: "speakers", search: { state: "awaiting" } },
    },
    {
      id: "tasks",
      label: "Speaker tasks outstanding",
      count: openInstances.length,
      capped: instances.capped,
      sentence:
        openInstances.length === 0
          ? instances.capped
            ? `No outstanding task among the first ${PANEL_INSTANCE_SCAN} read — larger events may have more.`
            : "No speaker owes you anything right now."
          : `${amount(openInstances.length, instances.capped)} ${plural(openInstances.length, "task is", "tasks are")} outstanding` +
            (overdueInstances.length === 0
              ? "."
              : `, ${amount(overdueInstances.length, instances.capped)} of them overdue.`),
      tone:
        overdueInstances.length > 0
          ? "blocked"
          : openInstances.length > 0
            ? "attention"
            : instances.capped
              ? "neutral"
              : "success",
      // `outstanding`, not `pending`: the count is every OPEN task — which
      // includes work sitting in Awaiting Review and Changes Requested — and a
      // link to `pending` would show the organizer a shorter list than the
      // number they just clicked. The destination filter is the same `isOpen`
      // predicate this count uses, so the two agree by construction rather
      // than by two lists of statuses kept in step by hand.
      link: {
        tab: "tasks",
        search: { tab: "instances", status: "outstanding" },
      },
    },
  ];

  // Any proposal at all — including withdrawn and already-decided ones — is
  // history, so this probe reads the whole table's head, not the pending
  // index. One row is enough to answer it.
  const anyProposal = await ctx.db
    .query("proposals")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .take(1);
  const firstEvent =
    !event.cfpPublished &&
    event.cfpOpenAt === undefined &&
    sessions.rows.length === 0 &&
    anyProposal.length === 0;

  return {
    rows,
    firstEvent,
    checklist: checklistFor({
      event,
      now,
      proposals: pending.rows.length,
      staged: staged.count,
      sessions: sessions.rows,
      confirmedSpeakers: participants.rows.filter(
        (p) => p.state === "confirmed",
      ).length,
    }),
    capped,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The lifecycle checklist (GOV.UK task-list, with its own warning applied:
// the SMALLEST useful set of statuses, not another giant checklist).
//
// Six steps, because six is what an event actually runs through, and each
// carries exactly one next action. It is computed for every event; the client
// decides — at ONE decision point — whether to show it or the summary.
// ─────────────────────────────────────────────────────────────────────────

function checklistFor(args: {
  event: Doc<"events">;
  now: number;
  proposals: number;
  staged: number;
  sessions: Array<Doc<"sessions">>;
  confirmedSpeakers: number;
}): ChecklistStep[] {
  const { event, now, proposals, staged, sessions, confirmedSpeakers } = args;
  const planned = sessions.filter((s) => s.status === "planned");
  const scheduled = planned.filter((s) => s.releasedSlot !== undefined);

  // Setup facts: the things a public page cannot be honest without.
  const setupDone =
    event.description !== undefined &&
    event.description.trim() !== "" &&
    event.location !== undefined &&
    event.location.trim() !== "";

  const cfpOpen =
    event.cfpPublished &&
    (event.cfpOpenAt === undefined || event.cfpOpenAt <= now);

  const steps: ChecklistStep[] = [
    {
      id: "setup",
      label: "Set up the event",
      state: setupDone ? "done" : "todo",
      sentence: setupDone
        ? "Dates, timezone, location and description are recorded."
        : "Add a location and a description so the public page can say what this is.",
      action: setupDone
        ? null
        : { label: "Open settings", link: { tab: "settings" } },
    },
    {
      id: "cfp",
      label: "Open the call for speakers",
      state: cfpOpen ? "done" : "todo",
      sentence: cfpOpen
        ? "The call for speakers is published and accepting submissions."
        : event.cfpPublished
          ? "The call for speakers is published but has not opened yet."
          : "Build the submission form and publish it.",
      action: cfpOpen
        ? null
        : { label: "Open the CFP builder", link: { tab: "cfp" } },
    },
    {
      id: "collect",
      label: "Collect proposals",
      state: proposals > 0 ? "done" : cfpOpen ? "active" : "todo",
      sentence:
        proposals > 0
          ? `${proposals} ${plural(proposals, "proposal is", "proposals are")} waiting for a decision.`
          : "No proposal has arrived yet. You can also add one by hand.",
      action: { label: "Open proposals", link: { tab: "proposals" } },
    },
    {
      id: "select",
      label: "Select the programme",
      state:
        planned.length > 0 ? "done" : proposals > 0 || staged > 0 ? "active" : "todo",
      sentence:
        planned.length > 0
          ? `${planned.length} ${plural(planned.length, "session is", "sessions are")} planned, ${confirmedSpeakers} ${plural(confirmedSpeakers, "speaker has", "speakers have")} confirmed.`
          : staged > 0
            ? `${staged} staged ${plural(staged, "decision is", "decisions are")} waiting to be released.`
            : "Accepting a proposal turns it into a session.",
      action: { label: "Open proposals", link: { tab: "proposals" } },
    },
    {
      id: "schedule",
      label: "Build the schedule",
      state:
        planned.length > 0 && scheduled.length === planned.length
          ? "done"
          : planned.length > 0
            ? "active"
            : "todo",
      sentence:
        planned.length === 0
          ? "There is nothing to schedule yet."
          : scheduled.length === planned.length
            ? "Every planned session has a released slot."
            : `${planned.length - scheduled.length} of ${planned.length} ${plural(planned.length, "session has", "sessions have")} no released slot.`,
      action: { label: "Open the agenda", link: { tab: "agenda" } },
    },
    {
      id: "publish",
      label: "Publish the programme",
      state:
        event.publicPageEnabled === true
          ? "done"
          : planned.length > 0
            ? "active"
            : "todo",
      sentence:
        event.publicPageEnabled === true
          ? "The public page is on."
          : "Nothing is public yet — the public page is off.",
      action:
        event.publicPageEnabled === true
          ? null
          : { label: "Open the publish console", link: { tab: "publish" } },
    },
  ];
  return steps;
}

// ─────────────────────────────────────────────────────────────────────────
// PANEL 3 — "What changed recently"
//
// Reads the audit rows every capability ALREADY writes. No new write path, no
// new table, no derived history: this is the trail, rendered.
// ─────────────────────────────────────────────────────────────────────────

const CHANGES_LIMIT = 20;
/** Distinct actors we will resolve names for. Bounded by the page above it. */
const ACTOR_LIMIT = CHANGES_LIMIT;

export type ChangeRow = {
  auditId: Id<"auditLog">;
  at: number;
  /** Resolved human name, or null when the event cannot attribute the action. */
  actor: string | null;
  /** True when an agent performed it on the actor's behalf. */
  viaAgent: boolean;
  /** The raw code, so a surface can key on it without re-parsing the sentence. */
  action: string;
  /** Composed here. Unknown codes get an honest generic sentence, never a crash. */
  sentence: string;
  /** Where to go, when the target has a route. Null otherwise. */
  link: ControlLink | null;
};

/**
 * Action code → the clause that follows the actor's name.
 *
 * Deliberately a partial map over ~90 codes: the ones an organizer scanning a
 * control center actually cares about get a sentence, and everything else
 * falls through to `genericClause`, which is READABLE rather than raw. A code
 * added by a future capability must never crash this panel, and must never be
 * silently swallowed either — hence the honest fallback.
 */
const ACTION_CLAUSE: Record<string, string> = {
  "agenda.autoPlace": "ran assisted placement",
  "agenda.autoPlace.undo": "undid an assisted placement run",
  "agenda.place": "placed a session on the schedule",
  "agenda.unschedule": "took a session off the schedule",
  "agenda.release": "released a schedule slot",
  "agenda.cancelRelease": "cancelled a released slot",
  "agenda.itemCreate": "added an agenda item",
  "agenda.itemUpdate": "edited an agenda item",
  "agenda.itemRemove": "removed an agenda item",
  "agenda.ack": "recorded a slot acknowledgement",
  "cfp.manualAdd": "added a proposal by hand",
  "cfp.publishForm": "published the call for speakers",
  "cfp.reopenProposal": "reopened a proposal for editing",
  "cfp.submit": "submitted a proposal",
  "cfp.withdraw": "withdrew a proposal",
  "comms.sendOneOff": "sent a one-off message",
  "decision.correct": "corrected a released decision",
  "decision.release": "released a decision",
  "decision.stage": "staged a decision",
  "decision.unstaged": "took a decision back out of the queue",
  "event.archive": "archived the event",
  "event.unarchive": "unarchived the event",
  "event.updateSettings": "changed the event settings",
  "import.confirm": "confirmed an import",
  "import.start": "started an import",
  "participation.setState": "changed a speaker's participation",
  "portal.claim": "claimed their speaker portal",
  "portal.invite": "invited a speaker to the portal",
  "portal.updateProfile": "updated a speaker profile",
  "portal.updateSession": "edited session content from the portal",
  "portal.withdraw": "withdrew from a session",
  "publish.lineup": "published or unpublished the lineup",
  "publish.agenda": "published or unpublished the schedule",
  "publish.session": "changed a session's publish toggle",
  "publish.bulkLineup": "published everything eligible to the lineup",
  "publish.bulkAgenda": "published everything eligible to the schedule",
  "review.assign": "assigned a review",
  "review.autoDistribute": "auto-distributed review assignments",
  "review.conflict": "declared a conflict of interest",
  "review.remind": "reminded reviewers",
  "review.roundCreate": "created a review round",
  "review.roundUpdate": "changed a review round",
  "review.submit": "submitted a review",
  "review.unassign": "unassigned a review",
  "reminders.sendOutstandingNow": "sent reminders for outstanding tasks",
  "session.directInvite": "invited a speaker directly",
  "sessions.setContentStatus": "changed a session's content status",
  "sessions.updateContent": "edited a session's content",
  "speakers.import": "imported speakers",
  "speakers.updateProfile": "updated a speaker profile",
  "task.approve": "approved a task",
  "task.comment": "commented on a task",
  "task.markProvided": "marked a task as provided",
  "task.markNotApplicable": "marked a task not applicable",
  "task.reopen": "reopened a task",
  "task.requestChanges": "requested changes on a task",
  "task.requirementCreate": "created a speaker requirement",
  "task.requirementUpdate": "changed a speaker requirement",
  "task.upload": "uploaded a file",
  "team.invite": "invited a team member",
  "team.acceptInvitation": "accepted a team invitation",
  "team.removeMember": "removed a team member",
};

/**
 * The honest fallback for a code this build has never heard of.
 *
 * "jordan did agenda.somethingNew" is worse than useless, so the code is
 * turned into words: the dotted segments become a phrase, camelCase is split,
 * and the result is clearly marked as a recorded action rather than dressed up
 * as a sentence somebody wrote.
 */
export function genericClause(action: string): string {
  const words = action
    .split(".")
    .flatMap((part) => part.replace(/([a-z\d])([A-Z])/g, "$1 $2").split(/[_\-\s]+/))
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== "");
  return words.length === 0
    ? "performed a recorded action"
    : `performed a recorded action: ${words.join(" ")}`;
}

/** Target type → the tab that shows that record. Unknown types get no link. */
const TARGET_TAB: Record<string, ControlTab> = {
  session: "sessions",
  proposal: "proposals",
  taskInstance: "tasks",
  requirement: "tasks",
  eventContact: "speakers",
  sessionParticipant: "speakers",
  agendaItem: "agenda",
  review: "reviews",
  reviewRound: "reviews",
  cfpForms: "cfp",
  emailTemplate: "comms",
  embed: "publish",
  event: "details",
  invitation: "team",
  eventMembers: "team",
  user: "team",
};

export function changeSentence(actor: string | null, action: string): string {
  const clause = ACTION_CLAUSE[action] ?? genericClause(action);
  return `${actor ?? "Someone"} ${clause}.`;
}

export async function recentChanges(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<{ rows: ChangeRow[]; capped: boolean }> {
  requireOrganizer(caller);
  const { rows, capped } = await takeCapped(
    ctx.db
      .query("auditLog")
      .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
      .order("desc"),
    CHANGES_LIMIT,
  );

  // One name lookup per DISTINCT actor, not per row: a bulk action writes many
  // rows for one person and this panel is subscribed live.
  const actorIds = [...new Set(rows.map((row) => row.actorUserId))].slice(
    0,
    ACTOR_LIMIT,
  );
  const names = new Map<Id<"users">, string | null>();
  await Promise.all(
    actorIds.map(async (userId) => {
      const user = await ctx.db.get("users", userId);
      names.set(
        userId,
        await eventUserDisplayName(ctx, caller.event._id, user),
      );
    }),
  );

  return {
    rows: rows.map((row) => {
      const actor = names.get(row.actorUserId) ?? null;
      const tab =
        row.targetType === undefined ? undefined : TARGET_TAB[row.targetType];
      return {
        auditId: row._id,
        at: row._creationTime,
        actor,
        viaAgent: row.viaAgent === true,
        action: row.action,
        sentence: changeSentence(actor, row.action),
        link: tab === undefined ? null : { tab },
      };
    }),
    capped,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PANEL 4 — "What happens next"
//
// Dated milestones the organizer cannot change by working harder, plus the
// publication state of each channel with its attribution. The "last published
// by … at …" line has ONE producer, here, so the control center and W10's
// publish center cannot end up saying different things about the same row.
// ─────────────────────────────────────────────────────────────────────────

export type Milestone = {
  id: "cfpOpens" | "cfpCloses" | "eventStarts" | "eventEnds";
  label: string;
  at: number;
  past: boolean;
  sentence: string;
};

export type ChannelState = {
  id: "lineup" | "agenda";
  label: string;
  published: boolean;
  /** Composed here — includes the attribution when there is one. */
  sentence: string;
  link: ControlLink;
};

export type UpNext = {
  milestones: Milestone[];
  channels: ChannelState[];
  /** The published projection's own version, or null if never published. */
  version: number | null;
};

export async function upNext(
  ctx: QueryCtx,
  caller: EventCaller,
  now: number,
): Promise<UpNext> {
  requireOrganizer(caller);
  const event = caller.event;
  const [flags, published] = await Promise.all([
    publicationFlags(ctx, event._id),
    ctx.db
      .query("publishedPrograms")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .unique(),
  ]);

  // Each milestone carries BOTH tenses, because a timeline shows the ones
  // already behind you as well: "the CFP closes in 6 days" and "the CFP closed
  // 6 days ago" are the same row on different sides of `now`, and picking the
  // wrong verb is the kind of small lie that costs the whole screen its
  // credibility.
  const MILESTONES: Array<{
    id: Milestone["id"];
    label: string;
    at: number | undefined;
    future: string;
    past: string;
  }> = [
    {
      id: "cfpOpens",
      label: "Call for speakers opens",
      at: event.cfpOpenAt,
      future: "The call for speakers opens",
      past: "The call for speakers opened",
    },
    {
      id: "cfpCloses",
      label: "Call for speakers closes",
      at: event.cfpCloseAt,
      future: "The call for speakers closes",
      past: "The call for speakers closed",
    },
    {
      id: "eventStarts",
      label: "Event starts",
      at: event.startsAt,
      future: "The event starts",
      past: "The event started",
    },
    {
      id: "eventEnds",
      label: "Event ends",
      at: event.endsAt,
      future: "The event ends",
      past: "The event ended",
    },
  ];

  const milestones: Milestone[] = MILESTONES.filter(
    (m): m is typeof m & { at: number } => m.at !== undefined,
  )
    .map((m) => {
      const past = m.at <= now;
      return {
        id: m.id,
        label: m.label,
        at: m.at,
        past,
        sentence: `${past ? m.past : m.future} ${relativeTime(m.at, now)}.`,
      };
    })
    // Chronological, so the list reads as a timeline and "what happens next"
    // is simply the first row that is not past.
    .sort((a, b) => a.at - b.at);

  // Attribution. `publishedBy` is only set by an EXPLICIT organizer publish
  // (model/publish.ts): a forced propagation leaves it alone, so the name here
  // is always somebody who chose to publish, never a side effect wearing a
  // person's name.
  let attribution = "";
  if (published !== null) {
    const user = await ctx.db.get("users", published.publishedBy);
    const name = await eventUserDisplayName(ctx, event._id, user);
    attribution =
      name === null
        ? ` Last published ${relativeTime(published.publishedAt, now)}; the account that published it is no longer attributable.`
        : ` Last published by ${name} ${relativeTime(published.publishedAt, now)}.`;
  }

  const lineupPublished = event.publicPageEnabled === true;
  const agendaPublished = isPublished(flags, "agenda", "event", false);
  const channels: ChannelState[] = [
    {
      id: "lineup",
      label: "Lineup",
      published: lineupPublished,
      sentence:
        (lineupPublished
          ? "The public page is on, so the lineup is being served."
          : "The public page is off, so no lineup is being served.") +
        attribution,
      link: { tab: "publish" },
    },
    {
      id: "agenda",
      label: "Schedule",
      published: agendaPublished,
      sentence:
        (agendaPublished
          ? "The schedule is published, so released slots are public."
          : "The schedule is not published, so no times are public.") +
        attribution,
      link: { tab: "publish" },
    },
  ];

  return { milestones, channels, version: published?.version ?? null };
}
