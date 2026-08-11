import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getFunctionName } from 'convex/server'
import type { Doc, Id } from '@convex/_generated/dataModel'

const state = vi.hoisted((): { status: Doc<'proposals'>['status'] } => ({
  status: 'accepted',
}))

vi.mock('convex/react', () => ({
  useMutation: () => vi.fn(() => Promise.resolve(null)),
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref)
    if (name === 'cfp:getProposalDetail') {
      return {
        proposal: {
          _id: 'proposal-1' as Id<'proposals'>,
          _creationTime: 1,
          eventId: 'event-1' as Id<'events'>,
          submitterUserId: 'user-1' as Id<'users'>,
          status: state.status,
          title: 'Taming 40-Minute CI',
          answers: {},
          formVersion: 1,
          submittedAt: 1,
          updatedAt: 1,
        },
        speakers: [],
        submitter: { name: 'Priya Raman', email: 'priya@example.com' },
        fileUrls: {},
      }
    }
    if (name === 'reviews:summary') {
      return {
        aggregate: {
          count: 0,
          submittedCount: 0,
          conflictCount: 0,
          avgScore: null,
          recommendations: { accept: 0, decline: 0, neutral: 0 },
        },
        reviews: [],
      }
    }
    return undefined
  },
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { ProposalDetailDialog } from './ProposalDetailDialog'

const event = {
  _id: 'event-1' as Id<'events'>,
  _creationTime: 1,
  orgId: 'org-1' as Id<'organizations'>,
  name: 'DevFlow Conf 2027',
  slug: 'devflow-conf-2027-2',
  startsAt: Date.parse('2027-05-01T09:00:00Z'),
  endsAt: Date.parse('2027-05-02T17:00:00Z'),
  timezone: 'UTC',
  cfpPublished: true,
} as Doc<'events'>

afterEach(() => {
  cleanup()
  state.status = 'accepted'
})

describe('ProposalDetailDialog reopen control', () => {
  it('offers an accepted proposal an explicit revision window without hiding correction', () => {
    render(
      <ProposalDetailDialog
        eventSlug={event.slug}
        event={event}
        proposalId={'proposal-1' as Id<'proposals'>}
        def={null}
        onClose={() => {}}
      />,
    )

    expect(screen.getAllByText('Reopen editing').length).toBeGreaterThan(0)
    expect(screen.getByText(/released acceptance stays in place/i)).toBeTruthy()
    expect(screen.getByText('Correct to Declined')).toBeTruthy()
  })

  it('keeps declined proposals correction-only', () => {
    state.status = 'declined'
    render(
      <ProposalDetailDialog
        eventSlug={event.slug}
        event={event}
        proposalId={'proposal-1' as Id<'proposals'>}
        def={null}
        onClose={() => {}}
      />,
    )

    expect(screen.queryByText('Reopen editing')).toBeNull()
    expect(screen.getByText('Correct to Accepted')).toBeTruthy()
  })

  it('hides reopening for an archived event while preserving correction history', () => {
    render(
      <ProposalDetailDialog
        eventSlug={event.slug}
        event={{ ...event, archivedAt: Date.now() }}
        proposalId={'proposal-1' as Id<'proposals'>}
        def={null}
        onClose={() => {}}
      />,
    )

    expect(screen.queryByText('Reopen editing')).toBeNull()
    expect(screen.getByText('Correct to Declined')).toBeTruthy()
  })
})
