import type { ViewId } from './model'

// The agenda route's URL vocabulary. Extracted from the route file (W8) so a
// deep link into a particular board view can be asserted against the same
// parser the route validates with, rather than against a copy of it.

export const AGENDA_VIEWS: ReadonlyArray<ViewId> = [
  'list',
  'day',
  'week',
  'track',
  'room',
]

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
/** Column keys are Convex ids or the two synthetic ones ("noroom"/"notrack"),
 * so anything with a separator or whitespace in it is not one. */
const COLUMN_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * `room` scopes the grid to ONE column — a roomId in the Room view, a trackId
 * in the Track view, or the synthetic "noroom"/"notrack". It is one parameter
 * rather than two because a board only ever has one column axis at a time, and
 * the phone picker that writes it is the same control in both views.
 */
export type AgendaSearch = { view: ViewId; day?: string; room?: string }

/** Route-level validateSearch: an unknown view falls back to the default. */
export function parseAgendaSearch(
  input: Record<string, unknown>,
): AgendaSearch {
  const rawView = input.view
  const view =
    typeof rawView === 'string' &&
    (AGENDA_VIEWS as ReadonlyArray<string>).includes(rawView)
      ? (rawView as ViewId)
      : 'room'
  const rawDay = input.day
  const day =
    typeof rawDay === 'string' && DAY_RE.test(rawDay) ? rawDay : undefined
  const rawRoom = input.room
  // A column that no longer exists is dropped by the board, not here: the
  // parser cannot know this event's rooms, and a stale link must still resolve.
  const room =
    typeof rawRoom === 'string' && COLUMN_RE.test(rawRoom) ? rawRoom : undefined
  return { view, day, room }
}
