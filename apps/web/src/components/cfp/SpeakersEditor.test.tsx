import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SpeakersEditor,
  emptySpeaker,
  speakersFromDocs,
  speakersToInput,
} from './SpeakersEditor'
import type { Doc, Id } from '@convex/_generated/dataModel'

function speakerDoc(
  id: string,
  firstName: string,
  isPrimary: boolean,
): Doc<'proposalSpeakers'> {
  return {
    _id: id as Id<'proposalSpeakers'>,
    _creationTime: 1,
    proposalId: 'proposal-1' as Id<'proposals'>,
    eventId: 'event-1' as Id<'events'>,
    order: isPrimary ? 0 : 1,
    firstName,
    lastName: 'Speaker',
    isPrimary,
  }
}

afterEach(cleanup)

describe('SpeakersEditor accepted revision identities', () => {
  it('round-trips persisted proposal speaker ids in the resubmit payload', () => {
    const docs = [
      speakerDoc('speaker-existing', 'Priya', true),
      speakerDoc('speaker-coauthor', 'Marcus', false),
    ]

    expect(speakersToInput(speakersFromDocs(docs))).toEqual([
      expect.objectContaining({ proposalSpeakerId: docs[0]._id }),
      expect.objectContaining({ proposalSpeakerId: docs[1]._id }),
    ])
  })

  it('disables removal only for materialized speakers and explains organizer withdrawal', () => {
    const existing = speakersFromDocs([
      speakerDoc('speaker-existing', 'Priya', true),
      speakerDoc('speaker-coauthor', 'Marcus', false),
    ])
    const newSpeaker = {
      ...emptySpeaker(false),
      firstName: 'New',
      lastName: 'Coauthor',
    }
    render(
      <SpeakersEditor
        speakers={[...existing, newSpeaker]}
        onChange={() => {}}
        lockExistingRemoval
      />,
    )

    expect(
      screen.getByText(/can only be withdrawn by an organizer/i),
    ).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Remove Priya Speaker',
      }).disabled,
    ).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Remove New Coauthor',
      }).disabled,
    ).toBe(false)
  })
})
