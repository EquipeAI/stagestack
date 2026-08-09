import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller, EventRole, OrgCaller, OrgRole } from "../lib/functions";
import { forbidden, notFound, requireOrgAdmin } from "../lib/functions";
import { logAudit } from "./audit";
import { emailShell, escapeHtml, sendLoggedEmail, siteUrl } from "./comms";
import { normalizeEmail } from "./validation";

const INVITE_TTL_MS = 14 * 24 * 3600 * 1000;

function inviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendInviteEmail(
  ctx: MutationCtx,
  args: {
    email: string;
    inviterName: string;
    scopeLabel: string;
    roleLabel: string;
    token: string;
    orgId: Id<"organizations">;
    eventId?: Id<"events">;
    sentByUserId: Id<"users">;
  },
): Promise<void> {
  const link = `${siteUrl()}/invite/${args.token}`;
  await sendLoggedEmail(ctx, {
    orgId: args.orgId,
    eventId: args.eventId,
    toEmail: args.email,
    kind: "team.invite",
    subject: `${args.inviterName} invited you to ${args.scopeLabel} on StageStack`,
    sentByUserId: args.sentByUserId,
    html: emailShell(
      [
        `<p>${escapeHtml(args.inviterName)} invited you to join <strong>${escapeHtml(args.scopeLabel)}</strong> as <strong>${escapeHtml(args.roleLabel)}</strong> on StageStack.</p>`,
        `<p><a href="${link}">Accept the invitation</a> (link expires in 14 days).</p>`,
        `<p>If you weren't expecting this, you can ignore this email.</p>`,
      ].join("\n"),
    ),
  });
}

/** Event-scoped invite (M0): organizers invite co-organizers and reviewers. */
export async function inviteToEvent(
  ctx: MutationCtx,
  caller: EventCaller,
  emailRaw: string,
  role: EventRole,
): Promise<Id<"invitations">> {
  const email = normalizeEmail(emailRaw);
  // Already a member? (by email → user → membership)
  const existingUser = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
  if (existingUser !== null) {
    const membership = await ctx.db
      .query("eventMembers")
      .withIndex("by_eventId_and_userId", (q) =>
        q.eq("eventId", caller.event._id).eq("userId", existingUser._id),
      )
      .unique();
    if (membership !== null) {
      throw new ConvexError({
        code: "already_member",
        message: "That person is already on this event's team.",
      });
    }
  }
  const pending = await ctx.db
    .query("invitations")
    .withIndex("by_email", (q) => q.eq("email", email))
    .take(20);
  if (
    pending.some(
      (i) =>
        i.status === "pending" &&
        i.eventId === caller.event._id &&
        i.expiresAt > Date.now(),
    )
  ) {
    throw new ConvexError({
      code: "already_invited",
      message: "There's already a pending invitation for that email.",
    });
  }
  const token = inviteToken();
  const id = await ctx.db.insert("invitations", {
    orgId: caller.org._id,
    eventId: caller.event._id,
    email,
    role,
    token,
    status: "pending",
    invitedBy: caller.user._id,
    expiresAt: Date.now() + INVITE_TTL_MS,
  });
  await sendInviteEmail(ctx, {
    email,
    inviterName: caller.user.name ?? "An organizer",
    scopeLabel: caller.event.name,
    roleLabel: role,
    token,
    orgId: caller.org._id,
    eventId: caller.event._id,
    sentByUserId: caller.user._id,
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "team.invite",
    targetType: "invitation",
    targetId: id,
    meta: { email, role },
  });
  return id;
}

/** Org-wide admin invite (M0): only org owner/admins grant org-wide access. */
export async function inviteOrgAdmin(
  ctx: MutationCtx,
  caller: OrgCaller,
  emailRaw: string,
  role: OrgRole,
): Promise<Id<"invitations">> {
  requireOrgAdmin(caller);
  if (role === "owner" && caller.orgRole !== "owner") {
    forbidden("Only owners can grant ownership.");
  }
  const email = normalizeEmail(emailRaw);
  const token = inviteToken();
  const id = await ctx.db.insert("invitations", {
    orgId: caller.org._id,
    email,
    role,
    token,
    status: "pending",
    invitedBy: caller.user._id,
    expiresAt: Date.now() + INVITE_TTL_MS,
  });
  await sendInviteEmail(ctx, {
    email,
    inviterName: caller.user.name ?? "An organizer",
    scopeLabel: caller.org.name,
    roleLabel: role,
    token,
    orgId: caller.org._id,
    sentByUserId: caller.user._id,
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    actorUserId: caller.user._id,
    action: "team.inviteOrgAdmin",
    targetType: "invitation",
    targetId: id,
    meta: { email, role },
  });
  return id;
}

