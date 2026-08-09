import { v } from "convex/values";
import { query } from "./_generated/server";
import { vFormDef } from "./shared/formDef";
import * as Cfp from "./model/cfp";

// The unauthenticated public CFP page (stagestack.dev/cfp/<eventSlug>).
// Deliberately its own module so the whole authenticated CFP surface stays in
// convex/cfp.ts and this file is trivially auditable: one read-only query that
// returns nothing until the organizer publishes.

export const get = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.object({
      event: v.object({
        name: v.string(),
        slug: v.string(),
        startsAt: v.number(),
        endsAt: v.number(),
        timezone: v.string(),
        location: v.optional(v.string()),
        description: v.optional(v.string()),
        website: v.optional(v.string()),
      }),
      form: vFormDef,
      version: v.number(),
      cfpOpenAt: v.optional(v.number()),
      cfpCloseAt: v.optional(v.number()),
      successMessage: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await Cfp.getPublicCfp(ctx, args.eventSlug);
  },
});
