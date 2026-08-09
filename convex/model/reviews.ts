import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import type { AnswerValue } from "../shared/formDef";

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

const MAX_COMMENTS = 5000;
const MAX_BULK = 500;
/** Ceiling for the event-wide review scans backing the progress map. */
const REVIEW_SCAN = 5000;
const MAX_SPEAKERS_PER_PROPOSAL = 40;

/** Proposals that may be reviewed: submitted and not yet decided. Queued
 * proposals stay reviewable — staging is an internal, reversible step. */
const REVIEWABLE: ReadonlySet<Doc<"proposals">["status"]> = new Set([
  "pending",
  "acceptQueue",
  "declineQueue",
]);

/**
 * Archived events stop accepting work (MILESTONES M0: archiving "removes an
 * event from active work and stops automations"). Reads stay open so history
 * remains browsable; every M2 write calls this first.
 */
export function assertEventActive(event: Doc<"events">): void {
  if (event.archivedAt !== undefined) {
    throw new ConvexError({
      code: "event_archived",
      message: "This event is archived.",
    });
  }
}

export type ReviewStatus = Doc<"reviews">["status"];
export type Recommendation = NonNullable<Doc<"reviews">["recommendation"]>;

function invalidStatus(message: string): never {
  throw new ConvexError({ code: "invalid_status", message });
}

function assertScore(score: number): void {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new ConvexError({
      code: "invalid_score",
      message: "A score must be a whole number from 1 to 5.",
    });
  }
}

function assertComments(comments: string): string {
  if (comments.length > MAX_COMMENTS) {
    throw new ConvexError({
      code: "invalid_comments",
      message: `Comments must be at most ${MAX_COMMENTS} characters.`,
    });
  }
  return comments;
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
): Promise<AssignResult> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  assertBulkSize(proposalIds);
  await assertCanReview(ctx, caller.event, reviewerUserId);

  // One scan of this reviewer's existing rows instead of a query per proposal.
  const existing = await ctx.db
    .query("reviews")
    .withIndex("by_eventId_and_reviewerUserId", (q) =>
      q.eq("eventId", caller.event._id).eq("reviewerUserId", reviewerUserId),
    )
    .take(REVIEW_SCAN);
  const already = new Set(existing.map((r) => r.proposalId));

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
    meta: { assigned, skipped, requested: proposalIds.length },
  });
  return { assigned, skipped };
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

