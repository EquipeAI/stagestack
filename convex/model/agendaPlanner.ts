import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { ITEM_SCAN, PARTICIPANT_SCAN, SESSION_SCAN } from "../lib/readCaps";
import {
  blockers,
  candidateConflicts,
  overlaps,
  type Conflict,
  type ScheduledThing,
} from "../shared/agenda";
import { logAudit } from "./audit";
import { loadFormats, resolveDurationMinutes } from "./library";
import { assertEventActive, takeAll } from "./validation";
// The planner reads the board through the same flatteners the board query
// uses. Imported one-way from `./agenda` — nothing there imports this module,
// so there is no cycle to reason about at module-init time.
import {
  DAY_MS,
  LIBRARY_SCAN,
  counts,
  groupParticipants,
  toScheduledThings,
} from "./agenda";

// ── Assisted placement (W7: AIA-08; rebuilt in W2) ───────────────────────
//
// ONE planner, two callers. `suggestSchedule` (a query) and `applySchedule`
// (a mutation) both go through `buildPlan`, so the preview an organizer reads
// and the placement the mutation writes cannot be produced by different code.
// The mutation re-runs the planner against current state and refuses anything
// that no longer matches, rather than quietly placing something else.
//
// Every sentence the UI shows about a placement or a leftover is composed
// here and rendered verbatim (the plan's one-explanation-one-producer rule).

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** The board's own droppable lattice — the plan snaps to what a drag can. */
const LATTICE_MS = 15 * MINUTE_MS;
/** Schedulable window per day, from the event's own start time-of-day. */
const WORKING_DAY_MS = 9 * HOUR_MS;
/** Breathing room a speaker gets between two of their own blocks. */
const SPEAKER_GAP_MS = 30 * MINUTE_MS;
/**
 * How many conflict-free candidates the scorer looks at before settling. The
 * walk is earliest-first, so this is "consider the next few legal slots and
 * pick the best one" rather than "take the first hole" — bounded on purpose,
 * because scoring every cell of a multi-day, multi-room grid for every session
 * is quadratic work inside one transaction for a preference, not a rule.
 */
const CANDIDATE_BUDGET = 24;
/** Hard ceiling on cells inspected per session, so a pathological board can
 * still not blow the transaction's CPU budget. */
const MAX_CELLS_PER_SESSION = 4000;

export type UnplacedReasonCode =
  | "outside_event_bounds"
  | "speaker_double_booked"
  | "no_free_room";

export type PlannedPlacement = {
  sessionId: Id<"sessions">;
  title: string;
  startsAt: number;
  endsAt: number;
  roomId?: Id<"rooms">;
  /** The block length the planner resolved (override → format → default). */
  durationMinutes: number;
  /** Rendered reason this slot was chosen. Shown verbatim. */
  why: string;
};

export type UnplacedSession = {
  sessionId: Id<"sessions">;
  title: string;
  reason: UnplacedReasonCode;
  /** Rendered explanation. Shown verbatim. */
  message: string;
};

export type PlacementPlan = {
  placements: PlannedPlacement[];
  unplaced: UnplacedSession[];
  /**
   * Digest of everything the plan was computed from. The apply mutation
   * refuses a plan whose fingerprint no longer matches, which is what makes
   * "review then apply" safe against a second organizer editing the board.
   */
  fingerprint: string;
};

type PlannerInput = {
  event: Doc<"events">;
  sessions: Array<Doc<"sessions">>;
  agendaItems: Array<Doc<"agendaItems">>;
  participantsBySession: Map<Id<"sessions">, Array<Doc<"sessionParticipants">>>;
  rooms: Array<Doc<"rooms">>;
  tracks: Array<Doc<"tracks">>;
  formats: Array<Doc<"formats">>;
};

/** FNV-1a, 32-bit. Not a security hash — a cheap, stable, order-sensitive
 * digest of the planner's inputs. */
