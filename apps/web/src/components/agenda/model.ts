import { DateTime } from 'luxon'
import {
  boardSpeakerIds,
  candidateConflicts,
  boardScheduledThings as sharedBoardScheduledThings,
} from '@convex/shared/agenda'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '@convex/_generated/api'
import type { Conflict, ScheduledThing } from '@convex/shared/agenda'
import type { Id } from '@convex/_generated/dataModel'

// The agenda board's read model (M6). The list/day/week/track/room views are
// all client-side projections of ONE `api.agenda.board` subscription, so every
// type here descends from that single query and the views can never disagree
// about what is scheduled or what collides.

export type Board = FunctionReturnType<typeof api.agenda.board>
export type BoardEvent = Board['event']
export type BoardRoom = Board['rooms'][number]
export type BoardTrack = Board['tracks'][number]
export type BoardSession = Board['sessions'][number]
export type BoardAgendaItem = Board['agendaItems'][number]
export type BoardParticipant = BoardSession['participants'][number]
export type BoardConflict = BoardSession['conflicts'][number]

export type ViewId = 'list' | 'day' | 'week' | 'track' | 'room'

export const VIEW_LABEL: Record<ViewId, string> = {
  list: 'List',
  day: 'Day',
  week: 'Week',
  track: 'Track',
  room: 'Room',
}

export const VIEW_ICON: Record<ViewId, string> = {
  list: 'list-filter',
  day: 'calendar-days',
  week: 'columns-3',
  track: 'layout-grid',
  room: 'presentation',
}

// ── Grid geometry ──────────────────────────────────────────────────────────
// Pixels are numbers, never string literals — the design-system adherence lint
// forbids raw `px` in string form, so every dimension is interpolated.

/** Drag placements snap to this increment. */
export const SNAP_MIN = 15
/** A tray card dropped onto the grid gets this long unless it already had a
 * duration to keep. */
export const DEFAULT_DURATION_MS = 60 * 60 * 1000
export const HOUR_MS = 60 * 60 * 1000
export const MIN_MS = 60 * 1000
/** One hour of wall-clock time is this tall. */
export const HOUR_PX = 64
/**
 * The floor a block's drawn height is clamped to. At HOUR_PX = 64 this is 26px
 * — the height of a block just under 25 minutes long — so anything shorter is
 * drawn taller than it really is and says so (`BlockCard`'s overflow mark).
 * Without a floor a 10-minute lightning talk is 10px tall: its own title does
 * not fit, let alone its time.
 */
export const MIN_BLOCK_PX = 26
/** Durations at or below this are drawn clamped (see MIN_BLOCK_PX). */
export const CLAMPED_BELOW_MS = (MIN_BLOCK_PX / HOUR_PX) * HOUR_MS
export const TIME_GUTTER_PX = 60
export const MIN_COL_PX = 168
/** W6's coarse-pointer target floor, applied to one 15-minute slot. */
export const SLOT_TAP_PX = 44
/**
 * The grid's hour height WHILE a session is armed for tap-to-place. A slot on
 * the ordinary grid is 16px tall, which is a fine drop target for a pointer
 * already holding a block and an impossible one for a thumb — so arming
 * tap-to-place zooms the time axis until one 15-minute slot is a 44px target.
 * The lattice itself is unchanged: same slots, same ids, same snap.
 */
export const HOUR_PX_PLACING = SLOT_TAP_PX * (60 / SNAP_MIN)

// ── Time helpers (event timezone is authoritative) ─────────────────────────

/** 'yyyy-MM-dd' for the wall-clock day `ms` falls on in `zone`. */
export function dayKey(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat('yyyy-MM-dd')
}

/** Epoch ms of the start of `key`'s day in `zone`. */
export function dayStartMs(key: string, zone: string): number {
  return DateTime.fromISO(key, { zone }).startOf('day').toMillis()
}

/** Every wall-clock day the event spans, inclusive, as 'yyyy-MM-dd'. */
export function eventDayKeys(event: BoardEvent): Array<string> {
  const start = DateTime.fromMillis(event.startsAt, {
    zone: event.timezone,
  }).startOf('day')
  const end = DateTime.fromMillis(event.endsAt, {
    zone: event.timezone,
  }).startOf('day')
  const out: Array<string> = []
  let cursor = start
  // Guard against a pathological range; an event is a handful of days.
  for (let i = 0; i < 60 && cursor <= end; i += 1) {
    out.push(cursor.toFormat('yyyy-MM-dd'))
    cursor = cursor.plus({ days: 1 })
  }
  return out.length > 0 ? out : [start.toFormat('yyyy-MM-dd')]
}

