/**
 * The API-key credential format, in one place.
 *
 * Deliberately dependency-free: both the mint path (`convex/model/apiKeys.ts`)
 * and the resolution path (`convex/lib/functions.ts`) need it, and a shared
 * module with no imports is what keeps those two from forming a cycle.
 *
 * `convex/model/slugs.ts` is NOT the precedent here. Slugs are guessable by
 * design (they live in URLs); a key is the whole credential, so its randomness
 * comes from `crypto.getRandomValues`, which the Convex isolate provides.
 */

/** Every key starts with this, so a leaked string is greppable in a log. */
export const API_KEY_PREFIX = "ssk_";

/** 32 random bytes → 64 hex characters. Far beyond any online guessing. */
const KEY_BYTES = 32;

/** How many trailing characters the display form keeps. */
const DISPLAY_TAIL = 4;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Mint one plaintext key. The only place a usable credential is created. */
export function mintApiKeyPlaintext(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return `${API_KEY_PREFIX}${toHex(bytes)}`;
}

/**
 * The rendered stand-in for a key we can no longer show, e.g. `ssk_…9f3c`.
 * Four characters is enough to tell two keys apart in a list and far too few
 * to narrow a 256-bit search.
 */
export function displayPrefix(plaintext: string): string {
  return `${API_KEY_PREFIX}…${plaintext.slice(-DISPLAY_TAIL)}`;
}

/**
 * SHA-256 hex of the presented key. A hash lookup needs no constant-time
 * compare: the index is keyed by the digest, and an attacker who can produce
 * a matching digest already holds the key.
 */
export async function hashApiKey(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(plaintext),
  );
  return toHex(new Uint8Array(digest));
}

/**
 * Cheap shape check before touching the database. Refusing garbage here means
 * a scanner spraying random bearer tokens never reaches an index read.
 */
export function looksLikeApiKey(presented: string): boolean {
  return (
    presented.startsWith(API_KEY_PREFIX) &&
    presented.length === API_KEY_PREFIX.length + KEY_BYTES * 2 &&
    /^[0-9a-f]+$/.test(presented.slice(API_KEY_PREFIX.length))
  );
}