export type InvitePreview = {
  orgName: string;
  eventName: string | null;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
};

/** Public-ish preview for the /invite/<token> landing page (token is the
 * bearer credential; reveals only names + role). */
export async function previewInvitation(
  ctx: QueryCtx,
  token: string,
): Promise<InvitePreview | null> {
  const invite = await ctx.db
    .query("invitations")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (invite === null) return null;
  const org = await ctx.db.get("organizations", invite.orgId);
  const event = invite.eventId
    ? await ctx.db.get("events", invite.eventId)
    : null;
  const status =
    invite.status === "pending" && invite.expiresAt < Date.now()
      ? "expired"
      : invite.status;
  return {
    orgName: org?.name ?? "an organization",
    eventName: event?.name ?? null,
    role: invite.role,
    status,
  };
}

/** Accept an invitation as the signed-in user. Users arriving through an
 * invitation land directly in that context (M0: no forced org creation). */
export async function acceptInvitation(
  ctx: MutationCtx,
  user: Doc<"users">,
  token: string,
): Promise<{ orgSlug: string; eventSlug: string | null }> {
  const invite = await ctx.db
    .query("invitations")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (invite === null || invite.status !== "pending") {
    throw new ConvexError({
      code: "invalid_invitation",
      message: "This invitation is no longer valid.",
    });
  }
  if (invite.expiresAt < Date.now()) {
    throw new ConvexError({
      code: "invitation_expired",
      message: "This invitation has expired — ask for a new one.",
    });
  }
  const org = await ctx.db.get("organizations", invite.orgId);
  if (org === null) {
    throw new ConvexError({
      code: "invalid_invitation",
      message: "This invitation's organization no longer exists.",
    });
  }
  let eventSlug: string | null = null;
  if (invite.eventId !== undefined) {
    const event = await ctx.db.get("events", invite.eventId);
    if (event === null) {
      throw new ConvexError({
        code: "invalid_invitation",
        message: "This invitation's event no longer exists.",
      });
    }
    eventSlug = event.slug;
    const existing = await ctx.db
      .query("eventMembers")
      .withIndex("by_eventId_and_userId", (q) =>
        q.eq("eventId", event._id).eq("userId", user._id),
      )
      .unique();
    if (existing === null) {
      await ctx.db.insert("eventMembers", {
        eventId: event._id,
        orgId: org._id,
        userId: user._id,
        role: invite.role as EventRole,
      });
    }
  } else {
    const existing = await ctx.db
      .query("members")
      .withIndex("by_orgId_and_userId", (q) =>
        q.eq("orgId", org._id).eq("userId", user._id),
      )
      .unique();
    if (existing === null) {
      await ctx.db.insert("members", {
        orgId: org._id,
        userId: user._id,
        role: invite.role as OrgRole,
      });
    }
  }
  await ctx.db.patch("invitations", invite._id, { status: "accepted" });
  await logAudit(ctx, {
    orgId: org._id,
    eventId: invite.eventId,
    actorUserId: user._id,
    action: "team.acceptInvitation",
    targetType: "invitation",
    targetId: invite._id,
  });
  return { orgSlug: org.slug, eventSlug };
}

export async function revokeInvitation(
  ctx: MutationCtx,
  caller: EventCaller,
  invitationId: Id<"invitations">,
): Promise<void> {
  const invite = await ctx.db.get("invitations", invitationId);
  // Scope to the caller's event, not just the org: an organizer of event A
  // must not be able to revoke event B's invitations.
  if (invite === null || invite.eventId !== caller.event._id) {
    notFound("invitation");
  }
  await ctx.db.patch("invitations", invitationId, { status: "revoked" });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: invite.eventId,
    actorUserId: caller.user._id,
    action: "team.revokeInvitation",
    targetType: "invitation",
    targetId: invitationId,
  });
}

export type TeamMember = {
  userId: Id<"users">;
  name: string | null;
  email: string | null;
  imageUrl: string | null;
  role: OrgRole | EventRole;
  scope: "organization" | "event";
  /** Set only for event-scoped rows — the handle removeEventMember takes. */
  eventMemberId: Id<"eventMembers"> | null;
};

