import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { eventMutation, eventQuery, publicQuery } from "./lib/functions";
import * as Publish from "./model/publish";

// Organizer publication console (M7). Public read path is convex/publicProgram
// + convex/http.ts. The served projection is privacy-filtered in model/publish.

export const state = eventQuery({
  args: {},
  returns: v.object({
    lineupPublished: v.boolean(),
    agendaPublished: v.boolean(),
    // True when the served blob is behind current state — editorial edits
    // awaiting a republish, or a scheduled rebuild that threw instead of landing.
    stale: v.boolean(),
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

// Every control below flips its flag and SCHEDULES the projection rebuild
// (internal.publish.rebuild), so a toggle costs one small write instead of a
// full event-graph read. They return null rather than the new version because
// the version now lands with the rebuild — `state` above is where the console
// reads it from.
export const setLineup = eventMutation({
  args: { enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Publish.publish(ctx, ctx.caller, {
      kind: "lineup",
      enabled: args.enabled,
    });
    return null;
  },
});

export const setAgenda = eventMutation({
  args: { enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Publish.publish(ctx, ctx.caller, {
      kind: "agenda",
      enabled: args.enabled,
    });
    return null;
  },
});

export const setSession = eventMutation({
  args: { sessionId: v.id("sessions"), published: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Publish.publish(ctx, ctx.caller, {
      kind: "session",
      sessionId: args.sessionId,
      published: args.published,
    });
    return null;
  },
});

export const setAgendaItem = eventMutation({
  args: { itemId: v.id("agendaItems"), published: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Publish.publish(ctx, ctx.caller, {
      kind: "agendaItem",
      itemId: args.itemId,
      published: args.published,
    });
    return null;
  },
});

/**
 * The projection writer, run in its own transaction. Internal: it is only ever
 * scheduled by the mutation that changed the underlying state (a publish flag
 * flip, a withdrawal, a decline) — never called by a client, and it does no
 * authorization of its own because the scheduling mutation already did.
 * `publishedBy` marks an explicit organizer publish (creates the row, enforces
 * the 900KB guard); absent it, an existing blob is refreshed in place.
 */
export const rebuild = internalMutation({
  args: {
    eventId: v.id("events"),
    publishedBy: v.optional(v.id("users")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await Publish.rebuildProgram(ctx, args.eventId, args.publishedBy);
    return null;
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
