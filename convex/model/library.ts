import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound } from "../lib/functions";
import { logAudit } from "./audit";
import { assertEventActive, assertText } from "./validation";

// Event library (M0): tracks, tags, rooms, custom fields — one generic CRUD
// over the four tables since they share shape and rules.

const SESSION_SCAN = 1000;
const ITEM_SCAN = 1000;

export type LibraryKind = "tracks" | "tags" | "rooms" | "customFields";

export type LibraryLists = {
  tracks: Array<Doc<"tracks">>;
  tags: Array<Doc<"tags">>;
  rooms: Array<Doc<"rooms">>;
  customFields: Array<Doc<"customFields">>;
};

export async function listLibrary(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<LibraryLists> {
  const [tracks, tags, rooms, customFields] = await Promise.all([
    ctx.db
      .query("tracks")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(200),
    ctx.db
      .query("tags")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(200),
    ctx.db
      .query("rooms")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(200),
    ctx.db
      .query("customFields")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(200),
  ]);
  const byOrder = <T extends { order: number }>(xs: T[]) =>
    [...xs].sort((a, b) => a.order - b.order);
  return {
    tracks: byOrder(tracks),
    tags: byOrder(tags),
    rooms: byOrder(rooms),
    customFields: byOrder(customFields),
  };
}

function assertName(name: string): string {
  return assertText(name, { label: "Name", max: 80 });
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
  assertEventActive(caller.event);
  await getScoped(ctx, caller, table, id);
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
  } else {
    if (patch.kind !== undefined) update.kind = patch.kind;
    if (patch.options !== undefined) update.options = patch.options;
    if (patch.appliesTo !== undefined) update.appliesTo = patch.appliesTo;
  }
  await ctx.db.patch(table, id as Id<LibraryKind>, update);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: `library.${table}.update`,
    targetType: table,
    targetId: id,
  });
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
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .take(SESSION_SCAN);
  const sessionCount = sessions.filter((s) =>
    table === "tracks"
      ? s.trackId === id
      : table === "tags"
        ? (s.tagIds ?? []).some((t) => t === id)
        : s.roomId === id || s.releasedSlot?.roomId === id,
  ).length;
  let itemCount = 0;
  if (table === "rooms") {
    const items = await ctx.db
      .query("agendaItems")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(ITEM_SCAN);
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

export async function removeLibraryItem(
  ctx: MutationCtx,
  caller: EventCaller,
  table: LibraryKind,
  id: string,
): Promise<void> {
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