function digest(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Deliberately covers only what the plan is COMPUTED from and what the apply
 * WRITES: the event window, room ids and order, format durations, every
 * session's scheduling fields, and the agenda items.
 *
 * Display-only fields are excluded on purpose — titles, room names, track
 * names, format labels. If one of those changed between preview and apply,
 * the placements the mutation writes are byte-identical to the ones the
 * organizer approved; only the words next to them were stale. Refusing that
 * would be a false alarm on a rename, and the plan's own re-derivation is what
 * guarantees the placements themselves are still current.
 */
function fingerprintOf(input: PlannerInput): string {
  const byId = <T extends { _id: string }>(rows: ReadonlyArray<T>): T[] =>
    [...rows].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
  const parts: string[] = [
    `e|${input.event._id}|${input.event.startsAt}|${input.event.endsAt}`,
  ];
  for (const room of byId(input.rooms)) parts.push(`r|${room._id}|${room.order}`);
  for (const format of byId(input.formats)) {
    parts.push(`f|${format._id}|${format.defaultDurationMinutes ?? ""}`);
  }
  for (const session of byId(input.sessions)) {
    const speakers = (input.participantsBySession.get(session._id) ?? [])
      .filter(counts)
      .map((p) => p.eventContactId)
      .sort()
      .join(",");
    parts.push(
      [
        "s",
        session._id,
        session.status,
        session.startsAt ?? "",
        session.endsAt ?? "",
        session.roomId ?? "",
        session.trackId ?? "",
        session.formatId ?? "",
        session.durationMinutes ?? "",
        speakers,
      ].join("|"),
    );
  }
  for (const item of byId(input.agendaItems)) {
    parts.push(
      `i|${item._id}|${item.startsAt}|${item.endsAt}|${item.roomId ?? ""}`,
    );
  }
  return digest(parts.join("\n"));
}

/** Gap between two non-overlapping blocks, in ms. */
function gapBetween(
  a: { startsAt: number; endsAt: number },
  b: { startsAt: number; endsAt: number },
): number {
  return a.endsAt <= b.startsAt ? b.startsAt - a.endsAt : a.startsAt - b.endsAt;
}

type Scored = {
  score: number;
  why: string;
};

/**
 * Preference, not law. Three modest, explainable nudges on top of "earliest
 * legal slot", each worth less than the next slot in the walk only when it
 * genuinely helps:
 *   • a track that already has a home room keeps it, back-to-back if possible;
 *   • a speaker with another block on the board gets 30 minutes either side;
 *   • a same-track overlap (a warning, not a blocker) is avoided when there is
 *     an alternative.
 * Everything else is left to the organizer, who reviews the plan before it is
 * written.
 */
function scoreCandidate(args: {
  candidate: ScheduledThing;
  things: ReadonlyArray<ScheduledThing>;
  conflicts: ReadonlyArray<Conflict>;
  dayIndex: number;
  eventStartsAt: number;
  durationMinutes: number;
  trackName?: string;
  roomName?: string;
}): Scored {
  const { candidate, things, dayIndex, eventStartsAt } = args;
  let score = 0;
  let why: string | null = null;

  // A same-track overlap is legal (warning level) but rarely what anyone
  // wants when a clear slot exists.
  if (args.conflicts.length > 0) score -= 40;

  if (candidate.trackId !== undefined && candidate.roomId !== undefined) {
    const sameTrackRoom = things.filter(
      (thing) =>
        thing.trackId === candidate.trackId &&
        thing.roomId === candidate.roomId,
    );
    const adjacent = sameTrackRoom.find(
      (thing) =>
        thing.endsAt === candidate.startsAt || thing.startsAt === candidate.endsAt,
    );
    if (adjacent !== undefined) {
      score += 30;
      why =
        args.trackName === undefined || args.roomName === undefined
          ? `Runs back-to-back with "${adjacent.title}".`
          : `Runs back-to-back with "${adjacent.title}" — the ${args.trackName} track stays in ${args.roomName}.`;
    } else if (
      sameTrackRoom.some(
        (thing) =>
          Math.floor((thing.startsAt - eventStartsAt) / DAY_MS) === dayIndex,
      )
    ) {
      score += 10;
      if (args.trackName !== undefined && args.roomName !== undefined) {
        why = `Keeps the ${args.trackName} track in ${args.roomName} on the same day.`;
      }
    }
  }

  if (candidate.speakerIds.length > 0) {
    const speakerBlocks = things.filter((thing) =>
      thing.speakerIds.some((id) => candidate.speakerIds.includes(id)),
    );
    const tight = speakerBlocks.some(
      (thing) => gapBetween(thing, candidate) < SPEAKER_GAP_MS,
    );
    if (tight) {
      score -= 20;
    } else if (speakerBlocks.length > 0) {
      score += 15;
      why ??= `Leaves at least 30 minutes around this speaker's other session.`;
    }
  }

  return {
    score,
    why: why ?? `First free ${args.durationMinutes}-minute slot with no conflicts.`,
  };
}

/**
 * The planner. Pure: same inputs, same plan, no reads and no writes — which is
 * what lets the preview query and the apply mutation share it outright.
 *
 * The slot walk is a 15-minute lattice, independent of the block being placed,
 * so a 10-minute lightning talk occupies 10 minutes and the next session can
 * start in the same hour. Block length is the session's own override, else its
 * format's default, else 60 minutes.
 */
export function buildPlan(input: PlannerInput): PlacementPlan {
  const { event } = input;
  const formatById = new Map(input.formats.map((f) => [f._id, f]));
  const trackNameById = new Map(input.tracks.map((t) => [t._id, t.name]));
  const roomNameById = new Map(input.rooms.map((r) => [r._id, r.name]));
  const roomIds: Array<Id<"rooms"> | undefined> =
    input.rooms.length > 0
      ? [...input.rooms].sort((a, b) => a.order - b.order).map((r) => r._id)
      : [undefined];

  const things = toScheduledThings({
    sessions: input.sessions,
    agendaItems: input.agendaItems,
    participantsBySession: input.participantsBySession,
  });

  const unscheduled = input.sessions.filter(
    (s) => s.status === "planned" && s.startsAt === undefined,
  );

  const dayCount = Math.max(
    1,
    Math.ceil((event.endsAt - event.startsAt) / DAY_MS),
  );

  const placements: PlannedPlacement[] = [];
  const unplaced: UnplacedSession[] = [];

  for (const session of unscheduled) {
    const durationMinutes = resolveDurationMinutes(session, formatById);
    const blockMs = durationMinutes * MINUTE_MS;
    const speakerIds = (input.participantsBySession.get(session._id) ?? [])
      .filter(counts)
      .map((p) => p.eventContactId);

    let cellsInspected = 0;
    /** Cells where a block of this length geometrically fits at all. */
    let fittingCells = 0;
    let sawSpeakerBlocker = false;
    let considered = 0;
    let best:
      | { score: number; placement: PlannedPlacement }
      | null = null;

    outer: for (let day = 0; day < dayCount; day += 1) {
      const dayAnchor = event.startsAt + day * DAY_MS;
      for (let step = 0; ; step += 1) {
        const startsAt = dayAnchor + step * LATTICE_MS;
        const endsAt = startsAt + blockMs;
        // Past this day's schedulable window — try the next day.
        if (endsAt > dayAnchor + WORKING_DAY_MS) break;
        // The WHOLE block must sit inside the event, not just its start: a
        // 120-minute session offered the last 60-minute slot would otherwise
        // be written half outside the event's own dates. `startsAt` only ever
        // increases across the walk (a day's anchor is 24h on, its window
        // 9h wide), so the first overrun means every later cell overruns too.
        if (startsAt >= event.endsAt || endsAt > event.endsAt) break outer;
        // Counted only for cells the block actually fits in, which is what
        // makes "no in-bounds cell at all" distinguishable from "every cell
        // was taken" when the leftover reason is chosen.
        fittingCells += 1;
        for (const roomId of roomIds) {
          if (cellsInspected >= MAX_CELLS_PER_SESSION) break outer;
          cellsInspected += 1;
          const candidate: ScheduledThing = {
            type: "session",
            id: session._id,
            title: session.title,
            startsAt,
            endsAt,
            roomId,
            trackId: session.trackId,
            speakerIds,
          };
          const conflicts = candidateConflicts(things, candidate);
          const blocking = blockers(conflicts);
          if (blocking.length > 0) {
            if (blocking.some((c) => c.kind === "speaker")) {
              sawSpeakerBlocker = true;
            }
            continue;
          }
          // A roomless event has no room-clash signal, so a slot is
          // exclusive: skip it when ANY placed block overlaps (otherwise
          // everything stacks onto the first slot).
          if (
            roomId === undefined &&
            things.some((thing) => overlaps(thing, candidate))
          ) {
            continue;
          }
          const scored = scoreCandidate({
            candidate,
            things,
            conflicts,
            dayIndex: day,
            eventStartsAt: event.startsAt,
            durationMinutes,
            trackName:
              session.trackId === undefined
                ? undefined
                : trackNameById.get(session.trackId),
            roomName: roomId === undefined ? undefined : roomNameById.get(roomId),
          });
          // Strictly greater keeps the earliest slot on a tie, so the walk
          // order is still the tiebreak and the plan stays deterministic.
          if (best === null || scored.score > best.score) {
            best = {
              score: scored.score,
              placement: {
                sessionId: session._id,
                title: session.title,
                startsAt,
                endsAt,
                roomId,
                durationMinutes,
                why: scored.why,
              },
            };
          }
          considered += 1;
          if (considered >= CANDIDATE_BUDGET) break outer;
        }
      }
    }

    if (best === null) {
      unplaced.push({
        sessionId: session._id,
        title: session.title,
        ...unplacedReason({
          durationMinutes,
          fittingCells,
          sawSpeakerBlocker,
        }),
      });
      continue;
    }
    placements.push(best.placement);
    things.push({
      type: "session",
      id: session._id,
      title: session.title,
      startsAt: best.placement.startsAt,
      endsAt: best.placement.endsAt,
      roomId: best.placement.roomId,
      trackId: session.trackId,
      speakerIds,
    });
  }

  return { placements, unplaced, fingerprint: fingerprintOf(input) };
}

/** The three things that can go wrong, said plainly. */
function unplacedReason(args: {
  durationMinutes: number;
  fittingCells: number;
  sawSpeakerBlocker: boolean;
}): { reason: UnplacedReasonCode; message: string } {
  if (args.fittingCells === 0) {
    return {
      reason: "outside_event_bounds",
      message: `The event's dates leave no ${args.durationMinutes}-minute window for this session.`,
    };
  }
  if (args.sawSpeakerBlocker) {
    return {
      reason: "speaker_double_booked",
      message: `Every free ${args.durationMinutes}-minute slot collides with a speaker who is already booked elsewhere.`,
    };
  }
  return {
    reason: "no_free_room",
    message: `No room is free for a ${args.durationMinutes}-minute block at any remaining time.`,
  };
}

/**
 * Load EXACTLY what the planner reads. Shared by the preview and the apply.
 *
 * Deliberately not `loadSchedule`: that also fetches every event contact and
 * builds the whole-board conflict map, and the planner needs neither — it
 * scores candidates against `candidateConflicts`, which derives collisions
 * from the overlapping blocks itself. Same `takeAll` refuse policy on every
 * read, because a dropped session is a missed collision either way.
 */
async function plannerInput(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<PlannerInput> {
  const [sessions, agendaItems, participants, rooms, tracks, formats] =
    await Promise.all([
      takeAll(
        ctx.db
          .query("sessions")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        SESSION_SCAN,
        "sessions",
      ),
      takeAll(
        ctx.db
          .query("agendaItems")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        ITEM_SCAN,
        "agenda items",
      ),
      takeAll(
        ctx.db
          .query("sessionParticipants")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        PARTICIPANT_SCAN,
        "speaker participations",
      ),
      takeAll(
        ctx.db
          .query("rooms")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        LIBRARY_SCAN,
        "rooms",
      ),
      takeAll(
        ctx.db
          .query("tracks")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        LIBRARY_SCAN,
        "tracks",
      ),
      loadFormats(ctx, event._id),
    ]);
  return {
    event,
    sessions,
    agendaItems,
    participantsBySession: groupParticipants(participants),
    rooms,
    tracks,
    formats,
  };
}

/** Preview: what "Suggest schedule" would do, written nowhere. */
export async function suggestSchedule(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<PlacementPlan> {
  requireOrganizer(caller);
  return buildPlan(await plannerInput(ctx, caller.event));
}

/** The undo record: exactly what a run wrote, and what was there before. */
export type PlacementRecord = {
  sessionId: Id<"sessions">;
  startsAt: number;
  endsAt: number;
  roomId?: Id<"rooms">;
  previous: {
    startsAt?: number;
    endsAt?: number;
    roomId?: Id<"rooms">;
  };
};

export type ApplyPlanResult = {
  placed: Array<{ sessionId: Id<"sessions">; title: string }>;
  unplaced: UnplacedSession[];
  /** The audit row this run wrote — what `undoPlacement` takes. */
  runId: Id<"auditLog">;
};

function samePlacement(
  a: { startsAt: number; endsAt: number; roomId?: Id<"rooms"> },
  b: { startsAt: number; endsAt: number; roomId?: Id<"rooms"> },
): boolean {
  return (
    a.startsAt === b.startsAt && a.endsAt === b.endsAt && a.roomId === b.roomId
  );
}

function planStale(message: string): never {
  throw new ConvexError({ code: "plan_stale", message });
}

/**
 * Apply exactly one previewed plan.
 *
 * The plan is re-derived from current state first. If the board moved under
 * the organizer — anything the planner reads changed — the write is refused
 * with a message rather than silently placing sessions somewhere the preview
 * never showed. `submitted` is compared against the fresh plan and the FRESH
 * plan is what gets written, so a doctored payload cannot place anything the
 * planner would not.
 */
export async function applySchedule(
  ctx: MutationCtx,
  caller: EventCaller,
  submitted: {
    fingerprint: string;
    placements: Array<{
      sessionId: Id<"sessions">;
      startsAt: number;
      endsAt: number;
      roomId?: Id<"rooms">;
    }>;
  },
): Promise<ApplyPlanResult> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const fresh = buildPlan(await plannerInput(ctx, caller.event));

  const stale =
    "The board changed since this suggestion was made, so it was not applied. Suggest a schedule again to see the current plan.";
  if (fresh.fingerprint !== submitted.fingerprint) planStale(stale);
  if (fresh.placements.length !== submitted.placements.length) planStale(stale);
  for (let i = 0; i < fresh.placements.length; i += 1) {
    const mine = fresh.placements[i];
    const theirs = submitted.placements[i];
    if (mine.sessionId !== theirs.sessionId || !samePlacement(mine, theirs)) {
      planStale(stale);
    }
  }

  const records: PlacementRecord[] = [];
  const placed: ApplyPlanResult["placed"] = [];
  for (const placement of fresh.placements) {
    const session = await ctx.db.get("sessions", placement.sessionId);
    if (session === null || session.eventId !== caller.event._id) {
      planStale(stale);
    }
    records.push({
      sessionId: placement.sessionId,
      startsAt: placement.startsAt,
      endsAt: placement.endsAt,
      roomId: placement.roomId,
      previous: {
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        roomId: session.roomId,
      },
    });
    await ctx.db.patch("sessions", placement.sessionId, {
      startsAt: placement.startsAt,
      endsAt: placement.endsAt,
      roomId: placement.roomId,
    });
    placed.push({ sessionId: placement.sessionId, title: placement.title });
  }

  const runId = await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "agenda.autoPlace",
    targetType: "event",
    targetId: caller.event._id,
    // The placement set is what makes this run undoable — the audit row is
    // the record of what changed, so it carries enough to change it back.
    meta: {
      placed: placed.length,
      unplaced: fresh.unplaced.length,
      placements: records,
    },
  });

  return { placed, unplaced: fresh.unplaced, runId };
}