export function dayLabel(key: string, zone: string): string {
  const dt = DateTime.fromISO(key, { zone })
  return dt.isValid ? dt.toFormat('ccc d LLL') : key
}

export function shortDayLabel(key: string, zone: string): string {
  const dt = DateTime.fromISO(key, { zone })
  return dt.isValid ? dt.toFormat('ccc d') : key
}

/** "09:00" in the event zone. */
export function clockLabel(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat('HH:mm')
}

/** "09:00 – 10:00" in the event zone, no date. */
export function slotClock(startsAt: number, endsAt: number, zone: string) {
  return `${clockLabel(startsAt, zone)} – ${clockLabel(endsAt, zone)}`
}

export type HourRange = { startHour: number; endHour: number }

/**
 * The vertical extent of the grid: wide enough for the event's own hours and
 * for anything already scheduled outside them (a 07:00 setup block is real).
 */
export function hourRange(
  event: BoardEvent,
  blocks: ReadonlyArray<{ startsAt: number; endsAt: number }>,
): HourRange {
  const zone = event.timezone
  let min = 24
  let max = 0
  const seeStart = (ms: number) => {
    const dt = DateTime.fromMillis(ms, { zone })
    min = Math.min(min, dt.hour + dt.minute / 60)
  }
  const seeEnd = (ms: number) => {
    const dt = DateTime.fromMillis(ms, { zone })
    max = Math.max(max, dt.hour + dt.minute / 60)
  }
  seeStart(event.startsAt)
  seeEnd(event.endsAt)
  for (const block of blocks) {
    seeStart(block.startsAt)
    seeEnd(block.endsAt)
  }
  if (min >= max) {
    return { startHour: 8, endHour: 19 }
  }
  return {
    startHour: Math.max(0, Math.floor(min)),
    endHour: Math.min(24, Math.ceil(max)),
  }
}

// ── Unified placed block ───────────────────────────────────────────────────
// Sessions and agenda items share the grid; a single shape lets one block
// component render both, with `session`/`item` carrying the kind-specific rest.

export type PlacedBlock = {
  kind: 'session' | 'item'
  id: string
  title: string
  startsAt: number
  endsAt: number
  roomId?: Id<'rooms'>
  trackId?: Id<'tracks'>
  conflicts: Array<BoardConflict>
  session?: BoardSession
  item?: BoardAgendaItem
}

export function sessionBlock(session: BoardSession): PlacedBlock {
  return {
    kind: 'session',
    id: session.sessionId,
    title: session.title,
    startsAt: session.startsAt ?? 0,
    endsAt: session.endsAt ?? 0,
    roomId: session.roomId,
    trackId: session.trackId,
    conflicts: session.conflicts,
    session,
  }
}

export function itemBlock(item: BoardAgendaItem): PlacedBlock {
  return {
    kind: 'item',
    id: item.itemId,
    title: item.title,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    roomId: item.roomId,
    conflicts: item.conflicts,
    item,
  }
}

/** Every block with a placement (sessions that have a time, plus all items). */
export function placedBlocks(board: Board): Array<PlacedBlock> {
  const out: Array<PlacedBlock> = []
  for (const session of board.sessions) {
    if (session.startsAt !== undefined && session.endsAt !== undefined) {
      out.push(sessionBlock(session))
    }
  }
  for (const item of board.agendaItems) {
    out.push(itemBlock(item))
  }
  return out
}

/** Sessions with no start time — the unscheduled tray. */
export function traySessions(board: Board): Array<BoardSession> {
  return board.sessions.filter((s) => s.startsAt === undefined)
}

// ── Conflicts ──────────────────────────────────────────────────────────────

export function blockerConflicts(
  conflicts: ReadonlyArray<BoardConflict>,
): Array<BoardConflict> {
  return conflicts.filter((c) => c.level === 'blocker')
}

export function hasBlocker(conflicts: ReadonlyArray<BoardConflict>): boolean {
  return conflicts.some((c) => c.level === 'blocker')
}

export function hasWarning(conflicts: ReadonlyArray<BoardConflict>): boolean {
  return conflicts.some((c) => c.level === 'warning')
}

// ── Release state ──────────────────────────────────────────────────────────

export type ReleaseState =
  | { kind: 'unscheduled' }
  | { kind: 'notReleased' }
  | { kind: 'released'; sequence: number }
  | { kind: 'pending'; sequence: number }

