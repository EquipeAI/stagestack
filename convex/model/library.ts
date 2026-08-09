import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { logAudit } from "./audit";

// Event library (M0): tracks, tags, rooms, custom fields — one generic CRUD
// over the four tables since they share shape and rules.

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
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 80) {
    throw new ConvexError({
      code: "invalid_name",
      message: "Name must be 1-80 characters.",
    });
  }
  return trimmed;
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
  const row = (await ctx.db.get(
    table,
    id as Id<T>,
  )) as Doc<T> | null;
  if (row === null || row.eventId !== caller.event._id) {
    throw new ConvexError({
      code: "not_found",
      message: "No such library item in this event.",
    });
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

export async function removeLibraryItem(
  ctx: MutationCtx,
  caller: EventCaller,
  table: LibraryKind,
  id: string,
): Promise<void> {
  await getScoped(ctx, caller, table, id);
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
