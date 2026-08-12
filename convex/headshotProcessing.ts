"use node";

import sharp from "sharp";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { MAX_HEADSHOT_BYTES, supportedHeadshotType } from "./model/headshotImages";

export const MAX_HEADSHOT_DIMENSION = 8192;
export const MAX_HEADSHOT_PIXELS = 25_000_000;
const NORMALIZED_DIMENSION = 2048;
const NORMALIZED_CONTENT_TYPE = "image/webp";

class InvalidDecodedHeadshot extends Error {}

export function validateDecodedDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new InvalidDecodedHeadshot("The image has invalid dimensions.");
  }
  if (width > MAX_HEADSHOT_DIMENSION || height > MAX_HEADSHOT_DIMENSION) {
    throw new InvalidDecodedHeadshot(
      `Headshots must be at most ${MAX_HEADSHOT_DIMENSION} pixels on either side.`,
    );
  }
  if (width * height > MAX_HEADSHOT_PIXELS) {
    throw new InvalidDecodedHeadshot(
      "Headshots must contain 25 million pixels or fewer.",
    );
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
  if (declared === null) {
    throw new InvalidDecodedHeadshot(
      "Choose a JPEG, PNG, or WebP image for the headshot.",
    );
  }
  const source = Buffer.from(bytes);
  try {
    const decoder = sharp(source, {
      failOn: "warning",
      limitInputPixels: MAX_HEADSHOT_PIXELS,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    if (formatContentType(metadata.format) !== declared) {
      throw new InvalidDecodedHeadshot(
        "The decoded image format did not match its content type.",
      );
    }
    if ((metadata.pages ?? 1) !== 1) {
      throw new InvalidDecodedHeadshot("Animated headshots are not supported.");
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
      throw new InvalidDecodedHeadshot(
        "The normalized headshot is still larger than 5 MB.",
      );
    }
    const outputMetadata = await sharp(normalized.data).metadata();
    if (
      outputMetadata.format !== "webp" ||
      outputMetadata.exif !== undefined ||
      outputMetadata.xmp !== undefined ||
      outputMetadata.iptc !== undefined ||
      outputMetadata.icc !== undefined
    ) {
      throw new InvalidDecodedHeadshot(
        "The image metadata could not be removed safely.",
      );
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
    if (error instanceof InvalidDecodedHeadshot) throw error;
    throw new InvalidDecodedHeadshot(
      "The image could not be decoded as a complete JPEG, PNG, or WebP file.",
    );
  }
}

const SAFE_PROCESSING_MESSAGES = new Set([
  "That upload lease expired.",
  "The temporary image was no longer available.",
  "The temporary image metadata changed before processing.",
  "The normalized headshot has an invalid size.",
  "That upload already reserved storage.",
  "Headshot storage quota reached. Remove unused photos or ask an administrator for help.",
]);

function safeProcessingMessage(error: unknown): string {
  if (error instanceof InvalidDecodedHeadshot) return error.message;
  if (error instanceof Error && SAFE_PROCESSING_MESSAGES.has(error.message)) {
    return error.message;
  }
  return "That photo could not be processed safely.";
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
        throw new Error(source.message ?? "That upload lease expired.");
      }
      const blob = await ctx.storage.get(args.sourceStorageId);
      if (blob === null) {
        throw new Error("The temporary image was no longer available.");
      }
      if (
        blob.size !== source.size ||
        blob.type.trim().toLowerCase() !== source.contentType
      ) {
        throw new Error(
          "The temporary image metadata changed before processing.",
        );
      }
      const normalized = await sanitizeHeadshotBytes(
        await blob.arrayBuffer(),
        source.contentType,
      );
      const outputStoreStarted = await ctx.runMutation(
        internal.headshotUploads.markOutputStoreStarted,
        { uploadId: args.uploadId },
      );
      if (!outputStoreStarted) {
        throw new Error("That upload lease expired.");
      }
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
      if (!ready) throw new Error("That upload lease expired.");
      const settled = await ctx.runMutation(
        internal.headshotUploads.cleanupSource,
        args,
      );
      if (!settled) {
        throw new Error("That photo could not be processed safely.");
      }
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
      return {
        ok: false as const,
        message: safeProcessingMessage(error),
      };
    } finally {
      await ctx.runMutation(internal.headshotUploads.cleanupSource, args).catch(
        () => undefined,
      );
    }
  },
});
