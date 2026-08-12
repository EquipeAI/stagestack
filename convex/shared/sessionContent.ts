// Session content snapshots: the vocabulary shared by the model layer (which
// projects the snapshot list) and the web history UI (which previews a restore
// before writing anything). W3 — "Snapshots, not inverse edits".
//
// Everything here is PURE: no ctx, no db, no wall clock. It lives in
// `convex/shared` for the same reason `formDef`, `scorecard` and `importPlan`
// do — the sentence an organizer reads about a restore must have exactly one
// producer, and both sides of the wire need it.
//
// Scope note that the whole workstream hangs on: a "snapshot" is the session's
// CONTENT — title, description, format (schema.ts `sessionRevisions`). Schedule,
// track and tags are NOT versioned and must never appear in this vocabulary.

/** The content fields a revision snapshots — the complete set, in read order. */
export const CONTENT_FIELDS = ["title", "description", "format"] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];

export type SessionContentFields = {
  title: string;
  description?: string;
  format?: string;
};

export const CONTENT_FIELD_LABEL: Record<ContentField, string> = {
  title: "Title",
  description: "Description",
  format: "Format",
};

export function contentValue(
  fields: SessionContentFields,
  field: ContentField,
): string {
  // Trimmed, because that is what a restore actually writes: updateContent
  // trims every field and treats a whitespace-only value as an explicit
  // clear. Comparing raw values here could show a diff the write would not
  // perform (or hide a clear it would) on legacy whitespace-padded rows.
  return (fields[field] ?? "").trim();
}

// ── Event-time moments ───────────────────────────────────────────────────

/** "11 Aug at 13:42 UTC" — event time, explicitly zoned, per the product rule
 * that organizer surfaces show and LABEL event time. `Intl` with a `timeZone`
 * works in the Convex runtime (precedent: `model/agenda.ts` `formatMoment`),
 * so these sentences are composed once, server-side, and rendered verbatim. */
export function contentMoment(ms: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).formatToParts(new Date(ms));
    const pick = (type: string) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const day = pick("day");
    const month = pick("month");
    const hour = pick("hour");
    const minute = pick("minute");
    const zone = pick("timeZoneName");
    if (day !== "" && month !== "" && hour !== "" && minute !== "") {
      return `${day} ${month} at ${hour}:${minute}${zone === "" ? "" : ` ${zone}`}`;
    }
  } catch {
    // A bad IANA zone must degrade the wording, never break the history panel.
  }
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The live content, which is not a revision and cannot be restored onto itself. */
export const CURRENT_SNAPSHOT_LABEL = "Current";

/** Label for the snapshot an ordinary edit left behind. */
export function editSnapshotLabel(editedAt: number, timezone: string): string {
  return `Before edit on ${contentMoment(editedAt, timezone)}`;
}

/** Label for the snapshot a RESTORE left behind — a restore is an edit too, but
 * calling it one is exactly the "edit war" reading W3 removes. */
export function restoreSnapshotLabel(
  editedAt: number,
  timezone: string,
): string {
  return `Before the restore on ${contentMoment(editedAt, timezone)}`;
}

/** The grouping sentence on a restore entry: what that event actually was. */
export function restoredFromSentence(
  restoredSnapshotAt: number | null,
  timezone: string,
): string {
  if (restoredSnapshotAt === null) return "Restored an earlier snapshot";
  return `Restored the snapshot from ${contentMoment(restoredSnapshotAt, timezone)}`;
}

// ── The restore diff ─────────────────────────────────────────────────────

export type ContentDiffStatus = "changed" | "cleared" | "unchanged";

export type ContentDiffEntry = {
  field: ContentField;
  /** "Title" */
  label: string;
  /** The value the session carries right now ("" when empty). */
  from: string;
  /** The value the snapshot would restore ("" when the snapshot was empty). */
  to: string;
  status: ContentDiffStatus;
  /** The one-line sentence: `Title: X → Y`, `Format: Talk → (cleared)`,
   * `Description: unchanged`. */
  sentence: string;
  /** Present only on `cleared`: why an absent field is not "kept as-is". */
  note: string | null;
};

export const EMPTY_VALUE_LABEL = "(empty)";
export const CLEARED_VALUE_LABEL = "(cleared)";

export const CLEARED_NOTE =
  "Restores as cleared, because this field was empty in the snapshot.";

function shown(value: string): string {
  return value === "" ? EMPTY_VALUE_LABEL : value;
}

/**
 * What restoring `snapshot` would do to `current`. Direction is
 * current → snapshot, because that is the write the button performs.
 *
 * The `cleared` case exists because `restoreRevision` deliberately passes ""
 * for absent fields (model/sessions.ts), which `updateContent` treats as an
 * explicit clear. That is defensible, but it must be SHOWN, not discovered.
 */
export function diffContent(
  current: SessionContentFields,
  snapshot: SessionContentFields,
): Array<ContentDiffEntry> {
  return CONTENT_FIELDS.map((field) => {
    const label = CONTENT_FIELD_LABEL[field];
    const from = contentValue(current, field);
    const to = contentValue(snapshot, field);
    if (from === to) {
      return {
        field,
        label,
        from,
        to,
        status: "unchanged" as const,
        sentence: `${label}: unchanged`,
        note: null,
      };
    }
    if (to === "") {
      return {
        field,
        label,
        from,
        to,
        status: "cleared" as const,
        sentence: `${label}: ${shown(from)} → ${CLEARED_VALUE_LABEL}`,
        note: CLEARED_NOTE,
      };
    }
    return {
      field,
      label,
      from,
      to,
      status: "changed" as const,
      sentence: `${label}: ${shown(from)} → ${to}`,
      note: null,
    };
  });
}

/** One sentence over the whole diff, for the confirm step's headline. */
export function diffHeadline(entries: Array<ContentDiffEntry>): string {
  const changed = entries.filter((e) => e.status === "changed").length;
  const cleared = entries.filter((e) => e.status === "cleared").length;
  if (changed === 0 && cleared === 0) {
    return "Nothing changes: this snapshot matches the current content.";
  }
  const parts: Array<string> = [];
  if (changed > 0) {
    parts.push(`${changed} field${changed === 1 ? "" : "s"} will change`);
  }
  if (cleared > 0) {
    parts.push(`${cleared} field${cleared === 1 ? "" : "s"} will be cleared`);
  }
  return `Restoring this snapshot: ${parts.join(" and ")}.`;
}
