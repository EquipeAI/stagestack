import type { FunctionReturnType } from 'convex/server'
import type { api } from '@convex/_generated/api'

// The speaker portal's read model (M3). `sessions.previewPortalContext`
// returns exactly this shape plus the previewed speaker's name, so every view
// under components/portal renders unchanged in preview — only `readOnly`
// differs.

export type PortalContext = FunctionReturnType<typeof api.portal.context>
export type SpeakingItem = PortalContext['speaking'][number]
export type ManagingItem = PortalContext['managing'][number]
export type ManagedParticipant = ManagingItem['participants'][number]
export type PortalProfile = SpeakingItem['eventContact']
export type ParticipantState = SpeakingItem['state']

/** The product's fixed vocabulary — StatusPill maps these to tones. */
export const PARTICIPANT_STATE_LABEL: Record<ParticipantState, string> = {
  awaiting: 'Awaiting Response',
  confirmed: 'Confirmed',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}

export function personName(person: {
  firstName: string
  lastName: string
}): string {
  return `${person.firstName} ${person.lastName}`.trim()
}

/** Blank collapses to absent: the backend clears a field that arrives empty. */
export function optionalText(value: string): string | undefined {
  const text = value.trim()
  return text.length > 0 ? text : undefined
}

/**
 * One profile editor per distinct snapshot. The same person can hold several
 * participations on one event (two sessions, one contact row) — editing the
 * same profile twice on one page would be two forms fighting over one row.
 */
export function distinctProfiles(
  speaking: Array<SpeakingItem>,
): Array<PortalProfile> {
  const seen = new Set<string>()
  const out: Array<PortalProfile> = []
  for (const item of speaking) {
    if (seen.has(item.eventContact._id)) continue
    seen.add(item.eventContact._id)
    out.push(item.eventContact)
  }
  return out
}

/** Sessions attached to one claimed snapshot — shown inside its profile card. */
export function sessionsForProfile(
  speaking: Array<SpeakingItem>,
  profileId: string,
): Array<SpeakingItem> {
  return speaking.filter((item) => item.eventContact._id === profileId)
}
