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

export type AgendaSearch = { view: ViewId; day?: string }

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
  return { view, day }
}
