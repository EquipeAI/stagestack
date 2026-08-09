import { v } from "convex/values";
import { nullable } from "convex-helpers/validators";
import {
  eventMutation,
  eventQuery,
  orgMutation,
  orgQuery,
} from "./lib/functions";
import { vv } from "./lib/validators";
import * as Events from "./model/events";

export const create = orgMutation({
  args: {
    name: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    timezone: v.string(),
  },
  returns: v.object({ slug: v.string() }),
  handler: async (ctx, args) => {
    const event = await Events.createEvent(ctx, ctx.caller, args);
    return { slug: event.slug };
  },
});

// Events visible to the caller within one org: org owner/admin see all;
// event-scoped members see only their events.
export const listForOrg = orgQuery({
  args: {},
  returns: v.array(vv.doc("events")),
  handler: async (ctx) => {
    return await Events.listVisible(ctx, ctx.caller);
  },
});

export const get = eventQuery({
  args: {},
  returns: v.object({
    event: vv.doc("events"),
    org: vv.doc("organizations"),
    role: v.union(v.literal("organizer"), v.literal("reviewer")),
    orgRole: v.union(v.literal("owner"), v.literal("admin"), v.null()),
  }),
  handler: async (ctx) => {
    return {
      event: ctx.caller.event,
      org: ctx.caller.org,
      role: ctx.caller.role,
      orgRole: ctx.caller.orgRole,
    };
  },
});

export const updateSettings = eventMutation({
  args: {
    patch: v.object({
      name: v.optional(v.string()),
      slug: v.optional(v.string()),
      startsAt: v.optional(v.number()),
      endsAt: v.optional(v.number()),
      timezone: v.optional(v.string()),
      type: v.optional(nullable(v.string())),
      location: v.optional(nullable(v.string())),
      website: v.optional(nullable(v.string())),
      description: v.optional(nullable(v.string())),
      logoId: v.optional(nullable(v.id("_storage"))),
      bannerId: v.optional(nullable(v.id("_storage"))),
      cfpOpenAt: v.optional(nullable(v.number())),
      cfpCloseAt: v.optional(nullable(v.number())),
      cfpPublished: v.optional(v.boolean()),
      // M5 comms settings; null clears.
      reminderCadenceDays: v.optional(nullable(v.number())),
      replyTo: v.optional(nullable(v.string())),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Events.updateEventSettings(ctx, ctx.caller, args.patch);
    return null;
  },
});

export const setArchived = eventMutation({
  args: { archived: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Events.setArchived(ctx, ctx.caller, args.archived);
    return null;
  },
});
