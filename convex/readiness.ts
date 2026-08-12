import { v } from "convex/values";
import { eventQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as ControlCenter from "./model/controlCenter";
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
      decisions: v.number(),
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

// ─────────────────────────────────────────────────────────────────────────
// The event control center (W8). FOUR PANELS, FOUR SUBSCRIPTIONS.
//
// Deliberately NOT one query. Readiness reads refuse (`event_too_large`)
// rather than truncate, so a single mega-query would let one over-ceiling
// table blank the whole screen; and the caps sum past Convex's per-transaction
// document limit at worst case anyway. Each panel below therefore stands on
// its own, and the route renders a contained error for the one that refuses.
//
// The read policy per panel is a decision, not a default — see the header of
// convex/model/controlCenter.ts for why each one truncates or refuses.
// ─────────────────────────────────────────────────────────────────────────

/** Tab ids the control center may deep-link to — the shell's TAB_PATHS keys. */
const vControlTab = v.union(
  v.literal("cfp"),
  v.literal("proposals"),
  v.literal("reviews"),
  v.literal("sessions"),
  v.literal("speakers"),
  v.literal("tasks"),
  v.literal("agenda"),
  v.literal("publish"),
  v.literal("comms"),
  v.literal("details"),
  v.literal("settings"),
  v.literal("team"),
  v.literal("import"),
);

/** A destination plus the destination route's OWN search vocabulary, so a
 * count lands on already-filtered work rather than on a page to filter. */
const vControlLink = v.object({
  tab: vControlTab,
  search: v.optional(v.record(v.string(), v.string())),
});

const vControlRow = v.object({
  id: v.string(),
  label: v.string(),
  count: v.number(),
  capped: v.boolean(),
  sentence: v.string(),
  tone: v.union(
    v.literal("neutral"),
    v.literal("info"),
    v.literal("success"),
    v.literal("attention"),
    v.literal("blocked"),
  ),
  link: vControlLink,
});

/**
 * "What needs my attention" — the rows the UX review specified, each counted
 * and deep-linked, plus the first-event decision and the lifecycle checklist.
 *
 * TRUNCATES (`takeCapped`). This panel is the reason the page exists, so it
 * must render for any event; its counts are prompts to go and look, and a
 * floor rendered as "at least 500" is honest and still actionable.
 */
export const attentionPanel = eventQuery({
  args: { now: v.number() },
  returns: v.object({
    rows: v.array(vControlRow),
    firstEvent: v.boolean(),
    checklist: v.array(
      v.object({
        id: v.union(
          v.literal("setup"),
          v.literal("cfp"),
          v.literal("collect"),
          v.literal("select"),
          v.literal("schedule"),
          v.literal("publish"),
        ),
        label: v.string(),
        state: v.union(
          v.literal("done"),
          v.literal("active"),
          v.literal("todo"),
        ),
        sentence: v.string(),
        action: v.union(
          v.null(),
          v.object({ label: v.string(), link: vControlLink }),
        ),
      }),
    ),
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    return await ControlCenter.attentionPanel(ctx, ctx.caller, args.now);
  },
});

/**
 * "What changed recently" — the audit rows every capability already writes,
 * rendered as sentences. No new write path, no derived history.
 *
 * TRUNCATES by construction: a feed is latest-N, so there is no whole-table
 * answer for a cap to falsify.
 */
export const recentChanges = eventQuery({
  args: {},
  returns: v.object({
    rows: v.array(
      v.object({
        auditId: vv.id("auditLog"),
        at: v.number(),
        actor: v.union(v.string(), v.null()),
        viaAgent: v.boolean(),
        action: v.string(),
        sentence: v.string(),
        link: v.union(vControlLink, v.null()),
      }),
    ),
    capped: v.boolean(),
  }),
  handler: async (ctx) => {
    return await ControlCenter.recentChanges(ctx, ctx.caller);
  },
});

/**
 * "What happens next" — the dated milestones, and each publication channel's
 * state with its "last published by … at …" attribution.
 *
 * Bounded by construction: single-row reads plus the flags map (which refuses
 * on its own, and is the same read the publish console already makes).
 */
export const upNext = eventQuery({
  args: { now: v.number() },
  returns: v.object({
    milestones: v.array(
      v.object({
        id: v.union(
          v.literal("cfpOpens"),
          v.literal("cfpCloses"),
          v.literal("eventStarts"),
          v.literal("eventEnds"),
        ),
        label: v.string(),
        at: v.number(),
        past: v.boolean(),
        sentence: v.string(),
      }),
    ),
    channels: v.array(
      v.object({
        id: v.union(v.literal("lineup"), v.literal("agenda")),
        label: v.string(),
        published: v.boolean(),
        sentence: v.string(),
        link: vControlLink,
      }),
    ),
    version: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    return await ControlCenter.upNext(ctx, ctx.caller, args.now);
  },
});
