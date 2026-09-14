import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { requireUser } from "./lib/functions";
import * as Speakers from "./model/speakers";

/** Private mutation boundary used only by the authenticated HTTP upload
 * action. Storage ids never cross a public Convex function. */
export const claim = internalMutation({
  args: {
    uploadId: v.id("headshotUploads"),
    contentType: v.string(),
  },
  returns: v.object({
    claimed: v.boolean(),
    message: v.optional(v.string()),
    expectedContentType: v.optional(v.string()),
    expectedSize: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await Speakers.claimHeadshotHttpUpload(
      ctx,
      user._id,
      args.uploadId,
      args.contentType,
    );
  },
});

export const recordSource = internalMutation({
  args: {
    uploadId: v.id("headshotUploads"),
    sourceStorageId: v.id("_storage"),
    contentType: v.string(),
    size: v.number(),
  },
  returns: v.object({
    recorded: v.boolean(),
    /** A `HeadshotFailureCode` when the refusal was a named one; the HTTP
     * action re-raises it by code. Plain string, re-narrowed by the caller. */
    code: v.optional(v.string()),
    message: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await Speakers.recordHeadshotSource(
      ctx,
      user._id,
      args.uploadId,
      args.sourceStorageId,
      args.contentType,
      args.size,
    );
  },
});

export const sourceDetails = internalQuery({
  args: {
    uploadId: v.id("headshotUploads"),
    sourceStorageId: v.id("_storage"),
  },
  returns: v.object({
    processable: v.boolean(),
    /** A `HeadshotFailureCode` when the refusal was a named one; the HTTP
     * action re-raises it by code. Plain string, re-narrowed by the caller. */
    code: v.optional(v.string()),
    message: v.optional(v.string()),
    contentType: v.optional(v.string()),
    size: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await Speakers.headshotSourceDetails(
      ctx,
      user._id,
      args.uploadId,
      args.sourceStorageId,
    );
  },
});

export const cleanupSource = internalMutation({
  args: {
    uploadId: v.id("headshotUploads"),
    sourceStorageId: v.id("_storage"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    return await Speakers.cleanupHeadshotSource(
      ctx,
      args.uploadId,
      args.sourceStorageId,
    );
  },
});

export const complete = internalMutation({
  args: {
    uploadId: v.id("headshotUploads"),
    storageId: v.id("_storage"),
    contentType: v.string(),
    size: v.number(),
    width: v.number(),
    height: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await Speakers.completeHeadshotHttpUpload(
      ctx,
      user._id,
      args.uploadId,
      args.storageId,
      args.contentType,
      args.size,
      args.width,
      args.height,
    );
  },
});

export const beginStorageAttempt = internalMutation({
  args: { uploadId: v.id("headshotUploads") },
  returns: v.object({
    reserved: v.boolean(),
    /** A `HeadshotFailureCode` when the refusal was a named one; the HTTP
     * action re-raises it by code. Plain string, re-narrowed by the caller. */
    code: v.optional(v.string()),
    message: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await Speakers.beginHeadshotStorageAttempt(
      ctx,
      user._id,
      args.uploadId,
    );
  },
});

export const markOutputStoreStarted = internalMutation({
  args: { uploadId: v.id("headshotUploads") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await Speakers.markHeadshotOutputStoreStarted(
      ctx,
      user._id,
      args.uploadId,
    );
  },
});

export const markOutputKnownDeleted = internalMutation({
  args: { uploadId: v.id("headshotUploads") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await Speakers.markHeadshotOutputKnownDeleted(
      ctx,
      user._id,
      args.uploadId,
    );
  },
});

export const retainIndeterminate = internalMutation({
  args: { uploadId: v.id("headshotUploads") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await Speakers.retainIndeterminateHeadshotAttempt(
      ctx,
      user._id,
      args.uploadId,
    );
    return null;
  },
});

export const releaseKnownClean = internalMutation({
  args: { uploadId: v.id("headshotUploads") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await Speakers.releaseKnownCleanHeadshotAttempt(
      ctx,
      user._id,
      args.uploadId,
    );
  },
});

export const fail = internalMutation({
  args: {
    uploadId: v.id("headshotUploads"),
    storageId: v.optional(v.id("_storage")),
    contentType: v.optional(v.string()),
    size: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const stored =
      args.storageId !== undefined &&
      args.contentType !== undefined &&
      args.size !== undefined &&
      args.width !== undefined &&
      args.height !== undefined
        ? {
            storageId: args.storageId,
            contentType: args.contentType,
            size: args.size,
            width: args.width,
            height: args.height,
          }
        : undefined;
    await Speakers.failHeadshotHttpUpload(ctx, user._id, args.uploadId, stored);
    return null;
  },
});

export const cleanupReplacement = internalMutation({
  args: { uploadId: v.id("headshotUploads") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Speakers.cleanupReplacedHeadshot(ctx, args.uploadId);
    return null;
  },
});

export const cleanupExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    return await Speakers.cleanupExpiredHeadshotUploads(ctx);
  },
});
