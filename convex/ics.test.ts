import { describe, expect, test } from "vitest";
import {
  base64Utf8,
  buildIcs,
  escapeIcsText,
  foldIcsLine,
  formatIcsUtc,
  icsContentType,
} from "./model/ics";

// Calendar invites (M5). These are pure-function tests on purpose: the two
// landmines this file exists to defuse — CRLF injection into the iCalendar
// stream and `btoa`'s Latin-1 ceiling — are both invisible until a real
// speaker's name breaks a real invite in a real inbox.

const STAMP = Date.parse("2026-08-09T12:00:00Z");
const START = Date.parse("2026-09-01T17:00:00Z");
const END = Date.parse("2026-09-01T18:00:00Z");

function baseInput() {
  return {
    method: "REQUEST" as const,
    uid: "session-1:participant-1@stagestack.dev",
    sequence: 0,
    startMs: START,
    endMs: END,
    stampMs: STAMP,
    summary: "Convex in anger",
    description: "See you on the main stage.",
    location: "Main Stage",
    organizerName: "StageStack",
    organizerEmail: "hello@stagestack.dev",
    attendeeName: "Carol Speaker",
    attendeeEmail: "carol@example.com",
  };
}

/** Unfold before asserting on content: folding is a transport detail. */
function unfold(ics: string): string {
  return ics.replace(/\r\n /g, "");
}

function lines(ics: string): string[] {
  return unfold(ics).split("\r\n");
}

