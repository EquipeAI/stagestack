// Import-with-AI planner (M2). The agent only PLANS: it maps spreadsheet
// rows to StageStack records using the event context the worker feeds it.
// Execution of the organizer-confirmed plan is deterministic worker code
// calling authorized Convex endpoints — the LLM never holds write authority.
// (docs/ARCHITECTURE.md "Worker & agents"; decision log #6/#15.)

import * as vb from "valibot";
import { defineTool, init, useModel, useTool } from "@flue/runtime";
// SheetJS ships off the npm registry since 0.19; both package.jsons pin the
// vendor tarball (cdn.sheetjs.com) because the last registry build, 0.18.5,
// carries the prototype-pollution and ReDoS advisories.
import * as XLSX from "xlsx";
import { ensureFlue } from "./flue";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  IMPORT_LIMITS,
  type ImportContext,
  type ImportPlan,
  type ImportRecord,
  type PlannedRecord,
} from "../../../convex/shared/importPlan";

const MODEL = "openrouter/openai/gpt-5.6-luna";
const CHUNK_SIZE = 40;
// Per-exchange cap. A hung LLM stream must not hold the job past the queue's
// lease TTL — better to fail this job than strand the worker slot.
const EXCHANGE_TIMEOUT_MS = 5 * 60 * 1000;

/** dispatch+read with a wall-clock cap. `signal` only cancels the read (the
 * submission keeps running server-side), so on timeout we also durably
 * abort() the instance before failing the job. */
async function exchange(
  agent: ReturnType<typeof init>,
  message: string,
): Promise<void> {
  const signal = AbortSignal.timeout(EXCHANGE_TIMEOUT_MS);
  try {
    await agent.read(await agent.dispatch(message), { signal });
  } catch (err) {
    if (signal.aborted) {
      await agent.abort().catch(() => undefined);
      throw new Error(
        `Import planner timed out after ${EXCHANGE_TIMEOUT_MS / 1000}s`,
      );
    }
    throw err;
  }
}

// ── File parsing (Node side; the model only ever sees bounded text) ──────

export type ParsedTable = {
  headers: string[];
  rows: string[][];
  truncated: boolean;
};

/**
 * Decode an uploaded text file to a string.
 *
 * UTF-8 first, strictly: if the bytes are not valid UTF-8 the file is almost
 * certainly a legacy Windows export, so fall back to CP1252 rather than
 * littering the abstracts with U+FFFD. Doing it in this order matters — every
 * CP1252 byte sequence is *some* UTF-8-invalid input, but the reverse is not
 * true, so trying UTF-8 first is the only way to tell them apart.
 */
export function decodeTextFile(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // UTF-16 has to be checked by BOM first: its bytes are invalid UTF-8, so it
  // would otherwise fall through to CP1252 and come back full of NULs. Excel's
  // "Unicode Text (*.txt)" export is UTF-16LE TSV, and .txt/.tsv are both
  // accepted here — SheetJS used to sniff this for us when it read the bytes.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  try {
    // TextDecoder strips a leading UTF-8 BOM itself, so Excel's CSV export
    // can't glue one to the first header name.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export function parseImportFile(
  buffer: ArrayBuffer,
  filename: string,
): ParsedTable {
  const lower = filename.toLowerCase();
  let aoa: unknown[][];
  if (
    lower.endsWith(".csv") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".tsv")
  ) {
    // Decode ourselves rather than handing bytes to SheetJS: given a text file
    // as an array it guesses CP1252, so a UTF-8 em-dash (E2 80 94) arrives as
    // "â€”" — and that corruption is what gets stored and published, since the
    // agent plans from the decoded string. Excel and Sheets both export UTF-8,
    // Excel with a BOM, which would otherwise glue itself to the first header.
    const wb = XLSX.read(decodeTextFile(buffer), { type: "string", raw: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    aoa = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
    }) as unknown[][];
  } else {
    // xlsx/xls/ods all go through the same reader.
    const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    aoa = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
    }) as unknown[][];
  }
  const nonEmpty = aoa.filter(
    (row) =>
      Array.isArray(row) && row.some((c) => String(c ?? "").trim() !== ""),
  );
  if (nonEmpty.length === 0) return { headers: [], rows: [], truncated: false };
  const headers = nonEmpty[0].map((c) => String(c ?? "").trim());
  const body = nonEmpty.slice(1);
  const truncated = body.length > IMPORT_LIMITS.maxRows;
  return {
    headers,
    rows: body
      .slice(0, IMPORT_LIMITS.maxRows)
      .map((r) => headers.map((_, i) => String(r[i] ?? "").trim())),
    truncated,
  };
}

