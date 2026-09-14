import type { Doc, Id } from "../_generated/dataModel";

// The conflict engine, shared (W13).
//
// This code used to live in `convex/model/agenda.ts` and moved here VERBATIM:
// it is pure — no ctx, no db, no wall clock — and the phone board needs to ask
// "would this placement be legal?" about cells that do not exist yet. Moving it
// (rather than re-deriving eligibility in TSX) is what makes the board,
// `buildPlan`/`applySchedule`, the release gate and the readiness dashboard
// agree by construction instead of by careful maintenance. Same precedent as
// `formDef`, `scorecard`, `importPlan`, `bulkDecisions` and `jobTypes`.
//
// `Id<...>` erases to `string` at runtime, so importing the generated data
// model here costs the client nothing but keeps the server's types exact.

export type ConflictKind = "room" | "speaker" | "track";
/** Speaker/room collisions are non-overridable for release and publication;
 * same-track overlap is a warning the organizer may accept (MILESTONES M6). */
export type ConflictLevel = "blocker" | "warning";
export type ScheduledKind = "session" | "agendaItem";

export type Conflict = {
  kind: ConflictKind;
  level: ConflictLevel;
  /** The other block involved, so the board can highlight both ends. */
  withType: ScheduledKind;
  withId: string;
  withTitle: string;
  message: string;
};

export type ScheduledThing = {
  type: ScheduledKind;
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  roomId?: Id<"rooms">;
  trackId?: Id<"tracks">;
  /** Speakers who still count — withdrawn/declined participants can't collide. */
  speakerIds: Array<Id<"eventContacts">>;
};

/** Half-open [start, end): back-to-back blocks do NOT overlap. */
export function overlaps(
  a: { startsAt: number; endsAt: number },
  b: { startsAt: number; endsAt: number },
): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

/**
 * Every collision on the board, keyed by block id. Pairwise over the placed
 * blocks — an event's schedule is hundreds of rows, not millions, and keeping
 * it pure means the same function answers for the board, the release gate and
 * the readiness dashboard.
 */
export function conflictsFor(
  things: ReadonlyArray<ScheduledThing>,
): Map<string, Conflict[]> {
  const out = new Map<string, Conflict[]>();
  const push = (id: string, conflict: Conflict): void => {
    const list = out.get(id) ?? [];
    list.push(conflict);
    out.set(id, list);
  };
  const pair = (
    a: ScheduledThing,
    b: ScheduledThing,
    kind: ConflictKind,
    level: ConflictLevel,
    message: (other: ScheduledThing) => string,
  ): void => {
    push(a.id, {
      kind,
      level,
      withType: b.type,
      withId: b.id,
      withTitle: b.title,
      message: message(b),
    });
    push(b.id, {
      kind,
      level,
      withType: a.type,
      withId: a.id,
      withTitle: a.title,
      message: message(a),
    });
  };

  for (let i = 0; i < things.length; i += 1) {
    for (let j = i + 1; j < things.length; j += 1) {
      const a = things[i];
      const b = things[j];
      if (!overlaps(a, b)) continue;

      if (a.roomId !== undefined && a.roomId === b.roomId) {
        pair(a, b, "room", "blocker", (o) => `Same room as "${o.title}".`);
      }
      if (a.speakerIds.some((id) => b.speakerIds.includes(id))) {
        pair(
          a,
          b,
          "speaker",
          "blocker",
          (o) => `The same speaker is booked on "${o.title}".`,
        );
      }
      if (a.trackId !== undefined && a.trackId === b.trackId) {
        pair(a, b, "track", "warning", (o) => `Same track as "${o.title}".`);
      }
    }
  }
  return out;
}

export function blockers(conflicts: ReadonlyArray<Conflict>): Conflict[] {
  return conflicts.filter((c) => c.level === "blocker");
}

