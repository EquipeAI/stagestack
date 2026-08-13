import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import { assertEventActive, assertText, takeAll, takeCapped } from "./validation";

// Event library (M0): tracks, tags, rooms, formats, custom fields — one
// generic CRUD over the five tables since they share shape and rules.

const SESSION_SCAN = 1000;
const ITEM_SCAN = 1000;

/** Library names are capped here; the backfill below honours the same cap. */
const MAX_NAME = 80;
/**
 * Formats are read with the REFUSE policy (`takeAll`), at the same ceiling
 * `convex/model/publish.ts` uses for tracks and rooms. A silently truncated
 * formats read is not a smaller list — it is a session whose label resolves to
 * nothing, which then renders stale free text on a public page and loses its
 * duration in the planner. Refusing is the only honest answer.
 */
const FORMAT_SCAN = 500;

export type LibraryKind =
  | "tracks"
  | "tags"
  | "rooms"
  | "formats"
  | "customFields";

export type LibraryLists = {
  tracks: Array<Doc<"tracks">>;
  tags: Array<Doc<"tags">>;
  rooms: Array<Doc<"rooms">>;
  formats: Array<Doc<"formats">>;
  customFields: Array<Doc<"customFields">>;
  /** Per-kind overflow flags: TRUE means the list is a prefix, never a lie. */
  capped: Record<LibraryKind, boolean>;
};

const LIST_SCAN = 200;

export async function listLibrary(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<LibraryLists> {
  const [tracks, tags, rooms, formats, customFields] = await Promise.all([
    takeCapped(
      ctx.db
        .query("tracks")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      LIST_SCAN,
    ),
    takeCapped(
      ctx.db
        .query("tags")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      LIST_SCAN,
    ),
    takeCapped(
      ctx.db
        .query("rooms")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      LIST_SCAN,
    ),
    // Formats carry the REFUSE policy promised in the header: the file's own
    // comment said a silently truncated formats read mis-labels public sessions,
    // but the code probed at 200 like the others. The ceiling is FORMAT_SCAN.
    takeAll(
      ctx.db
        .query("formats")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      FORMAT_SCAN,
      "formats",
    ),
    takeCapped(
      ctx.db
        .query("customFields")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      LIST_SCAN,
    ),
  ]);
  const byOrder = <T extends { order: number }>(xs: T[]) =>
    [...xs].sort((a, b) => a.order - b.order);
  return {
    tracks: byOrder(tracks.rows),
    tags: byOrder(tags.rows),
    rooms: byOrder(rooms.rows),
    formats: byOrder(formats),
    customFields: byOrder(customFields.rows),
    capped: {
      tracks: tracks.capped,
      tags: tags.capped,
      rooms: rooms.capped,
      formats: false, // REFUSE policy: reaching here means the read was complete
      customFields: customFields.capped,
    },
  };
}

function assertName(name: string): string {
  return assertText(name, { label: "Name", max: MAX_NAME });
}

/**
 * THE one normalization for a format label, used by every write path that
 * stores one (`library.add`/`update`, `sessions.createDirect`,
 * `sessions.updateContent`, `portal.updateSessionContent`) AND by the matcher
 * that links a label to a library row.
 *
 * The contract it exists to hold:
 *   • trim is the ONLY normalization — no case folding, no collapsing inner
 *     whitespace, no stripping the "(120 min)" the eval asserts verbatim;
 *   • an over-long label is REFUSED, never truncated. Truncation is the
 *     dangerous case: slicing an 85-character label to 80 could land exactly
 *     on an existing row's name and silently link a session to a format
 *     nobody chose. Refusing cannot mis-link;
 *   • because writers and the matcher share this function, a trailing space
 *     can never create a second row or break an existing link.
 */
export function normalizeFormatLabel(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return assertText(trimmed, {
    label: "Session format",
    max: MAX_NAME,
    code: "invalid_format",
  });
}

/** Block lengths are whole minutes inside one day. */
export function assertDurationMinutes(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new ConvexError({
      code: "invalid_duration",
      message: "A length must be a whole number of minutes between 1 and 1440.",
    });
  }
  return minutes;
}

async function nextOrder(
  ctx: QueryCtx,
  table: LibraryKind,
  eventId: Id<"events">,
): Promise<number> {
  const rows = await ctx.db
    .query(table)
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .take(500);
  return rows.reduce((max, r) => Math.max(max, r.order), -1) + 1;
}

