import { v } from "convex/values";
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
  returns: v.array(
    v.object({
      proposal: vv.doc("proposals"),
      speakerCount: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    return await Cfp.listProposals(ctx, ctx.caller, { status: args.status });
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

export const startProposal = authedMutation({
  args: { eventSlug: v.string() },
  returns: v.id("proposals"),
  handler: async (ctx, args) => {
    return await Cfp.startProposal(ctx, ctx.user, args.eventSlug);
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

export const withdrawProposal = authedMutation({
  args: { proposalId: v.id("proposals") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Cfp.withdrawProposal(ctx, ctx.user, args.proposalId);
    return null;
  },
});

/** Upload target for headshots and file answers. Owner-gated so an upload URL
 * is only ever minted for a proposal the caller manages. */
export const generateUploadUrl = authedMutation({
  args: { proposalId: v.id("proposals") },
  returns: v.string(),
  handler: async (ctx, args) => {
    await Cfp.requireOwnProposal(ctx, ctx.user, args.proposalId);
    return await ctx.storage.generateUploadUrl();
  },
});