/**
 * `auditLog.meta` is `v.any()` at rest, so what comes back is untyped data,
 * not a `PlacementRecord[]`. Casting it and indexing straight into a patch
 * would turn a malformed or hand-edited row into a TypeError — or worse, a
 * half-applied undo that patched the well-formed prefix and then threw.
 *
 * So: validate the whole set first, return null on ANYTHING unexpected, and
 * let the caller refuse cleanly. `undefined` (a run recorded before undo
 * existed) is a valid empty set, not a malformed one.
 */
function parsePlacementRecords(
  ctx: MutationCtx,
  meta: unknown,
): PlacementRecord[] | null {
  if (meta === undefined || meta === null) return [];
  if (typeof meta !== "object") return null;
  const raw = (meta as { placements?: unknown }).placements;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;

  const time = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const optionalTime = (value: unknown): number | null | undefined =>
    value === undefined ? undefined : time(value);
  // Ids are validated as ids of the right table, not merely as strings, so a
  // doctored row cannot aim the undo at another table's document.
  const roomId = (value: unknown): Id<"rooms"> | null | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return null;
    return ctx.db.normalizeId("rooms", value);
  };

  const out: PlacementRecord[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.sessionId !== "string") return null;
    const sessionId = ctx.db.normalizeId("sessions", e.sessionId);
    if (sessionId === null) return null;
    const startsAt = time(e.startsAt);
    const endsAt = time(e.endsAt);
    if (startsAt === null || endsAt === null) return null;
    const room = roomId(e.roomId);
    if (room === null) return null;
    if (e.previous !== undefined && typeof e.previous !== "object") return null;
    const previous = (e.previous ?? {}) as Record<string, unknown>;
    if (previous === null) return null;
    const prevStart = optionalTime(previous.startsAt);
    const prevEnd = optionalTime(previous.endsAt);
    if (prevStart === null || prevEnd === null) return null;
    const prevRoom = roomId(previous.roomId);
    if (prevRoom === null) return null;
    out.push({
      sessionId,
      startsAt,
      endsAt,
      roomId: room,
      previous: {
        startsAt: prevStart,
        endsAt: prevEnd,
        roomId: prevRoom,
      },
    });
  }
  // A record naming a session outside this event still can't move anything:
  // the undo loop re-checks `session.eventId` per record before patching.
  return out;
}