/**
 * Conflicts for ONE candidate placement — the question the phone board asks of
 * every visible cell before it highlights it, and the question `buildPlan` asks
 * of every cell in its walk.
 *
 * Restricted to the blocks the candidate actually overlaps before handing them
 * to `conflictsFor`: collisions only ever arise between overlapping pairs, so
 * this is the same answer the whole-board call gives — `conflictsFor` stays the
 * single producer of what blocks what.
 */
export function candidateConflicts(
  things: ReadonlyArray<ScheduledThing>,
  candidate: ScheduledThing,
): Conflict[] {
  const overlapping = things.filter((thing) => overlaps(thing, candidate));
  if (overlapping.length === 0) return [];
  return conflictsFor([...overlapping, candidate]).get(candidate.id) ?? [];
}

// ── Board projection → ScheduledThing ────────────────────────────────────
//
// The server flattens Convex DOCUMENTS into ScheduledThings (`toScheduledThings`
// in convex/model/agenda.ts, which needs `Doc<>` and therefore stays there).
// The client holds the `api.agenda.board` PROJECTION instead, which already
// carries every field the conflict engine reads. This is that adapter, and it
// lives beside the engine so the participant filter below cannot drift from
// `counts()` — the one rule the projection does not pre-apply.

/** The subset of a board session the conflict engine reads. Structural on
 * purpose: `BoardSession` (convex/model/agenda.ts) and the client's
 * `FunctionReturnType` view of it both satisfy this without either side
 * importing the other. */
/** `sessionParticipants.state` (convex/schema.ts), DERIVED from the schema
 * rather than spelled out: a rename there breaks this filter loudly at compile
 * time instead of silently letting a withdrawn speaker start colliding again —
 * the same "rename breaks loudly" guarantee, with one less hand-kept literal
 * union to drift. */
export type ParticipantState = Doc<"sessionParticipants">["state"];

export type BoardSessionLike = {
  sessionId: Id<"sessions">;
  title: string;
  trackId?: Id<"tracks">;
  startsAt?: number;
  endsAt?: number;
  roomId?: Id<"rooms">;
  participants: ReadonlyArray<{
    eventContactId: Id<"eventContacts">;
    state: ParticipantState;
  }>;
};

export type BoardAgendaItemLike = {
  itemId: Id<"agendaItems">;
  title: string;
  startsAt: number;
  endsAt: number;
  roomId?: Id<"rooms">;
};

/** Participants that can be double-booked — the client half of `counts()`
 * (convex/model/agenda.ts). Withdrawn and declined speakers hold no slot, so
 * they can never collide with one. */
export function participantCounts(participant: {
  state: ParticipantState;
}): boolean {
  return participant.state !== "withdrawn" && participant.state !== "declined";
}

/**
 * The board's placed blocks as conflict-engine input. `boardData` already
 * dropped cancelled sessions, so the only filter left is "has a placement".
 */
export function boardScheduledThings(board: {
  sessions: ReadonlyArray<BoardSessionLike>;
  agendaItems: ReadonlyArray<BoardAgendaItemLike>;
}): ScheduledThing[] {
  const things: ScheduledThing[] = [];
  for (const session of board.sessions) {
    if (session.startsAt === undefined || session.endsAt === undefined) continue;
    things.push({
      type: "session",
      id: session.sessionId,
      title: session.title,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      roomId: session.roomId,
      trackId: session.trackId,
      speakerIds: session.participants
        .filter(participantCounts)
        .map((p) => p.eventContactId),
    });
  }
  for (const item of board.agendaItems) {
    things.push({
      type: "agendaItem",
      id: item.itemId,
      title: item.title,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      roomId: item.roomId,
      speakerIds: [],
    });
  }
  return things;
}

/** The speakers a session contributes to a CANDIDATE placement — the same
 * filter, for a session that is not on the board yet (the tray). */
export function boardSpeakerIds(
  session: BoardSessionLike,
): Array<Id<"eventContacts">> {
  return session.participants
    .filter(participantCounts)
    .map((p) => p.eventContactId);
}
