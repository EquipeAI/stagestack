import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import {
  REVIEW_SCAN,
} from "../lib/readCaps";
import { logAudit } from "./audit";
import type { AnswerValue, FormDef } from "../shared/formDef";
import { findForm } from "./cfpForms";
import {
  MAX_SCORECARD_FIELDS,
  answerProblem,
  legacyAnswers,
  legacyScorecard,
  recommendationFromAnswers,
  reviewWeightedScore,
  type ReviewAnswers,
  type ScorecardField,
} from "../shared/scorecard";
import { sendLoggedEmail, siteUrl } from "./comms";

// ─────────────────────────────────────────────────────────────────────────
// Review & evaluation (M2). One `reviews` row per (proposal, reviewer) pair,
// created by the assignment and carrying the evaluation through its lifecycle
// (assigned → draft → submitted → locked).
//
// The privacy contract this file enforces (MILESTONES M2):
//   * "Reviewers have no access to unassigned submissions unless they also
//     hold an organizer role" — there is deliberately NO reviewer-facing
//     proposal-by-id capability; `myAssignments` is the only door.
//   * "they can see evaluation content and speaker professional identity, but
//     not contact details" — the non-blind speaker projection carries
//     name/tagline/bio and never email or phone. Blind rounds also remove every
//     answer from the form section that owns the locked identity fields.
//   * "Reviewers see only their own scores/comments" — every reviewer-facing
//     write and read is scoped to `caller.user`.
//   * "organizers see progress status, not unfinished content" — draft scores
//     and comments are withheld from the organizer summary until submitted.
//
// Every mutating capability re-checks the caller's role itself even when the
// public wrapper already did: model functions are called directly by the M2
// Import agent adapter, which must not be able to bypass a wrapper.
// ─────────────────────────────────────────────────────────────────────────

const MAX_BULK = 500;
/** Ceiling for the event-wide review scans backing the progress map. */
const REVIEW_SUMMARY_SCAN = 200;
const MAX_SPEAKERS_PER_PROPOSAL = 40;

function assertCompleteScan(
  rows: unknown[],
  limit: number,
  what: string,
): void {
  if (rows.length > limit) {
    throw new ConvexError({
      code: "event_too_large",
      message: `This event has more than ${limit} ${what}. The operation is refused rather than using a partial result.`,
    });
  }
}

/**
 * Review rounds are independent of the decision pipeline. Any proposal that
 * was submitted may enter another round even after its Accepted/Declined
 * decision was released; assigning review work must never rewrite or reopen
 * that decision. Drafts were never submitted, and withdrawn proposals remain
 * terminal and absent from active reviewer queues.
 */
function canEnterReviewRound(proposal: Doc<"proposals">): boolean {
  return proposal.status !== "draft" && proposal.status !== "withdrawn";
}

import { assertEventActive } from "./validation";
export { assertEventActive };

export type ReviewStatus = Doc<"reviews">["status"];
export type Recommendation = NonNullable<Doc<"reviews">["recommendation"]>;

function invalidStatus(message: string): never {
  throw new ConvexError({ code: "invalid_status", message });
}

function assertBulkSize(ids: ReadonlyArray<unknown>): void {
  if (ids.length === 0) {
    throw new ConvexError({
      code: "empty_selection",
      message: "Select at least one proposal.",
    });
  }
  if (ids.length > MAX_BULK) {
    throw new ConvexError({
      code: "too_many",
      message: `At most ${MAX_BULK} proposals at a time.`,
    });
  }
}

// ── Rounds (W2) ──────────────────────────────────────────────────────────

const MAX_ROUNDS = 20;
const MAX_POOL = 200;

export type RoundInfo = {
  roundId: Id<"reviewRounds"> | null;
  name: string;
  order: number;
  opensAt?: number;
  closesAt?: number;
  anonymized: boolean;
  reviewerCap?: number;
  scorecard: ScorecardField[];
  /** True only while the launch flow is still building this round (W11). */
  draft: boolean;
};

/** The events that predate rounds behave as one implicit round carrying the
 * old fixed scorecard. Reads use this; the first write materializes it. */
function virtualLegacyRound(): RoundInfo {
  return {
    roundId: null,
    name: "Initial Review",
    order: 0,
    anonymized: false,
    scorecard: legacyScorecard(),
    draft: false,
  };
}

export async function listRoundDocs(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Array<Doc<"reviewRounds">>> {
  const rounds = await ctx.db
    .query("reviewRounds")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .take(MAX_ROUNDS + 1);
  assertCompleteScan(rounds, MAX_ROUNDS, "review rounds");
  return rounds.sort((a, b) => a.order - b.order);
}

/**
 * A round the launch flow is still building (W11). ABSENCE of the marker
 * means launched, so every row written before the field existed reads as a
 * live round and nothing had to be migrated.
 */
export function isDraftRound(round: Doc<"reviewRounds">): boolean {
  return round.draft === true;
}

/** Every round that actually governs review work. This is what the reviewer
 * queue, the progress board, auto-distribute and the legacy-row fallback all
 * read; the organizer's plan list is the ONE surface that also sees drafts. */
export async function launchedRoundDocs(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Array<Doc<"reviewRounds">>> {
  return (await listRoundDocs(ctx, eventId)).filter(
    (round) => !isDraftRound(round),
  );
}

/** A draft round is a plan, not a policy — nothing may assign through it
 * until the flow launches it. */
function assertLaunchedRound(round: Doc<"reviewRounds">): void {
  if (isDraftRound(round)) {
    invalidStatus(
      `"${round.name}" has not been launched yet — finish its launch flow before assigning to it.`,
    );
  }
}

function roundInfo(round: Doc<"reviewRounds">): RoundInfo {
  return {
    roundId: round._id,
    name: round.name,
    order: round.order,
    opensAt: round.opensAt,
    closesAt: round.closesAt,
    anonymized: round.anonymized,
    reviewerCap: round.reviewerCap,
    scorecard: round.scorecard,
    draft: isDraftRound(round),
  };
}

/** Resolve a review row to its round; rows without roundId read through the
 * event's first round (or the virtual legacy one). */
function roundForReview(
  review: Doc<"reviews">,
  rounds: Array<Doc<"reviewRounds">>,
): RoundInfo {
  if (review.roundId !== undefined) {
    const round = rounds.find((r) => r._id === review.roundId);
    if (round !== undefined) return roundInfo(round);
  }
  return rounds.length > 0 ? roundInfo(rounds[0]) : virtualLegacyRound();
}

/** The round new assignments land in when none is named. Materializes the
 * legacy round on first use so pools/scorecards have a real row to edit. */
async function defaultRound(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<Doc<"reviewRounds">> {
  const rounds = await launchedRoundDocs(ctx, event._id);
  if (rounds.length > 0) return rounds[0];
  const id = await ctx.db.insert("reviewRounds", {
    eventId: event._id,
    name: "Initial Review",
    order: 0,
    anonymized: false,
    scorecard: legacyScorecard(),
    updatedAt: Date.now(),
  });
  const created = await ctx.db.get("reviewRounds", id);
  if (created === null) notFound("round", "Round creation failed.");
  return created;
}

function assertScorecard(scorecard: ScorecardField[]): void {
  if (scorecard.length === 0 || scorecard.length > MAX_SCORECARD_FIELDS) {
    throw new ConvexError({
      code: "invalid_scorecard",
      message: `A scorecard needs 1 to ${MAX_SCORECARD_FIELDS} criteria.`,
    });
  }
  const seen = new Set<string>();
  for (const field of scorecard) {
    if (field.id.trim() === "" || field.label.trim() === "") {
      throw new ConvexError({
        code: "invalid_scorecard",
        message: "Every criterion needs an id and a label.",
      });
    }
    if (seen.has(field.id)) {
      throw new ConvexError({
        code: "invalid_scorecard",
        message: "Criterion ids must be unique.",
      });
    }
    seen.add(field.id);
    if (field.kind === "numeric") {
      const min = field.min ?? 1;
      const max = field.max ?? 5;
      if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max) {
        throw new ConvexError({
          code: "invalid_scorecard",
          message: `"${field.label}": the numeric range must be whole numbers with min < max.`,
        });
      }
      if (field.weight !== undefined && !(field.weight > 0)) {
        throw new ConvexError({
          code: "invalid_scorecard",
          message: `"${field.label}": a weight must be positive.`,
        });
      }
    }
    if (field.kind === "dropdown") {
      const options = field.options ?? [];
      if (options.length < 2 || options.some((o) => o.trim() === "")) {
        throw new ConvexError({
          code: "invalid_scorecard",
          message: `"${field.label}": a dropdown needs at least two non-empty options.`,
        });
      }
    }
  }
}

export type RoundInput = {
  name: string;
  opensAt?: number;
  closesAt?: number;
  anonymized: boolean;
  reviewerCap?: number;
  scorecard: ScorecardField[];
  /** Create it as a draft: the launch flow materializes the round before the
   * organizer has decided anything, and a half-built round must not govern
   * review work. Only `launchRound` clears it. */
  draft?: boolean;
};

function assertRoundInput(input: RoundInput): void {
  if (input.name.trim() === "" || input.name.length > 120) {
    throw new ConvexError({
      code: "invalid_round",
      message: "A round needs a name of at most 120 characters.",
    });
  }
  if (
    input.opensAt !== undefined &&
    input.closesAt !== undefined &&
    input.closesAt <= input.opensAt
  ) {
    throw new ConvexError({
      code: "invalid_round",
      message: "A round must close after it opens.",
    });
  }
  if (
    input.reviewerCap !== undefined &&
    (!Number.isInteger(input.reviewerCap) || input.reviewerCap < 1)
  ) {
    throw new ConvexError({
      code: "invalid_round",
      message: "The per-reviewer cap must be a whole number of at least 1.",
    });
  }
  assertScorecard(input.scorecard);
}

export async function createRound(
  ctx: MutationCtx,
  caller: EventCaller,
  input: RoundInput,
): Promise<Id<"reviewRounds">> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  assertRoundInput(input);
  const rounds = await listRoundDocs(ctx, caller.event._id);
  if (rounds.length >= MAX_ROUNDS) {
    throw new ConvexError({
      code: "too_many",
      message: `At most ${MAX_ROUNDS} rounds per event.`,
    });
  }
  const id = await ctx.db.insert("reviewRounds", {
    eventId: caller.event._id,
    name: input.name.trim(),
    order: rounds.length === 0 ? 0 : rounds[rounds.length - 1].order + 1,
    opensAt: input.opensAt,
    closesAt: input.closesAt,
    anonymized: input.anonymized,
    reviewerCap: input.reviewerCap,
    scorecard: input.scorecard,
    draft: input.draft === true ? true : undefined,
    updatedAt: Date.now(),
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.roundCreate",
    targetType: "reviewRound",
    targetId: id,
    meta: { name: input.name },
  });
  return id;
}

async function requireRound(
  ctx: QueryCtx,
  caller: EventCaller,
  roundId: Id<"reviewRounds">,
): Promise<Doc<"reviewRounds">> {
  const round = await ctx.db.get("reviewRounds", roundId);
  if (round === null || round.eventId !== caller.event._id) {
    notFound("round", "No such review round on this event.");
  }
  return round;
}

export async function updateRound(
  ctx: MutationCtx,
  caller: EventCaller,
  roundId: Id<"reviewRounds">,
  input: RoundInput,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  await requireRound(ctx, caller, roundId);
  assertRoundInput(input);
  await ctx.db.patch("reviewRounds", roundId, {
    name: input.name.trim(),
    opensAt: input.opensAt,
    closesAt: input.closesAt,
    anonymized: input.anonymized,
    reviewerCap: input.reviewerCap,
    scorecard: input.scorecard,
    updatedAt: Date.now(),
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.roundUpdate",
    targetType: "reviewRound",
    targetId: roundId,
    meta: { name: input.name },
  });
}

async function completeRoundPool(
  ctx: QueryCtx,
  roundId: Id<"reviewRounds">,
): Promise<Array<Doc<"roundReviewers">>> {
  const pool = await ctx.db
    .query("roundReviewers")
    .withIndex("by_roundId_and_userId", (q) => q.eq("roundId", roundId))
    .take(MAX_POOL + 1);
  assertCompleteScan(pool, MAX_POOL, "reviewers in one round");
  return pool;
}

export async function deleteRound(
  ctx: MutationCtx,
  caller: EventCaller,
  roundId: Id<"reviewRounds">,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  await requireRound(ctx, caller, roundId);
  // A round with review rows is history, not clutter. Legacy rows (no
  // roundId) read through the FIRST round, so deleting that round would
  // silently reinterpret them under another scorecard — refuse that too.
  const rounds = await launchedRoundDocs(ctx, caller.event._id);
  const isFirst = rounds.length > 0 && rounds[0]._id === roundId;
  const anyReview = await ctx.db
    .query("reviews")
    .withIndex("by_eventId_and_reviewerUserId", (q) =>
      q.eq("eventId", caller.event._id),
    )
    .take(REVIEW_SCAN + 1);
  assertCompleteScan(anyReview, REVIEW_SCAN, "reviews");
  if (
    anyReview.some(
      (r) => r.roundId === roundId || (isFirst && r.roundId === undefined),
    )
  ) {
    invalidStatus("This round has reviews — it can't be deleted.");
  }
  const pool = await completeRoundPool(ctx, roundId);
  for (const member of pool) {
    await ctx.db.delete("roundReviewers", member._id);
  }
  await ctx.db.delete("reviewRounds", roundId);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.roundDelete",
    targetType: "reviewRound",
    targetId: roundId,
    meta: {},
  });
}