// ── The planning agent ───────────────────────────────────────────────────

const speakerSchema = vb.object({
  firstName: vb.string(),
  lastName: vb.string(),
  email: vb.optional(vb.string()),
});

const plannedSchema = vb.object({
  kind: vb.picklist(["contact", "track", "tag", "proposal", "session"]),
  sourceRow: vb.optional(vb.number()),
  uncertainty: vb.optional(vb.string()),
  firstName: vb.optional(vb.string()),
  lastName: vb.optional(vb.string()),
  email: vb.optional(vb.string()),
  tagline: vb.optional(vb.string()),
  bio: vb.optional(vb.string()),
  name: vb.optional(vb.string()),
  title: vb.optional(vb.string()),
  abstract: vb.optional(vb.string()),
  trackName: vb.optional(vb.string()),
  description: vb.optional(vb.string()),
  speakers: vb.optional(vb.array(speakerSchema)),
  speaker: vb.optional(speakerSchema),
});

type RawPlanned = vb.InferOutput<typeof plannedSchema>;

type PlanCapture = {
  records: RawPlanned[];
  skipped: Array<{ row: number; reason: string }>;
  summary: string | null;
};

// One capture per in-flight job, keyed by agent instance id.
const captures = new Map<string, PlanCapture>();

const addRecords = defineTool({
  name: "add_records",
  description:
    "Add the StageStack records you derived from the rows you were just " +
    "shown. Call once per batch of rows. Records: contact {firstName, " +
    "lastName, email?, tagline?, bio?}, track {name}, tag {name}, proposal " +
    "{title, abstract?, trackName?, speakers: [{firstName, lastName, " +
    "email?}]}, session {title, description?, speaker: {firstName, " +
    "lastName, email?}}. Set sourceRow to the 1-based data row a record " +
    "came from, and uncertainty to a short note whenever a mapping is a " +
    "guess.",
  input: vb.object({
    agentKey: vb.string(),
    records: vb.array(plannedSchema),
  }),
  async run({ data }) {
    const capture = captures.get(data.agentKey);
    if (capture === undefined) return { output: "unknown agentKey" };
    capture.records.push(...data.records);
    return { output: `recorded ${data.records.length} records` };
  },
});

const skipRows = defineTool({
  name: "skip_rows",
  description:
    "Report data rows you are deliberately NOT importing (blank, header " +
    "repeats, unmappable) with a short reason each.",
  input: vb.object({
    agentKey: vb.string(),
    rows: vb.array(vb.object({ row: vb.number(), reason: vb.string() })),
  }),
  async run({ data }) {
    const capture = captures.get(data.agentKey);
    if (capture === undefined) return { output: "unknown agentKey" };
    capture.skipped.push(...data.rows);
    return { output: `recorded ${data.rows.length} skipped rows` };
  },
});

const submitPlan = defineTool({
  name: "submit_plan",
  description:
    "Finish planning. Call exactly once, after every row batch has been " +
    "processed with add_records/skip_rows. The summary is 1-3 sentences an " +
    "event organizer reads before approving the import.",
  input: vb.object({
    agentKey: vb.string(),
    summary: vb.string(),
  }),
  async run({ data }) {
    const capture = captures.get(data.agentKey);
    if (capture === undefined) return { output: "unknown agentKey" };
    capture.summary = data.summary;
    return { output: "plan submitted", terminate: true };
  },
});

export function ImportPlanner() {
  useModel(MODEL, { thinkingLevel: "high" });
  useTool(addRecords);
  useTool(skipRows);
  useTool(submitPlan);
  return (
    "You map rows from an event organizer's spreadsheet into StageStack " +
    "records. You will receive event context first, then batches of rows. " +
    "For every batch, call add_records with the records it yields (and " +
    "skip_rows for rows you cannot map), then answer briefly. Rules: " +
    "abstracts/talks/applications become `proposal` records; " +
    "confirmed/invited talks become `session` records only when the sheet " +
    "clearly says they are confirmed — when unsure, use `proposal` with an " +
    "uncertainty note. People without a talk become `contact` records. Only " +
    "create `track`/`tag` records for values that do not already exist in " +
    "the provided lists. Never invent data not present in the sheet; leave " +
    "optional fields out instead. Reuse the exact agentKey you are given. " +
    "When told all rows are delivered, call submit_plan."
  );
}

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function tsv(headers: string[], rows: string[][], startRow: number): string {
  const lines = [`row\t${headers.join("\t")}`];
  rows.forEach((r, i) => lines.push(`${startRow + i}\t${r.join("\t")}`));
  return lines.join("\n");
}

