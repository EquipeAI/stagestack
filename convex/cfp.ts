import { ConvexError, v } from "convex/values";
import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import {
  authedMutation,
  authedQuery,
  eventMutation,
  eventQuery,
} from "./lib/functions";
import { vv } from "./lib/validators";
import { vAnswerValue, vFormDef } from "./shared/formDef";
import * as Cfp from "./model/cfp";

// ─────────────────────────────────────────────────────────────────────────
// Public surface for the CFP (M1). Two audiences:
//   * organizers (eventQuery/eventMutation) build and publish the form;
//   * signed-in submitters (authedQuery/authedMutation) own their proposals
//     without any org or event membership.
// Everything here is a thin wrapper; the rules live in convex/model/cfp.ts.
// ─────────────────────────────────────────────────────────────────────────

const vProposalStatus = v.union(
  v.literal("draft"),
  v.literal("pending"),
  v.literal("acceptQueue"),
  v.literal("declineQueue"),
  v.literal("accepted"),
  v.literal("declined"),
  v.literal("withdrawn"),
);

const vSpeakerInput = v.object({
  firstName: v.string(),
  lastName: v.string(),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  tagline: v.optional(v.string()),
  bio: v.optional(v.string()),
  headshotId: v.optional(v.id("_storage")),
  links: v.optional(
    v.object({
      website: v.optional(v.string()),
      twitter: v.optional(v.string()),
      linkedin: v.optional(v.string()),
      github: v.optional(v.string()),
    }),
  ),
  isPrimary: v.boolean(),
});

const vAnswers = v.record(v.string(), vAnswerValue);

// ── Organizer: form builder ──────────────────────────────────────────────

export const getForm = eventQuery({
  args: {},
  returns: v.object({
    working: vFormDef,
    published: v.union(vFormDef, v.null()),
    version: v.number(),
    publishedAt: v.union(v.number(), v.null()),
    maxSubmissionsPerUser: v.union(v.number(), v.null()),
    successMessage: v.union(v.string(), v.null()),
  }),
  handler: async (ctx) => {
    return await Cfp.getForm(ctx, ctx.caller);
  },
});

export const updateWorkingForm = eventMutation({
  args: { def: vFormDef },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Cfp.updateWorkingForm(ctx, ctx.caller, args.def);
    return null;
  },
});

export const updateFormSettings = eventMutation({
  args: {
    maxSubmissionsPerUser: v.optional(v.union(v.number(), v.null())),
    successMessage: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Cfp.updateFormSettings(ctx, ctx.caller, args);
    return null;
  },
});

export const publishForm = eventMutation({
  args: {},
  returns: v.object({ version: v.number() }),
  handler: async (ctx) => {
    return { version: await Cfp.publishForm(ctx, ctx.caller) };
  },
});

export const listProposals = eventQuery({
  args: { status: v.optional(vProposalStatus) },
  returns: v.object({
    rows: v.array(
      v.object({
        proposal: vv.doc("proposals"),
        speakerCount: v.number(),
      }),
    ),
    /** True when the event has more proposals than one read returns, so the
     * abstracts surface can say so instead of implying the page is the whole
     * CFP (H5). */
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    return await Cfp.listProposals(ctx, ctx.caller, { status: args.status });
  },
});

export const getProposalDetail = eventQuery({
  args: { proposalId: v.id("proposals") },
  returns: v.object({
    proposal: vv.doc("proposals"),
    speakers: v.array(vv.doc("proposalSpeakers")),
    submitter: v.object({
      name: v.union(v.string(), v.null()),
      email: v.union(v.string(), v.null()),
    }),
    fileUrls: v.record(v.string(), v.union(v.string(), v.null())),
  }),
  handler: async (ctx, args) => {
    return await Cfp.getProposalDetail(ctx, ctx.caller, args.proposalId);
  },
});

export const createManualProposal = eventMutation({
  args: {
    title: v.string(),
    abstract: v.optional(v.string()),
    speakers: v.array(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        email: v.optional(v.string()),
      }),
    ),
  },
  returns: v.id("proposals"),
  handler: async (ctx, args) => {
    return await Cfp.createManualProposal(ctx, ctx.caller, args);
  },
});

export const listFileAnswers = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      proposalId: v.id("proposals"),
      proposalTitle: v.string(),
      fieldLabel: v.string(),
      storageId: v.string(),
      url: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    return await Cfp.listFileAnswers(ctx, ctx.caller);
  },
});

