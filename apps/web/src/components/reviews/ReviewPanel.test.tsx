import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reviewPanelKey } from './model'
import type { Assignment } from './model'
import type { Id } from '@convex/_generated/dataModel'

const mutation = vi.hoisted(() => vi.fn(() => Promise.resolve(null)))

vi.mock('convex/react', () => ({
  // Only the draft mutation is exercised here; sharing the spy keeps the
  // component test independent of generated FunctionReference identity.
  useMutation: () => mutation,
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { ReviewPanel } from './ReviewPanel'

function assignment(contentVersion: number): Assignment {
  return {
    reviewId: 'review-1' as Id<'reviews'>,
    contentVersion,
    status: 'assigned',
    answers: {},
    round: {
      roundId: null,
      name: 'Initial Review',
      anonymized: false,
      scorecard: [
        {
          id: 'score',
          label: 'Score',
          kind: 'numeric',
          min: 1,
          max: 5,
          required: true,
        },
      ],
    },
    proposal: {
      _id: 'proposal-1' as Id<'proposals'>,
      title: 'Taming 40-Minute CI',
      answers: {},
      fields: [],
      fileUrls: {},
      speakers: [],
    },
  }
}

afterEach(() => {
  cleanup()
  mutation.mockClear()
})

describe('ReviewPanel proposal-content fence', () => {
  it('remounts revised content while a queued old autosave keeps its old version', async () => {
    const opened = assignment(0)
    const view = render(
      <ReviewPanel
        key={reviewPanelKey(opened)}
        eventSlug="devflow-conf"
        assignment={opened}
        archived={false}
        isLastUnfinished
        onCommitted={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '4' }))
    expect(mutation).not.toHaveBeenCalled()

    const revised = assignment(1)
    view.rerender(
      <ReviewPanel
        key={reviewPanelKey(revised)}
        eventSlug="devflow-conf"
        assignment={revised}
        archived={false}
        isLastUnfinished
        onCommitted={() => {}}
      />,
    )

    // The old component flushes its pending value on unmount, but cannot
    // masquerade as a review of the newly rendered proposal revision.
    await waitFor(() => {
      expect(mutation).toHaveBeenCalledWith({
        eventSlug: 'devflow-conf',
        reviewId: opened.reviewId,
        expectedContentVersion: 0,
        answers: { score: 4 },
      })
    })
    expect(screen.getByRole('button', { name: '4' }).getAttribute('aria-pressed')).toBe(
      'false',
    )
  })
})
