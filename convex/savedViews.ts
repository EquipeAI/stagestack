import { v } from "convex/values";
import { eventMemberMutation, eventQuery } from "./lib/functions";
import * as SavedViews from "./model/savedViews";

// ─────────────────────────────────────────────────────────────────────────
// Saved views (W2). Thin wrappers; every rule and every sentence lives in
// convex/model/savedViews.ts.
//
// The writes are `eventMemberMutation`, not `eventMutation`: a reviewer is a
// full member of the one module they work in, and naming a view of their own
// queue is a preference, not an act on the event. Which modules they may name
// is the model's role gate, applied on the read path and the write path alike
// — the wrapper never decides it, so the two can't disagree.
// ─────────────────────────────────────────────────────────────────────────

const vParams = v.record(v.string(), v.string());

const vView = v.object({
  viewId: v.id("savedViews"),
  name: v.string(),
  params: vParams,
  isDefault: v.boolean(),
  updatedAt: v.number(),
});

const vWrite = v.object({ viewId: v.id("savedViews"), message: v.string() });

export const list = eventQuery({
  args: { module: v.string() },
  returns: v.object({
    module: v.string(),
    moduleLabel: v.string(),
    views: v.array(vView),
    defaultViewId: v.union(v.id("savedViews"), v.null()),
    summary: v.string(),
  }),
  handler: async (ctx, args) => {
    return await SavedViews.listViews(ctx, ctx.caller, args.module);
  },
});

export const create = eventMemberMutation({
  args: { module: v.string(), name: v.string(), params: vParams },
  returns: vWrite,
  handler: async (ctx, args) => {
    return await SavedViews.createView(ctx, ctx.caller, args);
  },
});

export const rename = eventMemberMutation({
  args: { viewId: v.id("savedViews"), name: v.string() },
  returns: vWrite,
  handler: async (ctx, args) => {
    return await SavedViews.renameView(ctx, ctx.caller, args);
  },
});

export const updateParams = eventMemberMutation({
  args: { viewId: v.id("savedViews"), params: vParams },
  returns: vWrite,
  handler: async (ctx, args) => {
    return await SavedViews.updateViewParams(ctx, ctx.caller, args);
  },
});

export const remove = eventMemberMutation({
  args: { viewId: v.id("savedViews") },
  returns: v.object({ message: v.string() }),
  handler: async (ctx, args) => {
    return await SavedViews.deleteView(ctx, ctx.caller, args);
  },
});

export const setDefault = eventMemberMutation({
  args: { viewId: v.id("savedViews"), isDefault: v.boolean() },
  returns: vWrite,
  handler: async (ctx, args) => {
    return await SavedViews.setDefaultView(ctx, ctx.caller, args);
  },
});