export type LibraryItemInput = {
  name: string;
  description?: string;
  color?: string;
  capacity?: number;
  defaultDurationMinutes?: number;
  kind?: "text" | "number" | "select" | "multiselect" | "url";
  options?: string[];
  appliesTo?: "session" | "speaker";
};

export async function addLibraryItem(
  ctx: MutationCtx,
  caller: EventCaller,
  table: LibraryKind,
  input: LibraryItemInput,
): Promise<string> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const name = assertName(input.name);
  const eventId = caller.event._id;
  const order = await nextOrder(ctx, table, eventId);
  let id: string;
  if (table === "tracks") {
    id = await ctx.db.insert("tracks", {
      eventId,
      name,
      description: input.description,
      color: input.color,
      order,
    });
  } else if (table === "tags") {
    id = await ctx.db.insert("tags", {
      eventId,
      name,
      color: input.color,
      order,
    });
  } else if (table === "rooms") {
    id = await ctx.db.insert("rooms", {
      eventId,
      name,
      capacity: input.capacity,
      order,
    });
  } else if (table === "formats") {
    // A format added by hand still gets its duration from the label when the
    // organizer typed one, so "Workshop (120 min)" behaves the same however
    // it entered the library.
    id = await ctx.db.insert("formats", {
      eventId,
      name,
      defaultDurationMinutes:
        input.defaultDurationMinutes === undefined
          ? (parseDurationLabel(name) ?? undefined)
          : assertDurationMinutes(input.defaultDurationMinutes),
      order,
    });
  } else {
    id = await ctx.db.insert("customFields", {
      eventId,
      name,
      kind: input.kind ?? "text",
      options: input.options,
      appliesTo: input.appliesTo ?? "session",
      order,
    });
  }
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId,
    actorUserId: caller.user._id,
    action: `library.${table}.add`,
    targetType: table,
    targetId: id,
    meta: { name },
  });
  return id;
}

/** Fetch a library row and verify it belongs to the caller's event. */
async function getScoped<T extends LibraryKind>(
  ctx: MutationCtx,
  caller: EventCaller,
  table: T,
  id: string,
): Promise<Doc<T>> {
  const normalized = ctx.db.normalizeId(table, id);
  const row = normalized
    ? ((await ctx.db.get(table, normalized as Id<T>)) as Doc<T> | null)
    : null;
  if (row === null || row.eventId !== caller.event._id) {
    notFound("library item", "No such library item in this event.");
  }
  return row;
}

export async function updateLibraryItem(
  ctx: MutationCtx,
  caller: EventCaller,
  table: LibraryKind,
  id: string,
  patch: Partial<LibraryItemInput> & { order?: number },
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const before = await getScoped(ctx, caller, table, id);
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = assertName(patch.name);
  if (patch.order !== undefined) update.order = patch.order;
  if (table === "tracks") {
    if (patch.description !== undefined) update.description = patch.description;
    if (patch.color !== undefined) update.color = patch.color;
  } else if (table === "tags") {
    if (patch.color !== undefined) update.color = patch.color;
  } else if (table === "rooms") {
    if (patch.capacity !== undefined) update.capacity = patch.capacity;
  } else if (table === "formats") {
    if (patch.defaultDurationMinutes !== undefined) {
      update.defaultDurationMinutes = assertDurationMinutes(
        patch.defaultDurationMinutes,
      );
    }
  } else {
    if (patch.kind !== undefined) update.kind = patch.kind;
    if (patch.options !== undefined) update.options = patch.options;
    if (patch.appliesTo !== undefined) update.appliesTo = patch.appliesTo;
  }
  await ctx.db.patch(table, id as Id<LibraryKind>, update);
  const renamedTo =
    table === "formats" &&
    typeof update.name === "string" &&
    update.name !== before.name
      ? update.name
      : null;
  if (renamedTo !== null) {
    await syncFormatLabel(ctx, caller.event._id, id as Id<"formats">, renamedTo);
  }
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: `library.${table}.update`,
    targetType: table,
    targetId: id,
    ...(renamedTo === null
      ? {}
      : { meta: { renamedFrom: before.name, renamedTo } }),
  });
}

