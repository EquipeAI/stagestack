import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  type OrgCaller,
  notFound,
  requireOrgAdmin,
} from "../lib/functions";
import {
  displayPrefix,
  mintApiKeyPlaintext,
  hashApiKey,
} from "../lib/apiKeyToken";
import { assertText } from "./validation";
import { logAudit } from "./audit";

// ─────────────────────────────────────────────────────────────────────────
// API keys (D1): the credential an external agent presents to the hosted MCP
// endpoint. Everything about their meaning lives here; `convex/apiKeys.ts` is
// four thin wrappers, and `convex/lib/functions.ts` owns the reverse
// direction (presented key → caller).
//
// Org-admin gated end to end. Minting a key is handing out a durable
// credential that acts as the minter, which is the same class of act as
// inviting an admin — the surface that already requires `requireOrgAdmin`.
// ─────────────────────────────────────────────────────────────────────────

/** Names are a label in a settings list, not prose. */
const MAX_KEY_NAME = 60;

/** A single org's key list. Well past any real desk, small enough that the
 * list read stays one page. */
const KEY_SCAN = 200;

/**
 * Live keys one organization may hold at once.
 *
 * Deliberately well under `KEY_SCAN`: a credential that exists but does not
 * appear in the management list is a credential nobody can revoke, and a mint
 * path with no ceiling is exactly how a list cap becomes that. Revoked keys do
 * not count — they are history, and history should not stop you issuing a
 * replacement for the key you just turned off.
 */
export const MAX_ACTIVE_KEYS_PER_ORG = 50;

/**
 * How stale `lastUsedAt` is allowed to be. The field answers "is this key
 * still in use?", which five-minute granularity answers perfectly well — and
 * writing it per tool call would turn every read into a write.
 */
export const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export type KeyCeiling = "read" | "organizer";

// ─────────────────────────────────────────────────────────────────────────
// The sanitization boundary's vocabulary for the /mcp endpoint.
//
// Same invariant as `model/headshotImages.ts`' registry, for the same reason:
// text from an arbitrary throw never reaches an external agent. `convex/http.ts`
// looks a refusal's CODE up in this table and prints the registered sentence;
// a code that is not here — including every system error, every model refusal
// that was not written for this audience, and anything a future capability
// invents — lands on the generic sentence.
//
// Publishing a new sentence to the agent surface therefore means adding a code
// HERE, in a reviewed edit, and can never happen by accident at a throw site.
// ─────────────────────────────────────────────────────────────────────────
export const MCP_REFUSAL_MESSAGES: Record<string, string> = {
  api_key_missing: "Provide an API key as an Authorization: Bearer header.",
  api_key_invalid: "That API key is not valid.",
  api_key_revoked: "That API key was revoked.",
  api_key_expired: "That API key has expired.",
  forbidden: "This API key does not have access to that.",
  not_found: "No such record.",
  rate_limited: "Too many API calls — slow down.",
  api_key_limit: "This organization has reached its API key limit.",
  event_too_large:
    "This event has more records than one read can return, so no complete answer is available.",
};

export const MCP_GENERIC_REFUSAL = "That request could not be completed.";

/** HTTP status for a refusal code. Anything unlisted is a 400. */
export const MCP_REFUSAL_STATUS: Record<string, number> = {
  api_key_missing: 401,
  api_key_invalid: 401,
  api_key_revoked: 401,
  api_key_expired: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
};

/** What a key looks like once it can no longer be shown: never the hash, and
 * never anything from which the plaintext could be reconstructed. */
export type KeySummary = {
  keyId: Id<"apiKeys">;
  name: string;
  prefix: string;
  ceiling: KeyCeiling;
  eventSlug: string | null;
  eventName: string | null;
  createdAt: number;
  createdByName: string | null;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
};

async function summarize(
  ctx: QueryCtx,
  key: Doc<"apiKeys">,
): Promise<KeySummary> {
  const event =
    key.eventId === undefined ? null : await ctx.db.get("events", key.eventId);
  const minter = await ctx.db.get("users", key.createdByUserId);
  return {
    keyId: key._id,
    name: key.name,
    prefix: key.prefix,
    ceiling: key.ceiling,
    eventSlug: event?.slug ?? null,
    eventName: event?.name ?? null,
    createdAt: key._creationTime,
    createdByName: minter?.name ?? minter?.email ?? null,
    lastUsedAt: key.lastUsedAt ?? null,
    expiresAt: key.expiresAt ?? null,
    revokedAt: key.revokedAt ?? null,
  };
}

