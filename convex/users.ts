import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";

// Called by the web app right after Clerk sign-in (and after any auth state
// change). Upserts the user row keyed on tokenIdentifier — the one write that
// can't go through authedMutation because the row may not exist yet.
export const ensure = mutation({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => {
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
    const profile = {
      clerkSubject: identity.subject,
      email: identity.email?.toLowerCase(),
      name: identity.name ?? identity.email ?? undefined,
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
