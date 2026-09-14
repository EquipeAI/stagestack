import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { forbidden, notFound } from "../lib/functions";
import { assertText } from "./validation";
import {
  MODULE_ACCESS,
  MODULE_LABEL,
  checkViewParams,
  isViewModule,
  parseViewParams,
  sameParams,
} from "../shared/viewParams";
import type { ViewModule, ViewParams } from "../shared/viewParams";

// ─────────────────────────────────────────────────────────────────────────
// Saved views (W2).
//
// A saved view is a NAME for a set of URL params on one module table. That is
// the whole model: no sharing, no permissions, no visibility field. A view is
// private to the person who saved it, and a view they want somebody else to
// see is a link — the address bar already holds the state, and the link
// carries params, never this row's id, so nothing about a shared URL depends
// on the recipient having access to the sender's preferences.
//
// Three rules this file exists to hold:
//
//   1. STORED PARAMS ARE UNTRUSTED. Every write runs them through the
//      destination module's own parser (`convex/shared/viewParams.ts` — the
//      same function the route's `validateSearch` calls) and REFUSES a param
//      the route would drop, naming it. Reads re-parse too: a row written
//      before a vocabulary change must not resurface a param that has since
//      stopped meaning anything.
//   2. ROLE GATES THE MODULE, ON READ AND ON WRITE. Reviewers work in Reviews;
//      the other module tables are organizer surfaces (`requires: 'organizer'`
//      in the nav). Storing params for an organizer-only module and reading
//      them back would otherwise be a door around that gate, so both doors are
//      the same check.
//   3. ONE PRODUCER FOR EVERY SENTENCE. What the picker says about a view, a
//      default, or a refusal is composed here and rendered verbatim.
//
// No audit rows: a saved view is a personal preference, not an act on the
// event's record. Nothing another organizer can see changes when one is made.
// ─────────────────────────────────────────────────────────────────────────

/** Per (event, user, module). A picker is a shortlist, not an archive. */
const MAX_VIEWS = 24;
const MAX_NAME = 60;
/** No module's vocabulary is close to this; a wider object is not a view. */
const MAX_PARAM_KEYS = 12;

export type SavedViewRow = {
  viewId: Id<"savedViews">;
  name: string;
  params: ViewParams;
  isDefault: boolean;
  updatedAt: number;
};

export type SavedViewList = {
  module: ViewModule;
  moduleLabel: string;
  views: Array<SavedViewRow>;
  /** Applied on a first visit that carries no explicit params. */
  defaultViewId: Id<"savedViews"> | null;
  /** Composed here, printed verbatim. */
  summary: string;
};

export type SavedViewWrite = {
  viewId: Id<"savedViews">;
  /** Composed here, printed verbatim. */
  message: string;
};

// ── Gates ────────────────────────────────────────────────────────────────

/** A module id from the wire, or a refusal — never a silent empty list. */
export function requireModule(module: string): ViewModule {
  if (!isViewModule(module)) {
    throw new ConvexError({
      code: "unknown_module",
      message: `StageStack has no table called “${module}”, so there is nothing to save a view of.`,
    });
  }
  return module;
}

/**
 * The role gate, applied identically wherever a module id appears — on the
 * list read, on every write, and again on the module a stored row names.
 */
export function requireModuleAccess(
  caller: EventCaller,
  module: ViewModule,
): void {
  if (MODULE_ACCESS[module] === "organizer" && caller.role !== "organizer") {
    forbidden(
      `${MODULE_LABEL[module]} is an organizer surface, so there are no saved views of it for your reviewer access.`,
    );
  }
}

/**
 * The caller's own view, or nothing.
 *
 * Somebody else's view, a view on another event, and a view that never existed
 * are ONE answer on purpose: "not found" tells a caller nothing about whose
 * preferences exist, which is the only privacy a per-user preference needs.
 */
async function ownView(
  ctx: QueryCtx,
  caller: EventCaller,
  viewId: Id<"savedViews">,
): Promise<Doc<"savedViews">> {
  const view = await ctx.db.get("savedViews", viewId);
  if (
    view === null ||
    view.userId !== caller.user._id ||
    view.eventId !== caller.event._id
  ) {
    notFound("saved view");
  }
  requireModuleAccess(caller, requireModule(view.module));
  return view;
}

