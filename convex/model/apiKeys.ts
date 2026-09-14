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
  batch_unsupported:
    "Send one JSON-RPC message per request — batched arrays are not supported.",
  ambiguous_room: "More than one room on this event has that name.",
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
 * How a write reached through an API key becomes an agent-attributed one.
 *
 * FIRST DESIGN, AND WHY IT WAS WRONG (D3 review): this used to INSERT a second
 * audit row next to the one the capability writes for itself. That made every
 * agent write two rows the Control Center rendered as two sentences — one act
 * described twice, once flagged and once not, so the unflagged half read as a
 * human doing it. Worse, the envelope was written by the tool, which knows
 * what it ASKED for; the capability's row is written by the code that knows
 * what it DID. So a no-op edit still produced an "an agent changed this" row,
 * and the envelope's copy of an argument (a change-request note) could differ
 * from the normalized value actually stored and emailed.
 *
 * THE SEAM THAT IS RIGHT: don't describe the write a second time — MARK the
 * rows the capability actually wrote. `run` is the capability call; every
 * audit row it appends is patched with `viaAgent: true` and the key's prefix,
 * inside the SAME transaction, so no reader ever observes an unflagged agent
 * write. It follows for free that:
 *
 *   • a call that changed nothing writes no audit row, so it gets no flag and
 *     invents no history — "records only writes that actually happened" is not
 *     a rule anybody has to remember at a call site;
 *   • the flagged row is the capability's own, so its `action`, `targetId` and
 *     `meta` are the values the capability used, already trimmed, capped and
 *     normalized — the audit trail cannot disagree with the record;
 *   • the Control Center needs no new vocabulary: `viaAgent` decorates the
 *     sentence it already renders.
 *
 * The boundary is the newest audit row for this event BEFORE the call; rows
 * appended after it are this call's. Rows are found through `by_eventId`,
 * which is how the panel reads them too.
 */
const AGENT_AUDIT_MARK_CAP = 100;

export async function withAgentAudit<T>(
  ctx: MutationCtx,
  identity: { key: Doc<"apiKeys">; user: Doc<"users"> },
  eventId: Id<"events">,
  run: () => Promise<T>,
): Promise<{ result: T; marked: number }> {
  const newestBefore = await ctx.db
    .query("auditLog")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .order("desc")
    .first();
  const result = await run();
  // One row MORE than the cap, so "exactly `AGENT_AUDIT_MARK_CAP` rows were
  // appended" is distinguishable from "the boundary is somewhere past this
  // page" — at `.take(cap)` the boundary could not fit and a legitimate
  // cap-sized write would be refused by a sentence that says "more than".
  const page = await ctx.db
    .query("auditLog")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .order("desc")
    .take(AGENT_AUDIT_MARK_CAP + 1);
  const boundaryAt = page.findIndex((row) => row._id === newestBefore?._id);
  const appended = boundaryAt === -1 ? page : page.slice(0, boundaryAt);
  // Structural check, not a formality: if the boundary is not inside the page
  // we just read, we cannot tell this call's rows from history, and marking a
  // person's past action as an agent's is worse than refusing the write. The
  // whole mutation rolls back.
  if (appended.length > AGENT_AUDIT_MARK_CAP) {
    throw new ConvexError({
      code: "agent_audit_overflow",
      message: `One agent action recorded more than ${AGENT_AUDIT_MARK_CAP} audit rows, which this attribution cannot bound. Refused.`,
    });
  }
  let marked = 0;
  for (const row of appended) {
    const meta =
      row.meta !== null && typeof row.meta === "object" && !Array.isArray(row.meta)
        ? (row.meta as Record<string, unknown>)
        : {};
    await ctx.db.patch("auditLog", row._id, {
      viaAgent: true,
      meta: { ...meta, apiKeyPrefix: identity.key.prefix },
    });
    marked += 1;
  }
  return { result, marked };
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
