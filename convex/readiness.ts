import { v } from "convex/values";
import { eventQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Readiness from "./model/readiness";

// ─────────────────────────────────────────────────────────────────────────
// The readiness vocabulary's public surface (W4). Thin wrappers; every rule
// and every rendered string lives in convex/model/readiness.ts.
//
// `publication` is the per-page truth (a refusing, whole-event read, same caps
// as the projection it mirrors). `attention` is the cheap, truncating counts
// query the navigation rail subscribes to. Both derive from the same model
// code, so a badge and a session's summary can never disagree.
//
// The speaker-tracking dashboard stays where it has always been
// (convex/tasks.ts `dashboard`) — it takes a ticking `now`, and nothing in the
// shell may subscribe to that.
// ─────────────────────────────────────────────────────────────────────────

const vPublicationReasonCode = v.union(
  v.literal("session_cancelled"),
  v.literal("content_draft"),
  v.literal("session_not_published"),
  v.literal("lineup_not_published"),
  v.literal("slot_not_released"),
  v.literal("agenda_not_published"),
);

/** Tab ids from the app shell's TAB_PATHS — the deep-link vocabulary. */
const vPublicationTab = v.union(
  v.literal("sessions"),
  v.literal("agenda"),
  v.literal("publish"),
);

const vPublicationReason = v.object({
  code: vPublicationReasonCode,
  // "both" is the common case; "lineup" alone exists because the public page
  // toggle empties the lineup while a published schedule keeps serving.
  blocks: v.union(v.literal("both"), v.literal("lineup"), v.literal("agenda")),
  sentence: v.string(),
  repair: v.object({
    tab: vPublicationTab,
    params: v.optional(v.object({ sessionId: v.optional(vv.id("sessions")) })),
  }),
});

/** Every session's publication state, with the sentences surfaces print. */
export const publication = eventQuery({
  args: {},
  returns: v.array(
    v.object({
      sessionId: vv.id("sessions"),
      title: v.string(),
      publication: v.object({
        inLineup: v.boolean(),
        inAgenda: v.boolean(),
        toBeAnnounced: v.boolean(),
        reasons: v.array(vPublicationReason),
        summary: v.string(),
      }),
    }),
  ),
  handler: async (ctx) => {
    return await Readiness.publicationBoard(ctx, ctx.caller);
  },
});

/**
 * Per-module attention counts for the navigation rail (consumed by W7).
 *
 * No `now` argument by design: a ticking argument on a query the shell
 * subscribes to would re-run it on every tick. Overdue tasks are a subset of
 * the open ones counted here; the ticking view is the dashboard.
 */
export const attention = eventQuery({
  args: {},
  returns: v.object({
    counts: v.object({
      proposals: v.number(),
      reviews: v.number(),
      sessions: v.number(),
      speakers: v.number(),
      agenda: v.number(),
      tasks: v.number(),
      publish: v.number(),
    }),
    // True when a read hit its ceiling: the counts are floors, not totals.
    // This query truncates rather than refusing — the navigation must render
    // even for an event too large to scan in one pass.
    capped: v.boolean(),
  }),
  handler: async (ctx) => {
    return await Readiness.attentionCounts(ctx, ctx.caller);
  },
});
