import { v } from "convex/values";
import { eventMemberMutation, eventMutation, eventQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import { vAnswerValue } from "./shared/formDef";
import * as Reviews from "./model/reviews";

// ─────────────────────────────────────────────────────────────────────────
// Public surface for review & evaluation (M2). Thin wrappers only; the rules
// (and every authorization check) live in convex/model/reviews.ts.
//
// Wrapper choice is itself part of the contract:
//   * eventQuery       — organizers AND reviewers may read;
//   * eventMemberMutation — reviewers write their OWN review;
//   * eventMutation    — organizer-only writes (assignment).
// Model functions re-check the role regardless, so the agent adapter that
// calls them directly gets the same answer.
// ─────────────────────────────────────────────────────────────────────────

const vReviewStatus = v.union(
  v.literal("assigned"),
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("locked"),
);

const vRecommendation = v.union(
  v.literal("accept"),
  v.literal("decline"),
  v.literal("neutral"),
);

/** Professional identity only — no email, no phone (MILESTONES M2). */
const vReviewerSpeaker = v.object({
  firstName: v.string(),
  lastName: v.string(),
  tagline: v.optional(v.string()),
  bio: v.optional(v.string()),
});

const vAggregate = v.object({
  count: v.number(),
  submittedCount: v.number(),
  avgScore: v.union(v.number(), v.null()),
  recommendations: v.object({
    accept: v.number(),
    decline: v.number(),
    neutral: v.number(),
  }),
});

// ── Reviewer ─────────────────────────────────────────────────────────────

export const myAssignments = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      reviewId: vv.id("reviews"),
      status: vReviewStatus,
      score: v.optional(v.number()),
      recommendation: v.optional(vRecommendation),
      comments: v.optional(v.string()),
      proposal: v.object({
        _id: vv.id("proposals"),
        title: v.string(),
        answers: v.record(v.string(), vAnswerValue),
        speakers: v.array(vReviewerSpeaker),
      }),
    }),
  ),
  handler: async (ctx) => {
    return await Reviews.myAssignments(ctx, ctx.caller);
  },
});

export const saveDraft = eventMemberMutation({
  args: {
    reviewId: v.id("reviews"),
    score: v.optional(v.number()),
    recommendation: v.optional(vRecommendation),
    comments: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Reviews.saveReviewDraft(ctx, ctx.caller, args.reviewId, {
      score: args.score,
      recommendation: args.recommendation,
      comments: args.comments,
    });
    return null;
  },
});

export const submit = eventMemberMutation({
  args: {
    reviewId: v.id("reviews"),
    score: v.number(),
    recommendation: vRecommendation,
    comments: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Reviews.submitReview(ctx, ctx.caller, args.reviewId, {
      score: args.score,
      recommendation: args.recommendation,
      comments: args.comments,
    });
    return null;
  },
});

// ── Organizer ────────────────────────────────────────────────────────────

export const assign = eventMutation({
  args: {
    proposalIds: v.array(v.id("proposals")),
    reviewerUserId: v.id("users"),
  },
  returns: v.object({ assigned: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    return await Reviews.assignReviewers(
      ctx,
      ctx.caller,
      args.proposalIds,
      args.reviewerUserId,
    );
  },
});

export const unassign = eventMutation({
  args: { reviewId: v.id("reviews") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Reviews.unassignReviewer(ctx, ctx.caller, args.reviewId);
    return null;
  },
});

export const summary = eventQuery({
  args: { proposalId: v.id("proposals") },
  returns: v.object({
    proposalId: vv.id("proposals"),
    reviews: v.array(
      v.object({
        reviewId: vv.id("reviews"),
        reviewerUserId: vv.id("users"),
        reviewerName: v.union(v.string(), v.null()),
        reviewerEmail: v.union(v.string(), v.null()),
        status: vReviewStatus,
        score: v.optional(v.number()),
        recommendation: v.optional(vRecommendation),
        comments: v.optional(v.string()),
        submittedAt: v.optional(v.number()),
      }),
    ),
    aggregate: vAggregate,
  }),
  handler: async (ctx, args) => {
    return await Reviews.reviewSummary(ctx, ctx.caller, args.proposalId);
  },
});

/** Per-proposal progress for the abstracts table, keyed by proposal id. */
export const progress = eventQuery({
  args: {},
  returns: v.record(
    vv.id("proposals"),
    v.object({
      assigned: v.number(),
      submitted: v.number(),
      avgScore: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    return await Reviews.reviewProgress(ctx, ctx.caller);
  },
});
