import { v } from "convex/values";
import { orgMutation, orgQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as ApiKeys from "./model/apiKeys";

// ─────────────────────────────────────────────────────────────────────────
// Org-settings surface for agent access (D1). Thin wrappers only: every rule
// — org-admin gating, name bounds, event scoping, the audit rows — lives in
// convex/model/apiKeys.ts.
//
// THE CLOCK IS SERVER-SIDE HERE, deliberately. `now` used to be a mutation
// argument; that made the browser's clock an input to expiry validation, to
// the active-key ceiling and to the revocation timestamp — an org admin could
// post-date a mint and widen the ceiling from the client. Convex mutations run
// as transactions with a deterministic `Date.now()` taken at transaction
// start, so the wrapper reads it and the model keeps its injected-clock
// signature (which is what lets the tests choose an instant).
// ─────────────────────────────────────────────────────────────────────────

const vCeiling = v.union(v.literal("read"), v.literal("organizer"));

const vKeySummary = v.object({
  keyId: vv.id("apiKeys"),
  name: v.string(),
  prefix: v.string(),
  ceiling: vCeiling,
  eventSlug: v.union(v.string(), v.null()),
  eventName: v.union(v.string(), v.null()),
  createdAt: v.number(),
  createdByName: v.union(v.string(), v.null()),
  lastUsedAt: v.union(v.number(), v.null()),
  expiresAt: v.union(v.number(), v.null()),
  revokedAt: v.union(v.number(), v.null()),
});

/**
 * Mint a key. `plaintext` is the ONLY time the credential exists in a
 * response — the UI shows it once and the row keeps only its hash.
 */
export const mint = orgMutation({
  args: {
    name: v.string(),
    ceiling: vCeiling,
    eventSlug: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  returns: v.object({ plaintext: v.string(), key: vKeySummary }),
  handler: async (ctx, args) => {
    const minted = await ApiKeys.mintKey(
      ctx,
      ctx.caller,
      {
        name: args.name,
        ceiling: args.ceiling,
        eventSlug: args.eventSlug,
        expiresAt: args.expiresAt,
      },
      Date.now(),
    );
    return { plaintext: minted.plaintext, key: minted.summary };
  },
});

/** Every key in the org. The hash is not in the returned shape at all. */
export const list = orgQuery({
  args: {},
  returns: v.array(vKeySummary),
  handler: async (ctx) => {
    return await ApiKeys.listKeys(ctx, ctx.caller);
  },
});

export const rename = orgMutation({
  args: { keyId: v.id("apiKeys"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    return await ApiKeys.renameKey(ctx, ctx.caller, args.keyId, args.name);
  },
});

export const revoke = orgMutation({
  args: { keyId: v.id("apiKeys") },
  returns: v.null(),
  handler: async (ctx, args) => {
    return await ApiKeys.revokeKey(ctx, ctx.caller, args.keyId, Date.now());
  },
});
