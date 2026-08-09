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
    // Validate before touching the limiter so junk input gets a 400-style
    // error, not a consumed token. (Throws roll back the whole mutation
    // anyway — limiter debits included — so ordering is about clarity and
    // hot-path cost, not correctness.)
    const talkTitle = args.talkTitle.trim();
    if (talkTitle.length === 0 || talkTitle.length > 200) {
      throw new ConvexError({
        code: "invalid_talk_title",
        message: "Talk title must be 1-200 characters.",
      });
    }
    // anonKey is the bearer credential for this draft until it's linked to an
    // account (M1) — enforce unguessability at write time, not at link time.
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(args.anonKey)) {
      throw new ConvexError({
        code: "invalid_anon_key",
        message: "anonKey must be 32-128 chars of [A-Za-z0-9_-].",
      });
    }
    // Global backstop first: it's the real gate (per-client keys are
    // client-supplied and spoofable) and cheaper on the hot-rejection path.
    const global = await rateLimiter.limit(ctx, "cfpDraftGlobal");
    if (!global.ok) {
      throw new ConvexError({
        code: "rate_limited",
        retryAfter: global.retryAfter,
      });
    }
    const perClient = await rateLimiter.limit(ctx, "cfpDraftPerClient", {
      key: args.anonKey,
    });
    if (!perClient.ok) {
      throw new ConvexError({
        code: "rate_limited",
        retryAfter: perClient.retryAfter,
      });
    }
    return await ctx.db.insert("cfpDrafts", {
      talkTitle,
      anonKey: args.anonKey,
      status: "draft",
    });
  },
});
