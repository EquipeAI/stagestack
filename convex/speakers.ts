import { v } from "convex/values";
import { eventMutation, eventQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Speakers from "./model/speakers";

// ─────────────────────────────────────────────────────────────────────────
// Organizer speaker roster (W6). Thin wrappers; rules in model/speakers.ts.
// ─────────────────────────────────────────────────────────────────────────

const vCustomValues = v.record(
  v.string(),
  v.union(v.string(), v.array(v.string())),
);

const vParticipationState = v.union(
  v.literal("awaiting"),
  v.literal("confirmed"),
  v.literal("declined"),
  v.literal("withdrawn"),
);

export const roster = eventQuery({
  args: { search: v.optional(v.string()) },
  returns: v.array(
    v.object({
      eventContactId: vv.id("eventContacts"),
      firstName: v.string(),
      lastName: v.string(),
      email: v.optional(v.string()),
      tagline: v.optional(v.string()),
      jobTitle: v.optional(v.string()),
      company: v.optional(v.string()),
      bio: v.optional(v.string()),
      headshotUrl: v.union(v.string(), v.null()),
      claimed: v.boolean(),
      customValues: vCustomValues,
      sessions: v.array(
        v.object({
          sessionId: vv.id("sessions"),
          title: v.string(),
          state: vParticipationState,
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    return await Speakers.roster(ctx, ctx.caller, args.search);
  },
});

export const updateProfile = eventMutation({
  args: {
    eventContactId: v.id("eventContacts"),
    patch: v.object({
      firstName: v.optional(v.string()),
      lastName: v.optional(v.string()),
      email: v.optional(v.string()),
      tagline: v.optional(v.string()),
      jobTitle: v.optional(v.string()),
      company: v.optional(v.string()),
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
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Speakers.updateSpeakerProfile(
      ctx,
      ctx.caller,
      args.eventContactId,
      args.patch,
    );
    return null;
  },
});

export const setCustomValues = eventMutation({
  args: {
    eventContactId: v.id("eventContacts"),
    values: vCustomValues,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Speakers.setCustomValues(
      ctx,
      ctx.caller,
      args.eventContactId,
      args.values,
    );
    return null;
  },
});

export const importRows = eventMutation({
  args: {
    rows: v.array(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        email: v.optional(v.string()),
        tagline: v.optional(v.string()),
        jobTitle: v.optional(v.string()),
        company: v.optional(v.string()),
        bio: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({
    created: v.number(),
    merged: v.number(),
    skipped: v.array(v.object({ row: v.number(), reason: v.string() })),
  }),
  handler: async (ctx, args) => {
    return await Speakers.importRows(ctx, ctx.caller, args.rows);
  },
});