/** A membership row from either `members` or `eventMembers`. */
type MembershipRow = {
  _id: Id<"members"> | Id<"eventMembers">;
  userId: Id<"users">;
  role: OrgRole | EventRole;
};

/** Hydrate membership rows into TeamMembers, dropping rows whose user is
 * gone. One parallel batch of gets rather than a serial loop. */
async function toTeamMembers(
  ctx: QueryCtx,
  rows: MembershipRow[],
  scope: "organization" | "event",
): Promise<TeamMember[]> {
  const users = await Promise.all(
    rows.map((m) => ctx.db.get("users", m.userId)),
  );
  const members: TeamMember[] = [];
  for (const [i, m] of rows.entries()) {
    const u = users[i];
    if (u === null) continue;
    members.push({
      userId: u._id,
      name: u.name ?? null,
      email: u.email ?? null,
      imageUrl: u.imageUrl ?? null,
      role: m.role,
      scope,
      eventMemberId:
        scope === "event" ? (m._id as Id<"eventMembers">) : null,
    });
  }
  return members;
}

/** Everyone with access to an event: org owner/admins + event members.
 * Pending invitations (which carry bearer tokens) are organizer-only: a
 * reviewer who could read an organizer-invite token could accept it and
 * escalate their own role. */
export async function listEventTeam(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<{
  members: TeamMember[];
  invitations: Array<Doc<"invitations">>;
}> {
  const [orgMembers, eventMembers] = await Promise.all([
    ctx.db
      .query("members")
      .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", caller.org._id))
      .take(100),
    ctx.db
      .query("eventMembers")
      .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
      .take(200),
  ]);
  const members = [
    ...(await toTeamMembers(ctx, orgMembers, "organization")),
    ...(await toTeamMembers(ctx, eventMembers, "event")),
  ];
  const invitations =
    caller.role === "organizer"
      ? (
          await ctx.db
            .query("invitations")
            .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
            .take(100)
        ).filter((i) => i.status === "pending" && i.expiresAt > Date.now())
      : [];
  return { members, invitations };
}

/** Org-level team view: members plus pending org-wide invitations.
 * Admin-only — org invitations carry bearer tokens. */
export async function listOrgTeam(
  ctx: QueryCtx,
  caller: OrgCaller,
): Promise<{
  members: TeamMember[];
  invitations: Array<Doc<"invitations">>;
}> {
  requireOrgAdmin(caller);
  const orgMembers = await ctx.db
    .query("members")
    .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", caller.org._id))
    .take(100);
  const members = await toTeamMembers(ctx, orgMembers, "organization");
  const invitations = (
    await ctx.db
      .query("invitations")
      .withIndex("by_orgId", (q) => q.eq("orgId", caller.org._id))
      .take(200)
  ).filter(
    (i) =>
      i.eventId === undefined &&
      i.status === "pending" &&
      i.expiresAt > Date.now(),
  );
  return { members, invitations };
}

/** Revoke an org-wide invitation (eventId absent). Admin-only. */
export async function revokeOrgInvitation(
  ctx: MutationCtx,
  caller: OrgCaller,
  invitationId: Id<"invitations">,
): Promise<void> {
  requireOrgAdmin(caller);
  const invite = await ctx.db.get("invitations", invitationId);
  if (
    invite === null ||
    invite.orgId !== caller.org._id ||
    invite.eventId !== undefined
  ) {
    notFound("invitation");
  }
  await ctx.db.patch("invitations", invitationId, { status: "revoked" });
  await logAudit(ctx, {
    orgId: caller.org._id,
    actorUserId: caller.user._id,
    action: "team.revokeOrgInvitation",
    targetType: "invitation",
    targetId: invitationId,
  });
}

export async function removeEventMember(
  ctx: MutationCtx,
  caller: EventCaller,
  memberDocId: Id<"eventMembers">,
): Promise<void> {
  const membership = await ctx.db.get("eventMembers", memberDocId);
  if (membership === null || membership.eventId !== caller.event._id) {
    notFound("team member", "No such team member on this event.");
  }
  await ctx.db.delete("eventMembers", memberDocId);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "team.removeMember",
    targetType: "eventMembers",
    targetId: memberDocId,
    meta: { removedUserId: membership.userId, role: membership.role },
  });
}
