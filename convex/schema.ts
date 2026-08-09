import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Queue consumed by the exe.dev worker (see apps/worker and docs/ARCHITECTURE.md).
  jobs: defineTable({
    type: v.string(),
    payload: v.any(),
    status: v.union(
      v.literal("queued"),
      v.literal("claimed"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
    ),
    // Who asked for this work; the worker executes with this user's authority.
    initiatedBy: v.optional(v.string()),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  }).index("by_status", ["status"]),

  // CFP wizard drafts, created unauthenticated (public path, rate-limited).
  // anonKey is the client-generated session key; the draft is linked to a
  // real account at the wizard's account step (M1).
  cfpDrafts: defineTable({
    talkTitle: v.string(),
    anonKey: v.string(),
    status: v.literal("draft"),
  }).index("by_anonKey", ["anonKey"]),
});
