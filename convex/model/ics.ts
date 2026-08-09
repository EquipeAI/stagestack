// ─────────────────────────────────────────────────────────────────────────
// Calendar invites (M5 ships the machinery, M6 triggers it).
//
// Pure functions only — no ctx, no db — so the whole thing is unit-testable
// and can run from either a mutation or an action. Two landmines are handled
// here on purpose:
//
//  1. CRLF injection. Every input is stripped of raw CR/LF BEFORE RFC 5545
//     escaping. Without that, a speaker whose "name" contains a newline could
//     inject arbitrary iCalendar properties into the invite.
//  2. `btoa` is Latin-1 only and throws on anything above U+00FF, so a speaker
//     named "Zoë" would break the attachment. `base64Utf8` encodes UTF-8 bytes
//     itself (no Buffer in the default Convex runtime).
// ─────────────────────────────────────────────────────────────────────────

export const ICS_PRODID = "-//StageStack//StageStack v1//EN";

export type IcsMethod = "REQUEST" | "CANCEL";

export type IcsInput = {
  method: IcsMethod;
  /** Stable per (session, participant) so updates replace rather than duplicate. */
  uid: string;
  /** Bumped on every reschedule; calendars ignore a stale SEQUENCE. */
  sequence: number;
  startMs: number;
  endMs: number;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  organizerName: string;
  organizerEmail: string;
  attendeeName: string;
  attendeeEmail: string;
  /** Defaults to "now"; injectable so tests are deterministic. */
  stampMs?: number;
};

/** Kill raw line breaks before anything else touches the value. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/**
 * RFC 5545 §3.3.11 TEXT escaping. Backslash first (so the escapes we add next
 * are not double-escaped), then the separators, then any RAW CR/LF collapses
 * into the two-character `\n` escape — which renders as a line break inside the
 * value and, crucially, can never start a new content line. That is the whole
 * CRLF-injection fix: after this, no attacker-supplied byte reaches the stream
 * as an actual line terminator.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Values in property PARAMETERS (CN=…) can't use TEXT escaping at all. Strip
 * ALL control chars (not just CR/LF) and the double-quote (RFC 5545 param-
 * quoted values cannot contain a `"`), then collapse whitespace. The
 * separators `,` `;` `:` are LEFT INTACT — the caller wraps the result in
 * double quotes (see `quotedParam`) so those characters are safe in the value.
 */
function safeParam(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A CN parameter value, always double-quoted per RFC 5545 §3.2 so a comma
 * (`CN=Doe, Jane`) reads as one value rather than a malformed multi-valued
 * parameter. `safeParam` has already removed any `"`, so the quotes are safe.
 */
function quotedParam(value: string): string {
  return `"${safeParam(value)}"`;
}

/** UIDs keep `:` and `@` — only whitespace and quoting characters go. */
function safeUid(value: string): string {
  return oneLine(value).replace(/[\s";]/g, "").trim();
}

function safeAddress(value: string): string {
  return oneLine(value).replace(/[\s";:,]/g, "").trim();
}

/** `20260901T170000Z` — calendars get UTC instants; the event's own timezone
 * label lives in the human-readable body. */
export function formatIcsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

const utf8 = new TextEncoder();

/** Fold a content line to ≤75 OCTETS per RFC 5545 §3.1, never splitting a
 * multi-byte character; continuation lines start with one space. */
export function foldIcsLine(line: string): string {
  const bytes = utf8.encode(line);
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let start = 0;
  // The first line may use 75 octets; continuations spend one on the leading
  // space, so they carry 74.
  let budget = 75;
  while (start < bytes.length) {
    let end = Math.min(start + budget, bytes.length);
    // Never cut inside a UTF-8 sequence: continuation bytes are 10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    parts.push(decodeSlice(bytes, start, end));
    start = end;
    budget = 74;
  }
  return parts[0] + parts.slice(1).map((p) => `\r\n ${p}`).join("");
}

const utf8Decoder = new TextDecoder();

function decodeSlice(bytes: Uint8Array, start: number, end: number): string {
  return utf8Decoder.decode(bytes.subarray(start, end));
}

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 of the UTF-8 encoding of `value`. `btoa` would throw on any character
 * above U+00FF (the verified landmine), and `Buffer` doesn't exist in the
 * default Convex runtime — so encode the bytes by hand.
 */
export function base64Utf8(value: string): string {
  const bytes = utf8.encode(value);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * One VEVENT wrapped in a VCALENDAR, CRLF-terminated and folded.
 *
 * METHOD lives at the VCALENDAR level (Gmail/Outlook use it to decide between
 * "invitation" and "cancellation" UI), and a CANCEL additionally carries
 * STATUS:CANCELLED so a client that only reads the component still does the
 * right thing.
 */
export function buildIcs(input: IcsInput): string {
  const stamp = formatIcsUtc(input.stampMs ?? Date.now());
  const cancelled = input.method === "CANCEL";

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    `PRODID:${escapeIcsText(ICS_PRODID)}`,
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${input.method}`,
    "BEGIN:VEVENT",
    `UID:${safeUid(input.uid)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(input.sequence))}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${formatIcsUtc(input.startMs)}`,
    `DTEND:${formatIcsUtc(input.endMs)}`,
    `SUMMARY:${escapeIcsText(input.summary)}`,
  ];
  if (input.description !== undefined && input.description.length > 0) {
    lines.push(`DESCRIPTION:${escapeIcsText(input.description)}`);
  }
  if (input.location !== undefined && input.location.length > 0) {
    lines.push(`LOCATION:${escapeIcsText(input.location)}`);
  }
  if (input.url !== undefined && input.url.length > 0) {
    lines.push(`URL:${escapeIcsText(input.url)}`);
  }
  lines.push(
    `ORGANIZER;CN=${quotedParam(input.organizerName)}:mailto:${safeAddress(input.organizerEmail)}`,
    `ATTENDEE;CN=${quotedParam(input.attendeeName)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=${cancelled ? "FALSE" : "TRUE"}:mailto:${safeAddress(input.attendeeEmail)}`,
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  );
  // Content lines are joined AND terminated with CRLF: RFC 5545 §3.1 requires
  // every content line — including the last — to end with CRLF.
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/** The Resend attachment content-type for this method. */
export function icsContentType(method: IcsMethod): string {
  return `text/calendar; method=${method}; charset=UTF-8`;
}