export type UndoPlacementResult = {
  reverted: number;
  /** Placements left alone because the session was edited after the run. */
  skipped: number;
  message: string;
};

/**
 * Put back exactly what one assisted-placement run wrote.
 *
 * A session is only reverted while it still holds the values that run gave
 * it: anything an organizer moved by hand afterwards is theirs, and an undo
 * that clobbered a manual edit would be a worse bug than no undo at all.
 */
export async function undoPlacement(
  ctx: MutationCtx,
  caller: EventCaller,
  runId: Id<"auditLog">,
): Promise<UndoPlacementResult> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const row = await ctx.db.get("auditLog", runId);
  if (
    row === null ||
    row.eventId !== caller.event._id ||
    row.action !== "agenda.autoPlace"
  ) {
    notFound("placement run", "No such assisted-placement run on this event.");
  }
  const records = parsePlacementRecords(ctx, row.meta);
  if (records === null) {
    throw new ConvexError({
      code: "not_undoable",
      message:
        "This run's record can't be read back, so nothing was changed. Adjust the placements on the board instead.",
    });
  }
  if (records.length === 0) {
    throw new ConvexError({
      code: "not_undoable",
      message:
        "This run was recorded before placements could be undone, so there is nothing to put back.",
    });
  }

  let reverted = 0;
  let skipped = 0;
  for (const record of records) {
    const session = await ctx.db.get("sessions", record.sessionId);
    if (session === null || session.eventId !== caller.event._id) {
      skipped += 1;
      continue;
    }
    if (
      session.startsAt !== record.startsAt ||
      session.endsAt !== record.endsAt ||
      session.roomId !== record.roomId
    ) {
      skipped += 1;
      continue;
    }
    await ctx.db.patch("sessions", record.sessionId, {
      startsAt: record.previous.startsAt,
      endsAt: record.previous.endsAt,
      roomId: record.previous.roomId,
    });
    reverted += 1;
  }

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "agenda.autoPlace.undo",
    targetType: "event",
    targetId: caller.event._id,
    meta: { runId, reverted, skipped },
  });

  return {
    reverted,
    skipped,
    message:
      skipped === 0
        ? `${reverted} ${reverted === 1 ? "session is" : "sessions are"} back where ${reverted === 1 ? "it" : "they"} started.`
        : `${reverted} ${reverted === 1 ? "session" : "sessions"} put back. ${skipped} left alone — ${skipped === 1 ? "it was" : "they were"} moved by hand after the suggestion was applied.`,
  };
}