// ── Reads ────────────────────────────────────────────────────────────────

async function ownViews(
  ctx: QueryCtx,
  caller: EventCaller,
  module: ViewModule,
): Promise<Array<Doc<"savedViews">>> {
  const rows = await ctx.db
    .query("savedViews")
    .withIndex("by_eventId_and_userId_and_module", (q) =>
      q
        .eq("eventId", caller.event._id)
        .eq("userId", caller.user._id)
        .eq("module", module),
    )
    // Bounded by MAX_VIEWS on the write path; +1 so a legacy overflow still
    // reads rather than refusing somebody their own preferences.
    .take(MAX_VIEWS + 1);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function project(module: ViewModule, view: Doc<"savedViews">): SavedViewRow {
  return {
    viewId: view._id,
    name: view.name,
    // Re-parsed on the way out: a row is as untrusted as a URL.
    params: parseViewParams(module, view.params),
    isDefault: view.isDefault === true,
    updatedAt: view.updatedAt,
  };
}

function listSummary(
  module: ViewModule,
  views: Array<SavedViewRow>,
): string {
  const label = MODULE_LABEL[module];
  if (views.length === 0) {
    return `No saved views on ${label} yet. Filter the table the way you want it, then save it under a name.`;
  }
  const count = `${views.length} saved ${views.length === 1 ? "view" : "views"} on ${label}.`;
  const preferred = views.find((view) => view.isDefault);
  return preferred === undefined
    ? `${count} None of them opens by default.`
    : `${count} “${preferred.name}” opens by default.`;
}

export async function listViews(
  ctx: QueryCtx,
  caller: EventCaller,
  rawModule: string,
): Promise<SavedViewList> {
  const module = requireModule(rawModule);
  requireModuleAccess(caller, module);
  const views = (await ownViews(ctx, caller, module)).map((view) =>
    project(module, view),
  );
  return {
    module,
    moduleLabel: MODULE_LABEL[module],
    views,
    defaultViewId: views.find((view) => view.isDefault)?.viewId ?? null,
    summary: listSummary(module, views),
  };
}

// ── Writes ───────────────────────────────────────────────────────────────

function cleanName(name: string): string {
  return assertText(name, {
    label: "A view name",
    max: MAX_NAME,
    code: "invalid_name",
  });
}

/**
 * The stored params, or a refusal naming what the table would have thrown
 * away. Saving a view that quietly means something else than the screen it was
 * taken from is the one failure this whole mechanism has to not have.
 */
function cleanParams(module: ViewModule, params: ViewParams): ViewParams {
  if (Object.keys(params).length > MAX_PARAM_KEYS) {
    throw new ConvexError({
      code: "invalid_params",
      message: `A ${MODULE_LABEL[module]} view carries at most ${MAX_PARAM_KEYS} filters.`,
    });
  }
  const { params: kept, dropped } = checkViewParams(module, params);
  if (dropped.length > 0) {
    throw new ConvexError({
      code: "invalid_params",
      message: `${MODULE_LABEL[module]} does not filter by ${dropped.map((key) => `“${key}”`).join(", ")}, so this view would not open the table you are looking at.`,
    });
  }
  return kept;
}

async function assertNameFree(
  ctx: QueryCtx,
  caller: EventCaller,
  module: ViewModule,
  name: string,
  except: Id<"savedViews"> | null,
): Promise<void> {
  const taken = (await ownViews(ctx, caller, module)).some(
    (view) =>
      view._id !== except &&
      view.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    throw new ConvexError({
      code: "name_taken",
      message: `You already have a ${MODULE_LABEL[module]} view called “${name}”.`,
    });
  }
}

/** The one sentence that says what a view now holds. */
function describes(module: ViewModule, params: ViewParams): string {
  const filters = Object.keys(params).length;
  if (sameParams(params, parseViewParams(module, {}))) {
    return `It holds no narrowing, so it opens ${MODULE_LABEL[module]} in full.`;
  }
  return `It holds ${filters} ${filters === 1 ? "setting" : "settings"} from the table you were looking at.`;
}

export async function createView(
  ctx: MutationCtx,
  caller: EventCaller,
  args: { module: string; name: string; params: ViewParams },
): Promise<SavedViewWrite> {
  const module = requireModule(args.module);
  requireModuleAccess(caller, module);
  const name = cleanName(args.name);
  const params = cleanParams(module, args.params);
  const existing = await ownViews(ctx, caller, module);
  if (existing.length >= MAX_VIEWS) {
    throw new ConvexError({
      code: "too_many_views",
      message: `You already have ${MAX_VIEWS} saved views on ${MODULE_LABEL[module]} — the most StageStack keeps. Delete one to save this.`,
    });
  }
  await assertNameFree(ctx, caller, module, name, null);
  const now = Date.now();
  const viewId = await ctx.db.insert("savedViews", {
    eventId: caller.event._id,
    userId: caller.user._id,
    module,
    name,
    params,
    createdAt: now,
    updatedAt: now,
  });
  return {
    viewId,
    message: `Saved “${name}” on ${MODULE_LABEL[module]}. ${describes(module, params)}`,
  };
}

export async function renameView(
  ctx: MutationCtx,
  caller: EventCaller,
  args: { viewId: Id<"savedViews">; name: string },
): Promise<SavedViewWrite> {
  const view = await ownView(ctx, caller, args.viewId);
  const module = requireModule(view.module);
  const name = cleanName(args.name);
  await assertNameFree(ctx, caller, module, name, view._id);
  await ctx.db.patch("savedViews", view._id, { name, updatedAt: Date.now() });
  return {
    viewId: view._id,
    message:
      name === view.name
        ? `“${name}” keeps its name.`
        : `“${view.name}” is now called “${name}”.`,
  };
}

/**
 * Re-point an existing view at the params on screen. Separate from rename so
 * "update this view" never renames and "rename" never silently re-filters.
 */
export async function updateViewParams(
  ctx: MutationCtx,
  caller: EventCaller,
  args: { viewId: Id<"savedViews">; params: ViewParams },
): Promise<SavedViewWrite> {
  const view = await ownView(ctx, caller, args.viewId);
  const module = requireModule(view.module);
  const params = cleanParams(module, args.params);
  await ctx.db.patch("savedViews", view._id, {
    params,
    updatedAt: Date.now(),
  });
  return {
    viewId: view._id,
    message: `“${view.name}” now opens what you are looking at. ${describes(module, params)}`,
  };
}

export async function deleteView(
  ctx: MutationCtx,
  caller: EventCaller,
  args: { viewId: Id<"savedViews"> },
): Promise<{ message: string }> {
  const view = await ownView(ctx, caller, args.viewId);
  const module = requireModule(view.module);
  await ctx.db.delete("savedViews", view._id);
  return {
    message: `Deleted “${view.name}” from your ${MODULE_LABEL[module]} views. Nothing on the event changed — a view is only a way of looking at it.`,
  };
}

/**
 * One default per (event, user, module). Setting one clears the rest in the
 * same write, so two views can never both claim to be what opens first.
 */
export async function setDefaultView(
  ctx: MutationCtx,
  caller: EventCaller,
  args: { viewId: Id<"savedViews">; isDefault: boolean },
): Promise<SavedViewWrite> {
  const view = await ownView(ctx, caller, args.viewId);
  const module = requireModule(view.module);
  const now = Date.now();
  if (!args.isDefault) {
    await ctx.db.patch("savedViews", view._id, {
      isDefault: undefined,
      updatedAt: now,
    });
    return {
      viewId: view._id,
      message: `${MODULE_LABEL[module]} now opens unfiltered for you. “${view.name}” is still saved.`,
    };
  }
  for (const other of await ownViews(ctx, caller, module)) {
    if (other._id !== view._id && other.isDefault === true) {
      await ctx.db.patch("savedViews", other._id, {
        isDefault: undefined,
        updatedAt: now,
      });
    }
  }
  await ctx.db.patch("savedViews", view._id, { isDefault: true, updatedAt: now });
  return {
    viewId: view._id,
    message: `${MODULE_LABEL[module]} now opens on “${view.name}” for you. A link that carries its own filters still wins.`,
  };
}
