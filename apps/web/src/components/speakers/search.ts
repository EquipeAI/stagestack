import type { ParticipantState } from '~/lib/labels'

// The speaker roster's URL vocabulary (W8): the free-text search that already
// existed, plus a participation filter so "3 speakers have not answered their
// invitation" can land on exactly those three.

const STATES: ReadonlyArray<ParticipantState> = [
  'awaiting',
  'confirmed',
  'declined',
  'withdrawn',
]

export type SpeakersSearch = { q?: string; state?: ParticipantState }

/** Route-level validateSearch: unknown params are dropped, never trusted. */
export function parseSpeakersSearch(
  input: Record<string, unknown>,
): SpeakersSearch {
  const out: SpeakersSearch = {}
  const q = input.q
  if (typeof q === 'string' && q !== '') out.q = q.slice(0, 200)
  const state = input.state
  if (
    typeof state === 'string' &&
    (STATES as ReadonlyArray<string>).includes(state)
  ) {
    out.state = state as ParticipantState
  }
  return out
}

/** A row matches when ANY of its participations is in the filtered state. */
export function matchesState(
  sessions: ReadonlyArray<{ state: ParticipantState }>,
  state: ParticipantState | undefined,
): boolean {
  if (state === undefined) return true
  return sessions.some((s) => s.state === state)
}
