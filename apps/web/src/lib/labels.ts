import type { Doc } from '@convex/_generated/dataModel'

// Vocabulary shared by every surface that names a backend state. One table of
// labels so the portal, the agenda and the session roster can never disagree
// about what a state is called.

export type ParticipantState = Doc<'sessionParticipants'>['state']

/** The product's fixed vocabulary — StatusPill maps these to tones. */
export const PARTICIPANT_STATE_LABEL: Record<ParticipantState, string> = {
  awaiting: 'Awaiting Response',
  confirmed: 'Confirmed',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}
