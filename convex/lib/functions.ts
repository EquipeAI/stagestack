import { ConvexError, v } from "convex/values";
import {
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { hashApiKey, looksLikeApiKey } from "./apiKeyToken";

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
  /** True when the user is an organizer of at least one event in the org.
   * Always true for org owner/admins — they organize every event. */
  organizesEvents: boolean;
  /** This user's event memberships within this org. Empty for org
   * owner/admins: their access doesn't depend on them, so we never query. */
  eventMemberships: Array<Doc<"eventMembers">>;
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

export function notFound(what = "resource", message?: string): never {
  throw new ConvexError({
    code: "not_found",
    message: message ?? `No such ${what}.`,
  });
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
  return await orgCallerForUser(ctx, user, org);
}

/**
 * The org caller, built from an already-identified user. Split out of
 * `resolveOrgCaller` so the API-key path (which has a user document but no
 * `ctx.auth` identity) produces the SAME object rather than a second, drifting
 * definition of what org access means.
 */
async function orgCallerForUser(
  ctx: QueryCtx,
  user: Doc<"users">,
  org: Doc<"organizations">,
): Promise<OrgCaller> {
  const membership = await ctx.db
    .query("members")
    .withIndex("by_orgId_and_userId", (q) =>
      q.eq("orgId", org._id).eq("userId", user._id),
    )
    .unique();
  // Org owner/admins already see everything in the org, so their event
  // memberships change nothing — skip the scan entirely.
  if (membership !== null) {
    return {
      user,
      org,
      orgRole: membership.role,
      organizesEvents: true,
      eventMemberships: [],
    };
  }
  const inOrg = await ctx.db
    .query("eventMembers")
    .withIndex("by_userId_and_orgId", (q) =>
      q.eq("userId", user._id).eq("orgId", org._id),
    )
    .take(200);
  if (inOrg.length === 0) {
    forbidden("You are not a member of this organization.");
  }
  return {
    user,
    org,
    orgRole: null,
    organizesEvents: inOrg.some((m) => m.role === "organizer"),
    eventMemberships: inOrg,
  };
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
  return await eventCallerForUser(ctx, user, event);
}

/** The event caller, built from an already-identified user — the other half of
 * the split described on `orgCallerForUser`. */
async function eventCallerForUser(
  ctx: QueryCtx,
  user: Doc<"users">,
  event: Doc<"events">,
): Promise<EventCaller> {
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

// ── API-key callers (D1) ─────────────────────────────────────────────────
//
// The agent path enters here and nowhere else. It deliberately produces the
// SAME `OrgCaller` / `EventCaller` objects the signed-in wrappers produce, so
// every rule in `convex/model/*` applies to an agent without knowing one is
// calling. What differs is only how the user is identified (a hashed bearer
// key instead of a JWT) and one extra clamp: the key's `ceiling`.
//
// Two properties this file is responsible for, and the model layer is not:
//   * a key is never more than its minter is RIGHT NOW — membership is
//     re-read on every call, so a removed teammate's key resolves to nothing;
//   * a `read` key never reaches a write capability, whatever its minter can
//     do. (The read ROLE is not downgraded: a read key held by an organizer
//     still reads organizer surfaces. Downgrading reads too would make read
//     keys unable to answer any of the questions they exist to answer.)

export type ApiKeyIntent = "read" | "write";

export type ApiKeyIdentity = {
  key: Doc<"apiKeys">;
  user: Doc<"users">;
  /** Live org access, resolved at use time. Present means the minter still
   * belongs to the org at all; absence is a refusal, not an empty result. */
  orgCaller: OrgCaller;
};

function keyRefused(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

/**
 * Turn a presented bearer key into an identity, or refuse.
 *
 * Refuses: malformed · unknown · revoked · expired · minter no longer a
 * member of the key's organization. Never returns a partially-trusted value:
 * anything this resolves is a credential good for the current instant.
 */
export async function resolveCallerFromApiKey(
  ctx: QueryCtx,
  presentedKey: string,
  now: number,
): Promise<ApiKeyIdentity> {
  if (!looksLikeApiKey(presentedKey)) {
    keyRefused("api_key_invalid", "That API key is not valid.");
  }
  const keyHash = await hashApiKey(presentedKey);
  const key = await ctx.db
    .query("apiKeys")
    .withIndex("by_hash", (q) => q.eq("keyHash", keyHash))
    .unique();
  if (key === null) {
    keyRefused("api_key_invalid", "That API key is not valid.");
  }
  if (key.revokedAt !== undefined) {
    keyRefused("api_key_revoked", "That API key was revoked.");
  }
  if (key.expiresAt !== undefined && key.expiresAt <= now) {
    keyRefused("api_key_expired", "That API key has expired.");
  }
  const user = await ctx.db.get("users", key.createdByUserId);
  if (user === null) {
    keyRefused("api_key_invalid", "That API key is not valid.");
  }
  const org = await ctx.db.get("organizations", key.orgId);
  if (org === null) {
    keyRefused("api_key_invalid", "That API key is not valid.");
  }
  // Live membership, every call. A key outlives its minter's account only in
  // the sense that the row remains — it stops resolving the moment the
  // membership does.
  const orgCaller = await orgCallerForUser(ctx, user, org);
  return { key, user, orgCaller };
}

/**
 * Refuse a write attempt made with a read-ceiling key.
 *
 * THE SHIPPED MEANING OF `read`, decided deliberately (PLAN.md Part D, D1):
 * a read key carries its minter's live READ access with every write refused —
 * it does NOT downgrade the read role to reviewer. Downgrading would be the
 * literal reading of "a read key never resolves organizer", and it would
 * refuse all ten of D2's read tools, because `list_sessions`,
 * `list_proposals`, `agenda_board`, `publish_state`, `review_progress` and
 * `task_dashboard` every one call `requireOrganizer` in `convex/model/*`. A
 * read key that can read nothing is not a safer key, it is a broken one.
 * The ceiling is therefore about WRITE authority, and this is where it bites.
 */
function assertCeilingAllows(key: Doc<"apiKeys">, intent: ApiKeyIntent): void {
  if (intent === "write" && key.ceiling === "read") {
    forbidden("This API key is read-only.");
  }
}

/**
 * Org-wide caller for a key. Refuses event-scoped keys outright: an
 * event-scoped key must never widen into "everything this user can see", and
 * the agent tools route around this by resolving the key's own event instead.
 */
export function apiKeyOrgCaller(
  identity: ApiKeyIdentity,
  intent: ApiKeyIntent,
): OrgCaller {
  assertCeilingAllows(identity.key, intent);
  if (identity.key.eventId !== undefined) {
    forbidden("This API key is scoped to a single event.");
  }
  return identity.orgCaller;
}

/**
 * Event caller for a key, by event slug. An event-scoped key refuses every
 * other event before any membership is read; an org-scoped key is bounded by
 * the minter's live event membership exactly as the UI wrapper would be.
 */
export async function apiKeyEventCaller(
  ctx: QueryCtx,
  identity: ApiKeyIdentity,
  eventSlug: string,
  intent: ApiKeyIntent,
): Promise<EventCaller> {
  assertCeilingAllows(identity.key, intent);
  const event = await ctx.db
    .query("events")
    .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
    .unique();
  if (event === null) notFound("event");
  if (identity.key.eventId !== undefined && identity.key.eventId !== event._id) {
    forbidden("This API key is scoped to a different event.");
  }
  if (event.orgId !== identity.key.orgId) {
    forbidden("This API key is scoped to a different organization.");
  }
  return await eventCallerForUser(ctx, identity.user, event);
}

/** The event an event-scoped key is bound to, or null for an org-wide key. */
export async function apiKeyScopedEvent(
  ctx: QueryCtx,
  identity: ApiKeyIdentity,
): Promise<Doc<"events"> | null> {
  if (identity.key.eventId === undefined) return null;
  const event = await ctx.db.get("events", identity.key.eventId);
  if (event === null) notFound("event");
  return event;
}

// ── Wrappers ─────────────────────────────────────────────────────────────

/** Unauthenticated public read. Named for intent — a `publicQuery` is a
 * deliberate public surface (event page, read API), never an oversight. The
 * handler must return only already-public data. */
export const publicQuery = query;

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

/** Event-scoped write available to reviewers too. M2's review submission
 * (reviewers scoring proposals) is built on this wrapper. */
export const eventMemberMutation = customMutation(mutation, {
  args: { eventSlug: v.string() },
  input: async (ctx: MutationCtx, args: { eventSlug: string }) => ({
    ctx: { caller: await resolveEventCaller(ctx, args.eventSlug) },
    args: {},
  }),
});
