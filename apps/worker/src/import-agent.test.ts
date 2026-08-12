import { describe, expect, it } from "vitest";
import { decodeTextFile, parseImportFile } from "./import-agent";

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