/** Normalize the model's loose records into strict ImportRecords; invalid
 * ones become skipped rows. */
function normalize(
  raw: RawPlanned[],
  skipped: Array<{ row: number; reason: string }>,
): PlannedRecord[] {
  const out: PlannedRecord[] = [];
  raw.forEach((r, i) => {
    const id = `r${i}`;
    const base = { id, sourceRow: r.sourceRow, uncertainty: r.uncertainty };
    let record: ImportRecord | null = null;
    if (r.kind === "contact" && r.firstName && r.lastName) {
      record = {
        kind: "contact",
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email || undefined,
        tagline: r.tagline || undefined,
        bio: r.bio || undefined,
      };
    } else if ((r.kind === "track" || r.kind === "tag") && r.name) {
      record = { kind: r.kind, name: r.name };
    } else if (r.kind === "proposal" && r.title && r.speakers?.length) {
      record = {
        kind: "proposal",
        title: r.title,
        abstract: r.abstract || undefined,
        trackName: r.trackName || undefined,
        speakers: r.speakers,
      };
    } else if (r.kind === "session" && r.title && r.speaker) {
      record = {
        kind: "session",
        title: r.title,
        description: r.description || undefined,
        speaker: r.speaker,
      };
    }
    if (record === null) {
      skipped.push({
        row: r.sourceRow ?? -1,
        reason: `Planned ${r.kind} record was missing required fields`,
      });
    } else {
      out.push({ ...base, record });
    }
  });
  return out;
}

/** How many existing titles/emails the PROMPT carries. The deployment sends
 * up to 500 of each (`worker.importContext`) and `annotateDuplicates` matches
 * against all of them; only the model's copy is trimmed, to bound the context.
 * Two different ceilings, so the prompt states its own — a model told "existing
 * titles: …" reads an unmarked list as exhaustive and will confidently call a
 * duplicate new. */
export const HINT_PREVIEW = 200;

/** One "Existing …" prompt line that never overstates what it contains.
 * `capped` is the deployment's own truncation flag (there were more rows than
 * it read); the slice below is this file's. Either one makes the list a sample,
 * and the line says so. */
export function hintLine(
  label: string,
  values: string[],
  separator: string,
  capped: boolean,
): string {
  if (values.length === 0) {
    return `${label}: (none)${capped ? " were read, but the event has more than this list holds" : ""}`;
  }
  const shown = values.slice(0, HINT_PREVIEW);
  const note = capped
    ? ` (a PARTIAL list — ${shown.length} shown, and the event has more than this check covers; absence from it is NOT evidence a record is new)`
    : shown.length < values.length
      ? ` (a PARTIAL list — ${shown.length} of ${values.length}; absence from it is NOT evidence a record is new)`
      : "";
  return `${label}${note}: ${shown.join(separator)}`;
}

/** Deterministic duplicate/reuse detection against the event context. */
function annotateDuplicates(
  records: PlannedRecord[],
  context: ImportContext,
): void {
  const titleSet = new Map(
    context.proposalTitles.map((t) => [t.trim().toLowerCase(), t]),
  );
  const emailSet = new Map(
    context.contacts
      .filter((c) => c.email !== null)
      .map((c) => [c.email!.toLowerCase(), `${c.firstName} ${c.lastName}`]),
  );
  for (const planned of records) {
    const r = planned.record;
    if (r.kind === "proposal" || r.kind === "session") {
      const match = titleSet.get(r.title.trim().toLowerCase());
      if (match !== undefined) {
        planned.duplicateOf = match;
      }
    }
    if (r.kind === "contact" && r.email !== undefined) {
      const match = emailSet.get(r.email.trim().toLowerCase());
      if (match !== undefined) {
        planned.duplicateOf = match;
        planned.reuse = true;
      }
    }
  }
}

