import type { Doc } from "../_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────
// The URL vocabulary of every module table, in one place (W2).
//
// Table state has lived in typed `validateSearch` params since W12, and W8
// proved deep links against those parsers. Saved views make that state
// STORABLE, which adds a failure mode neither of those had: a row in the
// database can outlive the vocabulary it was written against, and a stored
// param the route would drop lands the organizer on a page that looks
// filtered and is not.
//
// So the parsers moved here — verbatim — from the six route modules that
// owned them. `apps/web/src/components/*/search.ts` now re-export these, so
// the route's `validateSearch` and the backend's stored-params validation are
// not two implementations that agree by maintenance: they are one function.
// Same precedent as `formDef`, `scorecard`, `bulkDecisions` and `agenda`.
//
// `Id<...>`/`Doc<...>` erase at runtime, so importing the generated data model
// costs the client nothing and keeps the status vocabulary exact.
// ─────────────────────────────────────────────────────────────────────────

/** A stored/serialized view: URL params, which are strings, and only that. */
export type ViewParams = Record<string, string>;

export type ViewModule =
  | "proposals"
  | "sessions"
  | "speakers"
  | "tasks"
  | "reviews"
  | "agenda";

export const VIEW_MODULES: ReadonlyArray<ViewModule> = [
  "proposals",
  "sessions",
  "speakers",
  "tasks",
  "reviews",
  "agenda",
];

export function isViewModule(value: string): value is ViewModule {
  return (VIEW_MODULES as ReadonlyArray<string>).includes(value);
}

/** What the module is CALLED, for sentences composed in the model layer. */
export const MODULE_LABEL: Record<ViewModule, string> = {
  proposals: "Proposals",
  sessions: "Sessions",
  speakers: "Speakers",
  tasks: "Tasks",
  reviews: "Reviews",
  agenda: "Agenda",
};

/**
 * Who may hold a view of this module.
 *
 * This is the SAME gate the nav applies (`requires: 'organizer'` in
 * `components/shell/nav.ts`) — stated here because a saved view is a stored
 * set of filters for a surface, and a reviewer who could store-and-retrieve
 * organizer params would have a door into organizer vocabulary that the nav
 * closed. Reviews is the one module a reviewer legitimately works in, so it is
 * the one module they can name a view of. Enforced on READ and on WRITE, in
 * `convex/model/savedViews.ts`.
 */
export const MODULE_ACCESS: Record<ViewModule, "organizer" | "member"> = {
  proposals: "organizer",
  sessions: "organizer",
  speakers: "organizer",
  tasks: "organizer",
  agenda: "organizer",
  reviews: "member",
};

// ── Per-module parsers ───────────────────────────────────────────────────

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Proposals ---------------------------------------------------------------

export type ProposalStatus = Doc<"proposals">["status"];

/** Every proposal state the table's URL may name. */
export const PROPOSAL_STATUSES: ReadonlyArray<ProposalStatus> = [
  "draft",
  "pending",
  "acceptQueue",
  "declineQueue",
  "accepted",
  "declined",
  "withdrawn",
];

/** Column ids, which double as sort keys. */
export const PROPOSAL_COLUMN_IDS: ReadonlyArray<string> = [
  "title",
  "speakers",
  "submitter",
  "status",
  "reviews",
  "submittedAt",
  "updatedAt",
];

export type AbstractsSearch = {
  q?: string;
  status?: string;
  sort?: string;
  dir?: "asc" | "desc";
  cols?: string;
};

function isProposalStatus(value: string): value is ProposalStatus {
  return (PROPOSAL_STATUSES as ReadonlyArray<string>).includes(value);
}

/** Route-level validateSearch: unknown params are dropped, never trusted. */
export function parseProposalsSearch(
  input: Record<string, unknown>,
): AbstractsSearch {
  const out: AbstractsSearch = {};
  const q = str(input.q);
  if (q !== undefined) out.q = q.slice(0, 200);
  const status = str(input.status);
  if (status !== undefined) {
    const list = status.split(",").filter(isProposalStatus);
    if (list.length > 0) out.status = list.join(",");
  }
  const sort = str(input.sort);
  if (sort !== undefined && PROPOSAL_COLUMN_IDS.includes(sort)) out.sort = sort;
  const dir = str(input.dir);
  if (dir === "asc" || dir === "desc") out.dir = dir;
  const cols = str(input.cols);
  if (cols !== undefined) {
    const list = cols.split(",").filter((c) => PROPOSAL_COLUMN_IDS.includes(c));
    if (list.length > 0) out.cols = list.join(",");
  }
  return out;
}