export type PoolMember = {
  userId: Id<"users">;
  name: string | null;
  email: string | null;
};

export type RoundListEntry = RoundInfo & {
  roundId: Id<"reviewRounds">;
  pool: PoolMember[];
};

/** Rounds with their pools, for the evaluation-plan screen. */
export async function listRounds(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<RoundListEntry[]> {
  requireOrganizer(caller);
  const rounds = await listRoundDocs(ctx, caller.event._id);
  const out: RoundListEntry[] = [];
  for (const round of rounds) {
    const pool = await completeRoundPool(ctx, round._id);
    const members: PoolMember[] = [];
    for (const member of pool) {
      const user = await ctx.db.get("users", member.userId);
      members.push({
        userId: member.userId,
        name: user?.name ?? null,
        email: user?.email ?? null,
      });
    }
    out.push({ ...roundInfo(round), roundId: round._id, pool: members });
  }
  return out;
}

async function ensurePoolMembership(
  ctx: MutationCtx,
  eventId: Id<"events">,
  roundId: Id<"reviewRounds">,
  userId: Id<"users">,
): Promise<void> {
  const existing = await ctx.db
    .query("roundReviewers")
    .withIndex("by_roundId_and_userId", (q) =>
      q.eq("roundId", roundId).eq("userId", userId),
    )
    .unique();
  if (existing === null) {
    const pool = await completeRoundPool(ctx, roundId);
    if (pool.length >= MAX_POOL) {
      throw new ConvexError({
        code: "reviewer_pool_full",
        message: `A review round can have at most ${MAX_POOL} reviewers.`,
      });
    }
    await ctx.db.insert("roundReviewers", { eventId, roundId, userId });
  }
}

export async function addRoundReviewer(
  ctx: MutationCtx,
  caller: EventCaller,
  roundId: Id<"reviewRounds">,
  userId: Id<"users">,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  await requireRound(ctx, caller, roundId);
  await assertCanReview(ctx, caller.event, userId);
  await ensurePoolMembership(ctx, caller.event._id, roundId, userId);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.poolAdd",
    targetType: "user",
    targetId: userId,
    meta: { roundId },
  });
}

export async function removeRoundReviewer(
  ctx: MutationCtx,
  caller: EventCaller,
  roundId: Id<"reviewRounds">,
  userId: Id<"users">,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  await requireRound(ctx, caller, roundId);
  const existing = await ctx.db
    .query("roundReviewers")
    .withIndex("by_roundId_and_userId", (q) =>
      q.eq("roundId", roundId).eq("userId", userId),
    )
    .unique();
  if (existing !== null) await ctx.db.delete("roundReviewers", existing._id);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.poolRemove",
    targetType: "user",
    targetId: userId,
    meta: { roundId },
  });
}

// ── Assignment ───────────────────────────────────────────────────────────

/** The event roles a reviewer assignment may target: an assigned reviewer, or
 * an organizer reviewing alongside the team. */
async function assertCanReview(
  ctx: QueryCtx,
  event: Doc<"events">,
  userId: Id<"users">,
): Promise<void> {
  const orgMembership = await ctx.db
    .query("members")
    .withIndex("by_orgId_and_userId", (q) =>
      q.eq("orgId", event.orgId).eq("userId", userId),
    )
    .unique();
  // Org owners/admins organize every event in the org.
  if (orgMembership !== null) return;
  const eventMembership = await ctx.db
    .query("eventMembers")
    .withIndex("by_eventId_and_userId", (q) =>
      q.eq("eventId", event._id).eq("userId", userId),
    )
    .unique();
  if (eventMembership === null) {
    throw new ConvexError({
      code: "invalid_reviewer",
      message: "That person isn't on this event's team.",
    });
  }
}

export type AssignResult = { assigned: number; skipped: number };

/**
 * Bulk manual assignment (M2: "Manual reviewer assignment with individual and
 * bulk actions"). Existing (proposal, reviewer) pairs are skipped rather than
 * duplicated so re-running a bulk action is harmless.
 */
