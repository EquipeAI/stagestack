import { describe, expect, it } from "vitest";
import type { ImportContext } from "../../../convex/shared/importPlan";
import {
  HINT_PREVIEW,
  decodeTextFile,
  hintLine,
  parseImportFile,
  withDuplicateCaveat,
} from "./import-agent";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("decodeTextFile", () => {
  it("keeps UTF-8 punctuation intact", () => {
    // The regression: handing these bytes to SheetJS as an array made it guess
    // CP1252, turning the em-dash into "â€”" — which then got stored and
    // published, because the planner works from the decoded string.
    expect(decodeTextFile(bytes("40k writes — connection pooling"))).toBe(
      "40k writes — connection pooling",
    );
  });

  it("handles non-latin text", () => {
    expect(decodeTextFile(bytes("Ünicode ✓ 日本語"))).toBe("Ünicode ✓ 日本語");
  });

  it("drops the BOM Excel writes on CSV export", () => {
    // TextDecoder does this itself; asserted so a future switch to a decoder
    // that doesn't can't silently glue "﻿" onto the first header name.
    expect(decodeTextFile(bytes("﻿Talk title,Speaker"))).toBe(
      "Talk title,Speaker",
    );
  });

  it("reads UTF-16 the way Excel's Unicode Text export writes it", () => {
    // UTF-16LE bytes are invalid UTF-8, so without the BOM check these fall
    // through to CP1252 and come back NUL-riddled. SheetJS used to sniff this
    // for us; decoding ourselves means we have to.
    const utf16le = new Uint8Array([
      0xff, 0xfe, 0x41, 0x00, 0x09, 0x00, 0x42, 0x00,
    ]).buffer;
    expect(decodeTextFile(utf16le)).toBe("A\tB");

    const utf16be = new Uint8Array([
      0xfe, 0xff, 0x00, 0x41, 0x00, 0x09, 0x00, 0x42,
    ]).buffer;
    expect(decodeTextFile(utf16be)).toBe("A\tB");
  });

  it("falls back to CP1252 for legacy exports rather than emitting U+FFFD", () => {
    // 0x96 is an en-dash in CP1252 and invalid as standalone UTF-8.
    const legacy = new Uint8Array([0x41, 0x96, 0x42]).buffer;
    expect(decodeTextFile(legacy)).toBe("A–B");
  });
});

describe("parseImportFile", () => {
  const csv =
    "Talk title,Speaker,Abstract\n" +
    'Postgres at 40k,Nadia Farouk,"What broke — pooling, WAL pressure"\n';

  it("round-trips UTF-8 through the CSV path", () => {
    const table = parseImportFile(bytes(csv), "talks.csv");
    expect(table.headers).toEqual(["Talk title", "Speaker", "Abstract"]);
    expect(table.rows[0][2]).toBe("What broke — pooling, WAL pressure");
  });

  it("does not let a BOM corrupt the first header", () => {
    const table = parseImportFile(bytes("﻿" + csv), "talks.csv");
    expect(table.headers[0]).toBe("Talk title");
  });
});

describe("duplicate-hint truncation", () => {
  const context = (truncated: {
    contacts: boolean;
    proposals: boolean;
  }): ImportContext => ({
    event: { name: "DevConf", slug: "devconf", timezone: "UTC" },
    filename: "talks.csv",
    description: null,
    fileUrl: null,
    tracks: [],
    tags: [],
    contacts: [],
    proposalTitles: [],
    truncated,
  });

  it("marks a prompt list the deployment truncated", () => {
    // The bug this guards: the deployment caps the existing-contacts read and
    // reports the cap, but the prompt used to present its slice as the whole
    // directory — so the model reads "not in the list" as "new person".
    const line = hintLine("Existing contact emails", ["a@x.com"], ", ", true);
    expect(line).toContain("PARTIAL");
    expect(line).toContain("NOT evidence a record is new");
    expect(line).toContain("a@x.com");
  });

  it("marks a list this file sliced, even when the read was complete", () => {
    const emails = Array.from(
      { length: HINT_PREVIEW + 5 },
      (_, i) => `p${i}@x.com`,
    );
    const line = hintLine("Existing contact emails", emails, ", ", false);
    expect(line).toContain(`${HINT_PREVIEW} of ${HINT_PREVIEW + 5}`);
    expect(line).not.toContain(`p${HINT_PREVIEW}@x.com`);
  });

  it("says nothing when the list is whole", () => {
    const line = hintLine("Existing tags", ["ai", "infra"], ", ", false);
    expect(line).toBe("Existing tags: ai, infra");
  });

  it("still reports an empty-but-capped list", () => {
    expect(hintLine("Existing contact emails", [], ", ", true)).toContain(
      "the event has more",
    );
  });

  it("discloses partial duplicate-checking in the summary the organizer approves", () => {
    // The summary is the one line the review UI always prints. Past the read
    // cap `annotateDuplicates` cannot mark a row, so an existing speaker shows
    // up as a brand-new contact with nothing on the row to say why.
    const both = withDuplicateCaveat(
      "Planned 12 records.",
      context({ contacts: true, proposals: true }),
    );
    expect(both).toContain("Planned 12 records.");
    expect(both).toContain("contacts and proposals");
    expect(both).toContain("may already exist");

    expect(
      withDuplicateCaveat(
        "Planned 12 records.",
        context({ contacts: true, proposals: false }),
      ),
    ).toContain("existing contacts than");

    // Nothing was truncated: no caveat, no noise.
    expect(
      withDuplicateCaveat(
        "Planned 12 records.",
        context({ contacts: false, proposals: false }),
      ),
    ).toBe("Planned 12 records.");
  });
});
