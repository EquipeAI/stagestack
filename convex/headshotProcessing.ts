"use node";

import sharp from "sharp";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  GENERIC_PROCESSING_FAILURE,
  HeadshotFailure,
  MAX_HEADSHOT_BYTES,
  MAX_HEADSHOT_DIMENSION,
  MAX_HEADSHOT_PIXELS,
  asHeadshotFailureCode,
  headshotFailure,
  supportedHeadshotType,
} from "./model/headshotImages";
import type { HeadshotFailureCode } from "./model/headshotImages";

// Re-exported so callers and tests keep one import site for the pixel bounds;
// the values (and the sentences that quote them) live in model/headshotImages.
export { MAX_HEADSHOT_DIMENSION, MAX_HEADSHOT_PIXELS };

const NORMALIZED_DIMENSION = 2048;
const NORMALIZED_CONTENT_TYPE = "image/webp";

export function validateDecodedDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    headshotFailure("invalid_dimensions");
  }
  if (width > MAX_HEADSHOT_DIMENSION || height > MAX_HEADSHOT_DIMENSION) {
    headshotFailure("dimensions_too_large");
  }
  if (width * height > MAX_HEADSHOT_PIXELS) {
    headshotFailure("too_many_pixels");
  }
}

function formatContentType(format: string | undefined): string | null {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  return null;
}

export async function sanitizeHeadshotBytes(
  bytes: ArrayBuffer,
  declaredContentType: string,
): Promise<{
  bytes: ArrayBuffer;
  contentType: "image/webp";
  width: number;
  height: number;
}> {
  const declared = supportedHeadshotType(declaredContentType);
  if (declared === null) headshotFailure("declared_type_unsupported");
  const source = Buffer.from(bytes);
  try {
    const decoder = sharp(source, {
      failOn: "warning",
      limitInputPixels: MAX_HEADSHOT_PIXELS,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    if (formatContentType(metadata.format) !== declared) {
      headshotFailure("decoded_format_mismatch");
    }
    if ((metadata.pages ?? 1) !== 1) {
      headshotFailure("animated_image");
    }
    validateDecodedDimensions(metadata.width ?? 0, metadata.height ?? 0);

    // rotate() applies EXIF orientation. Sharp strips EXIF, XMP, IPTC and ICC
    // unless a keep/withMetadata method is called; normalize to one WebP frame
    // so source metadata and parser-specific chunks never reach storage.
    const normalized = await decoder
      .rotate()
      .resize({
        width: NORMALIZED_DIMENSION,
        height: NORMALIZED_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 86, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    validateDecodedDimensions(normalized.info.width, normalized.info.height);
    if (normalized.data.byteLength > MAX_HEADSHOT_BYTES) {
      headshotFailure("normalized_too_large");
    }
    const outputMetadata = await sharp(normalized.data).metadata();
    if (
      outputMetadata.format !== "webp" ||
      outputMetadata.exif !== undefined ||
      outputMetadata.xmp !== undefined ||
      outputMetadata.iptc !== undefined ||
      outputMetadata.icc !== undefined
    ) {
      headshotFailure("metadata_not_stripped");
    }
    const output = normalized.data.buffer.slice(
      normalized.data.byteOffset,
      normalized.data.byteOffset + normalized.data.byteLength,
    ) as ArrayBuffer;
    return {
      bytes: output,
      contentType: NORMALIZED_CONTENT_TYPE,
      width: normalized.info.width,
      height: normalized.info.height,
    };
  } catch (error) {
    if (error instanceof HeadshotFailure) throw error;
    // `sharp` errors quote file paths and library internals — never rethrow one.
    headshotFailure("undecodable_image");
  }
}

/** Only a named failure travels back out of the Node runtime. Anything else —
 * a `sharp` throw, a storage error, an unexpected bug — becomes the generic
 * sentence with no code, and `convex/http.ts` then answers generically too. */
function safeProcessingFailure(error: unknown): {
  code?: HeadshotFailureCode;
  message: string;
} {
  return error instanceof HeadshotFailure
    ? { code: error.code, message: error.message }
    : { message: GENERIC_PROCESSING_FAILURE };
}

/** Cross-runtime processing uses only small ids/status values. The raw source
 * and normalized output stay inside storage, avoiding Convex's <1 MB value
 * limit even when the accepted source is several megabytes. */
export const process = internalAction({
  args: {
    uploadId: v.id("headshotUploads"),
    sourceStorageId: v.id("_storage"),
  },
  returns: v.object({
    ok: v.boolean(),
    /** A `HeadshotFailureCode` when the failure was a named one. Validated as
     * a plain string and re-narrowed by the caller: an unrecognized code is
     * treated exactly like no code at all. */
    code: v.optional(v.string()),
    message: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    let stored:
      | {
          storageId: Id<"_storage">;
          contentType: "image/webp";
          size: number;
          width: number;
          height: number;
        }
      | undefined;
    try {
      const source = await ctx.runQuery(
        internal.headshotUploads.sourceDetails,
        args,
      );
      if (
        !source.processable ||
        source.contentType === undefined ||
        source.size === undefined
      ) {
        throw new HeadshotFailure(
          asHeadshotFailureCode(source.code) ?? "lease_expired",
        );
      }
      const blob = await ctx.storage.get(args.sourceStorageId);
      if (blob === null) {
        headshotFailure("source_blob_missing");
      }
      if (
        blob.size !== source.size ||
        blob.type.trim().toLowerCase() !== source.contentType
      ) {
        headshotFailure("source_metadata_changed");
      }
      const normalized = await sanitizeHeadshotBytes(
        await blob.arrayBuffer(),
        source.contentType,
      );
      const outputStoreStarted = await ctx.runMutation(
        internal.headshotUploads.markOutputStoreStarted,
        { uploadId: args.uploadId },
      );
      if (!outputStoreStarted) headshotFailure("lease_expired");
      const storageId = await ctx.storage.store(
        new Blob([normalized.bytes], { type: normalized.contentType }),
      );
      stored = {
        storageId,
        contentType: normalized.contentType,
        size: normalized.bytes.byteLength,
        width: normalized.width,
        height: normalized.height,
      };
      const ready = await ctx.runMutation(internal.headshotUploads.complete, {
        uploadId: args.uploadId,
        ...stored,
      });
      if (!ready) headshotFailure("lease_expired");
      const settled = await ctx.runMutation(
        internal.headshotUploads.cleanupSource,
        args,
      );
      // Unnamed on purpose: an un-cleaned source is our bookkeeping problem,
      // not something to describe to the uploader.
      if (!settled) throw new Error(GENERIC_PROCESSING_FAILURE);
      return { ok: true as const };
    } catch (error) {
      try {
        await ctx.runMutation(internal.headshotUploads.fail, {
          uploadId: args.uploadId,
          ...stored,
        });
      } catch {
        if (stored !== undefined) {
          const deleted = await ctx.storage
            .delete(stored.storageId)
            .then(() => true)
            .catch(() => false);
          if (deleted) {
            await ctx.runMutation(
              internal.headshotUploads.markOutputKnownDeleted,
              { uploadId: args.uploadId },
            ).catch(() => false);
          }
        }
        await ctx.runMutation(internal.headshotUploads.fail, {
          uploadId: args.uploadId,
        }).catch(() => undefined);
      }
      return { ok: false as const, ...safeProcessingFailure(error) };
    } finally {
      await ctx.runMutation(internal.headshotUploads.cleanupSource, args).catch(
        () => undefined,
      );
    }
  },
});