export const reopenProposal = eventMutation({
  args: { proposalId: v.id("proposals"), until: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Cfp.reopenProposal(ctx, ctx.caller, args.proposalId, args.until);
    return null;
  },
});

// ── Submitter: proposals ─────────────────────────────────────────────────

// `maxSubmissionsPerUser` is unset by default, which leaves proposal creation
// with no per-account cap at all — one script could fill an event's queue.
// This is a floor *underneath* that setting (the model still enforces the
// organizer's own cap, and enforces it first when configured): 10 new drafts
// per hour is well past any real submitter, who starts one or two.
const proposalLimiter = new RateLimiter(components.rateLimiter, {
  cfpProposalPerUser: { kind: "token bucket", rate: 10, period: HOUR },
});

export const startProposal = authedMutation({
  args: { eventSlug: v.string() },
  returns: v.id("proposals"),
  handler: async (ctx, args) => {
    const proposalId = await Cfp.startProposal(ctx, ctx.user, args.eventSlug);
    // After the model's checks so an organizer-configured refusal still reads
    // as `submission_limit`; consumption rolls back with the mutation anyway.
    const limit = await proposalLimiter.limit(ctx, "cfpProposalPerUser", {
      key: ctx.user._id,
    });
    if (!limit.ok) {
      throw new ConvexError({
        code: "rate_limited",
        message: "Too many proposals started — try again in a little while.",
      });
    }
    return proposalId;
  },
});

export const getMyProposal = authedQuery({
  args: { proposalId: v.id("proposals") },
  returns: v.object({
    proposal: vv.doc("proposals"),
    speakers: v.array(vv.doc("proposalSpeakers")),
    form: vFormDef,
    formVersion: v.number(),
    event: v.object({
      name: v.string(),
      slug: v.string(),
      timezone: v.string(),
      cfpOpenAt: v.optional(v.number()),
      cfpCloseAt: v.optional(v.number()),
      cfpPublished: v.boolean(),
    }),
    windowOpen: v.boolean(),
  }),
  handler: async (ctx, args) => {
    return await Cfp.getMyProposal(ctx, ctx.user, args.proposalId);
  },
});

export const myProposals = authedQuery({
  args: {},
  returns: v.array(
    v.object({
      proposal: vv.doc("proposals"),
      eventName: v.string(),
      eventSlug: v.string(),
    }),
  ),
  handler: async (ctx) => {
    return await Cfp.myProposals(ctx, ctx.user);
  },
});

export const saveAnswers = authedMutation({
  args: { proposalId: v.id("proposals"), answers: vAnswers },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Cfp.saveAnswers(ctx, ctx.user, args.proposalId, args.answers);
    return null;
  },
});

export const setSpeakers = authedMutation({
  args: {
    proposalId: v.id("proposals"),
    speakers: v.array(vSpeakerInput),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Cfp.setSpeakers(ctx, ctx.user, args.proposalId, args.speakers);
    return null;
  },
});

export const submitProposal = authedMutation({
  args: { proposalId: v.id("proposals") },
  returns: v.object({ successMessage: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    return await Cfp.submitProposal(ctx, ctx.user, args.proposalId);
  },
});

export const sendSubmissionEmails = internalMutation({
  args: {
    proposalId: v.id("proposals"),
    submittedByUserId: v.id("users"),
    isResubmit: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Cfp.sendSubmissionEmails(ctx, args);
    return null;
  },
});

export const withdrawProposal = authedMutation({
  args: { proposalId: v.id("proposals") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Cfp.withdrawProposal(ctx, ctx.user, args.proposalId);
    return null;
  },
});

// Upload URLs cost storage the moment they're used; cap the mint rate so a
// single account can't fill the bucket (codex review of M1).
const uploadLimiter = new RateLimiter(components.rateLimiter, {
  cfpUploadPerUser: { kind: "token bucket", rate: 30, period: HOUR },
});

/** Upload target for headshots and file answers. Owner-gated so an upload URL
 * is only ever minted for a proposal the caller manages. */
export const generateUploadUrl = authedMutation({
  args: { proposalId: v.id("proposals") },
  returns: v.string(),
  handler: async (ctx, args) => {
    await Cfp.requireOwnProposal(ctx, ctx.user, args.proposalId);
    const limit = await uploadLimiter.limit(ctx, "cfpUploadPerUser", {
      key: ctx.user._id,
    });
    if (!limit.ok) {
      throw new ConvexError({
        code: "rate_limited",
        message: "Too many uploads — try again in a little while.",
      });
    }
    return await ctx.storage.generateUploadUrl();
  },
});