// Sessions ----------------------------------------------------------------

export const CONTENT_FILTERS = ["draft", "approved"] as const;
export type ContentFilter = (typeof CONTENT_FILTERS)[number];
export type SessionsSearch = { content?: ContentFilter };

export function parseSessionsSearch(
  input: Record<string, unknown>,
): SessionsSearch {
  const content = input.content;
  return typeof content === "string" &&
    (CONTENT_FILTERS as ReadonlyArray<string>).includes(content)
    ? { content: content as ContentFilter }
    : {};
}

// Speakers ----------------------------------------------------------------

export type ParticipantState = Doc<"sessionParticipants">["state"];

export const PARTICIPANT_STATES: ReadonlyArray<ParticipantState> = [
  "awaiting",
  "confirmed",
  "declined",
  "withdrawn",
];

export type SpeakersSearch = { q?: string; state?: ParticipantState };

export function parseSpeakersSearch(
  input: Record<string, unknown>,
): SpeakersSearch {
  const out: SpeakersSearch = {};
  const q = str(input.q);
  if (q !== undefined) out.q = q.slice(0, 200);
  const state = input.state;
  if (
    typeof state === "string" &&
    (PARTICIPANT_STATES as ReadonlyArray<string>).includes(state)
  ) {
    out.state = state as ParticipantState;
  }
  return out;
}

// Tasks -------------------------------------------------------------------

export const TASK_TABS = ["requirements", "instances", "files"] as const;
export type TaskTab = (typeof TASK_TABS)[number];

export type TaskStatus = Doc<"taskInstances">["status"];

export const TASK_STATUSES: ReadonlyArray<TaskStatus> = [
  "pending",
  "provided",
  "changesRequested",
  "approved",
  "complete",
  "notApplicable",
];

/** The cross-status filters, in the order the chip row shows them. */
export const DERIVED_TASK_FILTERS = ["outstanding", "overdue"] as const;
export type DerivedTaskFilter = (typeof DERIVED_TASK_FILTERS)[number];

export type TasksSearch = {
  tab?: TaskTab;
  status?: TaskStatus | DerivedTaskFilter;
  requirement?: string;
};

export function parseTasksSearch(input: Record<string, unknown>): TasksSearch {
  const out: TasksSearch = {};
  const tab = input.tab;
  if (typeof tab === "string" && (TASK_TABS as ReadonlyArray<string>).includes(tab)) {
    out.tab = tab as TaskTab;
  }
  const status = input.status;
  if (typeof status === "string") {
    if ((DERIVED_TASK_FILTERS as ReadonlyArray<string>).includes(status)) {
      out.status = status as DerivedTaskFilter;
    } else if ((TASK_STATUSES as ReadonlyArray<string>).includes(status)) {
      out.status = status as TaskStatus;
    }
  }
  const requirement = input.requirement;
  if (
    typeof requirement === "string" &&
    requirement !== "" &&
    requirement !== "all"
  ) {
    out.requirement = requirement.slice(0, 64);
  }
  return out;
}

// Reviews -----------------------------------------------------------------

export const REVIEW_TABS = ["queue", "plan", "progress"] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];
export type ReviewsSearch = { tab?: ReviewTab; flow?: string };

export function parseReviewsSearch(
  input: Record<string, unknown>,
): ReviewsSearch {
  const tab = input.tab;
  const flow = input.flow;
  const out: ReviewsSearch = {};
  if (
    typeof tab === "string" &&
    (REVIEW_TABS as ReadonlyArray<string>).includes(tab)
  ) {
    out.tab = tab as ReviewTab;
  }
  if (typeof flow === "string" && flow !== "" && flow.length <= 64) {
    out.flow = flow;
  }
  return out;
}

// Agenda ------------------------------------------------------------------

export type AgendaViewId = "list" | "day" | "week" | "track" | "room";

