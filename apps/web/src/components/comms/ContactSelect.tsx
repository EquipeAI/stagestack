import { useMemo } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Id } from '@convex/_generated/dataModel'
import { Select } from '~/ds'

// One deduped list of the event's speakers, keyed by the id every comms
// function actually takes (`eventContactId`).
//
// `sessions.list` is the source rather than `tasks.dashboard` because the
// dashboard takes a ticking `now`, and a picker that re-subscribes every
// minute would blank its own options for no reason.

export type CommsContact = {
  eventContactId: Id<'eventContacts'>
  name: string
  state: 'awaiting' | 'confirmed' | 'declined' | 'withdrawn'
  sessionCount: number
}

/** `undefined` while the underlying query is still loading. */
export function useEventContacts(
  eventSlug: string,
): Array<CommsContact> | undefined {
  const sessions = useQuery(api.sessions.list, { eventSlug })

  return useMemo(() => {
    if (sessions === undefined) return undefined
    const byContact = new Map<Id<'eventContacts'>, CommsContact>()
    for (const row of sessions) {
      for (const participant of row.participants) {
        const existing = byContact.get(participant.eventContactId)
        if (existing !== undefined) {
          existing.sessionCount += 1
          continue
        }
        byContact.set(participant.eventContactId, {
          eventContactId: participant.eventContactId,
          name:
            `${participant.firstName} ${participant.lastName}`.trim() ||
            'Unnamed speaker',
          state: participant.state,
          sessionCount: 1,
        })
      }
    }
    return [...byContact.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [sessions])
}

const STATE_SUFFIX: Record<CommsContact['state'], string> = {
  awaiting: 'Awaiting Response',
  confirmed: 'Confirmed',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}

export function ContactSelect({
  id,
  contacts,
  value,
  disabled,
  placeholder = 'Choose a speaker…',
  onChange,
}: {
  id: string
  contacts: Array<CommsContact>
  value: string
  disabled?: boolean
  placeholder?: string
  onChange: (eventContactId: string) => void
}) {
  const options = [
    { value: '', label: placeholder },
    ...contacts.map((contact) => ({
      value: contact.eventContactId,
      label: `${contact.name} — ${STATE_SUFFIX[contact.state]}`,
    })),
  ]
  return (
    <Select
      id={id}
      value={value}
      options={options}
      disabled={disabled}
      onChange={(e) => {
        onChange(e.target.value)
      }}
    />
  )
}
