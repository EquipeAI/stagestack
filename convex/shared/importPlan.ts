import { v, type Infer } from "convex/values";

// The Import agent's contract (M2). The worker's planning agent produces an
// ImportPlan; the organizer reviews it in the UI; the confirmed records are
// executed server-side through the same model capabilities the UI uses
// (docs/ARCHITECTURE.md "capability layer"). Kept in shared/ so the Convex
// executor, the worker and the UI cannot drift.

export const vImportRecord = v.union(
  v.object({
    kind: v.literal("contact"),
    firstName: v.string(),
    lastName: v.string(),
    email: v.optional(v.string()),
    tagline: v.optional(v.string()),
    bio: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("track"),
    name: v.string(),
  }),
  v.object({
    kind: v.literal("tag"),
    name: v.string(),
  }),
  v.object({
    kind: v.literal("proposal"),
    title: v.string(),
    abstract: v.optional(v.string()),
    trackName: v.optional(v.string()),
    speakers: v.array(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        email: v.optional(v.string()),
      }),
    ),
  }),
  v.object({
    // A confirmed/invited talk that bypasses review (Sessionboard's
    // "sessions" vs "abstracts"). Never sends communications when imported.
    kind: v.literal("session"),
    title: v.string(),
    description: v.optional(v.string()),
    speaker: v.object({
      firstName: v.string(),
      lastName: v.string(),
      email: v.optional(v.string()),
    }),
  }),
);

export const vPlannedRecord = v.object({
  // Stable id within the plan, e.g. "r12" — the UI's selection handle.
  id: v.string(),
  sourceRow: v.optional(v.number()),
  record: vImportRecord,
  // Agent-surfaced doubt, shown to the organizer ("column mapping unclear").
  uncertainty: v.optional(v.string()),
  // Existing-record match, shown as "reuses existing" / "possible duplicate".
  duplicateOf: v.optional(v.string()),
  reuse: v.optional(v.boolean()),
});

export const vImportPlan = v.object({
  summary: v.string(),
  columns: v.optional(v.array(v.string())),
  records: v.array(vPlannedRecord),
  skippedRows: v.array(
    v.object({ row: v.number(), reason: v.string() }),
  ),
});

export type ImportRecord = Infer<typeof vImportRecord>;
export type PlannedRecord = Infer<typeof vPlannedRecord>;
export type ImportPlan = Infer<typeof vImportPlan>;

// The context worker.importContext serves the planner: event facts, the
// upload, duplicate-detection hints, and which hint reads hit their scan cap.
export const vImportContext = v.object({
  event: v.object({
    name: v.string(),
    slug: v.string(),
    timezone: v.string(),
  }),
  filename: v.string(),
  description: v.union(v.string(), v.null()),
  fileUrl: v.union(v.string(), v.null()),
  tracks: v.array(v.string()),
  tags: v.array(v.string()),
  contacts: v.array(
    v.object({
      firstName: v.string(),
      lastName: v.string(),
      email: v.union(v.string(), v.null()),
    }),
  ),
  proposalTitles: v.array(v.string()),
  truncated: v.object({
    contacts: v.boolean(),
    proposals: v.boolean(),
  }),
});
export type ImportContext = Infer<typeof vImportContext>;

// One executed record's outcome; shared by the worker's batch calls and the
// execution report it stores on the job.
export const vRecordResult = v.object({
  id: v.string(),
  ok: v.boolean(),
  detail: v.string(),
});
export type RecordResult = Infer<typeof vRecordResult>;

// The import-execute job's stored result, written by the worker and read by
// the organizer's report view.
export const vExecutionReport = v.object({
  total: v.number(),
  ok: v.number(),
  failed: v.number(),
  results: v.array(vRecordResult),
});
export type ExecutionReport = Infer<typeof vExecutionReport>;

export const IMPORT_LIMITS = {
  maxRecords: 500,
  maxRows: 300,
  executeBatch: 25,
  // The byte ceiling for an uploaded import file (S5). ONE constant, because
  // the two ends of this path have to agree: the browser refuses the file
  // before it is ever stored, and the worker refuses the download before it
  // buffers it. A 300-row sheet is kilobytes; 10 MB is far above any honest
  // import and far below what would hurt the worker VM if someone points a
  // storage URL at something enormous.
  maxFileBytes: 10 * 1024 * 1024,
};

/** The one sentence both ends use when a file is over `maxFileBytes`. */
export function importFileTooLargeMessage(bytes: number | null): string {
  const cap = Math.round(IMPORT_LIMITS.maxFileBytes / (1024 * 1024));
  const seen =
    bytes === null
      ? ""
      : ` (this one is ${(bytes / (1024 * 1024)).toFixed(1)} MB)`;
  return `Import file is too large${seen} — the limit is ${cap} MB.`;
}