export const AGENDA_VIEWS: ReadonlyArray<AgendaViewId> = [
  "list",
  "day",
  "week",
  "track",
  "room",
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Column keys are Convex ids or the two synthetic ones ("noroom"/"notrack"),
 * so anything with a separator or whitespace in it is not one. */
const COLUMN_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type AgendaSearch = { view: AgendaViewId; day?: string; room?: string };

/** Route-level validateSearch: an unknown view falls back to the default. */
export function parseAgendaSearch(
  input: Record<string, unknown>,
): AgendaSearch {
  const rawView = input.view;
  const view =
    typeof rawView === "string" &&
    (AGENDA_VIEWS as ReadonlyArray<string>).includes(rawView)
      ? (rawView as AgendaViewId)
      : "room";
  const rawDay = input.day;
  const day = typeof rawDay === "string" && DAY_RE.test(rawDay) ? rawDay : undefined;
  const rawRoom = input.room;
  // A column that no longer exists is dropped by the board, not here: the
  // parser cannot know this event's rooms, and a stale link must still resolve.
  const room =
    typeof rawRoom === "string" && COLUMN_RE.test(rawRoom) ? rawRoom : undefined;
  return { view, day, room };
}

// ── The module-agnostic surface the saved-view capability uses ────────────

const PARSERS: Record<
  ViewModule,
  (input: Record<string, unknown>) => Record<string, string | undefined>
> = {
  proposals: parseProposalsSearch,
  sessions: parseSessionsSearch,
  speakers: parseSpeakersSearch,
  tasks: parseTasksSearch,
  reviews: parseReviewsSearch,
  agenda: parseAgendaSearch,
};

function compact(input: Record<string, string | undefined>): ViewParams {
  const out: ViewParams = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** What the destination route would keep, and nothing else. */
export function parseViewParams(
  module: ViewModule,
  input: Record<string, unknown>,
): ViewParams {
  return compact(PARSERS[module](input));
}

/** The params of an unfiltered view of this module — the "no explicit
 * narrowing" baseline. Not always empty: the agenda always names a view. */
export function baseViewParams(module: ViewModule): ViewParams {
  return parseViewParams(module, {});
}

export type ParamCheck = {
  /** Exactly what the route would keep. */
  params: ViewParams;
  /** Keys the route would DROP or rewrite — the reason to refuse a save. */
  dropped: Array<string>;
};

/**
 * Run params through the destination's own parser and report what it refused.
 *
 * A dropped key is not a detail to clean up quietly: it is the difference
 * between "the view you saved" and "a view that looks like it". The model
 * refuses the write and names the key.
 */
export function checkViewParams(
  module: ViewModule,
  input: ViewParams,
): ParamCheck {
  const params = parseViewParams(module, input);
  const dropped: Array<string> = [];
  for (const key of Object.keys(input)) {
    if (params[key] !== input[key]) dropped.push(key);
  }
  return { params, dropped: dropped.sort() };
}

/** Two views are the same view when they carry the same params. */
export function sameParams(a: ViewParams, b: ViewParams): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

// ── Presets ──────────────────────────────────────────────────────────────

/**
 * Code-level views: not stored, not per-user, not deletable.
 *
 * They exist so the picker is never empty on a fresh event, and so the
 * lifecycle's one always-present example — Decisions — goes through the same
 * mechanism as everything an organizer names themselves (W7 decision 6). The
 * Decisions NAV entry navigates with `DECISIONS_PRESET.params`; the picker on
 * Proposals shows the same preset and marks it current. One definition, two
 * surfaces, so they cannot drift apart.
 */
export type PresetView = { id: string; name: string; params: ViewParams };

const PRESETS: Record<ViewModule, ReadonlyArray<PresetView>> = {
  proposals: [
    { id: "all", name: "All", params: {} },
    { id: "inbox", name: "Inbox", params: { status: "pending" } },
    {
      id: "decisions",
      name: "Decisions",
      params: { status: "acceptQueue,declineQueue" },
    },
    { id: "released", name: "Released", params: { status: "accepted,declined" } },
    { id: "withdrawn", name: "Withdrawn", params: { status: "withdrawn" } },
  ],
  sessions: [
    { id: "all", name: "All", params: {} },
    { id: "draft", name: "Draft content", params: { content: "draft" } },
  ],
  speakers: [
    { id: "all", name: "All", params: {} },
    { id: "awaiting", name: "Awaiting reply", params: { state: "awaiting" } },
  ],
  tasks: [
    { id: "all", name: "All tasks", params: { tab: "instances" } },
    {
      id: "outstanding",
      name: "Outstanding work",
      params: { tab: "instances", status: "outstanding" },
    },
  ],
  reviews: [
    { id: "queue", name: "My queue", params: {} },
    { id: "progress", name: "Progress", params: { tab: "progress" } },
  ],
  agenda: [
    { id: "room", name: "Room view", params: { view: "room" } },
    { id: "list", name: "List view", params: { view: "list" } },
  ],
};

export function presetsFor(module: ViewModule): ReadonlyArray<PresetView> {
  return PRESETS[module];
}

/** The staged-decision queues — the Select group's Decisions entry (W7). */
export const DECISIONS_PRESET: PresetView = PRESETS.proposals[2];
