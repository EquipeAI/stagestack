import { v } from "convex/values";
import {
  eventMemberMutation,
  eventMutation,
  eventQuery,
} from "./lib/functions";
import { vv } from "./lib/validators";
import { vAnswerValue } from "./shared/formDef";
import { vReviewAnswers, vScorecard } from "./shared/scorecard";
import * as Reviews from "./model/reviews";

// ─────────────────────────────────────────────────────────────────────────
// Public surface for review & evaluation (M2, multi-round W2). Thin wrappers
// only; the rules (and every authorization check) live in
// convex/model/reviews.ts.
//
// Wrapper choice is itself part of the contract:
//   * eventQuery       — organizers AND reviewers may read;
//   * eventMemberMutation — reviewers write their OWN review;
//   * eventMutation    — organizer-only writes (rounds, pools, assignment).
// Model functions re-check the role regardless, so the agent adapter that
// calls them directly gets the same answer.
// ─────────────────────────────────────────────────────────────────────────

const vReviewStatus = v.union(
  v.literal("assigned"),
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("locked"),
  v.literal("conflict"),
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
  conflictCount: v.number(),
  submittedCount: v.number(),
  avgScore: v.union(v.number(), v.null()),
  recommendations: v.object({
    accept: v.number(),
    decline: v.number(),
    neutral: v.number(),
  }),
});

const vRoundInput = {
  name: v.string(),
  opensAt: v.optional(v.number()),
  closesAt: v.optional(v.number()),
  anonymized: v.boolean(),
  reviewerCap: v.optional(v.number()),
  scorecard: vScorecard,
};

// ── Reviewer ─────────────────────────────────────────────────────────────

export const myAssignments = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      reviewId: vv.id("reviews"),
      status: vReviewStatus,
      answers: vReviewAnswers,
      round: v.object({
        roundId: v.union(vv.id("reviewRounds"), v.null()),
        name: v.string(),
        anonymized: v.boolean(),
        opensAt: v.optional(v.number()),
        closesAt: v.optional(v.number()),
        scorecard: vScorecard,
      }),
      proposal: v.object({
        _id: vv.id("proposals"),
        title: v.string(),
        answers: v.record(v.string(), vAnswerValue),
        fields: v.array(
          v.object({ id: v.string(), label: v.string(), kind: v.string() }),
        ),
        fileUrls: v.record(v.string(), v.union(v.string(), v.null())),
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
    answers: vReviewAnswers,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Reviews.saveReviewDraft(ctx, ctx.caller, args.reviewId, args.answers);
    return null;
  },
});

export const submit = eventMemberMutation({
  args: {
    reviewId: v.id("reviews"),
    answers: vReviewAnswers,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Reviews.submitReview(ctx, ctx.caller, args.reviewId, args.answers);
    return null;
  },
});

export const declareConflict = eventMemberMutation({
  args: {
    reviewId: v.id("reviews"),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Reviews.declareConflict(ctx, ctx.caller, args.reviewId, args.note);
    return null;
  },
});

// ── Organizer: evaluation plan ───────────────────────────────────────────

export const listRounds = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      roundId: vv.id("reviewRounds"),
      name: v.string(),
      order: v.number(),
      opensAt: v.optional(v.number()),
      closesAt: v.optional(v.number()),
      anonymized: v.boolean(),
      reviewerCap: v.optional(v.number()),
      scorecard: vScorecard,
      pool: v.array(
        v.object({
          userId: vv.id("users"),
          name: v.union(v.string(), v.null()),
          email: v.union(v.string(), v.null()),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    return await Reviews.listRounds(ctx, ctx.caller);
  },
});

export const createRound = eventMutation({
  args: vRoundInput,
  returns: vv.id("reviewRounds"),
  handler: async (ctx, args) => {
    return await Reviews.createRound(ctx, ctx.caller, args);
  },
});

export const updateRound = eventMutation({
  args: { roundId: v.id("reviewRounds"), ...vRoundInput },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { roundId, ...input } = args;
    await Reviews.updateRound(ctx, ctx.caller, roundId, input);
    return null;
  },
});

export const deleteRound = eventMutation({
  args: { roundId: v.id("reviewRounds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Reviews.deleteRound(ctx, ctx.caller, args.roundId);
    return null;
  },
});

export const addRoundReviewer = eventMutation({
  args: { roundId: v.id("reviewRounds"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Reviews.addRoundReviewer(ctx, ctx.caller, args.roundId, args.userId);
    return null;
  },
});

export const removeRoundReviewer = eventMutation({
  args: { roundId: v.id("reviewRounds"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Reviews.removeRoundReviewer(
      ctx,
      ctx.caller,
      args.roundId,
      args.userId,
    );
    return null;
  },
});

// ── Organizer: assignment ────────────────────────────────────────────────

export const assign = eventMutation({
  args: {
    proposalIds: v.array(v.id("proposals")),
    reviewerUserId: v.id("users"),
    roundId: v.optional(v.id("reviewRounds")),
  },
  returns: v.object({ assigned: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    return await Reviews.assignReviewers(
      ctx,
      ctx.caller,
      args.proposalIds,
      args.reviewerUserId,
      args.roundId,
    );
  },
});

export const autoDistribute = eventMutation({
  args: {
    roundId: v.id("reviewRounds"),
    proposalIds: v.optional(v.array(v.id("proposals"))),
    perProposal: v.optional(v.number()),
  },
  returns: v.object({
    assigned: v.number(),
    unplaced: v.number(),
    perReviewer: v.array(
      v.object({
        userId: vv.id("users"),
        assigned: v.number(),
        total: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    return await Reviews.autoDistribute(ctx, ctx.caller, args.roundId, {
      proposalIds: args.proposalIds,
      perProposal: args.perProposal,
    });
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

// ── Organizer: results & progress ────────────────────────────────────────

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
        roundId: v.union(vv.id("reviewRounds"), v.null()),
        roundName: v.string(),
        scorecard: vScorecard,
        answers: v.optional(vReviewAnswers),
        weightedScore: v.optional(v.number()),
        score: v.optional(v.number()),
        recommendation: v.optional(vRecommendation),
        comments: v.optional(v.string()),
        conflictNote: v.optional(v.string()),
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
      conflicts: v.number(),
      avgScore: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    return await Reviews.reviewProgress(ctx, ctx.caller);
  },
});

/** Per-reviewer completion board (ABS-08). */
export const reviewerProgress = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      userId: vv.id("users"),
      name: v.union(v.string(), v.null()),
      email: v.union(v.string(), v.null()),
      roundId: v.union(vv.id("reviewRounds"), v.null()),
      roundName: v.string(),
      assigned: v.number(),
      submitted: v.number(),
      conflicts: v.number(),
    }),
  ),
  handler: async (ctx) => {
    return await Reviews.reviewerProgress(ctx, ctx.caller);
  },
});

/** Consolidated nudge to lagging reviewers (ABS-09). */
export const remind = eventMutation({
  args: { reviewerUserIds: v.array(v.id("users")) },
  returns: v.object({
    sent: v.number(),
    failed: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    return await Reviews.remindReviewers(ctx, ctx.caller, args.reviewerUserIds);
  },
});
