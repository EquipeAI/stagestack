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

export type RecordResult = {
  id: string;
  ok: boolean;
  detail: string;
};

export const IMPORT_LIMITS = {
  maxRecords: 500,
  maxRows: 300,
  executeBatch: 25,
};