export async function assignReviewers(
  ctx: MutationCtx,
  caller: EventCaller,
  proposalIds: Array<Id<"proposals">>,
  reviewerUserId: Id<"users">,
  roundId?: Id<"reviewRounds">,
): Promise<AssignResult> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  assertBulkSize(proposalIds);
  await assertCanReview(ctx, caller.event, reviewerUserId);
  const round =
    roundId === undefined
      ? await defaultRound(ctx, caller.event)
      : await requireRound(ctx, caller, roundId);
  assertLaunchedRound(round);
  // Assignment implies pool membership — the pool is the source of truth for
  // auto-distribute and the progress board.
  await ensurePoolMembership(ctx, caller.event._id, round._id, reviewerUserId);

  // One scan of this reviewer's existing rows instead of a query per proposal.
  // Legacy rows (no roundId) belong to the FIRST round only — attributing
  // them to whichever round is being processed would corrupt later rounds'
  // dedupe (codex W2 review).
  const allRounds = await launchedRoundDocs(ctx, caller.event._id);
  const firstRoundId = allRounds[0]?._id;
  const existing = await ctx.db
    .query("reviews")
    .withIndex("by_eventId_and_reviewerUserId", (q) =>
      q.eq("eventId", caller.event._id).eq("reviewerUserId", reviewerUserId),
    )
    .take(REVIEW_SCAN + 1);
  assertCompleteScan(existing, REVIEW_SCAN, "reviews for one reviewer");
  const already = new Set(
    existing
      .filter((r) => (r.roundId ?? firstRoundId) === round._id)
      .map((r) => r.proposalId),
  );

  const now = Date.now();
  let assigned = 0;
  let skipped = 0;
  for (const proposalId of new Set(proposalIds)) {
    const proposal = await ctx.db.get("proposals", proposalId);
    if (proposal === null || proposal.eventId !== caller.event._id) {
      notFound("proposal", "No such proposal on this event.");
    }
    if (!canEnterReviewRound(proposal)) {
      invalidStatus(
        `"${proposal.title}" isn't in review (it is ${proposal.status}).`,
      );
    }
    if (already.has(proposalId)) {
      skipped += 1;
      continue;
    }
    await ctx.db.insert("reviews", {
      eventId: caller.event._id,
      proposalId,
      reviewerUserId,
      roundId: round._id,
      status: "assigned",
      contentVersion: proposal.contentVersion ?? 0,
      updatedAt: now,
    });
    assigned += 1;
  }

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.assign",
    targetType: "user",
    targetId: reviewerUserId,
    meta: {
      assigned,
      skipped,
      requested: proposalIds.length,
      roundId: round._id,
    },
  });
  return { assigned, skipped };
}

// ── The assignment planner (W11) ─────────────────────────────────────────
//
// ONE implementation of "who gets what". The launch summary reads it through
// a query, the launch mutation re-derives it before writing, and
// auto-distribute is the same planner with the preview step skipped — so the
// sentences an organizer approved and the rows that get inserted can never
// come from two different pieces of arithmetic (the W2 suggest/apply
// contract, including its stale-plan refusal).

export type PlannerInput = {
  round: Doc<"reviewRounds">;
  /** Pool membership, in pool order — the planner's tie-break order. */
  poolUserIds: Array<Id<"users">>;
  /** Reviewable proposals this run may touch. The planner canonicalizes the
   * order itself, so the same SET always produces the same plan however the
   * client happened to list it. */
  candidates: Array<Doc<"proposals">>;
  /** Every review row already attributed to this round. */
  roundReviews: Array<Doc<"reviews">>;
  perProposal: number;
};

export type PlannedAssignment = {
  proposalId: Id<"proposals">;
  title: string;
  reviewerUserId: Id<"users">;
};

export type DistributionPlan = {
  assignments: PlannedAssignment[];
  /** Review slots no eligible reviewer could take (everyone at the cap). */
  unplaced: number;
  perReviewer: Array<{ userId: Id<"users">; assigned: number; total: number }>;
  /** Candidates that already hold the reviews this round asks for. */
  alreadyCovered: number;
};

/**
 * Least-loaded-first distribution across the round's pool, respecting the
 * per-reviewer cap and never duplicating a (proposal, reviewer) pair.
 * Conflicted reviews keep the pair blocked but release the reviewer's cap and
 * the proposal's coverage, so a replacement can still be placed.
 *
 * Pure: it reads only its input and writes nothing, which is what lets the
 * preview and the mutation run the very same code.
 */
function planDistribution(input: PlannerInput): DistributionPlan {
  const { round, poolUserIds, roundReviews, perProposal } = input;
  // Canonical order, here rather than in the fingerprint: a plan is a
  // function of the SET of selected proposals, so two clients that name the
  // same proposals in a different order must get the same assignments — and
  // then the fingerprint agrees by construction rather than by luck.
  const candidates = [...input.candidates].sort((a, b) =>
    a._id < b._id ? -1 : a._id > b._id ? 1 : 0,
  );
  const load = new Map<Id<"users">, number>();
  for (const userId of poolUserIds) load.set(userId, 0);
  const pairs = new Set<string>();
  const covered = new Map<Id<"proposals">, number>();
  for (const review of roundReviews) {
    pairs.add(`${review.proposalId}:${review.reviewerUserId}`);
    if (review.status === "conflict") continue;
    if (load.has(review.reviewerUserId)) {
      load.set(
        review.reviewerUserId,
        (load.get(review.reviewerUserId) ?? 0) + 1,
      );
    }
    covered.set(review.proposalId, (covered.get(review.proposalId) ?? 0) + 1);
  }

  const cap = round.reviewerCap;
  const assignments: PlannedAssignment[] = [];
  const assignedPer = new Map<Id<"users">, number>();
  let unplaced = 0;
  let alreadyCovered = 0;
  for (const proposal of candidates) {
    let needed = perProposal - (covered.get(proposal._id) ?? 0);
    if (needed <= 0) {
      alreadyCovered += 1;
      continue;
    }
    while (needed > 0) {
      const target = poolUserIds
        .filter(
          (userId) =>
            !pairs.has(`${proposal._id}:${userId}`) &&
            (cap === undefined || (load.get(userId) ?? 0) < cap),
        )
        .sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0))[0];
      if (target === undefined) {
        unplaced += 1;
        break;
      }
      assignments.push({
        proposalId: proposal._id,
        title: proposal.title,
        reviewerUserId: target,
      });
      pairs.add(`${proposal._id}:${target}`);
      load.set(target, (load.get(target) ?? 0) + 1);
      assignedPer.set(target, (assignedPer.get(target) ?? 0) + 1);
      needed -= 1;
    }
  }

  return {
    assignments,
    unplaced,
    alreadyCovered,
    perReviewer: poolUserIds.map((userId) => ({
      userId,
      assigned: assignedPer.get(userId) ?? 0,
      total: load.get(userId) ?? 0,
    })),
  };
}

/**
 * FNV-1a over EVERYTHING `buildLaunchPlan` reads — the loader's output is the
 * dependency set, so the fingerprint is taken over a canonical rendering of
 * exactly that. Anything that shapes the plan (pool, candidates, existing
 * assignments, cap) or merely shapes the SENTENCES (scorecard, window, blind
 * flag, reviewer display names) is in here: launching must apply the plan the
 * organizer read, not a different one that happens to assign the same rows.
 */
