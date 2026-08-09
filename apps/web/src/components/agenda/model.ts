import { DateTime } from 'luxon'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '@convex/_generated/api'
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
export const MIN_BLOCK_PX = 26
export const TIME_GUTTER_PX = 60
export const MIN_COL_PX = 168

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

/** Round a duration-preserving placement so a dropped block keeps its length. */
export function durationOf(block: PlacedBlock): number {
  const d = block.endsAt - block.startsAt
  return d > 0 ? d : DEFAULT_DURATION_MS
}
