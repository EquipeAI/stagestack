import { ConvexError } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────
// http(s)-only link validation, shared by every user-supplied URL that later
// renders as an href (speaker profile links, the event website, CFP speaker
// links). Refusing `javascript:`/`data:` and bare hosts at write time is what
// keeps public pages' hrefs safe — the read path renders stored values as-is.
// ─────────────────────────────────────────────────────────────────────────

const HTTP_URL = /^https?:\/\//i;

/**
 * Trim + bound an optional URL field; blank collapses to absent so a cleared
 * form field removes the value rather than storing "". A non-empty value must
 * be a full http(s) URL — any other scheme throws `invalid_link`.
 */
export function optionalHttpUrl(
  value: string | undefined,
  label: string,
  max = 300,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > max) {
    throw new ConvexError({
      code: "invalid_link",
      message: `${label} must be at most ${max} characters.`,
    });
  }
  if (!HTTP_URL.test(trimmed)) {
    throw new ConvexError({
      code: "invalid_link",
      message: `${label} must be a full URL starting with http:// or https://.`,
    });
  }
  return trimmed;
}