function fingerprintOf(
  input: PlannerInput,
  names: Map<Id<"users">, string>,
): string {
  const canonical = JSON.stringify({
    round: {
      id: input.round._id,
      name: input.round.name,
      order: input.round.order,
      opensAt: input.round.opensAt ?? null,
      closesAt: input.round.closesAt ?? null,
      anonymized: input.round.anonymized,
      reviewerCap: input.round.reviewerCap ?? null,
      draft: isDraftRound(input.round),
      scorecard: input.round.scorecard,
    },
    perProposal: input.perProposal,
    pool: [...input.poolUserIds]
      .map((userId) => `${userId}:${names.get(userId) ?? ""}`)
      .sort(),
    candidates: input.candidates
      .map((p) => `${p._id}:${p.status}:${p.contentVersion ?? 0}`)
      .sort(),
    reviews: input.roundReviews
      .map((r) => `${r.proposalId}:${r.reviewerUserId}:${r.status}`)
      .sort(),
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Load exactly what the planner reads. Shared by the preview, the launch and
 * auto-distribute so all three see one world. */
async function loadPlannerInput(
  ctx: QueryCtx,
  caller: EventCaller,
  roundId: Id<"reviewRounds">,
  options: {
    proposalIds?: Array<Id<"proposals">>;
    perProposal?: number;
  },
): Promise<PlannerInput> {
  const round = await requireRound(ctx, caller, roundId);
  const pool = await completeRoundPool(ctx, round._id);
  // Mirror the client's rule rather than clamping it: clamping accepts a
  // NaN or a 1.5 the flow already refused, and then assigns something the
  // organizer never asked for.
  const perProposal = options.perProposal ?? 1;
  if (!Number.isInteger(perProposal) || perProposal < 1) {
    throw new ConvexError({
      code: "invalid_cap",
      message: "Reviews per proposal must be a whole number, at least 1.",
    });
  }

  let candidates: Array<Doc<"proposals">>;
  if (options.proposalIds !== undefined) {
    if (options.proposalIds.length > MAX_BULK) {
      throw new ConvexError({
        code: "too_many",
        message: `At most ${MAX_BULK} proposals at a time.`,
      });
    }
    candidates = [];
    for (const id of new Set(options.proposalIds)) {
      const proposal = await ctx.db.get("proposals", id);
      if (proposal === null || proposal.eventId !== caller.event._id) {
        notFound("proposal", "No such proposal on this event.");
      }
      if (canEnterReviewRound(proposal)) candidates.push(proposal);
    }
  } else {
    const all = await ctx.db
      .query("proposals")
      .withIndex("by_eventId_and_status", (q) =>
        q.eq("eventId", caller.event._id),
      )
      .take(REVIEW_SCAN + 1);
    assertCompleteScan(all, REVIEW_SCAN, "proposals");
    candidates = all.filter(canEnterReviewRound);
  }

  // Legacy rows (no roundId) belong to the FIRST round only — attributing
  // them to whichever round is being planned would corrupt later rounds.
  const allRounds = await launchedRoundDocs(ctx, caller.event._id);
  const firstRoundId = allRounds[0]?._id;
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_eventId_and_reviewerUserId", (q) =>
      q.eq("eventId", caller.event._id),
    )
    .take(REVIEW_SCAN + 1);
  assertCompleteScan(reviews, REVIEW_SCAN, "reviews");

  return {
    round,
    poolUserIds: pool.map((member) => member.userId),
    candidates,
    roundReviews: reviews.filter(
      (r) => (r.roundId ?? firstRoundId) === round._id,
    ),
    perProposal,
  };
}

export type DistributeResult = {
  assigned: number;
  perReviewer: Array<{ userId: Id<"users">; assigned: number; total: number }>;
  /** Proposals left unassigned because every pool member hit the cap. */
  unplaced: number;
};

/**
 * Auto-distribute (ABS-06): spread reviewable proposals across the round's
 * pool, least-loaded first, respecting the round's per-reviewer cap. Existing
 * (round, proposal, reviewer) pairs are never duplicated; proposals already
 * holding `perProposal` reviews in this round are skipped.
 */
export async function autoDistribute(
  ctx: MutationCtx,
  caller: EventCaller,
  roundId: Id<"reviewRounds">,
  options?: { proposalIds?: Array<Id<"proposals">>; perProposal?: number },
): Promise<DistributeResult> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  if (options?.proposalIds !== undefined) assertBulkSize(options.proposalIds);
  const input = await loadPlannerInput(ctx, caller, roundId, options ?? {});
  // A draft round is still being built in the launch flow — it assigns
  // nothing until the flow says so.
  assertLaunchedRound(input.round);
  if (input.poolUserIds.length === 0) {
    throw new ConvexError({
      code: "empty_pool",
      message: "Add at least one reviewer to this round first.",
    });
  }
  const plan = planDistribution(input);
  await writeAssignments(ctx, caller, input.round._id, plan);

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.autoDistribute",
    targetType: "reviewRound",
    targetId: input.round._id,
    meta: {
      assigned: plan.assignments.length,
      unplaced: plan.unplaced,
      candidates: input.candidates.length,
    },
  });
  return {
    assigned: plan.assignments.length,
    unplaced: plan.unplaced,
    perReviewer: plan.perReviewer,
  };
}

/** Insert exactly the rows a plan describes. The proposal is re-read so the
 * review is fenced to the content version that exists at write time. */
async function writeAssignments(
  ctx: MutationCtx,
  caller: EventCaller,
  roundId: Id<"reviewRounds">,
  plan: DistributionPlan,
): Promise<void> {
  const now = Date.now();
  for (const assignment of plan.assignments) {
    const proposal = await ctx.db.get("proposals", assignment.proposalId);
    if (proposal === null || proposal.eventId !== caller.event._id) {
      notFound("proposal", "No such proposal on this event.");
    }
    await ctx.db.insert("reviews", {
      eventId: caller.event._id,
      proposalId: assignment.proposalId,
      reviewerUserId: assignment.reviewerUserId,
      roundId,
      status: "assigned",
      contentVersion: proposal.contentVersion ?? 0,
      updatedAt: now,
    });
  }
}

// ── Launch summary & launch (W11) ────────────────────────────────────────
//
// The summary states consequences in SENTENCES, and it is composed here —
// one producer, over the same planner input the launch will act on. The
// client renders the strings; it never re-words a count, because a second
// author of the same fact is a second chance to be wrong.

export type LaunchPerReviewer = {
  userId: Id<"users">;
  name: string;
  assigned: number;
  total: number;
};

export type LaunchPlan = {
  /** Echo this back to `launchRound`; a mismatch refuses the write. */
  fingerprint: string;
  roundId: Id<"reviewRounds">;
  roundName: string;
  anonymized: boolean;
  reviewerCap: number | null;
  perProposal: number;
  poolSize: number;
  candidateCount: number;
  newAssignments: number;
  unplaced: number;
  alreadyCovered: number;
  /** Candidates receiving work whose Accept/Decline was already released. */
  decidedCount: number;
  perReviewer: LaunchPerReviewer[];
  /** The whole summary, ready to print. */
  sentences: string[];
};

function s(count: number): string {
  return count === 1 ? "" : "s";
}

/** "Both" / "All 4" / "2" — a summary reads like a sentence, not a report. */
function subject(count: number, total: number): string {
  if (count === total && count === 2) return "Both";
  if (count === total && count > 2) return `All ${count}`;
  return String(count);
}

function decidedSentence(decided: number, targeted: number): string | null {
  if (decided === 0) return null;
  if (decided === targeted && targeted === 1) {
    return "It already has a released decision; that decision will not change.";
  }
  if (decided === targeted) {
    return `${subject(decided, targeted)} already have released decisions; those decisions will not change.`;
  }
  return decided === 1
    ? "1 of them already has a released decision; that decision will not change."
    : `${decided} of them already have released decisions; those decisions will not change.`;
}

function blindSentence(anonymized: boolean): string {
  return anonymized
    ? "Reviewer identities are hidden: speaker names and every identity answer are removed from what reviewers see."
    : "Speaker identities are visible to reviewers — this round is not blind.";
}

function capSentence(cap: number | null): string {
  return cap === null
    ? "No per-reviewer cap: reviewers take as many proposals as the split gives them."
    : `Cap: ${cap} proposal${s(cap)} per reviewer.`;
}

function unplacedSentence(unplaced: number): string | null {
  return unplaced === 0
    ? null
    : `${unplaced} review slot${s(unplaced)} cannot be filled — every eligible reviewer is already at the cap.`;
}

/** The one reason nothing will happen, said plainly. */
function nothingToDoSentence(
  plan: Pick<
    LaunchPlan,
    "poolSize" | "candidateCount" | "alreadyCovered" | "unplaced"
  >,
  tense: "will" | "did",
): string {
  if (plan.poolSize === 0) {
    return "This round has no reviewers yet, so nothing will be assigned.";
  }
  if (plan.candidateCount === 0) {
    return "No proposals are selected, so nothing will be assigned.";
  }
  if (plan.alreadyCovered === plan.candidateCount) {
    const who = subject(plan.alreadyCovered, plan.candidateCount).toLowerCase();
    const noun = `selected proposal${s(plan.alreadyCovered)}`;
    const verb = plan.alreadyCovered === 1 ? "is" : "are";
    return tense === "will"
      ? `No new assignments: ${who} ${noun} ${verb} already assigned.`
      : `No new assignments: ${who} ${noun} ${verb} already assigned.`;
  }
  return "Nothing can be assigned: every eligible reviewer is already at the cap.";
}

function summarySentences(
  plan: Omit<LaunchPlan, "sentences">,
  targetedDecided: number,
  targetedProposals: number,
): string[] {
  const lines: string[] = [];
  if (plan.newAssignments === 0) {
    lines.push(nothingToDoSentence(plan, "will"));
  } else {
    for (const row of [...plan.perReviewer]
      .filter((row) => row.assigned > 0)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(
        `${row.assigned} proposal${s(row.assigned)} will be assigned to ${row.name}.`,
      );
    }
    const decided = decidedSentence(targetedDecided, targetedProposals);
    if (decided !== null) lines.push(decided);
  }
  lines.push(blindSentence(plan.anonymized));
  lines.push(capSentence(plan.reviewerCap));
  const unplaced = unplacedSentence(plan.unplaced);
  if (unplaced !== null) lines.push(unplaced);
  return lines;
}

function buildLaunchPlan(
  input: PlannerInput,
  names: Map<Id<"users">, string>,
): { plan: LaunchPlan; distribution: DistributionPlan } {
  const distribution = planDistribution(input);
  const targeted = new Set(distribution.assignments.map((a) => a.proposalId));
  const decidedCount = input.candidates.filter(
    (p) =>
      targeted.has(p._id) &&
      (p.status === "accepted" || p.status === "declined"),
  ).length;

  const base: Omit<LaunchPlan, "sentences"> = {
    fingerprint: fingerprintOf(input, names),
    roundId: input.round._id,
    roundName: input.round.name,
    anonymized: input.round.anonymized,
    reviewerCap: input.round.reviewerCap ?? null,
    perProposal: input.perProposal,
    poolSize: input.poolUserIds.length,
    candidateCount: input.candidates.length,
    newAssignments: distribution.assignments.length,
    unplaced: distribution.unplaced,
    alreadyCovered: distribution.alreadyCovered,
    decidedCount,
    perReviewer: distribution.perReviewer.map((row) => ({
      ...row,
      name: names.get(row.userId) ?? "a reviewer",
    })),
  };
  return {
    plan: {
      ...base,
      sentences: summarySentences(base, decidedCount, targeted.size),
    },
    distribution,
  };
}

