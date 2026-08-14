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
  if (bytes.length === 0) headshotFailure("empty_image");
  if (bytes.length > MAX_HEADSHOT_SOURCE_BYTES) {
    headshotFailure("source_too_large");
  }
  if (bytes.length !== expectedSize) headshotFailure("byte_size_mismatch");
  const declared = supportedHeadshotType(declaredType);
  if (declared === null || declared !== expectedType) {
    headshotFailure("content_type_mismatch");
  }
  const detected = detectHeadshotType(bytes);
  if (detected === null || detected !== declared) {
    headshotFailure("unsupported_format");
  }
  return detected;
}

// ─────────────────────────────────────────────────────────────────────────
// Headshot failure codes.
//
// Upload failures cross three boundaries before a browser sees them: a V8
// mutation, a Node action (which can only return small values, never throw
// across the runtime), and the public HTTP endpoint in `convex/http.ts`. The
// code is what travels; the sentence is looked up here, once.
//
// INVARIANT (the endpoint is public-facing): `convex/http.ts` never echoes an
// error's own text back to the client. It maps a KNOWN code to the sentence
// registered below, and answers anything else — an unexpected throw, a Convex
// system error, a `sharp` failure carrying a file path — with one generic
// sentence. Adding a code here is therefore a deliberate decision to publish
// that sentence to the open internet.
// ─────────────────────────────────────────────────────────────────────────

export const MAX_HEADSHOT_DIMENSION = 8192;
export const MAX_HEADSHOT_PIXELS = 25_000_000;

/** Every headshot failure sentence, keyed by code. Client-safe by
 * construction: no ids, no paths, no upstream library text. */
export const HEADSHOT_FAILURE_MESSAGES = {
  empty_image: "The selected image is empty.",
  source_too_large: "Source headshots must be 4 MB or smaller.",
  byte_size_mismatch: "The uploaded byte size did not match the selected image.",
  content_type_mismatch:
    "The upload content type did not match the selected image.",
  unsupported_format: "The file contents did not match a supported image format.",
  undecodable_image:
    "The image could not be decoded as a complete JPEG, PNG, or WebP file.",
  decoded_format_mismatch:
    "The decoded image format did not match its content type.",
  invalid_dimensions: "The image has invalid dimensions.",
  dimensions_too_large: `Headshots must be at most ${MAX_HEADSHOT_DIMENSION} pixels on either side.`,
  too_many_pixels: "Headshots must contain 25 million pixels or fewer.",
  animated_image: "Animated headshots are not supported.",
  normalized_too_large: "The normalized headshot is still larger than 5 MB.",
  metadata_not_stripped: "The image metadata could not be removed safely.",
  lease_expired: "That upload lease expired.",
  normalized_invalid_size: "The normalized headshot has an invalid size.",
  storage_already_reserved: "That upload already reserved storage.",
  storage_quota_reached:
    "Headshot storage quota reached. Remove unused photos or ask an administrator for help.",
  // Below this line: real failures with real sentences, but codes the HTTP
  // endpoint deliberately does NOT publish (see HTTP_SAFE_FAILURE_CODES). They
  // describe internal bookkeeping an uploader can do nothing about, so the
  // client gets the generic sentence instead.
  source_blob_missing: "The temporary image was no longer available.",
  source_metadata_changed:
    "The temporary image metadata changed before processing.",
  storage_attempt_in_progress: "That storage attempt already started.",
  source_already_deleted: "That upload source was already deleted.",
  source_already_recorded: "That upload already has source bytes.",
  declared_type_unsupported:
    "Choose a JPEG, PNG, or WebP image for the headshot.",
} as const;

export type HeadshotFailureCode = keyof typeof HEADSHOT_FAILURE_MESSAGES;

/** The generic answer for every unknown code and every unexpected throw. */
export const GENERIC_UPLOAD_FAILURE = "That photo could not be uploaded.";

/** The generic answer the processing action reports for anything it did not
 * name itself. */
export const GENERIC_PROCESSING_FAILURE =
  "That photo could not be processed safely.";

/** Codes whose sentence `convex/http.ts` publishes verbatim. Everything else,
 * INCLUDING the remaining codes above, collapses to `GENERIC_UPLOAD_FAILURE`. */
export const HTTP_SAFE_FAILURE_CODES: ReadonlySet<HeadshotFailureCode> = new Set(
  [
    "empty_image",
    "source_too_large",
    "byte_size_mismatch",
    "content_type_mismatch",
    "unsupported_format",
    "undecodable_image",
    "decoded_format_mismatch",
    "invalid_dimensions",
    "dimensions_too_large",
    "too_many_pixels",
    "animated_image",
    "normalized_too_large",
    "metadata_not_stripped",
    "lease_expired",
    "normalized_invalid_size",
    "storage_already_reserved",
    "storage_quota_reached",
  ] satisfies Array<HeadshotFailureCode>,
);

/** An expected, named upload failure. Carries the code; the sentence is always
 * derived from the registry so a caller cannot smuggle its own text out. */
export class HeadshotFailure extends Error {
  readonly code: HeadshotFailureCode;
  constructor(code: HeadshotFailureCode) {
    super(HEADSHOT_FAILURE_MESSAGES[code]);
    this.name = "HeadshotFailure";
    this.code = code;
  }
}

export function headshotFailure(code: HeadshotFailureCode): never {
  throw new HeadshotFailure(code);
}

/** Narrow an untrusted string (an action return, a serialized error field)
 * back to a known code. Anything unrecognized becomes `undefined`. */
export function asHeadshotFailureCode(
  value: unknown,
): HeadshotFailureCode | undefined {
  return typeof value === "string" &&
    Object.hasOwn(HEADSHOT_FAILURE_MESSAGES, value)
    ? (value as HeadshotFailureCode)
    : undefined;
}
