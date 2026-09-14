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

const vPreviewRecipient = v.object({
  eventContactId: v.union(vv.id("eventContacts"), v.null()),
  name: v.string(),
  firstName: v.string(),
  lastName: v.string(),
  email: v.union(v.string(), v.null()),
  sample: v.boolean(),
});

/**
 * Live preview (W3): the saved template, or the draft still being typed,
 * rendered through the exact substitution — and the exact escaping — a real
 * send uses. `eventContactId` personalises it against a real speaker on this
 * event; without one the recipient is a clearly-flagged stand-in.
 */
export const preview = eventQuery({
  args: {
    key: v.string(),
    /** Present while the editor is dirty; absent previews what is stored. */
    draft: v.optional(v.object({ subject: v.string(), html: v.string() })),
    eventContactId: v.optional(v.id("eventContacts")),
  },
  returns: v.object({
    subject: v.string(),
    html: v.string(),
    recipient: vPreviewRecipient,
  }),
  handler: async (ctx, args) => {
    return await Templates.previewTemplate(ctx, ctx.caller, args);
  },
});

/** Speakers on this event a preview can be personalised against. Organizer
 * only: a preview carries a real person's name and address. */
export const previewRecipients = eventQuery({
  args: {},
  returns: v.array(vPreviewRecipient),
  handler: async (ctx) => {
    return await Templates.previewRecipients(ctx, ctx.caller);
  },
});