export function releaseState(session: BoardSession): ReleaseState {
  const scheduled = session.startsAt !== undefined
  if (session.releasedSlot === undefined) {
    return scheduled ? { kind: 'notReleased' } : { kind: 'unscheduled' }
  }
  const sequence = session.releasedSlot.sequence
  return session.pendingRelease
    ? { kind: 'pending', sequence }
    : { kind: 'released', sequence }
}

/** Label + Badge tone for a session's release state. Badge tones only — release
 * is not one of the fixed workflow states StatusPill owns. */
export function releaseBadge(state: ReleaseState): {
  label: string
  tone: 'neutral' | 'info' | 'success' | 'attention' | 'blocked' | 'brand' | 'agent'
} {
  switch (state.kind) {
    case 'unscheduled':
      return { label: 'Unscheduled', tone: 'neutral' }
    case 'notReleased':
      return { label: 'Not released', tone: 'neutral' }
    case 'released':
      return { label: `Released v${state.sequence}`, tone: 'success' }
    case 'pending':
      return { label: 'Draft differs from released', tone: 'attention' }
  }
}

// ── Acknowledgement ────────────────────────────────────────────────────────

export type AckValue = NonNullable<BoardParticipant['ack']>

export const ACK_LABEL: Record<AckValue, string> = {
  awaitingAck: 'Awaiting Acknowledgement',
  acknowledged: 'Acknowledged',
  conflict: 'Conflict',
}

// State labels live in ~/lib/labels — re-exported here so agenda views keep
// importing their vocabulary from the agenda model.
export { PARTICIPANT_STATE_LABEL } from '~/lib/labels'

export function participantName(p: {
  firstName: string
  lastName: string
}): string {
  return `${p.firstName} ${p.lastName}`.trim() || 'Unnamed contact'
}

/** Participants who still count toward the schedule (not withdrawn/declined). */
export function activeParticipants(
  session: BoardSession,
): Array<BoardParticipant> {
  return session.participants.filter(
    (p) => p.state !== 'withdrawn' && p.state !== 'declined',
  )
}

// ── Drag id encoding ───────────────────────────────────────────────────────
// Draggable id = `<kind>:<id>`; a droppable slot id = `slot|<columnKey>|<ms>`.
// The tray is a single droppable, id `tray`.

export const TRAY_DROPPABLE = 'tray'

export function draggableId(block: {
  kind: 'session' | 'item'
  id: string
}): string {
  return `${block.kind}:${block.id}`
}

export function parseDraggableId(
  raw: string,
): { kind: 'session' | 'item'; id: string } | null {
  const idx = raw.indexOf(':')
  if (idx < 0) return null
  const kind = raw.slice(0, idx)
  if (kind !== 'session' && kind !== 'item') return null
  return { kind, id: raw.slice(idx + 1) }
}

export function slotDroppableId(columnKey: string, ms: number): string {
  return `slot|${columnKey}|${ms}`
}

export function parseSlotDroppableId(
  raw: string,
): { columnKey: string; ms: number } | null {
  if (!raw.startsWith('slot|')) return null
  const rest = raw.slice('slot|'.length)
  const idx = rest.lastIndexOf('|')
  if (idx < 0) return null
  const ms = Number(rest.slice(idx + 1))
  if (!Number.isFinite(ms)) return null
  return { columnKey: rest.slice(0, idx), ms }
}

/**
 * How long a block should be once placed: the length it already has, else the
 * session's resolved duration (override → format default, W2), else an hour.
 *
 * The middle case is the one that matters: a tray card has no interval at all,
 * so before W13 every dragged Lightning Talk landed as a 60-minute block.
 */
export function durationOf(block: PlacedBlock): number {
  const d = block.endsAt - block.startsAt
  if (d > 0) return d
  return block.session === undefined
    ? DEFAULT_DURATION_MS
    : sessionDurationMs(block.session)
}

/** A session's block length in ms — `durationMinutes` is resolved server-side
 * (override → format default → 60), so DEFAULT_DURATION_MS is only ever the
 * fallback for a projection that predates it. */
export function sessionDurationMs(session: BoardSession): number {
  const minutes = session.durationMinutes
  return typeof minutes === 'number' && minutes > 0
    ? minutes * MIN_MS
    : DEFAULT_DURATION_MS
}

// ── Client-side eligibility (W13) ──────────────────────────────────────────
// The board asks the SHARED conflict engine (convex/shared/agenda.ts) whether
// a placement WOULD be legal, so a highlighted cell and the backend's answer
// cannot disagree. Everything below is pure and bounded to what is on screen.

export type { Conflict, ScheduledThing } from '@convex/shared/agenda'

