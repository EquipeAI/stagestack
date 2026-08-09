import { v } from "convex/values";
import { eventMutation, eventQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Templates from "./model/templates";

// ─────────────────────────────────────────────────────────────────────────
// Organizer-managed email templates (M5). Thin wrappers; the defaults,
// substitution rules and validation live in convex/model/templates.ts.
// ─────────────────────────────────────────────────────────────────────────

export const list = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      key: v.string(),
      name: v.string(),
      subject: v.string(),
      html: v.string(),
      /** False → this row is the built-in default, nothing stored yet. */
      customized: v.boolean(),
      updatedAt: v.optional(v.number()),
      updatedBy: v.optional(vv.id("users")),
    }),
  ),
  handler: async (ctx) => {
    return await Templates.listTemplates(ctx, ctx.caller);
  },
});

export const upsert = eventMutation({
  args: {
    /** A built-in key, or `custom:<slug>`. */
    key: v.string(),
    name: v.optional(v.string()),
    subject: v.string(),
    html: v.string(),
  },
  returns: vv.id("emailTemplates"),
  handler: async (ctx, args) => {
    return await Templates.upsertTemplate(ctx, ctx.caller, args);
  },
});

/** Delete the override and fall back to StageStack's built-in copy. */
export const reset = eventMutation({
  args: { key: v.string() },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    return { removed: await Templates.resetTemplate(ctx, ctx.caller, args.key) };
  },
});

/** Live preview: the current template rendered against sample data through the
 * exact substitution a real send uses. */
export const preview = eventQuery({
  args: { key: v.string() },
  returns: v.object({ subject: v.string(), html: v.string() }),
  handler: async (ctx, args) => {
    return await Templates.previewTemplate(ctx, ctx.caller, args.key);
  },
});