async function poolNames(
  ctx: QueryCtx,
  userIds: Array<Id<"users">>,
): Promise<Map<Id<"users">, string>> {
  const names = new Map<Id<"users">, string>();
  for (const userId of userIds) {
    const user = await ctx.db.get("users", userId);
    names.set(userId, user?.name ?? user?.email ?? "a reviewer");
  }
  return names;
}

export type LaunchArgs = {
  roundId: Id<"reviewRounds">;
  proposalIds?: Array<Id<"proposals">>;
  perProposal?: number;
};

/** Preview: what launching this round would do, written nowhere. */
export async function previewLaunch(
  ctx: QueryCtx,
  caller: EventCaller,
  args: LaunchArgs,
): Promise<LaunchPlan> {
  requireOrganizer(caller);
  const input = await loadPlannerInput(ctx, caller, args.roundId, args);
  return buildLaunchPlan(input, await poolNames(ctx, input.poolUserIds)).plan;
}

export type LaunchOutcome = {
  assigned: number;
  unplaced: number;
  perReviewer: LaunchPerReviewer[];
  /** What happened, in sentences — the client prints these verbatim. */
  sentences: string[];
};

function outcomeSentences(plan: LaunchPlan): string[] {
  if (plan.newAssignments === 0) {
    const lines = [nothingToDoSentence(plan, "did")];
    const unplaced = unplacedSentence(plan.unplaced);
    if (unplaced !== null) lines.push(unplaced);
    return lines;
  }
  const lines = [
    `${plan.newAssignments} assignment${s(plan.newAssignments)} created across ${plan.candidateCount} selected proposal${s(plan.candidateCount)}.`,
  ];
  for (const row of [...plan.perReviewer]
    .filter((row) => row.assigned > 0)
    .sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(
      `${row.assigned} proposal${s(row.assigned)} assigned to ${row.name} — ${row.total} in this round in total.`,
    );
  }
  if (plan.alreadyCovered > 0) {
    lines.push(
      `${plan.alreadyCovered} selected proposal${s(plan.alreadyCovered)} ${plan.alreadyCovered === 1 ? "was" : "were"} already assigned and ${plan.alreadyCovered === 1 ? "was" : "were"} left alone.`,
    );
  }
  const decided = decidedSentence(plan.decidedCount, plan.newAssignments);
  if (plan.decidedCount > 0 && decided !== null) {
    lines.push(
      `${plan.decidedCount} of the newly assigned proposal${s(plan.decidedCount)} already ${plan.decidedCount === 1 ? "has a released decision; that decision was" : "have released decisions; those decisions were"} not changed.`,
    );
  }
  const unplaced = unplacedSentence(plan.unplaced);
  if (unplaced !== null) lines.push(unplaced);
  return lines;
}

/**
 * Launch: apply exactly the plan the summary described.
 *
 * The plan is re-derived from current state first. If anything the planner
 * reads moved between the preview and the launch — the pool, the selection,
 * the round's cap, another organizer's assignment — the write is refused
 * rather than assigning work the organizer never read a sentence about. The
 * FRESH plan is what gets written, so a doctored fingerprint cannot place
 * anything the planner would not.
 */
export async function launchRound(
  ctx: MutationCtx,
  caller: EventCaller,
  args: LaunchArgs & { fingerprint: string },
): Promise<LaunchOutcome> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  if (args.proposalIds !== undefined) assertBulkSize(args.proposalIds);
  const input = await loadPlannerInput(ctx, caller, args.roundId, args);
  if (input.poolUserIds.length === 0) {
    throw new ConvexError({
      code: "empty_pool",
      message: "Add at least one reviewer to this round first.",
    });
  }
  const { plan, distribution } = buildLaunchPlan(
    input,
    await poolNames(ctx, input.poolUserIds),
  );
  if (plan.fingerprint !== args.fingerprint) {
    throw new ConvexError({
      code: "plan_stale",
      message:
        "The round changed since this summary was composed, so nothing was assigned. Read the summary again to see what launching would do now.",
    });
  }

  // Written from the FRESH plan — never from the client's payload.
  await writeAssignments(ctx, caller, input.round._id, distribution);
  // Launching is what turns a draft round into a live one: from here it is
  // visible to reviewers, to the progress board and to the readiness counts.
  if (isDraftRound(input.round)) {
    await ctx.db.patch("reviewRounds", input.round._id, {
      draft: undefined,
      updatedAt: Date.now(),
    });
  }

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.launch",
    targetType: "reviewRound",
    targetId: input.round._id,
    meta: {
      assigned: plan.newAssignments,
      unplaced: plan.unplaced,
      candidates: plan.candidateCount,
      anonymized: plan.anonymized,
    },
  });

  return {
    assigned: plan.newAssignments,
    unplaced: plan.unplaced,
    perReviewer: plan.perReviewer,
    sentences: outcomeSentences(plan),
  };
}

export type EligibleProposal = {
  proposalId: Id<"proposals">;
  title: string;
  status: Doc<"proposals">["status"];
  /** Reviews this proposal already holds in this round. */
  assigned: number;
  decisionReleased: boolean;
};

/** The round's eligible set, for the flow's "which proposals" step. */
export async function eligibleProposals(
  ctx: QueryCtx,
  caller: EventCaller,
  roundId: Id<"reviewRounds">,
): Promise<EligibleProposal[]> {
  requireOrganizer(caller);
  const input = await loadPlannerInput(ctx, caller, roundId, {});
  const covered = new Map<Id<"proposals">, number>();
  for (const review of input.roundReviews) {
    if (review.status === "conflict") continue;
    covered.set(
      review.proposalId,
      (covered.get(review.proposalId) ?? 0) + 1,
    );
  }
  return input.candidates.map((proposal) => ({
    proposalId: proposal._id,
    title: proposal.title,
    status: proposal.status,
    assigned: covered.get(proposal._id) ?? 0,
    decisionReleased:
      proposal.status === "accepted" || proposal.status === "declined",
  }));
}

/** Undo an assignment. A submitted review is evidence and stays put. */
export async function unassignReviewer(
  ctx: MutationCtx,
  caller: EventCaller,
  reviewId: Id<"reviews">,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const review = await ctx.db.get("reviews", reviewId);
  if (review === null || review.eventId !== caller.event._id) {
    notFound("review", "No such review on this event.");
  }
  if (review.status !== "assigned" && review.status !== "draft") {
    invalidStatus("A submitted review can't be unassigned.");
  }
  await ctx.db.delete("reviews", reviewId);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.unassign",
    targetType: "review",
    targetId: reviewId,
    meta: {
      proposalId: review.proposalId,
      reviewerUserId: review.reviewerUserId,
    },
  });
}

// ── Reviewer's own work ──────────────────────────────────────────────────

/** Speaker fields a reviewer may see: professional identity only. */
export type ReviewerSpeaker = {
  firstName: string;
  lastName: string;
  tagline?: string;
  bio?: string;
};

export type ReviewerField = {
  id: string;
  label: string;
  kind: string;
};

export type AssignmentRow = {
  reviewId: Id<"reviews">;
  /** Proposal content revision this assignment currently evaluates. Every
   * reviewer write must echo it back as an optimistic-concurrency fence. */
  contentVersion: number;
  status: ReviewStatus;
  /** Scorecard answers (legacy rows are translated on read). */
  answers: ReviewAnswers;
  round: {
    roundId: Id<"reviewRounds"> | null;
    name: string;
    anonymized: boolean;
    opensAt?: number;
    closesAt?: number;
    scorecard: ScorecardField[];
  };
  proposal: {
    _id: Id<"proposals">;
    title: string;
    answers: Record<string, AnswerValue>;
    /** Published-form projection (evaluation fields only) so the UI can
     * label and order answers. Contact-detail fields are absent. */
    fields: ReviewerField[];
    /** Signed URLs for file-kind answers, keyed by storage id. */
    fileUrls: Record<string, string | null>;
    speakers: ReviewerSpeaker[];
  };
};

function reviewerSpeaker(row: Doc<"proposalSpeakers">): ReviewerSpeaker {
  // Deliberately NOT spread: email, phone, links and the submitter's identity
  // must not reach a reviewer.
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    tagline: row.tagline,
    bio: row.bio,
  };
}

const SPEAKER_IDENTITY_SYSTEM_KEYS: ReadonlySet<string> = new Set([
  "firstName",
  "lastName",
  "email",
]);

type ReviewerProjection = {
  fields: ReviewerField[];
  allowedIds: ReadonlySet<string>;
  fileFieldIds: ReadonlySet<string>;
};

/**
 * The form's locked identity fields establish a structural privacy boundary:
 * every custom question in that section belongs to the submitter/speaker
 * profile, regardless of its editable label. Blind rounds omit the whole
 * section, so an organizer-authored bio/company/role question cannot leak an
 * author identity. Non-blind rounds retain those professional-profile answers.
 */