/**
 * The board projection as conflict-engine input — the client half of the
 * server's `toScheduledThings`. Delegates to the shared adapter so the
 * withdrawn/declined participant filter (`counts()` in convex/model/agenda.ts)
 * has exactly one implementation.
 */
export function boardScheduledThings(board: Board): Array<ScheduledThing> {
  return sharedBoardScheduledThings(board)
}

/** Every 15-minute slot start on one grid column, in order. The lattice the
 * droppables are built from — shared with TimeGrid so an eligibility map and
 * the cells it colours can never be computed from two different walks. */
export function columnSlotTimes(
  day: string,
  hours: HourRange,
  zone: string,
): Array<number> {
  const base = dayStartMs(day, zone) + hours.startHour * HOUR_MS
  const span = Math.max(1, hours.endHour - hours.startHour)
  const count = (span * 60) / SNAP_MIN
  return Array.from({ length: count }, (_, i) => base + i * SNAP_MIN * MIN_MS)
}

/**
 * Which room a drop or tap on `columnKey` means. Only the Room view rewrites
 * the room; every other grid keeps whatever the block already had.
 */
export function roomForColumn(
  view: ViewId,
  columnKey: string,
  current: Id<'rooms'> | undefined,
): Id<'rooms'> | undefined {
  if (view !== 'room') return current
  return columnKey === 'noroom' ? undefined : (columnKey as Id<'rooms'>)
}

export type SlotEligibility = Map<string, Array<Conflict>>

/**
 * The conflicts a candidate placement of `session` would have, for every
 * VISIBLE cell of the scoped view — keyed by the cell's droppable id, so the
 * grid colours exactly the lattice it drops onto.
 *
 * Bounded by construction: columns on screen × slots in the visible hour range.
 * A cell with no entry is impossible; a cell whose entry has no blocker is
 * eligible (a same-track warning is still a legal placement).
 */
export function eligibleSlots(args: {
  board: Board
  session: BoardSession
  view: ViewId
  columns: ReadonlyArray<{ key: string; dayKey: string }>
  hours: HourRange
  zone: string
}): SlotEligibility {
  const { board, session, view, columns, hours, zone } = args
  const duration = sessionDurationMs(session)
  const speakerIds = boardSpeakerIds(session)
  // A session being re-placed must not collide with the placement it is
  // leaving; the tray case has nothing to exclude.
  const things = boardScheduledThings(board).filter(
    (thing) => thing.id !== (session.sessionId as string),
  )
  const out: SlotEligibility = new Map()
  for (const column of columns) {
    const roomId = roomForColumn(view, column.key, session.roomId)
    for (const startsAt of columnSlotTimes(column.dayKey, hours, zone)) {
      out.set(
        slotDroppableId(column.key, startsAt),
        candidateConflicts(things, {
          type: 'session',
          id: session.sessionId,
          title: session.title,
          startsAt,
          endsAt: startsAt + duration,
          roomId,
          trackId: session.trackId,
          speakerIds,
        }),
      )
    }
  }
  return out
}

/** A cell is placeable unless something non-overridable sits in it. */
export function slotIsEligible(conflicts: ReadonlyArray<Conflict>): boolean {
  return !conflicts.some((c) => c.level === 'blocker')
}

// ── The one placement request ──────────────────────────────────────────────

/**
 * What the board sends when a block lands somewhere — from a drop, from an
 * arrow-key drop, or from a tap on a highlighted slot. All three build this
 * and hand it to the same submit, so "tap to place" cannot drift from "drag to
 * place": there is one request shape and one caller of each mutation.
 */
export type PlacementRequest =
  | {
      kind: 'session'
      sessionId: Id<'sessions'>
      slot: { startsAt: number; endsAt: number; roomId?: Id<'rooms'> } | null
    }
  | {
      kind: 'item'
      itemId: Id<'agendaItems'>
      patch: { startsAt: number; endsAt: number; roomId?: Id<'rooms'> }
    }

/** The request for landing `block` at `ms` on `columnKey` in `view`. */
export function placementRequest(args: {
  view: ViewId
  block: PlacedBlock
  columnKey: string
  ms: number
}): PlacementRequest {
  const { view, block, columnKey, ms } = args
  const startsAt = ms
  const endsAt = startsAt + durationOf(block)
  const roomId = roomForColumn(view, columnKey, block.roomId)
  return block.kind === 'session'
    ? {
        kind: 'session',
        sessionId: block.id as Id<'sessions'>,
        slot: { startsAt, endsAt, roomId },
      }
    : {
        kind: 'item',
        itemId: block.id as Id<'agendaItems'>,
        patch: { startsAt, endsAt, roomId },
      }
}