/**
 * Say it in the plan the ORGANIZER approves when duplicate detection ran
 * against a partial directory. `worker.importContext` caps the existing
 * contacts/proposals it sends and reports the cap in `truncated` precisely so
 * this is not silent: past the cap, `annotateDuplicates` cannot see a match,
 * and an existing speaker is presented as a brand-new contact with no mark on
 * the row. The summary is the one line the review UI always prints, so a
 * "possible duplicate" badge that CANNOT appear is disclosed where the
 * approval decision is made.
 */
export function withDuplicateCaveat(
  summary: string,
  context: ImportContext,
): string {
  const partial: string[] = [];
  if (context.truncated.contacts) partial.push("contacts");
  if (context.truncated.proposals) partial.push("proposals");
  if (partial.length === 0) return summary;
  return `${summary} Note: this event has more existing ${partial.join(" and ")} than duplicate-checking reads in one pass, so some rows marked new may already exist — check before approving.`;
}

export async function runImportPlan(
  jobId: Id<"jobs">,
  context: ImportContext,
): Promise<ImportPlan> {
  if (context.fileUrl === null) {
    throw new Error("Uploaded file is gone from storage");
  }
  const res = await fetch(context.fileUrl);
  if (!res.ok) throw new Error(`File download failed: ${res.status}`);
  const table = parseImportFile(await res.arrayBuffer(), context.filename);
  if (table.rows.length === 0) {
    return {
      summary: "The file contained no data rows.",
      columns: table.headers,
      records: [],
      skippedRows: [],
    };
  }

  await ensureFlue();
  // Per-RUN key, not per-job: two runs of the same job (a retry after the
  // lease sweep, or a stale worker that hasn't noticed it lost the lease)
  // would otherwise share one capture entry and clobber each other's records.
  // Deliberately a locally-generated nonce rather than the job's claim token —
  // this string is fed to the model and echoed back in every tool call, so it
  // must not carry anything that authorizes writes.
  const agentKey = `import-${jobId}-${crypto.randomUUID().slice(0, 8)}`;
  const capture: PlanCapture = { records: [], skipped: [], summary: null };
  captures.set(agentKey, capture);
  try {
    const agent = init(ImportPlanner, { id: agentKey });
    const contextMsg = [
      `agentKey: ${agentKey}`,
      `Event: ${context.event.name}`,
      context.description === null
        ? "The organizer gave no description of the file."
        : `The organizer says: ${context.description}`,
      `File: ${context.filename} — columns: ${table.headers.join(" | ")}`,
      `Existing tracks: ${context.tracks.join(", ") || "(none)"}`,
      `Existing tags: ${context.tags.join(", ") || "(none)"}`,
      hintLine(
        "Existing proposal titles",
        context.proposalTitles,
        " ;; ",
        context.truncated.proposals,
      ),
      hintLine(
        "Existing contact emails",
        context.contacts.filter((c) => c.email !== null).map((c) => c.email!),
        ", ",
        context.truncated.contacts,
      ),
      "Row batches follow. Wait for them before planning records.",
    ].join("\n");
    await exchange(agent, contextMsg);

    const batches = chunk(table.rows, CHUNK_SIZE);
    let rowCursor = 1;
    for (const batch of batches) {
      const msg = `Rows ${rowCursor}-${rowCursor + batch.length - 1} of ${
        table.rows.length
      } (tab-separated):\n${tsv(table.headers, batch, rowCursor)}\n\nCall add_records (and skip_rows if needed) for THESE rows now. agentKey: ${agentKey}`;
      await exchange(agent, msg);
      rowCursor += batch.length;
    }
    await exchange(
      agent,
      `All ${table.rows.length} rows delivered. Call submit_plan now. agentKey: ${agentKey}`,
    );

    const skipped = [...capture.skipped];
    const records = normalize(capture.records, skipped).slice(
      0,
      IMPORT_LIMITS.maxRecords,
    );
    annotateDuplicates(records, context);
    if (table.truncated) {
      skipped.push({
        row: IMPORT_LIMITS.maxRows + 1,
        reason: `File had more rows; only the first ${IMPORT_LIMITS.maxRows} were read`,
      });
    }
    return {
      summary: withDuplicateCaveat(
        capture.summary ??
          `Planned ${records.length} records from ${table.rows.length} rows.`,
        context,
      ),
      columns: table.headers,
      records,
      skippedRows: skipped,
    };
  } finally {
    captures.delete(agentKey);
  }
}