function reviewerProjection(
  def: FormDef | undefined,
  anonymized: boolean,
): ReviewerProjection {
  const fields: ReviewerField[] =
    def === undefined
      ? []
      : def.sections.flatMap((section) => {
          const identitySection = section.fields.some(
            (field) =>
              field.systemKey !== undefined &&
              SPEAKER_IDENTITY_SYSTEM_KEYS.has(field.systemKey),
          );
          if (anonymized && identitySection) return [];
          return section.fields
            .filter(
              (field) =>
                field.systemKey !== "firstName" &&
                field.systemKey !== "lastName" &&
                field.systemKey !== "email" &&
                field.kind !== "email" &&
                field.kind !== "phone",
            )
            .map((field) => ({
              id: field.id,
              label: field.label,
              kind: field.kind,
            }));
        });
  return {
    fields,
    allowedIds: new Set(fields.map((field) => field.id)),
    fileFieldIds: new Set(
      fields.filter((field) => field.kind === "file").map((field) => field.id),
    ),
  };
}

/**
 * The reviewer-facing shape of ONE proposal. The only place the projection is
 * applied to data — `myAssignments` and the organizer's "preview as reviewer"
 * both come through here, so a blind round cannot leak through a second,
 * slightly different renderer.
 */
async function reviewerProposalView(
  ctx: QueryCtx,
  proposal: Doc<"proposals">,
  projection: ReviewerProjection,
  anonymized: boolean,
): Promise<AssignmentRow["proposal"]> {
  const speakers = await ctx.db
    .query("proposalSpeakers")
    .withIndex("by_proposalId", (q) => q.eq("proposalId", proposal._id))
    .take(MAX_SPEAKERS_PER_PROPOSAL);
  const answers: Record<string, AnswerValue> = {};
  const fileUrls: Record<string, string | null> = {};
  for (const [fieldId, value] of Object.entries(proposal.answers)) {
    if (!projection.allowedIds.has(fieldId)) continue;
    answers[fieldId] = value;
    if (
      projection.fileFieldIds.has(fieldId) &&
      typeof value === "string" &&
      value.length > 0
    ) {
      // One malformed stored value must not throw and blank the reviewer's
      // whole assignment list — it degrades to a null URL instead.
      const storageId = ctx.db.system.normalizeId("_storage", value);
      fileUrls[value] =
        storageId === null ? null : await ctx.storage.getUrl(storageId);
    }
  }
  return {
    _id: proposal._id,
    title: proposal.title,
    answers,
    fields: projection.fields,
    fileUrls,
    // Blind round: no author identity of any kind crosses the wire (ABS-07).
    // The professional-identity-only projection applies to non-blind rounds.
    speakers: anonymized
      ? []
      : speakers.sort((a, b) => a.order - b.order).map(reviewerSpeaker),
  };
}

/**
 * Everything this reviewer has been asked to evaluate, unfinished first
 * (M2 "Submit & Next"). Organizers who assigned themselves see their own rows
 * here too — the query is scoped to the caller either way.
 */
export async function myAssignments(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<AssignmentRow[]> {
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_eventId_and_reviewerUserId", (q) =>
      q.eq("eventId", caller.event._id).eq("reviewerUserId", caller.user._id),
    )
    .take(REVIEW_SCAN + 1);
  assertCompleteScan(reviews, REVIEW_SCAN, "reviews for one reviewer");

  // Reviewers see evaluation content and professional identity only
  // (MILESTONES M2): contact-detail fields never cross the wire — neither
  // the system identity fields nor any email/phone-kind custom field. Blind
  // rounds additionally remove the entire section that owns system identity,
  // including organizer-authored profile questions such as bio or company.
  const form = await findForm(ctx, caller.event._id);
  const def = form?.published ?? form?.working;
  const nonBlindProjection = reviewerProjection(def, false);
  const blindProjection = reviewerProjection(def, true);

  const rounds = await launchedRoundDocs(ctx, caller.event._id);
  const rows: AssignmentRow[] = [];
  for (const review of reviews) {
    const proposal = await ctx.db.get("proposals", review.proposalId);
    // A withdrawn-and-deleted draft can outlive its assignment; an explicit
    // withdrawal must leave every active review queue (MILESTONES M1).
    if (proposal === null || proposal.status === "withdrawn") continue;
    const round = roundForReview(review, rounds);
    const projection = round.anonymized ? blindProjection : nonBlindProjection;
    rows.push({
      reviewId: review._id,
      contentVersion: proposal.contentVersion ?? 0,
      status: review.status,
      answers: review.answers ?? legacyAnswers(review),
      round: {
        roundId: round.roundId,
        name: round.name,
        anonymized: round.anonymized,
        opensAt: round.opensAt,
        closesAt: round.closesAt,
        scorecard: round.scorecard,
      },
      proposal: await reviewerProposalView(
        ctx,
        proposal,
        projection,
        round.anonymized,
      ),
    });
  }
  const rank = (status: ReviewStatus): number =>
    status === "assigned" || status === "draft" ? 0 : 1;
  return rows.sort((a, b) => rank(a.status) - rank(b.status));
}

export type ReviewerPreview = {
  roundId: Id<"reviewRounds">;
  roundName: string;
  anonymized: boolean;
  scorecard: ScorecardField[];
  proposal: AssignmentRow["proposal"];
  /** Answers the round removes from the reviewer's view, by label — what the
   * preview PROVES is hidden rather than asking the organizer to reason. */
  hiddenFieldLabels: string[];
  /** Speaker names withheld, count only — the preview must not print them. */
  hiddenSpeakerCount: number;
};

/**
 * "Preview as reviewer" (W11). Organizer-only, and deliberately built from the
 * SAME projection the reviewer query serves — a sample proposal from the
 * round's eligible set run through `reviewerProjection` + `reviewerProposalView`.
 * Blinding is never re-implemented on the client; this is the server showing
 * its own work.
 */
export async function previewAsReviewer(
  ctx: QueryCtx,
  caller: EventCaller,
  roundId: Id<"reviewRounds">,
  proposalId?: Id<"proposals">,
): Promise<ReviewerPreview | null> {
  requireOrganizer(caller);
  const round = await requireRound(ctx, caller, roundId);

  let proposal: Doc<"proposals"> | null = null;
  if (proposalId !== undefined) {
    const picked = await ctx.db.get("proposals", proposalId);
    if (picked === null || picked.eventId !== caller.event._id) {
      notFound("proposal", "No such proposal on this event.");
    }
    if (canEnterReviewRound(picked)) proposal = picked;
  } else {
    const all = await ctx.db
      .query("proposals")
      .withIndex("by_eventId_and_status", (q) =>
        q.eq("eventId", caller.event._id),
      )
      .take(REVIEW_SCAN + 1);
    assertCompleteScan(all, REVIEW_SCAN, "proposals");
    proposal = all.find(canEnterReviewRound) ?? null;
  }
  if (proposal === null) return null;

  const form = await findForm(ctx, caller.event._id);
  const def = form?.published ?? form?.working;
  const projection = reviewerProjection(def, round.anonymized);
  const everything = reviewerProjection(def, false);
  const speakers = await ctx.db
    .query("proposalSpeakers")
    .withIndex("by_proposalId", (q) => q.eq("proposalId", proposal._id))
    .take(MAX_SPEAKERS_PER_PROPOSAL);

  return {
    roundId: round._id,
    roundName: round.name,
    anonymized: round.anonymized,
    scorecard: round.scorecard,
    proposal: await reviewerProposalView(
      ctx,
      proposal,
      projection,
      round.anonymized,
    ),
    hiddenFieldLabels: everything.fields
      .filter((field) => !projection.allowedIds.has(field.id))
      .map((field) => field.label),
    hiddenSpeakerCount: round.anonymized ? speakers.length : 0,
  };
}

/** A review the caller owns. Non-owners get "not_found", never "forbidden":
 * review ids must not be probeable across reviewers. */
async function requireOwnReview(
  ctx: QueryCtx,
  caller: EventCaller,
  reviewId: Id<"reviews">,
): Promise<Doc<"reviews">> {
  const review = await ctx.db.get("reviews", reviewId);
  if (
    review === null ||
    review.eventId !== caller.event._id ||
    review.reviewerUserId !== caller.user._id
  ) {
    notFound("review", "No such review assigned to you.");
  }
  return review;
}

/** Withdrawal removes a proposal from active review (MILESTONES M1): its
 * reviews stop accepting writes the moment the submitter withdraws. */