export type AssignmentRow = {
  reviewId: Id<"reviews">;
  status: ReviewStatus;
  score?: number;
  recommendation?: Recommendation;
  comments?: string;
  proposal: {
    _id: Id<"proposals">;
    title: string;
    answers: Record<string, AnswerValue>;
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
    .take(REVIEW_SCAN);

  const rows: AssignmentRow[] = [];
  for (const review of reviews) {
    const proposal = await ctx.db.get("proposals", review.proposalId);
    // A withdrawn-and-deleted draft can outlive its assignment.
    if (proposal === null) continue;
    const speakers = await ctx.db
      .query("proposalSpeakers")
      .withIndex("by_proposalId", (q) => q.eq("proposalId", proposal._id))
      .take(MAX_SPEAKERS_PER_PROPOSAL);
    rows.push({
      reviewId: review._id,
      status: review.status,
      score: review.score,
      recommendation: review.recommendation,
      comments: review.comments,
      proposal: {
        _id: proposal._id,
        title: proposal.title,
        answers: proposal.answers,
        speakers: speakers
          .sort((a, b) => a.order - b.order)
          .map(reviewerSpeaker),
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

export type ReviewDraftPatch = {
  score?: number;
  recommendation?: Recommendation;
  comments?: string;
};

/** Autosave for the single-screen review (M2). Only fields present in the
 * patch are written, so a partial autosave never clears the rest. */
export async function saveReviewDraft(
  ctx: MutationCtx,
  caller: EventCaller,
  reviewId: Id<"reviews">,
  patch: ReviewDraftPatch,
): Promise<void> {
  assertEventActive(caller.event);
  const review = await requireOwnReview(ctx, caller, reviewId);
  if (review.status === "locked") {
    invalidStatus("This review is locked — ask an organizer to reopen it.");
  }
  if (review.status === "submitted") {
    invalidStatus("This review is already submitted — submit again to revise it.");
  }
  const update: Partial<Doc<"reviews">> = {
    status: "draft",
    updatedAt: Date.now(),
  };
  if (patch.score !== undefined) {
    assertScore(patch.score);
    update.score = patch.score;
  }
  if (patch.recommendation !== undefined) {
    update.recommendation = patch.recommendation;
  }
  if (patch.comments !== undefined) {
    update.comments = assertComments(patch.comments);
  }
  await ctx.db.patch("reviews", reviewId, update);
}

export type ReviewSubmission = {
  score: number;
  recommendation: Recommendation;
  comments?: string;
};

/**
 * Score + recommendation are required to submit (M2: "required score and
 * recommendation, optional comments"). A submitted review "remains revisable
 * until round close", so resubmitting simply overwrites it; the first
 * submission time is kept as the record.
 */
export async function submitReview(
  ctx: MutationCtx,
  caller: EventCaller,
  reviewId: Id<"reviews">,
  submission: ReviewSubmission,
): Promise<void> {
  assertEventActive(caller.event);
  const review = await requireOwnReview(ctx, caller, reviewId);
  if (review.status === "locked") {
    invalidStatus("This review is locked — ask an organizer to reopen it.");
  }
  assertScore(submission.score);
  const now = Date.now();
  const isRevision = review.status === "submitted";
  await ctx.db.patch("reviews", reviewId, {
    status: "submitted",
    score: submission.score,
    recommendation: submission.recommendation,
    comments:
      submission.comments === undefined
        ? review.comments
        : assertComments(submission.comments),
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
      score: submission.score,
      recommendation: submission.recommendation,
      isRevision,
    },
  });
}

// ── Organizer views ──────────────────────────────────────────────────────

export type ReviewAggregate = {
  count: number;
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
  /** Withheld until the review is submitted (M2: organizers see progress
   * status, not unfinished content). */
  score?: number;
  recommendation?: Recommendation;
  comments?: string;
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
    submittedCount: 0,
    avgScore: null,
    recommendations: { accept: 0, decline: 0, neutral: 0 },
  };
}

function aggregate(reviews: Array<Doc<"reviews">>): ReviewAggregate {
  const out = emptyAggregate();
  out.count = reviews.length;
  let scoreSum = 0;
  let scored = 0;
  for (const review of reviews) {
    if (review.status !== "submitted" && review.status !== "locked") continue;
    out.submittedCount += 1;
    if (typeof review.score === "number") {
      scoreSum += review.score;
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
    .take(200);

  const rows: ReviewSummaryRow[] = [];
  for (const review of reviews) {
    const reviewer = await ctx.db.get("users", review.reviewerUserId);
    const finished = isFinished(review);
    rows.push({
      reviewId: review._id,
      reviewerUserId: review.reviewerUserId,
      reviewerName: reviewer?.name ?? null,
      reviewerEmail: reviewer?.email ?? null,
      status: review.status,
      score: finished ? review.score : undefined,
      recommendation: finished ? review.recommendation : undefined,
      comments: finished ? review.comments : undefined,
      submittedAt: review.submittedAt,
    });
  }
  return { proposalId, reviews: rows, aggregate: aggregate(reviews) };
}

export type ProgressEntry = {
  assigned: number;
  submitted: number;
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
    .take(REVIEW_SCAN);

  const sums = new Map<Id<"proposals">, { total: number; scored: number }>();
  const out: Record<Id<"proposals">, ProgressEntry> = {};
  for (const review of reviews) {
    const entry = (out[review.proposalId] ??= {
      assigned: 0,
      submitted: 0,
      avgScore: null,
    });
    const sum = sums.get(review.proposalId) ?? { total: 0, scored: 0 };
    entry.assigned += 1;
    if (isFinished(review)) {
      entry.submitted += 1;
      if (typeof review.score === "number") {
        sum.total += review.score;
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
