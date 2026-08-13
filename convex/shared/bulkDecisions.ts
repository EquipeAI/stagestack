// The arithmetic of a bulk decision action, stated once.
//
// W5: a bulk bar has to say what it is about to do (how many are selected, how
// many are eligible, what is excluded and why, what the result will be) and
// then what it did. Both halves have to agree with the mutation that actually
// runs, so the eligibility RULES live here and `convex/model/sessions.ts`
// imports them — the same shared-module pattern as `formDef`, `scorecard`,
// `importPlan` and `sessionContent`. Nothing in this file touches ctx or the
// database, so the organizer's browser can state the plan before the call and
// the backend can enforce exactly the same rule when the call lands.
import type { Doc } from "../_generated/dataModel";

/** Derived from the schema, not hand-declared: a new proposal status breaks
 * every consumer at compile time instead of drifting across three literal
 * unions kept in step by hand. */
export type ProposalStatus = Doc<"proposals">["status"];

export type StageTarget = "pending" | "acceptQueue" | "declineQueue";

/** Statuses a staged decision may move between. Draft/withdrawn/decided
 * proposals are not stageable. */
export const STAGEABLE_STATUSES: ReadonlySet<ProposalStatus> = new Set([
  "pending",
  "acceptQueue",
  "declineQueue",
]);

/** Statuses a release can act on: a decision must be staged before it leaves
 * the building. */
export const RELEASABLE_STATUSES: ReadonlySet<ProposalStatus> = new Set([
  "acceptQueue",
  "declineQueue",
]);

export type BulkAction =
  | { kind: "stage"; to: StageTarget }
  | { kind: "release" };

export type Exclusion = { count: number; reason: string };

export type BulkPlan = {
  /** Rows the organizer ticked. */
  selected: number;
  /** Rows this action can act on at all. */
  eligible: number;
  /** Eligible rows already in the requested state — acted on, nothing moves. */
  unchanged: number;
  /** Rows that will change, i.e. the expected result. */
  willChange: number;
  /** Ineligible rows, grouped by the reason they are ineligible. */
  excluded: Array<Exclusion>;
  /** Release only: the split that decides who gets which email. */
  acceptQueue: number;
  declineQueue: number;
};

const TARGET_LABEL: Record<StageTarget, string> = {
  pending: "Submitted",
  acceptQueue: "the accept queue",
  declineQueue: "the decline queue",
};

/** Why a status cannot take part, in the words the organizer should read. */
function exclusionReason(status: ProposalStatus, action: BulkAction): string {
  if (action.kind === "release") {
    if (status === "draft") return "still a draft — never submitted";
    if (status === "pending") return "not staged for a decision yet";
    if (status === "accepted" || status === "declined") {
      return "already released — correct it individually instead";
    }
    return "withdrawn";
  }
  if (status === "draft") return "still a draft — never submitted";
  if (status === "accepted" || status === "declined") {
    return "already released — correct it individually instead";
  }
  return "withdrawn";
}

function countBy(reasons: Array<string>): Array<Exclusion> {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => ({ count, reason }));
}

export function planBulk(
  statuses: ReadonlyArray<ProposalStatus>,
  action: BulkAction,
): BulkPlan {
  const eligibleSet =
    action.kind === "release" ? RELEASABLE_STATUSES : STAGEABLE_STATUSES;
  const eligible = statuses.filter((s) => eligibleSet.has(s));
  const excludedReasons = statuses
    .filter((s) => !eligibleSet.has(s))
    .map((s) => exclusionReason(s, action));
  const unchanged =
    action.kind === "stage"
      ? eligible.filter((s) => s === action.to).length
      : 0;
  return {
    selected: statuses.length,
    eligible: eligible.length,
    unchanged,
    willChange: eligible.length - unchanged,
    excluded: countBy(excludedReasons),
    acceptQueue: eligible.filter((s) => s === "acceptQueue").length,
    declineQueue: eligible.filter((s) => s === "declineQueue").length,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The BEFORE statement: selection, eligibility, exclusions, expected result. */
export function planLines(plan: BulkPlan, action: BulkAction): Array<string> {
  const lines: Array<string> = [
    `${plural(plan.selected, "proposal", "proposals")} selected · ${plan.eligible} eligible.`,
  ];
  if (action.kind === "release") {
    lines.push(
      `${plan.acceptQueue} in the accept queue — each becomes a session and its speakers are emailed an invitation.`,
      `${plan.declineQueue} in the decline queue — each submitter is emailed the decline.`,
    );
  } else {
    lines.push(
      `${plural(plan.willChange, "proposal moves", "proposals move")} to ${TARGET_LABEL[action.to]}.`,
    );
    if (plan.unchanged > 0) {
      lines.push(`${plan.unchanged} already there — nothing changes for them.`);
    }
  }
  for (const item of plan.excluded) {
    lines.push(
      `${plural(item.count, "proposal is", "proposals are")} ${item.reason} — left alone.`,
    );
  }
  return lines;
}

/** Stable per-id error codes returned by the bulk mutations. */
export type BulkResultLike = { ok: boolean; error?: string };

export type BulkOutcome = {
  requested: number;
  succeeded: number;
  failed: number;
  byError: Array<Exclusion>;
};

const ERROR_SENTENCE: Record<string, string> = {
  not_found: "no longer exist on this event",
  invalid_status: "moved out of an eligible state before the action ran",
};

/** The AFTER statement, derived from the mutation's own per-id results — so
 * the outcome the organizer reads is the outcome the database recorded. */
export function summarizeBulk(
  results: ReadonlyArray<BulkResultLike>,
): BulkOutcome {
  const failed = results.filter((r) => !r.ok);
  return {
    requested: results.length,
    succeeded: results.length - failed.length,
    failed: failed.length,
    byError: countBy(
      failed.map(
        (r) => ERROR_SENTENCE[r.error ?? ""] ?? "were refused by the server",
      ),
    ),
  };
}

export function outcomeLines(outcome: BulkOutcome): Array<string> {
  const lines = [
    `${plural(outcome.succeeded, "proposal", "proposals")} changed of ${outcome.requested} attempted.`,
  ];
  for (const item of outcome.byError) {
    lines.push(`${plural(item.count, "proposal", "proposals")} ${item.reason}.`);
  }
  return lines;
}
