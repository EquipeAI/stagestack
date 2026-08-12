// @vitest-environment node

import sharp from "sharp";
import { describe, expect, test } from "vitest";
import {
  MAX_HEADSHOT_DIMENSION,
  sanitizeHeadshotBytes,
  validateDecodedDimensions,
} from "./headshotProcessing";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function shallowPng(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  return bytes;
}

describe("headshot decode and normalization", () => {
  test("rejects a shallow magic/header match that is not a complete image", async () => {
    await expect(
      sanitizeHeadshotBytes(arrayBuffer(shallowPng()), "image/png"),
    ).rejects.toThrow("could not be decoded");
  });

  test("requires the decoder format to match the declared MIME", async () => {
    const jpeg = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: "#336699",
      },
    })
      .jpeg()
      .toBuffer();
    await expect(
      sanitizeHeadshotBytes(arrayBuffer(jpeg), "image/png"),
    ).rejects.toThrow("did not match its content type");
  });

  test("applies orientation and stores a single metadata-free WebP", async () => {
    const source = await sharp({
      create: {
        width: 10,
        height: 20,
        channels: 3,
        background: "#336699",
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const result = await sanitizeHeadshotBytes(
      arrayBuffer(source),
      "image/jpeg",
    );
    const metadata = await sharp(Buffer.from(result.bytes)).metadata();

    expect(result).toMatchObject({
      contentType: "image/webp",
      width: 20,
      height: 10,
    });
    expect(metadata).toMatchObject({
      format: "webp",
      width: 20,
      height: 10,
    });
    expect(metadata.pages ?? 1).toBe(1);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  test("rejects excessive dimensions and decoded pixel counts", async () => {
    const tooWide = await sharp({
      create: {
        width: MAX_HEADSHOT_DIMENSION + 1,
        height: 1,
        channels: 3,
        background: "#336699",
      },
    })
      .png()
      .toBuffer();
    await expect(
      sanitizeHeadshotBytes(arrayBuffer(tooWide), "image/png"),
    ).rejects.toThrow("at most 8192 pixels");
    expect(() => validateDecodedDimensions(5_001, 5_000)).toThrow(
      "25 million pixels",
    );
  });
});
