import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/functions";
import {
  canonicalIdentityName,
  requirePersonDisplayName,
  storedPersonName,
} from "./model/userDisplay";

// Called by the web app right after Clerk sign-in (and after any auth state
// change). Upserts the user row keyed on tokenIdentifier — the one write that
// can't go through authedMutation because the row may not exist yet.
export const ensure = mutation({
  args: { displayName: v.optional(v.string()) },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new ConvexError({
        code: "not_authenticated",
        message: "Sign in to continue.",
      });
    }
    const existing = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
    const canonicalName = canonicalIdentityName(identity, args.displayName);
    const profile = {
      clerkSubject: identity.subject,
      // Display/delivery data only, stored regardless of verification —
      // NEVER an authorization key. Anything that authorizes by address
      // (portal claiming, handoff completion) must re-read the live token
      // and require `identity.emailVerified` (see model/portal.enterPortal).
      email: identity.email?.toLowerCase(),
      // A claimless refresh must not erase a legitimate stored display name.
      // Conversely, an old name equal to the delivery email is deliberately
      // not preserved: that was the legacy fallback this path self-heals.
      name:
        canonicalName ??
        (existing === null
          ? undefined
          : (storedPersonName(existing) ?? undefined)),
      imageUrl: identity.pictureUrl,
    };
    if (existing !== null) {
      // The client calls this on every auth state change; only write when the
      // Clerk profile actually moved, so we don't churn the row (and every
      // query subscribed to it) on each page load.
      const changed =
        existing.clerkSubject !== profile.clerkSubject ||
        existing.email !== profile.email ||
        existing.name !== profile.name ||
        existing.imageUrl !== profile.imageUrl;
      if (changed) {
        await ctx.db.patch("users", existing._id, profile);
      }
      return existing._id;
    }
    return await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      ...profile,
    });
  },
});

/** The signed-in account's app-owned presentation profile. Delivery data is
 * deliberately absent: a missing name must never make the UI display email. */
export const currentProfile = authedQuery({
  args: {},
  returns: v.object({
    displayName: v.union(v.string(), v.null()),
    needsDisplayName: v.boolean(),
  }),
  handler: async (ctx) => {
    const displayName = storedPersonName(ctx.user);
    return {
      displayName,
      needsDisplayName: displayName === null,
    };
  },
});

/** Set only the authenticated account's display label. The stable user id and
 * tokenIdentifier remain the actor identity used by authorization and audit. */
export const setDisplayName = authedMutation({
  args: { displayName: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const displayName = requirePersonDisplayName(
      args.displayName,
      ctx.user.email,
    );
    if (ctx.user.name !== displayName) {
      await ctx.db.patch("users", ctx.user._id, { name: displayName });
    }
    return null;
  },
});