async function assertProposalStillReviewable(
  ctx: QueryCtx,
  review: Doc<"reviews">,
  expectedContentVersion: number | undefined,
): Promise<{ proposal: Doc<"proposals">; contentVersion: number }> {
  if (
    expectedContentVersion !== undefined &&
    (!Number.isSafeInteger(expectedContentVersion) ||
      expectedContentVersion < 0)
  ) {
    throw new ConvexError({
      code: "invalid_content_version",
      message: "Reload this review before saving it.",
    });
  }
  const proposal = await ctx.db.get("proposals", review.proposalId);
  if (proposal === null || proposal.status === "withdrawn") {
    invalidStatus("This proposal was withdrawn — it no longer needs review.");
  }
  const proposalContentVersion = proposal.contentVersion ?? 0;
  const reviewContentVersion = review.contentVersion ?? 0;
  if (expectedContentVersion === undefined) {
    // Compatibility window for clients deployed before the content fence was
    // added. They may write only the legacy state that cannot be stale: both
    // sides still at v0. Once either side advances, an explicit observed
    // version is mandatory so an old tab cannot overwrite revised work.
    if (proposalContentVersion !== 0 || reviewContentVersion !== 0) {
      throw new ConvexError({
        code: "client_upgrade_required",
        message:
          "This proposal has newer content. Refresh the review to load the latest version before saving; update the app if the message persists.",
      });
    }
    return { proposal, contentVersion: 0 };
  }
  if (
    proposalContentVersion !== expectedContentVersion ||
    reviewContentVersion !== expectedContentVersion
  ) {
    throw new ConvexError({
      code: "stale_proposal_content",
      message:
        "This proposal changed since you opened the review. Reload it before saving so old answers cannot be applied to the revised content.",
    });
  }
  return { proposal, contentVersion: expectedContentVersion };
}

/** The round a mutation should validate a review's answers against. */
async function roundForReviewWrite(
  ctx: QueryCtx,
  review: Doc<"reviews">,
): Promise<RoundInfo> {
  const rounds = await launchedRoundDocs(ctx, review.eventId);
  return roundForReview(review, rounds);
}

/** Mirror scorecard answers into the pre-W2 columns the decision pipeline
 * still reads (avg score chips, recommendation counts). */
function legacyMirror(
  scorecard: ScorecardField[],
  answers: ReviewAnswers,
  weightedScore: number | null,
): Pick<Doc<"reviews">, "score" | "recommendation" | "comments"> {
  const directScore = answers.score;
  const comments = answers.comments;
  return {
    score:
      typeof directScore === "number"
        ? directScore
        : weightedScore === null
          ? undefined
          : Math.round(weightedScore * 100) / 100,
    recommendation: recommendationFromAnswers(scorecard, answers),
    comments: typeof comments === "string" ? comments : undefined,
  };
}

function assertAnswers(
  scorecard: ScorecardField[],
  answers: ReviewAnswers,
  { complete }: { complete: boolean },
): void {
  const known = new Set(scorecard.map((f) => f.id));
  for (const key of Object.keys(answers)) {
    if (!known.has(key)) {
      throw new ConvexError({
        code: "invalid_answers",
        message: "An answer targets a criterion that isn't on this scorecard.",
      });
    }
  }
  for (const field of scorecard) {
    const value = answers[field.id];
    if (!complete && value === undefined) continue;
    const problem = answerProblem(field, value);
    if (problem !== null) {
      throw new ConvexError({ code: "invalid_answers", message: problem });
    }
  }
}

/** Autosave for the single-screen review (M2). Only criteria present in the
 * patch are written, so a partial autosave never clears the rest. */
export async function saveReviewDraft(
  ctx: MutationCtx,
  caller: EventCaller,
  reviewId: Id<"reviews">,
  patch: ReviewAnswers,
  expectedContentVersion: number | undefined,
): Promise<void> {
  assertEventActive(caller.event);
  const review = await requireOwnReview(ctx, caller, reviewId);
  const { contentVersion } = await assertProposalStillReviewable(
    ctx,
    review,
    expectedContentVersion,
  );
  if (review.status === "locked") {
    invalidStatus("This review is locked — ask an organizer to reopen it.");
  }
  if (review.status === "submitted") {
    invalidStatus(
      "This review is already submitted — submit again to revise it.",
    );
  }
  if (review.status === "conflict") {
    invalidStatus("You declared a conflict on this one.");
  }
  const round = await roundForReviewWrite(ctx, review);
  const merged: ReviewAnswers = {
    ...(review.answers ?? legacyAnswers(review)),
    ...patch,
  };
  assertAnswers(round.scorecard, merged, { complete: false });
  await ctx.db.patch("reviews", reviewId, {
    status: "draft",
    answers: merged,
    contentVersion,
    updatedAt: Date.now(),
  });
}

/**
 * Submitting requires every required criterion answered. A submitted review
 * "remains revisable until round close", so resubmitting overwrites it; the
 * first submission time is kept as the record.
 */
export async function submitReview(
  ctx: MutationCtx,
  caller: EventCaller,
  reviewId: Id<"reviews">,
  answers: ReviewAnswers,
  expectedContentVersion: number | undefined,
): Promise<void> {
  assertEventActive(caller.event);
  const review = await requireOwnReview(ctx, caller, reviewId);
  const { contentVersion } = await assertProposalStillReviewable(
    ctx,
    review,
    expectedContentVersion,
  );
  if (review.status === "locked") {
    invalidStatus("This review is locked — ask an organizer to reopen it.");
  }
  if (review.status === "conflict") {
    // A declared conflict is a recusal, not a pause: only an organizer
    // reassigning (unassign + assign) puts this proposal back in play.
    invalidStatus(
      "You declared a conflict on this one — ask an organizer to reassign it.",
    );
  }
  const round = await roundForReviewWrite(ctx, review);
  assertAnswers(round.scorecard, answers, { complete: true });
  const weightedScore = reviewWeightedScore(round.scorecard, answers);
  const now = Date.now();
  const isRevision = review.status === "submitted";
  await ctx.db.patch("reviews", reviewId, {
    status: "submitted",
    answers,
    contentVersion,
    weightedScore: weightedScore ?? undefined,
    ...legacyMirror(round.scorecard, answers, weightedScore),
    submittedAt: review.submittedAt ?? now,
    updatedAt: now,
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    viaAgent: false,
    action: "review.submit",
    targetType: "review",
    targetId: reviewId,
    meta: {
      proposalId: review.proposalId,
      weightedScore,
      isRevision,
    },
  });
}

/** Conflict of interest (ABS-12): takes the item out of the reviewer's
 * actionable queue and flags it for the organizer to reassign. */
export async function declareConflict(
  ctx: MutationCtx,
  caller: EventCaller,
  reviewId: Id<"reviews">,
  expectedContentVersion: number | undefined,
  note?: string,
): Promise<void> {
  assertEventActive(caller.event);
  const review = await requireOwnReview(ctx, caller, reviewId);
  const { contentVersion } = await assertProposalStillReviewable(
    ctx,
    review,
    expectedContentVersion,
  );
  if (review.status === "submitted" || review.status === "locked") {
    invalidStatus("This review is already submitted.");
  }
  if (note !== undefined && note.length > 1000) {
    invalidStatus("Keep the conflict note under 1000 characters.");
  }
  await ctx.db.patch("reviews", reviewId, {
    status: "conflict",
    conflictNote: note,
    contentVersion,
    updatedAt: Date.now(),
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.conflict",
    targetType: "review",
    targetId: reviewId,
    meta: { proposalId: review.proposalId },
  });
}

// ── Organizer views ──────────────────────────────────────────────────────

export type ReviewAggregate = {
  /** Actionable assignments; declared conflicts are disclosed separately. */
  count: number;
  conflictCount: number;
  submittedCount: number;
  /** Mean of submitted scores; null until at least one review lands. */
  avgScore: number | null;
  recommendations: { accept: number; decline: number; neutral: number };
};

export type ReviewSummaryRow = {
  reviewId: Id<"reviews">;
  reviewerUserId: Id<"users">;
  reviewerName: string | null;
  reviewerEmail: string | null;
  status: ReviewStatus;
  roundId: Id<"reviewRounds"> | null;
  roundName: string;
  /** Withheld until the review is submitted (M2: organizers see progress
   * status, not unfinished content). */
  answers?: ReviewAnswers;
  scorecard: ScorecardField[];
  weightedScore?: number;
  score?: number;
  recommendation?: Recommendation;
  comments?: string;
  conflictNote?: string;
  submittedAt?: number;
};

export type ReviewSummary = {
  proposalId: Id<"proposals">;
  reviews: ReviewSummaryRow[];
  aggregate: ReviewAggregate;
};

function emptyAggregate(): ReviewAggregate {
  return {
    count: 0,
    conflictCount: 0,
    submittedCount: 0,
    avgScore: null,
    recommendations: { accept: 0, decline: 0, neutral: 0 },
  };
}

/** A review's contribution to the per-proposal aggregate: the weighted mean
 * of its numeric criteria (falling back to the legacy score column). */
function reviewScore(review: Doc<"reviews">): number | null {
  if (typeof review.weightedScore === "number") return review.weightedScore;
  if (typeof review.score === "number") return review.score;
  return null;
}

function aggregate(reviews: Array<Doc<"reviews">>): ReviewAggregate {
  const out = emptyAggregate();
  let scoreSum = 0;
  let scored = 0;
  for (const review of reviews) {
    if (review.status === "conflict") {
      out.conflictCount += 1;
      continue;
    }
    out.count += 1;
    if (review.status !== "submitted" && review.status !== "locked") continue;
    out.submittedCount += 1;
    const score = reviewScore(review);
    if (score !== null) {
      scoreSum += score;
      scored += 1;
    }
    if (review.recommendation !== undefined) {
      out.recommendations[review.recommendation] += 1;
    }
  }
  out.avgScore = scored === 0 ? null : scoreSum / scored;
  return out;
}

