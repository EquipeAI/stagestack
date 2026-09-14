import { v } from "convex/values";
import { eventQuery } from "./lib/functions";
import * as Analytics from "./model/analytics";

// ─────────────────────────────────────────────────────────────────────────
// Turnaround analytics (W4) — a thin wrapper. Every interval, every cap and
// every rendered string lives in convex/model/analytics.ts.
//
// ONE query, unlike the control center's four, because this panel truncates
// end to end: it is supplementary by design, it sits BELOW the four questions,
// and its caps are all `takeCapped`. Nothing here refuses, so nothing here
// needs a panel of its own to contain a refusal.
//
// No `now` argument, deliberately: medians over CLOSED intervals need no
// clock, and a ticking argument would re-run this read every minute for an
// answer that only changes when the history does.
// ─────────────────────────────────────────────────────────────────────────

export const turnaround = eventQuery({
  args: {},
  returns: v.object({
    stats: v.array(
      v.object({
        id: v.union(
          v.literal("decision"),
          v.literal("confirmation"),
          v.literal("task"),
          v.literal("publish"),
        ),
        label: v.string(),
        // Closed intervals only — the population the median describes.
        count: v.number(),
        // Started and never finished: named in the sentence, never averaged in.
        openCount: v.number(),
        // Exists, but with no start this history can time. Named in the
        // sentence too — it is what keeps the empty state from denying rows
        // another panel is counting.
        untimeableCount: v.number(),
        // Milliseconds, or null when the population is empty. A null median is
        // the truth an empty population has; zero would be a lie with a number.
        p50: v.union(v.number(), v.null()),
        p90: v.union(v.number(), v.null()),
        capped: v.boolean(),
        sentence: v.string(),
      }),
    ),
    capped: v.boolean(),
    summary: v.string(),
  }),
  handler: async (ctx) => {
    return await Analytics.turnaround(ctx, ctx.caller);
  },
});
