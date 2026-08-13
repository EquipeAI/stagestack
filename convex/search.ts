import { v } from "convex/values";
import { authedQuery, resolveEventCaller } from "./lib/functions";
import * as Search from "./model/search";

// ─────────────────────────────────────────────────────────────────────────
// The command palette's read surface (W1). One thin wrapper; every rule and
// every rendered string lives in convex/model/search.ts.
//
// `authedQuery` rather than `eventQuery` because the palette outlives any one
// event: it opens on My StageStack and on an organization page too, where
// there is no event slug to scope by. When there IS one, the event caller is
// resolved through the same `resolveEventCaller` every event surface uses —
// so a slug the caller has no membership on refuses here exactly as it would
// anywhere else, before the model reads a single record.
// ─────────────────────────────────────────────────────────────────────────

const vSearchKind = v.union(
  v.literal("event"),
  v.literal("session"),
  v.literal("speaker"),
  v.literal("proposal"),
  v.literal("review"),
);

const vSearchHit = v.object({
  kind: vSearchKind,
  /** The record id, spent as a route param — heterogeneous, so a string. */
  id: v.string(),
  eventSlug: v.string(),
  title: v.string(),
  subtitle: v.optional(v.string()),
  /** The destination route's own filter vocabulary, when it has one. */
  query: v.optional(v.string()),
});

export const everything = authedQuery({
  args: {
    term: v.string(),
    /** The event the palette was opened from, when it was opened in one. */
    eventSlug: v.optional(v.string()),
  },
  returns: v.object({
    groups: v.array(
      v.object({
        kind: vSearchKind,
        label: v.string(),
        hits: v.array(vSearchHit),
        capped: v.boolean(),
        sentence: v.string(),
      }),
    ),
    summary: v.string(),
  }),
  handler: async (ctx, args) => {
    const caller =
      args.eventSlug === undefined
        ? null
        : await resolveEventCaller(ctx, args.eventSlug);
    return await Search.search(ctx, ctx.user, caller, args.term);
  },
});
