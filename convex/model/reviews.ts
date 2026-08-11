import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import type { AnswerValue } from "../shared/formDef";
import { allFields } from "../shared/formDef";
import { findForm } from "./cfp";
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
//     not contact details" — the speaker projection carries name/tagline/bio
//     and never email or phone.
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
const REVIEW_SCAN = 5000;
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

/** Proposals that may be reviewed: submitted and not yet decided. Queued
 * proposals stay reviewable — staging is an internal, reversible step. */
const REVIEWABLE: ReadonlySet<Doc<"proposals">["status"]> = new Set([
  "pending",
  "acceptQueue",
  "declineQueue",
]);

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
  const rounds = await listRoundDocs(ctx, event._id);
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
  const rounds = await listRoundDocs(ctx, caller.event._id);
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
  // Assignment implies pool membership — the pool is the source of truth for
  // auto-distribute and the progress board.
  await ensurePoolMembership(ctx, caller.event._id, round._id, reviewerUserId);

  // One scan of this reviewer's existing rows instead of a query per proposal.
  // Legacy rows (no roundId) belong to the FIRST round only — attributing
  // them to whichever round is being processed would corrupt later rounds'
  // dedupe (codex W2 review).
  const allRounds = await listRoundDocs(ctx, caller.event._id);
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
    if (!REVIEWABLE.has(proposal.status)) {
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
  const round = await requireRound(ctx, caller, roundId);
  const pool = await completeRoundPool(ctx, round._id);
  if (pool.length === 0) {
    throw new ConvexError({
      code: "empty_pool",
      message: "Add at least one reviewer to this round first.",
    });
  }
  const perProposal = Math.max(1, options?.perProposal ?? 1);

  // Candidate proposals: the explicit selection, or every reviewable one.
  let candidates: Array<Doc<"proposals">>;
  if (options?.proposalIds !== undefined) {
    assertBulkSize(options.proposalIds);
    candidates = [];
    for (const id of new Set(options.proposalIds)) {
      const proposal = await ctx.db.get("proposals", id);
      if (proposal === null || proposal.eventId !== caller.event._id) {
        notFound("proposal", "No such proposal on this event.");
      }
      if (REVIEWABLE.has(proposal.status)) candidates.push(proposal);
    }
  } else {
    const all = await ctx.db
      .query("proposals")
      .withIndex("by_eventId_and_status", (q) =>
        q.eq("eventId", caller.event._id),
      )
      .take(REVIEW_SCAN + 1);
    assertCompleteScan(all, REVIEW_SCAN, "proposals");
    candidates = all.filter((p) => REVIEWABLE.has(p.status));
  }

  // Current load + existing pairs in one event-wide scan. Legacy rows (no
  // roundId) attribute to the FIRST round only; conflicted reviews keep the
  // (proposal, reviewer) pair blocked but release the reviewer's cap and the
  // proposal's coverage so a replacement can be assigned (codex W2 review).
  const allRounds = await listRoundDocs(ctx, caller.event._id);
  const firstRoundId = allRounds[0]?._id;
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_eventId_and_reviewerUserId", (q) =>
      q.eq("eventId", caller.event._id),
    )
    .take(REVIEW_SCAN + 1);
  assertCompleteScan(reviews, REVIEW_SCAN, "reviews");
  const inRound = reviews.filter(
    (r) => (r.roundId ?? firstRoundId) === round._id,
  );
  const load = new Map<Id<"users">, number>();
  for (const member of pool) load.set(member.userId, 0);
  const pairs = new Set<string>();
  const perProposalCount = new Map<Id<"proposals">, number>();
  for (const review of inRound) {
    pairs.add(`${review.proposalId}:${review.reviewerUserId}`);
    if (review.status === "conflict") continue;
    if (load.has(review.reviewerUserId)) {
      load.set(
        review.reviewerUserId,
        (load.get(review.reviewerUserId) ?? 0) + 1,
      );
    }
    perProposalCount.set(
      review.proposalId,
      (perProposalCount.get(review.proposalId) ?? 0) + 1,
    );
  }

  const cap = round.reviewerCap;
  const now = Date.now();
  const assignedPer = new Map<Id<"users">, number>();
  let assigned = 0;
  let unplaced = 0;
  for (const proposal of candidates) {
    let needed = perProposal - (perProposalCount.get(proposal._id) ?? 0);
    while (needed > 0) {
      // Least-loaded eligible pool member for THIS proposal.
      const eligible = pool
        .map((m) => m.userId)
        .filter(
          (userId) =>
            !pairs.has(`${proposal._id}:${userId}`) &&
            (cap === undefined || (load.get(userId) ?? 0) < cap),
        )
        .sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0));
      const target = eligible[0];
      if (target === undefined) {
        unplaced += 1;
        break;
      }
      await ctx.db.insert("reviews", {
        eventId: caller.event._id,
        proposalId: proposal._id,
        reviewerUserId: target,
        roundId: round._id,
        status: "assigned",
        updatedAt: now,
      });
      pairs.add(`${proposal._id}:${target}`);
      load.set(target, (load.get(target) ?? 0) + 1);
      assignedPer.set(target, (assignedPer.get(target) ?? 0) + 1);
      assigned += 1;
      needed -= 1;
    }
  }

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "review.autoDistribute",
    targetType: "reviewRound",
    targetId: round._id,
    meta: { assigned, unplaced, candidates: candidates.length },
  });
  return {
    assigned,
    unplaced,
    perReviewer: pool.map((m) => ({
      userId: m.userId,
      assigned: assignedPer.get(m.userId) ?? 0,
      total: load.get(m.userId) ?? 0,
    })),
  };
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
  // the system identity fields nor any email/phone-kind custom field.
  const form = await findForm(ctx, caller.event._id);
  const def = form?.published ?? form?.working;
  const evaluationFields: ReviewerField[] =
    def === undefined
      ? []
      : allFields(def)
          .filter(
            (f) =>
              f.systemKey !== "firstName" &&
              f.systemKey !== "lastName" &&
              f.systemKey !== "email" &&
              f.kind !== "email" &&
              f.kind !== "phone",
          )
          .map((f) => ({ id: f.id, label: f.label, kind: f.kind }));
  const allowedIds = new Set(evaluationFields.map((f) => f.id));
  const fileFieldIds = new Set(
    evaluationFields.filter((f) => f.kind === "file").map((f) => f.id),
  );

  const rounds = await listRoundDocs(ctx, caller.event._id);
  const rows: AssignmentRow[] = [];
  for (const review of reviews) {
    const proposal = await ctx.db.get("proposals", review.proposalId);
    // A withdrawn-and-deleted draft can outlive its assignment; an explicit
    // withdrawal must leave every active review queue (MILESTONES M1).
    if (proposal === null || proposal.status === "withdrawn") continue;
    const round = roundForReview(review, rounds);
    const speakers = await ctx.db
      .query("proposalSpeakers")
      .withIndex("by_proposalId", (q) => q.eq("proposalId", proposal._id))
      .take(MAX_SPEAKERS_PER_PROPOSAL);
    const answers: Record<string, AnswerValue> = {};
    const fileUrls: Record<string, string | null> = {};
    for (const [fieldId, value] of Object.entries(proposal.answers)) {
      if (!allowedIds.has(fieldId)) continue;
      answers[fieldId] = value;
      if (
        fileFieldIds.has(fieldId) &&
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
    rows.push({
      reviewId: review._id,
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
      proposal: {
        _id: proposal._id,
        title: proposal.title,
        answers,
        fields: evaluationFields,
        fileUrls,
        // Blind round: no author identity of any kind crosses the wire
        // (ABS-07). The professional-identity-only projection applies to
        // non-blind rounds.
        speakers: round.anonymized
          ? []
          : speakers.sort((a, b) => a.order - b.order).map(reviewerSpeaker),
      },
    });
  }
  const rank = (status: ReviewStatus): number =>
    status === "assigned" || status === "draft" ? 0 : 1;
  return rows.sort((a, b) => rank(a.status) - rank(b.status));
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
): Promise<void> {
  const proposal = await ctx.db.get("proposals", review.proposalId);
  if (proposal === null || proposal.status === "withdrawn") {
    invalidStatus("This proposal was withdrawn — it no longer needs review.");
  }
}

/** The round a mutation should validate a review's answers against. */
async function roundForReviewWrite(
  ctx: QueryCtx,
  review: Doc<"reviews">,
): Promise<RoundInfo> {
  const rounds = await listRoundDocs(ctx, review.eventId);
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
): Promise<void> {
  assertEventActive(caller.event);
  const review = await requireOwnReview(ctx, caller, reviewId);
  await assertProposalStillReviewable(ctx, review);
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
): Promise<void> {
  assertEventActive(caller.event);
  const review = await requireOwnReview(ctx, caller, reviewId);
  await assertProposalStillReviewable(ctx, review);
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
  note?: string,
): Promise<void> {
  assertEventActive(caller.event);
  const review = await requireOwnReview(ctx, caller, reviewId);
  if (review.status === "submitted" || review.status === "locked") {
    invalidStatus("This review is already submitted.");
  }
  if (note !== undefined && note.length > 1000) {
    invalidStatus("Keep the conflict note under 1000 characters.");
  }
  await ctx.db.patch("reviews", reviewId, {
    status: "conflict",
    conflictNote: note,
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

  const rounds = await listRoundDocs(ctx, caller.event._id);
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
  const rounds = await listRoundDocs(ctx, caller.event._id);
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
export async function remindReviewers(
  ctx: MutationCtx,
  caller: EventCaller,
  reviewerUserIds: Array<Id<"users">>,
): Promise<{ sent: number; failed: number; skipped: number }> {
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
  let skipped = 0;
  for (const userId of new Set(reviewerUserIds)) {
    const count = outstanding.get(userId) ?? 0;
    const user = await ctx.db.get("users", userId);
    const email = user?.email?.trim();
    if (count === 0 || email === undefined || email.length === 0) {
      skipped += 1;
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
    meta: { sent, failed, skipped },
  });
  return { sent, failed, skipped };
}