/**
 * Carry a format rename into the sessions that denormalize its name.
 *
 * `sessions.format` is the display fallback, but it is also what
 * `resolveFormatId` re-keys off on the next content save — so a stale copy is
 * not merely cosmetic: an unrelated title edit would look up the OLD label,
 * find nothing, and silently drop the session's `formatId`. Patching the copy
 * here is what keeps the link stable.
 *
 * Written with `ctx.db.patch` rather than through `updateContent` on purpose:
 * renaming a library row is not an editorial change to anyone's session, and
 * routing it through the content path would stamp a spurious revision on every
 * linked session.
 *
 * Refuses (`event_too_large`) past the ceiling instead of renaming a prefix —
 * a half-applied rename is exactly the desync this function exists to prevent.
 */
async function syncFormatLabel(
  ctx: MutationCtx,
  eventId: Id<"events">,
  formatId: Id<"formats">,
  name: string,
): Promise<void> {
  const sessions = await takeAll(
    ctx.db
      .query("sessions")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
    SESSION_SCAN,
    "sessions",
  );
  for (const session of sessions) {
    if (session.formatId !== formatId) continue;
    if (session.format === name) continue;
    await ctx.db.patch("sessions", session._id, { format: name });
  }
}

/**
 * Refuse to delete a library row anything still points at. Nothing rewrites the
 * dangling ids — and a room id inside `releasedSlot` is already out in the .ics
 * files speakers hold, so a deleted room would leave the calendar entry naming
 * a place that no longer exists.
 *
 * Custom fields are exempt: no table stores per-field answers yet.
 */
async function assertNotInUse(
  ctx: MutationCtx,
  table: LibraryKind,
  eventId: Id<"events">,
  id: string,
): Promise<void> {
  if (table === "customFields") return;
  // REFUSE past the ceiling rather than scanning a prefix: a silent partial
  // scan here could miss a reference and delete a row that is still in use.
  const sessions = await takeAll(
    ctx.db
      .query("sessions")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
    SESSION_SCAN,
    "sessions",
  );
  const sessionCount = sessions.filter((s) =>
    table === "tracks"
      ? s.trackId === id
      : table === "tags"
        ? (s.tagIds ?? []).some((t) => t === id)
        : table === "formats"
          ? s.formatId === id
          : s.roomId === id || s.releasedSlot?.roomId === id,
  ).length;
  let itemCount = 0;
  if (table === "rooms") {
    const items = await takeAll(
      ctx.db
        .query("agendaItems")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      ITEM_SCAN,
      "agenda items",
    );
    itemCount = items.filter((i) => i.roomId === id).length;
  }
  if (sessionCount === 0 && itemCount === 0) return;
  const used = [
    sessionCount > 0
      ? `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`
      : null,
    itemCount > 0
      ? `${itemCount} ${itemCount === 1 ? "agenda item" : "agenda items"}`
      : null,
  ].filter((part) => part !== null);
  throw new ConvexError({
    code: "library_item_in_use",
    message: `Still used by ${used.join(" and ")} — change them first, then delete this.`,
  });
}

// ── Formats (W2) ─────────────────────────────────────────────────────────

/** The block length assumed when neither the session nor its format says. */
export const DEFAULT_DURATION_MINUTES = 60;

/**
 * Read a trailing duration parenthetical off a format label.
 *
 * The ONLY accepted shape is a trailing `(N min)` — `min`, `mins` or
 * `minutes`, any case, optional space before the unit: "Workshop (120 min)" →
 * 120. Everything else returns null, including "120 min Workshop" and
 * "Workshop (2 hours)". Deliberately narrow: this parser runs over labels the
 * eval asserts verbatim, so guessing wrong is worse than not guessing.
 *
 * The label itself is NEVER rewritten — the number is stored beside the name.
 */
export function parseDurationLabel(label: string): number | null {
  const match = /\((\d+)\s*(?:min|mins|minutes)\)$/i.exec(label.trim());
  if (match === null) return null;
  const minutes = Number(match[1]);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    return null;
  }
  return minutes;
}

/** How long a session's block is: override → format default → 60 minutes. */
export function resolveDurationMinutes(
  session: Pick<Doc<"sessions">, "durationMinutes" | "formatId">,
  formatById: ReadonlyMap<Id<"formats">, Doc<"formats">>,
): number {
  if (session.durationMinutes !== undefined) return session.durationMinutes;
  if (session.formatId !== undefined) {
    const fromFormat = formatById.get(session.formatId)?.defaultDurationMinutes;
    if (fromFormat !== undefined) return fromFormat;
  }
  return DEFAULT_DURATION_MINUTES;
}

