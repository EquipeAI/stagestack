import { v } from "convex/values";
import { authedMutation, authedQuery, orgQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Orgs from "./model/orgs";

export const create = authedMutation({
  args: { name: v.string() },
  returns: v.object({ slug: v.string() }),
  handler: async (ctx, args) => {
    const org = await Orgs.createOrg(ctx, ctx.user, args.name);
    return { slug: org.slug };
  },
});

// My StageStack home: orgs + events the user can see. Grows with later
// milestones (drafts, proposals, reviews, speaking engagements).
export const myHome = authedQuery({
  args: {},
  returns: v.array(
    v.object({
      org: vv.doc("organizations"),
      role: v.union(v.literal("owner"), v.literal("admin"), v.null()),
      events: v.array(vv.doc("events")),
    }),
  ),
  handler: async (ctx) => {
    return await Orgs.myHome(ctx, ctx.user);
  },
});

export const get = orgQuery({
  args: {},
  returns: v.object({
    org: vv.doc("organizations"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.null()),
  }),
  handler: async (ctx) => {
    return { org: ctx.caller.org, role: ctx.caller.orgRole };
  },
});
