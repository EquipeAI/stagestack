import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { eventMutation, eventQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Library from "./model/library";

const vKind = v.union(
  v.literal("tracks"),
  v.literal("tags"),
  v.literal("rooms"),
  v.literal("formats"),
  v.literal("customFields"),
);

const vItemInput = v.object({
  name: v.string(),
  description: v.optional(v.string()),
  color: v.optional(v.string()),
  capacity: v.optional(v.number()),
  defaultDurationMinutes: v.optional(v.number()),
  kind: v.optional(
    v.union(
      v.literal("text"),
      v.literal("number"),
      v.literal("select"),
      v.literal("multiselect"),
      v.literal("url"),
    ),
  ),
  options: v.optional(v.array(v.string())),
  appliesTo: v.optional(v.union(v.literal("session"), v.literal("speaker"))),
});

export const list = eventQuery({
  args: {},
  returns: v.object({
    tracks: v.array(vv.doc("tracks")),
    tags: v.array(vv.doc("tags")),
    rooms: v.array(vv.doc("rooms")),
    formats: v.array(vv.doc("formats")),
    customFields: v.array(vv.doc("customFields")),
    capped: v.object({
      tracks: v.boolean(),
      tags: v.boolean(),
      rooms: v.boolean(),
      formats: v.boolean(),
      customFields: v.boolean(),
    }),
  }),
  handler: async (ctx) => {
    return await Library.listLibrary(ctx, ctx.caller.event._id);
  },
});

export const add = eventMutation({
  args: { table: vKind, item: vItemInput },
  returns: v.string(),
  handler: async (ctx, args) => {
    return await Library.addLibraryItem(ctx, ctx.caller, args.table, args.item);
  },
});

export const update = eventMutation({
  args: {
    table: vKind,
    id: v.string(),
    patch: v.object({ ...vItemInput.fields, name: v.optional(v.string()), order: v.optional(v.number()) }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Library.updateLibraryItem(
      ctx,
      ctx.caller,
      args.table,
      args.id,
      args.patch,
    );
    return null;
  },
});

export const remove = eventMutation({
  args: { table: vKind, id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Library.removeLibraryItem(ctx, ctx.caller, args.table, args.id);
    return null;
  },
});

/**
 * One-event migration of free-text `sessions.format` values into formats
 * library rows (W2). INTERNAL and per-event on purpose: it is the rehearsable
 * unit — run it against dev, read the counts, then run it per event on
 * develop/prod. It is idempotent, so a re-run is always safe.
 */
export const backfillFormats = internalMutation({
  args: { eventId: v.id("events") },
  returns: v.object({
    formatsCreated: v.number(),
    sessionsLinked: v.number(),
    unmatched: v.number(),
  }),
  handler: async (ctx, args) => {
    return await Library.backfillFormats(ctx, args.eventId);
  },
});