/** Load one key that belongs to this caller's org, or refuse. Scoping by org
 * here is what stops a key id from another org being renamed or revoked. */
async function ownKey(
  ctx: QueryCtx,
  caller: OrgCaller,
  keyId: Id<"apiKeys">,
): Promise<Doc<"apiKeys">> {
  const key = await ctx.db.get("apiKeys", keyId);
  if (key === null || key.orgId !== caller.org._id) {
    notFound("API key", "No such API key in this organization.");
  }
  return key;
}

/**
 * Refuse a mint that would push the org past `MAX_ACTIVE_KEYS_PER_ORG`.
 *
 * The count has to be STRUCTURALLY COMPLETE, not merely bounded: counting
 * live keys out of a `by_orgId` page means an org with enough revoked history
 * pages past its own live keys and sees zero, which is a ceiling that silently
 * stops holding. So the read enumerates unrevoked keys directly
 * (`by_orgId_and_revokedAt`, where a missing `revokedAt` sorts first) and asks
 * for one row MORE than the ceiling admits. That makes the two outcomes
 * decidable from the page alone:
 *
 *   fewer than the probe → this is EVERY unrevoked key, so expiry can be
 *     filtered in code and the active count is exact (an expired key frees
 *     its slot, which is what makes a short-lived key worth minting);
 *   the full probe → the org holds more unrevoked keys than the ceiling
 *     allows whatever their expiries say, so refuse without pretending to
 *     know the exact number.
 *
 * Dead rows never enter either branch — an org may accumulate any number of
 * them without weakening the ceiling.
 */
async function assertKeyBudget(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  now: number,
): Promise<void> {
  const refuse = (): never => {
    throw new ConvexError({
      code: "api_key_limit",
      message: `An organization may hold ${MAX_ACTIVE_KEYS_PER_ORG} active API keys. Revoke one before minting another.`,
    });
  };
  const probe = MAX_ACTIVE_KEYS_PER_ORG + 1;
  const unrevoked = await ctx.db
    .query("apiKeys")
    .withIndex("by_orgId_and_revokedAt", (q) =>
      q.eq("orgId", orgId).eq("revokedAt", undefined),
    )
    .take(probe);
  if (unrevoked.length >= probe) refuse();
  const active = unrevoked.filter(
    (key) => key.expiresAt === undefined || key.expiresAt > now,
  );
  if (active.length >= MAX_ACTIVE_KEYS_PER_ORG) refuse();
}

export type MintArgs = {
  name: string;
  ceiling: KeyCeiling;
  /** Bind the key to one event. Absent → the whole org, still clamped to the
   * minter's live memberships at every use. */
  eventSlug?: string;
  expiresAt?: number;
};

/**
 * Mint a key. Returns the plaintext, which exists in exactly this one value
 * and is never recoverable afterwards — the row keeps only its SHA-256.
 */
export async function mintKey(
  ctx: MutationCtx,
  caller: OrgCaller,
  args: MintArgs,
  now: number,
): Promise<{ keyId: Id<"apiKeys">; plaintext: string; summary: KeySummary }> {
  requireOrgAdmin(caller);
  const name = assertText(args.name, { label: "Key name", max: MAX_KEY_NAME });
  if (args.expiresAt !== undefined && args.expiresAt <= now) {
    throw new ConvexError({
      code: "invalid_expiry",
      message: "An expiry date has to be in the future.",
    });
  }
  await assertKeyBudget(ctx, caller.org._id, now);
  let eventId: Id<"events"> | undefined;
  if (args.eventSlug !== undefined) {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", args.eventSlug as string))
      .unique();
    if (event === null || event.orgId !== caller.org._id) {
      notFound("event", "No such event in this organization.");
    }
    eventId = event._id;
  }
  const plaintext = mintApiKeyPlaintext();
  const keyId = await ctx.db.insert("apiKeys", {
    orgId: caller.org._id,
    eventId,
    keyHash: await hashApiKey(plaintext),
    prefix: displayPrefix(plaintext),
    name,
    createdByUserId: caller.user._id,
    ceiling: args.ceiling,
    expiresAt: args.expiresAt,
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId,
    actorUserId: caller.user._id,
    action: "apiKey.mint",
    targetType: "apiKey",
    targetId: keyId,
    // The prefix, never the key: an audit row must stay safe to read.
    meta: { name, ceiling: args.ceiling, prefix: displayPrefix(plaintext) },
  });
  const key = await ctx.db.get("apiKeys", keyId);
  if (key === null) notFound("API key");
  return { keyId, plaintext, summary: await summarize(ctx, key) };
}

