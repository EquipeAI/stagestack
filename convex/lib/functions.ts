import { ConvexError, v } from "convex/values";
import {
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────
// The capability layer's entry points (docs/ARCHITECTURE.md): every public
// function is built from one of these wrappers, which resolve
// { user, org, event, role } once. Model functions in convex/model/* receive
// the resolved caller and re-check nothing about identity.
// ─────────────────────────────────────────────────────────────────────────

export type OrgRole = "owner" | "admin";
export type EventRole = "organizer" | "reviewer";

export type OrgCaller = {
  user: Doc<"users">;
  org: Doc<"organizations">;
  /** Org-wide role, null when access comes only from event membership. */
  orgRole: OrgRole | null;
  /** True when the user is an organizer of at least one event in the org. */
  organizesEvents: boolean;
};

export type EventCaller = {
  user: Doc<"users">;
  org: Doc<"organizations">;
  event: Doc<"events">;
  /** Effective role on this event; org owner/admin act as organizer. */
  role: EventRole;
  orgRole: OrgRole | null;
};

export function forbidden(message = "You don't have access to this."): never {
  throw new ConvexError({ code: "forbidden", message });
}

export function notFound(what = "resource"): never {
  throw new ConvexError({ code: "not_found", message: `No such ${what}.` });
}

export async function requireUser(ctx: QueryCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError({
      code: "not_authenticated",
      message: "Sign in to continue.",
    });
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
  if (user === null) {
    // The client calls users.ensure right after sign-in; hitting this means a
    // query raced ahead of provisioning. The UI treats it as a loading state.
    throw new ConvexError({
      code: "user_not_provisioned",
      message: "Account not provisioned yet.",
    });
  }
  return user;
}

async function resolveOrgCaller(
  ctx: QueryCtx,
  orgSlug: string,
): Promise<OrgCaller> {
  const user = await requireUser(ctx);
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_slug", (q) => q.eq("slug", orgSlug))
    .unique();
  if (org === null) notFound("organization");
  const membership = await ctx.db
    .query("members")
    .withIndex("by_orgId_and_userId", (q) =>
      q.eq("orgId", org._id).eq("userId", user._id),
    )
    .unique();
  const eventMemberships = await ctx.db
    .query("eventMembers")
    .withIndex("by_userId", (q) => q.eq("userId", user._id))
    .take(200);
  const inOrg = eventMemberships.filter((m) => m.orgId === org._id);
  const organizesEvents = inOrg.some((m) => m.role === "organizer");
  if (membership === null && inOrg.length === 0) {
    forbidden("You are not a member of this organization.");
  }
  return { user, org, orgRole: membership?.role ?? null, organizesEvents };
}

export async function resolveEventCaller(
  ctx: QueryCtx,
  eventSlug: string,
): Promise<EventCaller> {
  const user = await requireUser(ctx);
  const event = await ctx.db
    .query("events")
    .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
    .unique();
  if (event === null) notFound("event");
  const org = await ctx.db.get("organizations", event.orgId);
  if (org === null) notFound("organization");
  const membership = await ctx.db
    .query("members")
    .withIndex("by_orgId_and_userId", (q) =>
      q.eq("orgId", org._id).eq("userId", user._id),
    )
    .unique();
  if (membership !== null) {
    return { user, org, event, role: "organizer", orgRole: membership.role };
  }
  const eventMembership = await ctx.db
    .query("eventMembers")
    .withIndex("by_eventId_and_userId", (q) =>
      q.eq("eventId", event._id).eq("userId", user._id),
    )
    .unique();
  if (eventMembership === null) {
    forbidden("You don't have access to this event.");
  }
  return {
    user,
    org,
    event,
    role: eventMembership.role,
    orgRole: null,
  };
}

export function requireOrganizer(caller: EventCaller): void {
  if (caller.role !== "organizer") {
    forbidden("Only event organizers can do this.");
  }
}

export function requireOrgAdmin(caller: OrgCaller): void {
  if (caller.orgRole === null) {
    forbidden("Only organization owners/admins can do this.");
  }
}

// ── Wrappers ─────────────────────────────────────────────────────────────

/** Signed-in user resolved; no org/event scoping. */
export const authedQuery = customQuery(
  query,
  customCtx(async (ctx) => ({ user: await requireUser(ctx) })),
);

export const authedMutation = customMutation(
  mutation,
  customCtx(async (ctx) => ({ user: await requireUser(ctx) })),
);

/** Org-scoped read: any org member or event member of the org. */
export const orgQuery = customQuery(query, {
  args: { orgSlug: v.string() },
  input: async (ctx: QueryCtx, args: { orgSlug: string }) => ({
    ctx: { caller: await resolveOrgCaller(ctx, args.orgSlug) },
    args: {},
  }),
});

/** Org-scoped write: caller resolved; model functions enforce role. */
export const orgMutation = customMutation(mutation, {
  args: { orgSlug: v.string() },
  input: async (ctx: MutationCtx, args: { orgSlug: string }) => ({
    ctx: { caller: await resolveOrgCaller(ctx, args.orgSlug) },
    args: {},
  }),
});

/** Event-scoped read: organizer or reviewer of the event (or org admin). */
export const eventQuery = customQuery(query, {
  args: { eventSlug: v.string() },
  input: async (ctx: QueryCtx, args: { eventSlug: string }) => ({
    ctx: { caller: await resolveEventCaller(ctx, args.eventSlug) },
    args: {},
  }),
});

/** Event-scoped write: organizer only (org owner/admin count as organizer). */
export const eventMutation = customMutation(mutation, {
  args: { eventSlug: v.string() },
  input: async (ctx: MutationCtx, args: { eventSlug: string }) => {
    const caller = await resolveEventCaller(ctx, args.eventSlug);
    requireOrganizer(caller);
    return { ctx: { caller }, args: {} };
  },
});

/** Event-scoped write available to reviewers too (e.g. submitting reviews). */
export const eventMemberMutation = customMutation(mutation, {
  args: { eventSlug: v.string() },
  input: async (ctx: MutationCtx, args: { eventSlug: string }) => ({
    ctx: { caller: await resolveEventCaller(ctx, args.eventSlug) },
    args: {},
  }),
});
