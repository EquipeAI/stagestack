export const MAX_HEADSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_HEADSHOT_SOURCE_BYTES = 4 * 1024 * 1024;

export type SupportedHeadshotType = "image/jpeg" | "image/png" | "image/webp";

const SUPPORTED_TYPES = new Set<SupportedHeadshotType>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function supportedHeadshotType(
  value: string | null | undefined,
): SupportedHeadshotType | null {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined &&
    SUPPORTED_TYPES.has(normalized as SupportedHeadshotType)
    ? (normalized as SupportedHeadshotType)
    : null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (bytes[offset + i] !== value.charCodeAt(i)) return false;
  }
  return true;
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/** Detect only formats StageStack deliberately serves as headshots. The
 * checks include structural bytes beyond the shortest prefix so a renamed
 * arbitrary file is not accepted merely because it begins with one magic
 * byte sequence. SVG is intentionally unsupported. */
export function detectHeadshotType(
  bytes: Uint8Array,
): SupportedHeadshotType | null {
  const png =
    bytes.length >= 33 &&
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
    bytes[8] === 0 &&
    bytes[9] === 0 &&
    bytes[10] === 0 &&
    bytes[11] === 13 &&
    asciiAt(bytes, 12, "IHDR");
  if (png) return "image/png";

  const jpeg =
    bytes.length >= 4 &&
    startsWith(bytes, [0xff, 0xd8, 0xff]) &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9;
  if (jpeg) return "image/jpeg";

  const webp =
    bytes.length >= 16 &&
    asciiAt(bytes, 0, "RIFF") &&
    uint32le(bytes, 4) === bytes.length - 8 &&
    asciiAt(bytes, 8, "WEBP") &&
    (asciiAt(bytes, 12, "VP8 ") ||
      asciiAt(bytes, 12, "VP8L") ||
      asciiAt(bytes, 12, "VP8X"));
  if (webp) return "image/webp";

  return null;
}

export function validateHeadshotBytes(
  bytes: Uint8Array,
  declaredType: string | null | undefined,
  expectedType: string,
  expectedSize: number,
): SupportedHeadshotType {
  if (bytes.length === 0) throw new Error("The selected image is empty.");
  if (bytes.length > MAX_HEADSHOT_SOURCE_BYTES) {
    throw new Error("Source headshots must be 4 MB or smaller.");
  }
  if (bytes.length !== expectedSize) {
    throw new Error("The uploaded byte size did not match the selected image.");
  }
  const declared = supportedHeadshotType(declaredType);
  if (declared === null || declared !== expectedType) {
    throw new Error(
      "The upload content type did not match the selected image.",
    );
  }
  const detected = detectHeadshotType(bytes);
  if (detected === null || detected !== declared) {
    throw new Error(
      "The file contents did not match a supported image format.",
    );
  }
  return detected;
}
