import { v } from "convex/values";
import { eventMutation, eventQuery, publicQuery } from "./lib/functions";
import * as Publish from "./model/publish";

// Organizer publication console (M7). Public read path is convex/publicProgram
// + convex/http.ts. The served projection is privacy-filtered in model/publish.

export const state = eventQuery({
  args: {},
  returns: v.object({
    lineupPublished: v.boolean(),
    agendaPublished: v.boolean(),
    version: v.union(v.number(), v.null()),
    publishedAt: v.union(v.number(), v.null()),
    publishedSessionIds: v.array(v.string()),
    publishedAgendaItemIds: v.array(v.string()),
    acceptedSessions: v.number(),
    releasedSessions: v.number(),
  }),
  handler: async (ctx) => {
    return await Publish.publishState(ctx, ctx.caller);
  },
});

// Live preview of what WOULD be served given the current flags — lets the
// organizer see the page before the public does, without persisting.
export const preview = eventQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    return await Publish.computeProgram(ctx, ctx.caller.event);
  },
});

export const setLineup = eventMutation({
  args: { enabled: v.boolean() },
  returns: v.number(),
  handler: async (ctx, args) => {
    return await Publish.publish(ctx, ctx.caller, {
      kind: "lineup",
      enabled: args.enabled,
    });
  },
});

export const setAgenda = eventMutation({
  args: { enabled: v.boolean() },
  returns: v.number(),
  handler: async (ctx, args) => {
    return await Publish.publish(ctx, ctx.caller, {
      kind: "agenda",
      enabled: args.enabled,
    });
  },
});

export const setSession = eventMutation({
  args: { sessionId: v.id("sessions"), published: v.boolean() },
  returns: v.number(),
  handler: async (ctx, args) => {
    return await Publish.publish(ctx, ctx.caller, {
      kind: "session",
      sessionId: args.sessionId,
      published: args.published,
    });
  },
});

export const setAgendaItem = eventMutation({
  args: { itemId: v.id("agendaItems"), published: v.boolean() },
  returns: v.number(),
  handler: async (ctx, args) => {
    return await Publish.publish(ctx, ctx.caller, {
      kind: "agendaItem",
      itemId: args.itemId,
      published: args.published,
    });
  },
});

// Public, unauthenticated read of the SERVED projection (the last explicitly
// published version). Powers the public event page SSR; the HTTP API in
// convex/http.ts reads the same model function.
export const publicProgram = publicQuery({
  args: { slug: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await Publish.publicProgramBySlug(ctx, args.slug);
  },
});
