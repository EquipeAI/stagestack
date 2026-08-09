import { v } from "convex/values";
import { query } from "./_generated/server";
import {
  authedMutation,
  eventMutation,
  eventQuery,
  orgMutation,
  orgQuery,
} from "./lib/functions";
import { vv } from "./lib/validators";
import * as Team from "./model/team";

const vTeamMembers = v.array(
  v.object({
    userId: v.id("users"),
    name: v.union(v.string(), v.null()),
    email: v.union(v.string(), v.null()),
    imageUrl: v.union(v.string(), v.null()),
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("organizer"),
      v.literal("reviewer"),
    ),
    scope: v.union(v.literal("organization"), v.literal("event")),
    eventMemberId: v.union(v.id("eventMembers"), v.null()),
  }),
);

export const listForEvent = eventQuery({
  args: {},
  returns: v.object({
    members: vTeamMembers,
    invitations: v.array(vv.doc("invitations")),
  }),
  handler: async (ctx) => {
    return await Team.listEventTeam(ctx, ctx.caller);
  },
});

export const listForOrg = orgQuery({
  args: {},
  returns: v.object({
    members: vTeamMembers,
    invitations: v.array(vv.doc("invitations")),
  }),
  handler: async (ctx) => {
    return await Team.listOrgTeam(ctx, ctx.caller);
  },
});

export const revokeOrgInvitation = orgMutation({
  args: { invitationId: v.id("invitations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Team.revokeOrgInvitation(ctx, ctx.caller, args.invitationId);
    return null;
  },
});

export const inviteToEvent = eventMutation({
  args: {
    email: v.string(),
    role: v.union(v.literal("organizer"), v.literal("reviewer")),
  },
  returns: v.id("invitations"),
  handler: async (ctx, args) => {
    return await Team.inviteToEvent(ctx, ctx.caller, args.email, args.role);
  },
});

export const inviteOrgAdmin = orgMutation({
  args: {
    email: v.string(),
    role: v.union(v.literal("owner"), v.literal("admin")),
  },
  returns: v.id("invitations"),
  handler: async (ctx, args) => {
    return await Team.inviteOrgAdmin(ctx, ctx.caller, args.email, args.role);
  },
});

// Public: the /invite/<token> landing page previews before sign-in. The token
// itself is the credential; this reveals only org/event names + role.
export const previewInvitation = query({
  args: { token: v.string() },
  returns: v.union(
    v.object({
      orgName: v.string(),
      eventName: v.union(v.string(), v.null()),
      role: v.string(),
      status: v.union(
        v.literal("pending"),
        v.literal("accepted"),
        v.literal("revoked"),
        v.literal("expired"),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await Team.previewInvitation(ctx, args.token);
  },
});

export const acceptInvitation = authedMutation({
  args: { token: v.string() },
  returns: v.object({
    orgSlug: v.string(),
    eventSlug: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    return await Team.acceptInvitation(ctx, ctx.user, args.token);
  },
});

export const revokeInvitation = eventMutation({
  args: { invitationId: v.id("invitations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Team.revokeInvitation(ctx, ctx.caller, args.invitationId);
    return null;
  },
});

export const removeEventMember = eventMutation({
  args: { eventMemberId: v.id("eventMembers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Team.removeEventMember(ctx, ctx.caller, args.eventMemberId);
    return null;
  },
});
