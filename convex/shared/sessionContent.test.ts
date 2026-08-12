import { describe, expect, test } from "vitest";
import {
  CLEARED_NOTE,
  contentMoment,
  diffContent,
  diffHeadline,
  editSnapshotLabel,
  restoreSnapshotLabel,
  restoredFromSentence,
} from "./sessionContent";

// W3: the one producer of every sentence a session-content snapshot says.

const AUG_11_1342_UTC = Date.parse("2026-08-11T13:42:00Z");

describe("snapshot labels", () => {
  test("a moment is event time, day-month-at-HH:mm, with its zone named", () => {
    expect(contentMoment(AUG_11_1342_UTC, "UTC")).toBe("11 Aug at 13:42 UTC");
    // Same instant, Berlin: two hours later in summer, and it says so.
    expect(contentMoment(AUG_11_1342_UTC, "Europe/Berlin")).toContain(
      "11 Aug at 15:42",
    );
    // Not the machine's zone: an America/Los_Angeles event reads 06:42.
    expect(contentMoment(AUG_11_1342_UTC, "America/Los_Angeles")).toContain(
      "11 Aug at 06:42",
    );
  });

  test("midnight is 00:00, never 24:00", () => {
    expect(contentMoment(Date.parse("2026-08-11T00:00:00Z"), "UTC")).toBe(
      "11 Aug at 00:00 UTC",
    );
  });

  test("a nonsense timezone degrades the wording instead of throwing", () => {
    expect(contentMoment(AUG_11_1342_UTC, "Mars/Olympus")).toBe(
      "2026-08-11 13:42 UTC",
    );
  });

  test("an edit and a restore leave differently-worded snapshots behind", () => {
    expect(editSnapshotLabel(AUG_11_1342_UTC, "UTC")).toBe(
      "Before edit on 11 Aug at 13:42 UTC",
    );
    expect(restoreSnapshotLabel(AUG_11_1342_UTC, "UTC")).toBe(
      "Before the restore on 11 Aug at 13:42 UTC",
    );
    expect(restoredFromSentence(AUG_11_1342_UTC, "UTC")).toBe(
      "Restored the snapshot from 11 Aug at 13:42 UTC",
    );
    expect(restoredFromSentence(null, "UTC")).toBe(
      "Restored an earlier snapshot",
    );
  });
});

describe("restore diff", () => {
  const current = {
    title: "Reactive backends",
    description: "A live demo.",
    format: "Talk",
  };

  test("every content field is reported, changed or not, in read order", () => {
    const entries = diffContent(current, {
      title: "Reactive backends, revisited",
      description: "A live demo.",
      format: "Talk",
    });
    expect(entries.map((e) => e.field)).toEqual([
      "title",
      "description",
      "format",
    ]);
    expect(entries[0].status).toBe("changed");
    expect(entries[0].sentence).toBe(
      "Title: Reactive backends → Reactive backends, revisited",
    );
    expect(entries[1].status).toBe("unchanged");
    expect(entries[1].sentence).toBe("Description: unchanged");
    expect(entries[2].status).toBe("unchanged");
  });

  test("a field the snapshot never had is CLEARED, and says why", () => {
    const entries = diffContent(current, { title: "Reactive backends" });
    const format = entries.find((e) => e.field === "format");
    expect(format?.status).toBe("cleared");
    expect(format?.sentence).toBe("Format: Talk → (cleared)");
    expect(format?.note).toBe(CLEARED_NOTE);
    expect(format?.note).toContain("empty in the snapshot");
    // An absent description is the same sharp edge.
    expect(entries.find((e) => e.field === "description")?.status).toBe(
      "cleared",
    );
  });

  test("filling an empty field is a change, not a clear", () => {
    const entries = diffContent(
      { title: "Reactive backends" },
      { title: "Reactive backends", format: "Talk" },
    );
    const format = entries.find((e) => e.field === "format");
    expect(format?.status).toBe("changed");
    expect(format?.sentence).toBe("Format: (empty) → Talk");
    expect(format?.note).toBeNull();
  });

  test("the direction is current → snapshot: it describes the write", () => {
    const [title] = diffContent(current, { ...current, title: "Older title" });
    expect(title.from).toBe("Reactive backends");
    expect(title.to).toBe("Older title");
  });

  test("the headline counts changes and clears separately", () => {
    expect(diffHeadline(diffContent(current, current))).toBe(
      "Nothing changes: this snapshot matches the current content.",
    );
    expect(diffHeadline(diffContent(current, { title: "Older title" }))).toBe(
      "Restoring this snapshot: 1 field will change and 2 fields will be cleared.",
    );
  });
});