/** True once a review's content may be shown to organizers. */
function isFinished(review: Doc<"reviews">): boolean {
  return review.status === "submitted" || review.status === "locked";
}

/** Individual reviews + the simple aggregate an organizer decides on (M2). */
export async function reviewSummary(
  ctx: QueryCtx,
  caller: EventCaller,
  proposalId: Id<"proposals">,
): Promise<ReviewSummary> {
  requireOrganizer(caller);
  const proposal = await ctx.db.get("proposals", proposalId);
  if (proposal === null || proposal.eventId !== caller.event._id) {
    notFound("proposal", "No such proposal on this event.");
  }
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId))
    .take(REVIEW_SUMMARY_SCAN + 1);
  assertCompleteScan(reviews, REVIEW_SUMMARY_SCAN, "reviews on one proposal");

  const rounds = await launchedRoundDocs(ctx, caller.event._id);
  const rows: ReviewSummaryRow[] = [];
  for (const review of reviews) {
    const reviewer = await ctx.db.get("users", review.reviewerUserId);
    const finished = isFinished(review);
    const round = roundForReview(review, rounds);
    rows.push({
      reviewId: review._id,
      reviewerUserId: review.reviewerUserId,
      reviewerName: reviewer?.name ?? null,
      reviewerEmail: reviewer?.email ?? null,
      status: review.status,
      roundId: round.roundId,
      roundName: round.name,
      scorecard: round.scorecard,
      answers: finished ? (review.answers ?? legacyAnswers(review)) : undefined,
      weightedScore: finished ? (reviewScore(review) ?? undefined) : undefined,
      score: finished ? review.score : undefined,
      recommendation: finished ? review.recommendation : undefined,
      comments: finished ? review.comments : undefined,
      conflictNote:
        review.status === "conflict" ? review.conflictNote : undefined,
      submittedAt: review.submittedAt,
    });
  }
  return { proposalId, reviews: rows, aggregate: aggregate(reviews) };
}

export type ProgressEntry = {
  assigned: number;
  submitted: number;
  conflicts: number;
  avgScore: number | null;
};

/**
 * Per-proposal review progress for the abstracts table, in ONE event-wide
 * query. `by_eventId_and_reviewerUserId` is used as an eventId-only prefix.
 */
export async function reviewProgress(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<Record<Id<"proposals">, ProgressEntry>> {
  requireOrganizer(caller);
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_eventId_and_reviewerUserId", (q) =>
      q.eq("eventId", caller.event._id),
    )
    .take(REVIEW_SCAN + 1);
  assertCompleteScan(reviews, REVIEW_SCAN, "reviews");

  const sums = new Map<Id<"proposals">, { total: number; scored: number }>();
  const out: Record<Id<"proposals">, ProgressEntry> = {};
  for (const review of reviews) {
    const entry = (out[review.proposalId] ??= {
      assigned: 0,
      submitted: 0,
      conflicts: 0,
      avgScore: null,
    });
    const sum = sums.get(review.proposalId) ?? { total: 0, scored: 0 };
    if (review.status === "conflict") {
      entry.conflicts += 1;
      sums.set(review.proposalId, sum);
      continue;
    }
    entry.assigned += 1;
    if (isFinished(review)) {
      entry.submitted += 1;
      const score = reviewScore(review);
      if (score !== null) {
        sum.total += score;
        sum.scored += 1;
      }
    }
    sums.set(review.proposalId, sum);
  }
  for (const [proposalId, sum] of sums) {
    out[proposalId].avgScore = sum.scored === 0 ? null : sum.total / sum.scored;
  }
  return out;
}

// ── Reviewer progress & reminders (W2: ABS-08, ABS-09) ───────────────────

export type ReviewerProgressRow = {
  userId: Id<"users">;
  name: string | null;
  email: string | null;
  roundId: Id<"reviewRounds"> | null;
  roundName: string;
  assigned: number;
  submitted: number;
  conflicts: number;
};

/** Per-reviewer completion counts, one row per (reviewer, round) with any
 * assignments, plus empty rows for pool members not yet assigned. */
export async function reviewerProgress(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<ReviewerProgressRow[]> {
  requireOrganizer(caller);
  const rounds = await launchedRoundDocs(ctx, caller.event._id);
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_eventId_and_reviewerUserId", (q) =>
      q.eq("eventId", caller.event._id),
    )
    .take(REVIEW_SCAN + 1);
  assertCompleteScan(reviews, REVIEW_SCAN, "reviews");

  const byKey = new Map<string, ReviewerProgressRow>();
  const rowFor = async (
    userId: Id<"users">,
    round: RoundInfo,
  ): Promise<ReviewerProgressRow> => {
    const key = `${round.roundId ?? "legacy"}:${userId}`;
    let row = byKey.get(key);
    if (row === undefined) {
      const user = await ctx.db.get("users", userId);
      row = {
        userId,
        name: user?.name ?? null,
        email: user?.email ?? null,
        roundId: round.roundId,
        roundName: round.name,
        assigned: 0,
        submitted: 0,
        conflicts: 0,
      };
      byKey.set(key, row);
    }
    return row;
  };

  for (const review of reviews) {
    const round = roundForReview(review, rounds);
    const row = await rowFor(review.reviewerUserId, round);
    if (review.status === "conflict") {
      row.conflicts += 1;
      continue;
    }
    row.assigned += 1;
    if (isFinished(review)) row.submitted += 1;
  }
  // Pool members with nothing assigned still belong on the board.
  for (const round of rounds) {
    const pool = await completeRoundPool(ctx, round._id);
    for (const member of pool) {
      await rowFor(member.userId, roundInfo(round));
    }
  }
  return [...byKey.values()].sort((a, b) =>
    (a.roundName + (a.name ?? "")).localeCompare(b.roundName + (b.name ?? "")),
  );
}

/** Nudge the selected reviewers about their outstanding reviews (ABS-09).
 * One consolidated email per reviewer, recorded in the comms log. */
/** W5: a bulk action states its arithmetic, so the skips are counted BY REASON
 * here — where eligibility is actually decided — rather than collapsed into
 * one number the UI has to guess at. `skipped` stays the total. */
export type RemindOutcome = {
  sent: number;
  failed: number;
  skipped: number;
  /** Selected, but had no assigned/draft review waiting. */
  skippedNothingOutstanding: number;
  /** Selected and behind, but we hold no address for them. */
  skippedNoAddress: number;
};

export async function remindReviewers(
  ctx: MutationCtx,
  caller: EventCaller,
  reviewerUserIds: Array<Id<"users">>,
): Promise<RemindOutcome> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  if (reviewerUserIds.length === 0 || reviewerUserIds.length > MAX_POOL) {
    throw new ConvexError({
      code: "invalid_selection",
      message: "Select between 1 and 200 reviewers.",
    });
  }
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_eventId_and_reviewerUserId", (q) =>
      q.eq("eventId", caller.event._id),
    )
    .take(REVIEW_SCAN + 1);
  assertCompleteScan(reviews, REVIEW_SCAN, "reviews");
  const outstanding = new Map<Id<"users">, number>();
  for (const review of reviews) {
    if (review.status !== "assigned" && review.status !== "draft") continue;
    outstanding.set(
      review.reviewerUserId,
      (outstanding.get(review.reviewerUserId) ?? 0) + 1,
    );
  }
  let sent = 0;
  let failed = 0;
  let skippedNothingOutstanding = 0;
  let skippedNoAddress = 0;
  for (const userId of new Set(reviewerUserIds)) {
    const count = outstanding.get(userId) ?? 0;
    const user = await ctx.db.get("users", userId);
    const email = user?.email?.trim();
    if (count === 0) {
      skippedNothingOutstanding += 1;
      continue;
    }
    if (email === undefined || email.length === 0) {
      skippedNoAddress += 1;
      continue;
    }
    const eventName = caller.event.name;
    const link = `${siteUrl()}/app/e/${caller.event.slug}/reviews`;
    const messageId = await sendLoggedEmail(ctx, {
      orgId: caller.org._id,
      eventId: caller.event._id,
      toEmail: email,
      kind: "review.reminder",
      subject: `Reminder: ${count} review${count === 1 ? "" : "s"} waiting for you — ${eventName}`,
      html: [
        `<p>You have <strong>${count}</strong> proposal review${count === 1 ? "" : "s"} waiting in <strong>${eventName}</strong>.</p>`,
        `<p><a href="${link}">Open your review queue</a></p>`,
      ].join("\n"),
      sentByUserId: caller.user._id,
      replyTo: caller.event.replyTo,
      context: { outstanding: count },
    });
    const message = await ctx.db.get("messages", messageId);
    if (message?.deliveryStatus === "failed") failed += 1;
    else sent += 1;
  }
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.remind",
    targetType: "event",
    targetId: caller.event._id,
    meta: {
      sent,
      failed,
      skipped: skippedNothingOutstanding + skippedNoAddress,
      skippedNothingOutstanding,
      skippedNoAddress,
    },
  });
  return {
    sent,
    failed,
    skipped: skippedNothingOutstanding + skippedNoAddress,
    skippedNothingOutstanding,
    skippedNoAddress,
  };
}
