import { v } from "convex/values";
import { query } from "./_generated/server";
import { eventMutation, eventQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Embeds from "./model/embeds";

// ─────────────────────────────────────────────────────────────────────────
// Embeds (W3). Organizer CRUD + ONE anonymous read (`resolve`) that serves
// exclusively already-published projection data with the embed's filters.
// ─────────────────────────────────────────────────────────────────────────

const vWidget = v.union(
  v.literal("sessions"),
  v.literal("speakers"),
  v.literal("agenda"),
  v.literal("itinerary"),
  v.literal("gallery"),
);

const vConfig = v.object({
  trackName: v.optional(v.string()),
  brandColor: v.optional(v.string()),
  hiddenFields: v.optional(v.array(v.string())),
});

export const list = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      embedId: vv.id("embeds"),
      name: v.string(),
      widget: vWidget,
      enabled: v.boolean(),
      config: vConfig,
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await Embeds.listEmbeds(ctx, ctx.caller);
    return rows.map((row) => ({
      embedId: row._id,
      name: row.name,
      widget: row.widget,
      enabled: row.enabled,
      config: row.config,
      updatedAt: row.updatedAt,
    }));
  },
});

export const create = eventMutation({
  args: { name: v.string(), widget: vWidget, config: vConfig },
  returns: vv.id("embeds"),
  handler: async (ctx, args) => {
    return await Embeds.createEmbed(ctx, ctx.caller, args);
  },
});

export const update = eventMutation({
  args: {
    embedId: v.id("embeds"),
    name: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    config: v.optional(vConfig),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { embedId, ...patch } = args;
    await Embeds.updateEmbed(ctx, ctx.caller, embedId, patch);
    return null;
  },
});

export const remove = eventMutation({
  args: { embedId: v.id("embeds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Embeds.deleteEmbed(ctx, ctx.caller, args.embedId);
    return null;
  },
});

/** Anonymous: the widget payload behind /embed/w/<id> and /api/embeds/<id>.
 * Serves only already-published data; disabled/unknown ids read as null. */
export const resolve = query({
  args: { embedId: v.string() },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    return await Embeds.resolveEmbed(ctx, args.embedId);
  },
});
