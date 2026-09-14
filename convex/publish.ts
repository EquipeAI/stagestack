import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { eventMutation, eventQuery, publicQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Publish from "./model/publish";
import * as PublishBulk from "./model/publishBulk";

// Organizer publication console (M7). Public read path is convex/publicProgram
// + convex/http.ts. The served projection is privacy-filtered in model/publish.

// ── The public program, as a validator ─────────────────────────────────────
//
// ONE shape for every surface that serves the projection: `publish.state`'s
// live preview, `publish.publicProgram`, and anything else that ever returns a
// `PublicProgram`. Defining it once means the model can add a field and every
// consumer's generated types pick it up — and a field the model EMITS but this
// validator forgets would be silently stripped by Convex, which is exactly the
// kind of drift this shared definition exists to prevent. Kept in lockstep
// with `PublicProgram` in model/publish.ts (the field list below IS that type).
const vPublicSpeaker = v.object({
  speakerId: v.string(),
  name: v.string(),
  tagline: v.optional(v.string()),
  jobTitle: v.optional(v.string()),
  company: v.optional(v.string()),
  bio: v.optional(v.string()),
  headshotUrl: v.optional(v.string()),
  links: v.optional(
    v.object({
      website: v.optional(v.string()),
      twitter: v.optional(v.string()),
      linkedin: v.optional(v.string()),
      github: v.optional(v.string()),
    }),
  ),
});

const vPublicSession = v.object({
  sessionId: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
  format: v.optional(v.string()),
  trackName: v.optional(v.string()),
  startsAt: v.optional(v.number()),
  endsAt: v.optional(v.number()),
  roomName: v.optional(v.string()),
  speakers: v.array(vPublicSpeaker),
  toBeAnnounced: v.boolean(),
});

export const vPublicProgram = v.object({
  event: v.object({
    name: v.string(),
    slug: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    timezone: v.string(),
    location: v.optional(v.string()),
    description: v.optional(v.string()),
    website: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
  }),
  lineupPublished: v.boolean(),
  agendaPublished: v.boolean(),
  lineup: v.array(vPublicSession),
  agenda: v.array(
    v.union(
      v.object({ kind: v.literal("session"), ...vPublicSession.fields }),
      v.object({
        kind: v.literal("item"),
        itemId: v.string(),
        title: v.string(),
        startsAt: v.number(),
        endsAt: v.number(),
        roomName: v.optional(v.string()),
        description: v.optional(v.string()),
      }),
    ),
  ),
});

export const state = eventQuery({
  args: {},
  returns: v.object({
    lineupPublished: v.boolean(),
    agendaPublished: v.boolean(),
    // True when the served blob is behind current state — editorial edits
    // awaiting a republish, or a scheduled rebuild that threw instead of landing.
    stale: v.boolean(),
    // The projection under the CURRENT flags — the console's live preview.
    // Computed once for both this and `stale` (F6: one projection, not two),
    // and TYPED so the frontend gets the real shape instead of `any`.
    preview: vPublicProgram,
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

// ── Diff preview (W10) ────────────────────────────────────────────────────
//
// "What will publishing change?" answered per channel, from the same read
// pattern `state` uses (served blob + fresh recompute) with a structural diff
// instead of a boolean. Organizer-only, and read-only: the 1MiB guard still
// lives in the publish mutation, where a refusal can roll a flag flip back.

const vChangeField = v.union(
  v.literal("title"),
  v.literal("format"),
  v.literal("track"),
  v.literal("description"),
  v.literal("speakers"),
  v.literal("slot"),
  v.literal("details"),
);

const vDiffEntry = v.object({
  id: v.string(),
  title: v.string(),
  changes: v.array(vChangeField),
});

const vChannelDiff = v.object({
  added: v.array(vDiffEntry),
  changed: v.array(vDiffEntry),
  removed: v.array(vDiffEntry),
  empty: v.boolean(),
  // Empty diff ≠ nothing to do: turning an empty channel ON is a real action.
  doesNothing: v.boolean(),
  servedCount: v.number(),
  wouldBeCount: v.number(),
  sentence: v.string(),
  unpublishSentence: v.string(),
});

export const diff = eventQuery({
  args: {},
  returns: v.object({
    neverPublished: v.boolean(),
    lineup: vChannelDiff,
    agenda: vChannelDiff,
  }),
  handler: async (ctx) => {
    return await Publish.programDiff(ctx, ctx.caller);
  },
});

// ── Bulk publish (W10) ────────────────────────────────────────────────────
//
// The plan query and the mutation call the SAME model producer, so the
// arithmetic stated before the click is the arithmetic the click enforces.

const vChannel = v.union(v.literal("lineup"), v.literal("agenda"));

export const bulkPlan = eventQuery({
  args: { channel: vChannel },
  returns: v.object({
    channel: vChannel,
    enablesChannel: v.boolean(),
    targets: v.array(
      v.object({
        kind: v.union(v.literal("session"), v.literal("agendaItem")),
        id: v.string(),
        title: v.string(),
        alreadyPublished: v.boolean(),
      }),
    ),
    eligible: v.number(),
    alreadyPublished: v.number(),
    excluded: v.array(
      v.object({
        sessionId: vv.id("sessions"),
        title: v.string(),
        sentence: v.string(),
      }),
    ),
    sentence: v.string(),
  }),
  handler: async (ctx, args) => {
    return await PublishBulk.channelPlan(ctx, ctx.caller, args.channel);
  },
});

export const bulkPublish = eventMutation({
  args: { channel: vChannel },
  returns: v.object({
    channel: vChannel,
    status: v.union(v.literal("success"), v.literal("noop")),
    title: v.string(),
    lines: v.array(v.string()),
    published: v.number(),
    alreadyPublished: v.number(),
    excluded: v.number(),
  }),
  handler: async (ctx, args) => {
    return await PublishBulk.bulkPublishChannel(ctx, ctx.caller, args.channel);
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
//
// Deliberately NOT typed by `vPublicProgram`: this serves the STORED blob,
// which may predate fields added to the shape since it was written. The
// freshly-computed preview above is always current, so it is the one surface
// that carries the strict validator. A served blob is re-validated the next
// time a rebuild rewrites it.
export const publicProgram = publicQuery({
  args: { slug: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await Publish.publicProgramBySlug(ctx, args.slug);
  },
});