/** Every key in the org, newest first. Never the hash. */
export async function listKeys(
  ctx: QueryCtx,
  caller: OrgCaller,
): Promise<Array<KeySummary>> {
  requireOrgAdmin(caller);
  const keys = await ctx.db
    .query("apiKeys")
    .withIndex("by_orgId", (q) => q.eq("orgId", caller.org._id))
    .order("desc")
    .take(KEY_SCAN);
  return await Promise.all(keys.map((key) => summarize(ctx, key)));
}

export async function renameKey(
  ctx: MutationCtx,
  caller: OrgCaller,
  keyId: Id<"apiKeys">,
  rawName: string,
): Promise<null> {
  requireOrgAdmin(caller);
  const key = await ownKey(ctx, caller, keyId);
  const name = assertText(rawName, { label: "Key name", max: MAX_KEY_NAME });
  await ctx.db.patch("apiKeys", key._id, { name });
  return null;
}

/**
 * Revoke a key. Idempotent, and immediate: resolution reads `revokedAt` on
 * every call, so an agent mid-session stops on its next tool call.
 */
export async function revokeKey(
  ctx: MutationCtx,
  caller: OrgCaller,
  keyId: Id<"apiKeys">,
  now: number,
): Promise<null> {
  requireOrgAdmin(caller);
  const key = await ownKey(ctx, caller, keyId);
  if (key.revokedAt !== undefined) return null;
  await ctx.db.patch("apiKeys", key._id, { revokedAt: now });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: key.eventId,
    actorUserId: caller.user._id,
    action: "apiKey.revoke",
    targetType: "apiKey",
    targetId: key._id,
    meta: { name: key.name, prefix: key.prefix },
  });
  return null;
}

/**
 * The one producer of an audit row for work done through an API key.
 *
 * Every write reached with a key goes through here rather than calling
 * `logAudit` directly, so `viaAgent` can never be forgotten at a call site —
 * the Control Center renders that flag, and a write that lies about being
 * agent-driven is worse than no audit row at all. D3's write tools are its
 * callers; it lives here because the flag is a property of the credential,
 * not of any one capability.
 */
export async function agentAudit(
  ctx: MutationCtx,
  identity: { key: Doc<"apiKeys">; user: Doc<"users"> },
  entry: {
    eventId?: Id<"events">;
    action: string;
    targetType?: string;
    targetId?: string;
    meta?: Record<string, unknown>;
  },
): Promise<Id<"auditLog">> {
  return await logAudit(ctx, {
    orgId: identity.key.orgId,
    eventId: entry.eventId ?? identity.key.eventId,
    actorUserId: identity.user._id,
    viaAgent: true,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    meta: { ...(entry.meta ?? {}), apiKeyPrefix: identity.key.prefix },
  });
}

/**
 * Record that a key was just used, at most once per `LAST_USED_THROTTLE_MS`.
 * Returns whether it wrote, which is only interesting to the tests.
 */
export async function touchLastUsed(
  ctx: MutationCtx,
  key: Doc<"apiKeys">,
  now: number,
): Promise<boolean> {
  if (
    key.lastUsedAt !== undefined &&
    now - key.lastUsedAt < LAST_USED_THROTTLE_MS
  ) {
    return false;
  }
  await ctx.db.patch("apiKeys", key._id, { lastUsedAt: now });
  return true;
}