export async function loadFormats(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Array<Doc<"formats">>> {
  const rows = await takeAll(
    ctx.db
      .query("formats")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
    FORMAT_SCAN,
    "formats",
  );
  return [...rows].sort((a, b) => a.order - b.order);
}

export async function formatsById(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Map<Id<"formats">, Doc<"formats">>> {
  return new Map((await loadFormats(ctx, eventId)).map((f) => [f._id, f]));
}

/** The label a surface shows: the library row's name, else what was typed. */
export function formatLabel(
  session: Pick<Doc<"sessions">, "format" | "formatId">,
  formatById: ReadonlyMap<Id<"formats">, Doc<"formats">>,
): string | undefined {
  if (session.formatId !== undefined) {
    const name = formatById.get(session.formatId)?.name;
    if (name !== undefined) return name;
  }
  return session.format;
}

/**
 * Map a typed/selected format string onto a library row by EXACT name, after
 * the SAME normalization every write path applies. Exact because the CFP
 * form's conditional logic and the eval both compare these strings literally —
 * a fuzzy match here would silently make two labels one — and normalized
 * through the shared helper so a trailing space can never break a link that
 * the identical label without it would have made.
 */
export async function resolveFormatId(
  ctx: QueryCtx,
  eventId: Id<"events">,
  label: string | undefined,
): Promise<Id<"formats"> | undefined> {
  const normalized = normalizeFormatLabel(label);
  if (normalized === undefined) return undefined;
  const formats = await loadFormats(ctx, eventId);
  return formats.find((f) => f.name === normalized)?._id;
}

export type BackfillFormatsResult = {
  formatsCreated: number;
  sessionsLinked: number;
  /** Sessions whose free-text format matched no row — left as free text. */
  unmatched: number;
};

/**
 * Turn one event's distinct free-text `sessions.format` strings into formats
 * library rows, then point the sessions at them.
 *
 * Idempotent by construction: rows are keyed by their EXACT name and sessions
 * are only patched when their `formatId` would change, so a second run is a
 * no-op. Names are preserved verbatim — "Workshop (120 min)" stays
 * "Workshop (120 min)" and only the parsed 120 goes into the separate
 * duration field. The one normalization applied is the shared trim every
 * other write path uses, so the row a legacy " Talk " produces is the same
 * row a later "Talk" resolves to. A label longer than the library's name
 * limit is left as free text rather than truncated into a row nobody could
 * rename — and, more importantly, than truncated into some OTHER row's name.
 *
 * Reads REFUSE past the ceiling rather than migrating a prefix and reporting
 * success: a partial backfill that says "done" is how half an event ends up
 * silently unlinked.
 */
export async function backfillFormats(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<BackfillFormatsResult> {
  const existing = await loadFormats(ctx, eventId);
  const byName = new Map(existing.map((f) => [f.name, f._id]));
  let order = existing.reduce((max, f) => Math.max(max, f.order), -1) + 1;

  const sessions = await takeAll(
    ctx.db
      .query("sessions")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
    SESSION_SCAN,
    "sessions",
  );

  let formatsCreated = 0;
  let sessionsLinked = 0;
  let unmatched = 0;

  for (const session of sessions) {
    const raw = session.format;
    if (raw === undefined || raw.trim() === "") continue;
    // Over-long labels are counted, not truncated (see normalizeFormatLabel).
    if (raw.trim().length > MAX_NAME) {
      unmatched += 1;
      continue;
    }
    const label = raw.trim();
    let formatId = byName.get(label);
    if (formatId === undefined) {
      formatId = await ctx.db.insert("formats", {
        eventId,
        name: label,
        defaultDurationMinutes: parseDurationLabel(label) ?? undefined,
        order,
      });
      order += 1;
      formatsCreated += 1;
      byName.set(label, formatId);
    }
    if (session.formatId !== formatId) {
      await ctx.db.patch("sessions", session._id, { formatId });
      sessionsLinked += 1;
    }
  }

  return { formatsCreated, sessionsLinked, unmatched };
}

export async function removeLibraryItem(
  ctx: MutationCtx,
  caller: EventCaller,
  table: LibraryKind,
  id: string,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  await getScoped(ctx, caller, table, id);
  await assertNotInUse(ctx, table, caller.event._id, id);
  await ctx.db.delete(table, id as Id<LibraryKind>);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: `library.${table}.remove`,
    targetType: table,
    targetId: id,
  });
}
