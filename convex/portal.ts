import { ConvexError, v } from "convex/values";
import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import { authedMutation, authedQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Portal from "./model/portal";

// ─────────────────────────────────────────────────────────────────────────
// Public surface for the speaker portal (M3). Every function here is an
// `authed*` wrapper: portal users are plain signed-in accounts with no org or
// event membership, and their reach is decided purely by ownership inside
// convex/model/portal.ts.
//
// Organizer-side portal controls (invite, handoff, preview, participation
// override) live in convex/sessions.ts, on the event-scoped wrappers.
// ─────────────────────────────────────────────────────────────────────────

const vParticipantState = v.union(
  v.literal("awaiting"),
  v.literal("confirmed"),
  v.literal("declined"),
  v.literal("withdrawn"),
);

const vProposalStatus = v.union(
  v.literal("draft"),
  v.literal("pending"),
  v.literal("acceptQueue"),
  v.literal("declineQueue"),
  v.literal("accepted"),
  v.literal("declined"),
  v.literal("withdrawn"),
);

const vLinks = v.object({
  website: v.optional(v.string()),
  twitter: v.optional(v.string()),
  linkedin: v.optional(v.string()),
  github: v.optional(v.string()),
});

const vProfileInput = v.object({
  firstName: v.string(),
  lastName: v.string(),
  tagline: v.optional(v.string()),
  bio: v.optional(v.string()),
  links: v.optional(vLinks),
  headshotId: v.optional(v.id("_storage")),
});

const vProfileView = v.object({
  _id: vv.id("eventContacts"),
  firstName: v.string(),
  lastName: v.string(),
  tagline: v.optional(v.string()),
  bio: v.optional(v.string()),
  headshotId: v.optional(v.id("_storage")),
  headshotUrl: v.union(v.string(), v.null()),
  links: v.optional(vLinks),
});

/** Shared with convex/sessions.ts, whose organizer preview returns this shape
 * plus the previewed speaker's name for the banner. */
export const vPortalContext = v.object({
  event: v.object({
    name: v.string(),
    slug: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    timezone: v.string(),
    location: v.optional(v.string()),
  }),
  speaking: v.array(
    v.object({
      participantId: vv.id("sessionParticipants"),
      sessionId: vv.id("sessions"),
      sessionTitle: v.string(),
      sessionDescription: v.optional(v.string()),
      format: v.optional(v.string()),
      state: vParticipantState,
      eventContact: vProfileView,
    }),
  ),
  managing: v.array(
    v.object({
      sessionId: vv.id("sessions"),
      title: v.string(),
      description: v.optional(v.string()),
      format: v.optional(v.string()),
      source: v.union(v.literal("cfp"), v.literal("direct")),
      status: v.union(v.literal("planned"), v.literal("cancelled")),
      viaProposalId: v.optional(vv.id("proposals")),
      // Names and states only — never other speakers' contact details.
      participants: v.array(
        v.object({
          participantId: vv.id("sessionParticipants"),
          firstName: v.string(),
          lastName: v.string(),
          state: vParticipantState,
        }),
      ),
    }),
  ),
  myProposalsSummary: v.array(
    v.object({
      proposalId: vv.id("proposals"),
      title: v.string(),
      status: vProposalStatus,
    }),
  ),
  hasAccess: v.boolean(),
});

/**
 * Claim portal access for an event. The web app calls this once when the
 * portal route loads; it is idempotent and returns nothing — the UI then
 * subscribes to `portal.context`.
 */
export const enter = authedMutation({
  args: { eventSlug: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    return await Portal.enterPortal(ctx, ctx.user, args.eventSlug);
  },
});

export const mySpeaking = authedQuery({
  args: {},
  returns: v.array(
    v.object({
      eventName: v.string(),
      eventSlug: v.string(),
      sessionTitle: v.string(),
      state: v.union(
        v.literal("awaiting"),
        v.literal("confirmed"),
        v.literal("declined"),
        v.literal("withdrawn"),
      ),
    }),
  ),
  handler: async (ctx) => {
    return await Portal.mySpeaking(ctx, ctx.user);
  },
});

export const context = authedQuery({
  args: { eventSlug: v.string() },
  returns: vPortalContext,
  handler: async (ctx, args) => {
    return await Portal.portalContext(ctx, ctx.user, args.eventSlug);
  },
});

export const updateMyProfile = authedMutation({
  args: {
    eventSlug: v.string(),
    eventContactId: v.id("eventContacts"),
    profile: vProfileInput,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Portal.updateMyProfile(ctx, ctx.user, args);
    return null;
  },
});

// Minting an upload URL costs storage the moment it's used; cap the rate per
// portal user the same way the CFP wizard does.
const uploadLimiter = new RateLimiter(components.rateLimiter, {
  portalUploadPerUser: { kind: "token bucket", rate: 10, period: HOUR },
});

export const generateHeadshotUploadUrl = authedMutation({
  args: { eventSlug: v.string(), eventContactId: v.id("eventContacts") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const event = await Portal.requireEventForPortal(ctx, args.eventSlug);
    await Portal.requireOwnEventContact(
      ctx,
      ctx.user,
      event,
      args.eventContactId,
    );
    const limit = await uploadLimiter.limit(ctx, "portalUploadPerUser", {
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

export const confirmParticipation = authedMutation({
  args: {
    eventSlug: v.string(),
    participantId: v.id("sessionParticipants"),
    to: v.union(v.literal("confirmed"), v.literal("declined")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Portal.confirmParticipation(ctx, ctx.user, args);
    return null;
  },
});

export const withdrawParticipation = authedMutation({
  args: { eventSlug: v.string(), participantId: v.id("sessionParticipants") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Portal.withdrawParticipation(ctx, ctx.user, args);
    return null;
  },
});

export const updateSessionContent = authedMutation({
  args: {
    eventSlug: v.string(),
    sessionId: v.id("sessions"),
    patch: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      format: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Portal.updateSessionContent(ctx, ctx.user, args);
    return null;
  },
});