describe("escaping", () => {
  test("escapes backslash, semicolon and comma per RFC 5545", () => {
    expect(escapeIcsText("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
  });

  test("raw CR/LF becomes the literal \\n escape — no property injection", () => {
    const injected = escapeIcsText(
      "Carol\r\nSUMMARY:Injected\r\nATTENDEE:mailto:evil@example.com",
    );
    // No real line terminator survives, so nothing can start a content line.
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).toBe(
      "Carol\\nSUMMARY:Injected\\nATTENDEE:mailto:evil@example.com",
    );
  });

  test("a newline in a speaker name cannot add a line to the stream", () => {
    const ics = buildIcs({
      ...baseInput(),
      attendeeName: "Carol\r\nATTENDEE;CN=Mallory:mailto:mallory@example.com",
      summary: "Talk\r\nX-EVIL:1",
    });
    // One ATTENDEE, one SUMMARY, and no smuggled property anywhere.
    expect(lines(ics).filter((l) => l.startsWith("ATTENDEE"))).toHaveLength(1);
    expect(lines(ics).filter((l) => l.startsWith("SUMMARY"))).toHaveLength(1);
    expect(lines(ics).some((l) => l.startsWith("X-EVIL"))).toBe(false);
  });

  test("a real newline in a description becomes an escaped break", () => {
    const ics = buildIcs({
      ...baseInput(),
      description: "Line one\nLine two",
    });
    expect(unfold(ics)).toContain("DESCRIPTION:Line one\\nLine two");
    expect(lines(ics).filter((l) => l.startsWith("DESCRIPTION"))).toHaveLength(
      1,
    );
  });
});

describe("folding", () => {
  test("leaves lines of 75 octets or fewer alone", () => {
    const line = "A".repeat(75);
    expect(foldIcsLine(line)).toBe(line);
  });

  test("folds longer lines with a leading space and CRLF", () => {
    const folded = foldIcsLine("B".repeat(200));
    const parts = folded.split("\r\n");
    expect(parts[0]).toHaveLength(75);
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    // Continuations carry 74 payload octets + the leading space.
    expect(parts[1]).toHaveLength(75);
    expect(folded.replace(/\r\n /g, "")).toBe("B".repeat(200));
  });

  test("never splits a multi-byte character", () => {
    // "é" is 2 octets, so a naive 75-character fold would cut one in half.
    const folded = foldIcsLine("é".repeat(60));
    expect(folded.replace(/\r\n /g, "")).toBe("é".repeat(60));
    for (const part of folded.split("\r\n")) {
      expect(part).not.toContain("�");
    }
  });

  test("every emitted line stays within 75 octets", () => {
    const ics = buildIcs({
      ...baseInput(),
      summary: "A very long session title that keeps going ".repeat(4),
    });
    const encoder = new TextEncoder();
    for (const line of ics.split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

describe("buildIcs", () => {
  test("REQUEST carries UTC stamps, METHOD and CONFIRMED status", () => {
    const ics = buildIcs(baseInput());
    const out = lines(ics);

    expect(out[0]).toBe("BEGIN:VCALENDAR");
    // The stream is CRLF-terminated per RFC 5545 §3.1, so unfolding+splitting
    // on CRLF yields a trailing empty element after the final content line.
    expect(out.at(-1)).toBe("");
    expect(out.at(-2)).toBe("END:VCALENDAR");
    // Every content line — including the last — ends with CRLF.
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.includes("\r\n")).toBe(true);
    // No bare LF anywhere: CRLF only.
    expect(/(?<!\r)\n/.test(ics)).toBe(false);

    expect(out).toContain("PRODID:-//StageStack//StageStack v1//EN");
    expect(out).toContain("VERSION:2.0");
    expect(out).toContain("METHOD:REQUEST");
    expect(out).toContain("DTSTART:20260901T170000Z");
    expect(out).toContain("DTEND:20260901T180000Z");
    expect(out).toContain("DTSTAMP:20260809T120000Z");
    expect(out).toContain("SEQUENCE:0");
    expect(out).toContain("STATUS:CONFIRMED");
    expect(out).toContain(
      `ORGANIZER;CN="StageStack":mailto:hello@stagestack.dev`,
    );
    expect(
      out.find((l) => l.startsWith("ATTENDEE")),
    ).toContain("RSVP=TRUE:mailto:carol@example.com");
    // METHOD belongs to the VCALENDAR, above the VEVENT.
    expect(out.indexOf("METHOD:REQUEST")).toBeLessThan(
      out.indexOf("BEGIN:VEVENT"),
    );
  });

  test("CANCEL sets both METHOD and STATUS, keeping the same UID", () => {
    const ics = buildIcs({ ...baseInput(), method: "CANCEL", sequence: 2 });
    const out = lines(ics);
    expect(out).toContain("METHOD:CANCEL");
    expect(out).toContain("STATUS:CANCELLED");
    expect(out).toContain("SEQUENCE:2");
    expect(out).toContain("UID:session-1:participant-1@stagestack.dev");
    expect(icsContentType("CANCEL")).toBe(
      "text/calendar; method=CANCEL; charset=UTF-8",
    );
  });

  test("a comma in a CN is quoted so it stays a single parameter value", () => {
    const out = lines(
      buildIcs({ ...baseInput(), attendeeName: "Doe, Jane" }),
    );
    const attendee = out.find((l) => l.startsWith("ATTENDEE"));
    // RFC 5545 3.2: a param value containing a comma MUST be double-quoted,
    // otherwise "Doe, Jane" reads as two values.
    expect(attendee).toContain(`CN="Doe, Jane"`);
  });

  test("control chars are stripped from a CN parameter value", () => {
    // Tab (0x09), vertical tab (0x0b), form feed (0x0c), NUL (0x00) embedded
    // in the middle of the name -- none may reach the stream.
    const dirty = "Stage" + String.fromCharCode(9, 11, 12, 0) + "Stack";
    const out = lines(buildIcs({ ...baseInput(), organizerName: dirty }));
    const organizer = out.find((l) => l.startsWith("ORGANIZER"));
    expect(organizer).toContain(`CN="StageStack"`);
    // No raw control character (0x00-0x1f or 0x7f) survives anywhere.
    const raw = unfold(out.join("\n"));
    for (let c = 0; c < raw.length; c++) {
      const code = raw.charCodeAt(c);
      const isControl = (code <= 0x1f && code !== 0x0a) || code === 0x7f;
      expect(isControl).toBe(false);
    }
  });

  test("a double-quote inside a CN is removed (quoted values can't nest quotes)", () => {
    const out = lines(
      buildIcs({ ...baseInput(), attendeeName: 'Jane "JJ" Doe' }),
    );
    const attendee = out.find((l) => l.startsWith("ATTENDEE"));
    expect(attendee).toContain(`CN="Jane JJ Doe"`);
  });

  test("optional properties are omitted rather than emitted empty", () => {
    const out = lines(
      buildIcs({
        ...baseInput(),
        description: undefined,
        location: undefined,
      }),
    );
    expect(out.some((l) => l.startsWith("DESCRIPTION"))).toBe(false);
    expect(out.some((l) => l.startsWith("LOCATION"))).toBe(false);
  });

  test("formatIcsUtc renders the UTC instant, not local time", () => {
    expect(formatIcsUtc(Date.parse("2026-01-02T03:04:05.678Z"))).toBe(
      "20260102T030405Z",
    );
  });
});

describe("base64Utf8", () => {
  /** atob gives back Latin-1 code units; re-read them as UTF-8 bytes. */
  function decodeUtf8(b64: string): string {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  test("round-trips ASCII", () => {
    expect(decodeUtf8(base64Utf8("hello"))).toBe("hello");
    expect(base64Utf8("hello")).toBe(btoa("hello"));
  });

  test("round-trips non-ASCII that btoa cannot encode at all", () => {
    const value = "Zoë Müller — 東京 🎤";
    expect(() => btoa(value)).toThrow();
    expect(decodeUtf8(base64Utf8(value))).toBe(value);
  });

  test("pads correctly at every byte-length remainder", () => {
    for (const value of ["a", "ab", "abc", "abcd", "abcde", ""]) {
      expect(decodeUtf8(base64Utf8(value))).toBe(value);
    }
    expect(base64Utf8("a")).toBe("YQ==");
    expect(base64Utf8("ab")).toBe("YWI=");
    expect(base64Utf8("abc")).toBe("YWJj");
  });

  test("a full non-ASCII invite survives the attachment encoding", () => {
    const ics = buildIcs({
      ...baseInput(),
      summary: "Café ☕ session",
      attendeeName: "Zoë Müller",
    });
    expect(decodeUtf8(base64Utf8(ics))).toBe(ics);
  });
});
