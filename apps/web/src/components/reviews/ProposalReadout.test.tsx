import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ProposalReadout } from './ProposalReadout'
import type { Id } from '@convex/_generated/dataModel'
import type { Assignment } from './model'

afterEach(cleanup)

function assignment(anonymized: boolean): Assignment {
  return {
    reviewId: 'review-1' as Id<'reviews'>,
    contentVersion: 0,
    status: 'assigned',
    answers: {},
    round: {
      roundId: 'round-1' as Id<'reviewRounds'>,
      name: anonymized ? 'Blind Round' : 'Open Round',
      anonymized,
      scorecard: [],
    },
    proposal: {
      _id: 'proposal-1' as Id<'proposals'>,
      title: 'A proposal title',
      answers: anonymized
        ? { 'session-context': 'Session-only evaluation context.' }
        : {
            'speaker-bio-profile': 'A professional profile answer.',
            'session-context': 'Session-only evaluation context.',
          },
      fields: anonymized
        ? [
            {
              id: 'session-context',
              label: 'Speaker bio',
              kind: 'textarea',
            },
          ]
        : [
            {
              id: 'speaker-bio-profile',
              label: 'Speaker bio',
              kind: 'textarea',
            },
            {
              id: 'session-context',
              label: 'Speaker bio',
              kind: 'textarea',
            },
          ],
      fileUrls: {},
      // Deliberately over-complete: the blind renderer must not trust this
      // secondary identity surface even though the backend also returns [].
      speakers: [
        {
          firstName: 'Named',
          lastName: 'Speaker',
          tagline: 'Principal Engineer at Identified Company',
          bio: 'Professional identity details.',
        },
      ],
    },
  }
}

describe('ProposalReadout blind review', () => {
  it('renders the structurally filtered proposal and never paints speaker identity', () => {
    render(<ProposalReadout assignment={assignment(true)} />)

    expect(screen.getByText('Session-only evaluation context.')).toBeTruthy()
    expect(screen.getByText('Blind review')).toBeTruthy()
    expect(screen.queryByText('Named Speaker')).toBeNull()
    expect(screen.queryByText(/Identified Company/)).toBeNull()
    expect(screen.queryByText('Professional identity details.')).toBeNull()
  })

  it('preserves professional identity and identity-section answers outside blind mode', () => {
    render(<ProposalReadout assignment={assignment(false)} />)

    expect(screen.getByText('Named Speaker')).toBeTruthy()
    expect(screen.getByText(/Identified Company/)).toBeTruthy()
    expect(screen.getByText('Professional identity details.')).toBeTruthy()
    expect(screen.getByText('A professional profile answer.')).toBeTruthy()
  })
})
