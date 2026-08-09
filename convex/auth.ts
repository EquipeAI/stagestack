import { query } from "./_generated/server";
import { v } from "convex/values";

// Walking-skeleton check: proves the Clerk JWT round-trips into Convex.
export const viewer = query({
  args: {},
  returns: v.union(
    v.object({
      subject: v.string(),
      name: v.union(v.string(), v.null()),
      email: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return null;
    }
    return {
      subject: identity.subject,
      name: identity.name ?? null,
      email: identity.email ?? null,
    };
  },
});
