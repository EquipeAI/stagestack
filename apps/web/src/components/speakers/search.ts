import type { ParticipantState } from '~/lib/labels'

// The speaker roster's URL vocabulary (W8). The parser moved to
// `convex/shared/viewParams.ts` in W2 so a stored saved view and this route
// validate through one function.

export { parseSpeakersSearch } from '@convex/shared/viewParams'
export type { SpeakersSearch } from '@convex/shared/viewParams'

/** A row matches when ANY of its participations is in the filtered state. */
export function matchesState(
  sessions: ReadonlyArray<{ state: ParticipantState }>,
  state: ParticipantState | undefined,
): boolean {
  if (state === undefined) return true
  return sessions.some((s) => s.state === state)
}
