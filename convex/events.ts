import { v } from "convex/values";
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
    const { caller } = ctx;
    const all = await ctx.db
      .query("events")
      .withIndex("by_orgId", (q) => q.eq("orgId", caller.org._id))
      .take(200);
    if (caller.orgRole !== null) return all;
    const memberships = await ctx.db
      .query("eventMembers")
      .withIndex("by_userId", (q) => q.eq("userId", caller.user._id))
      .take(200);
    const mine = new Set(
      memberships
        .filter((m) => m.orgId === caller.org._id)
        .map((m) => m.eventId),
    );
    return all.filter((e) => mine.has(e._id));
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

const vNullable = <T extends Parameters<typeof v.union>[0]>(x: T) =>
  v.union(x, v.null());

export const updateSettings = eventMutation({
  args: {
    patch: v.object({
      name: v.optional(v.string()),
      slug: v.optional(v.string()),
      startsAt: v.optional(v.number()),
      endsAt: v.optional(v.number()),
      timezone: v.optional(v.string()),
      type: v.optional(vNullable(v.string())),
      location: v.optional(vNullable(v.string())),
      website: v.optional(vNullable(v.string())),
      description: v.optional(vNullable(v.string())),
      logoId: v.optional(vNullable(v.id("_storage"))),
      bannerId: v.optional(vNullable(v.id("_storage"))),
      cfpOpenAt: v.optional(vNullable(v.number())),
      cfpCloseAt: v.optional(vNullable(v.number())),
      cfpPublished: v.optional(v.boolean()),
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
