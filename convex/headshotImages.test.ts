import { describe, expect, test } from "vitest";
import {
  MAX_HEADSHOT_SOURCE_BYTES,
  detectHeadshotType,
  validateHeadshotBytes,
} from "./model/headshotImages";

function png(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  return bytes;
}

function webp(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  bytes.set([8, 0, 0, 0], 4);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  return bytes;
}

describe("headshot image validation", () => {
  test("recognizes only the supported structural signatures", () => {
    expect(detectHeadshotType(png())).toBe("image/png");
    expect(
      detectHeadshotType(new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xd9])),
    ).toBe("image/jpeg");
    expect(detectHeadshotType(webp())).toBe("image/webp");
    expect(detectHeadshotType(new TextEncoder().encode("<svg></svg>"))).toBe(
      null,
    );
  });

  test("requires declared MIME, ticket MIME, byte size, and magic to agree", () => {
    const bytes = png();
    expect(
      validateHeadshotBytes(bytes, "image/png", "image/png", bytes.length),
    ).toBe("image/png");
    expect(() =>
      validateHeadshotBytes(bytes, undefined, "image/png", bytes.length),
    ).toThrow("content type");
    expect(() =>
      validateHeadshotBytes(bytes, "image/jpeg", "image/png", bytes.length),
    ).toThrow("content type");
    expect(() =>
      validateHeadshotBytes(
        bytes,
        "image/png; charset=binary",
        "image/png",
        bytes.length,
      ),
    ).toThrow("content type");
    expect(() =>
      validateHeadshotBytes(bytes, "image/png", "image/png", bytes.length - 1),
    ).toThrow("byte size");
    expect(() =>
      validateHeadshotBytes(
        new Uint8Array(bytes.length),
        "image/png",
        "image/png",
        bytes.length,
      ),
    ).toThrow("file contents");
  });

  test("enforces the four-megabyte source ceiling independently of ticket size", () => {
    const bytes = new Uint8Array(MAX_HEADSHOT_SOURCE_BYTES + 1);
    expect(() =>
      validateHeadshotBytes(bytes, "image/png", "image/png", bytes.length),
    ).toThrow("4 MB");
  });
});
