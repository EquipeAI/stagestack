import { v, ConvexError } from "convex/values";
import { mutation } from "./_generated/server";
import { components } from "./_generated/api";
import { RateLimiter, MINUTE } from "@convex-dev/rate-limiter";

// Public CFP path is unauthenticated by design (wizard before account step);
// the rate limiter is its only gate. Per-client key is client-supplied and
// therefore spoofable — the global cap is the real backstop.
const rateLimiter = new RateLimiter(components.rateLimiter, {
  cfpDraftPerClient: { kind: "token bucket", rate: 5, period: MINUTE },
  cfpDraftGlobal: { kind: "fixed window", rate: 100, period: MINUTE },
});

export const startDraft = mutation({
  args: {
    talkTitle: v.string(),
    anonKey: v.string(),
  },
  returns: v.id("cfpDrafts"),
  handler: async (ctx, args) => {
    const perClient = await rateLimiter.limit(ctx, "cfpDraftPerClient", {
      key: args.anonKey,
    });
    if (!perClient.ok) {
      throw new ConvexError({
        code: "rate_limited",
        retryAfter: perClient.retryAfter,
      });
    }
    const global = await rateLimiter.limit(ctx, "cfpDraftGlobal");
    if (!global.ok) {
      throw new ConvexError({
        code: "rate_limited",
        retryAfter: global.retryAfter,
      });
    }
    return await ctx.db.insert("cfpDrafts", {
      talkTitle: args.talkTitle,
      anonKey: args.anonKey,
      status: "draft",
    });
  },
});
