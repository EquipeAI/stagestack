import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { getFunctionName } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'

// The guided launch flow (W11).
//
// What these tests hold:
//   • one step is on screen at a time, and Next is gated by the step that
//     owns the problem;
//   • the draft survives moving between steps, and leaving warns;
//   • every sentence on the summary and on the outcome comes from the server
//     verbatim — this component composes no consequence of its own;
//   • "Preview as reviewer" paints the server's blind projection, and no
//     identity the server withheld can appear in it.

const { state, mutations } = vi.hoisted(() => ({
  state: {
    pool: [] as Array<{ userId: string; name: string; email: string }>,
    reviewerPreview: null as Record<string, unknown> | null,
  },
  mutations: {
    'reviews:createRound': vi.fn(() => Promise.resolve('round-1')),
    'reviews:updateRound': vi.fn(() => Promise.resolve(null)),
    'reviews:deleteRound': vi.fn(() => Promise.resolve(null)),
    'reviews:launchRound': vi.fn(() =>
      Promise.resolve({
        assigned: 2,
        unplaced: 0,
        perReviewer: [
          { userId: 'user-1', name: 'Sam Whitfield', assigned: 2, total: 2 },
        ],
        sentences: [
          '2 assignments created across 2 selected proposals.',
          '2 proposals assigned to Sam Whitfield — 2 in this round in total.',
        ],
      }),
    ),
    'reviews:addRoundReviewer': vi.fn(() => Promise.resolve(null)),
    'reviews:removeRoundReviewer': vi.fn(() => Promise.resolve(null)),
  } as Record<string, ReturnType<typeof vi.fn>>,
}))

const SUMMARY_SENTENCES = [
  '2 proposals will be assigned to Sam Whitfield.',
  'Both already have released decisions; those decisions will not change.',
  'Reviewer identities are hidden: speaker names and every identity answer are removed from what reviewers see.',
  'Cap: 2 proposals per reviewer.',
]

const ELIGIBLE = [
  {
    proposalId: 'proposal-1',
    title: 'Taming 40-Minute CI',
    status: 'accepted',
    assigned: 0,
    decisionReleased: true,
  },
  {
    proposalId: 'proposal-2',
    title: 'Convex in anger',
    status: 'declined',
    assigned: 0,
    decisionReleased: true,
  },
]

const BLIND_PREVIEW = {
  roundId: 'round-1',
  roundName: 'First pass',
  anonymized: true,
  scorecard: [],
  proposal: {
    _id: 'proposal-1',
    title: 'Taming 40-Minute CI',
    // The server already removed the identity section; the payload the
    // component receives simply does not carry it.
    answers: { 'session-context': 'Session-only evaluation context.' },
    fields: [
      { id: 'session-context', label: 'Session context', kind: 'textarea' },
    ],
    fileUrls: {},
    speakers: [],
  },
  hiddenFieldLabels: ['Speaker bio'],
  hiddenSpeakerCount: 1,
}

vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args?: unknown) => {
    if (args === 'skip') return undefined
    const name = getFunctionName(ref)
    if (name === 'reviews:listRounds') {
      return [
        {
          roundId: 'round-1',
          name: 'First pass',
          order: 0,
          anonymized: true,
          reviewerCap: 2,
          scorecard: [
            { id: 'score', label: 'Score', kind: 'numeric', required: true },
          ],
          draft: false,
          pool: state.pool,
        },
      ]
    }
    if (name === 'reviews:eligibleProposals') return ELIGIBLE
    if (name === 'reviews:reviewerPreview') return state.reviewerPreview
    if (name === 'reviews:launchPreview') {
      return {
        fingerprint: 'abc123',
        roundId: 'round-1',
        roundName: 'First pass',
        anonymized: true,
        reviewerCap: 2,
        perProposal: 1,
        poolSize: 1,
        candidateCount: 2,
        newAssignments: 2,
        unplaced: 0,
        alreadyCovered: 0,
        decidedCount: 2,
        perReviewer: [
          { userId: 'user-1', name: 'Sam Whitfield', assigned: 2, total: 2 },
        ],
        sentences: SUMMARY_SENTENCES,
      }
    }
    return undefined
  },
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref)
    return mutations[name] ?? vi.fn(() => Promise.resolve(null))
  },
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { RoundLaunchFlow } from './RoundLaunchFlow'

const MEMBERS = [
  {
    userId: 'user-1' as Id<'users'>,
    name: 'Sam Whitfield',
    email: 'sam@example.com',
    role: 'reviewer' as const,
  },
]

function renderFlow(
  overrides: { onOpenProgress?: () => void; onClose?: () => void } = {},
) {
  return render(
    <RoundLaunchFlow
      eventSlug="devconf"
      timezone="UTC"
      round={null}
      // The team list carries more than this in production; the flow only
      // reads what PoolEditor needs.
      members={MEMBERS as never}
      onClose={overrides.onClose ?? (() => {})}
      onOpenProgress={overrides.onOpenProgress ?? (() => {})}
    />,
  )
}

/** Walk to a step by driving the real Next button, as an organizer would. */
async function advanceTo(step: string) {
  for (let guard = 0; guard < 10; guard += 1) {
    if (document.querySelector(`[data-step="${step}"]`) !== null) return
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByText(/^Step \d of 7/)).toBeTruthy()
    })
  }
  throw new Error(`never reached step ${step}`)
}

beforeEach(() => {
  state.pool = [
    { userId: 'user-1', name: 'Sam Whitfield', email: 'sam@example.com' },
  ]
  state.reviewerPreview = BLIND_PREVIEW
  for (const spy of Object.values(mutations)) spy.mockClear()
})

afterEach(cleanup)

describe('RoundLaunchFlow step progression', () => {
  it('shows exactly one step at a time and refuses Next until the step is valid', async () => {
    renderFlow()

    // One step per screen — the mobile layout is the same DOM.
    expect(document.querySelectorAll('[data-step]')).toHaveLength(1)
    expect(screen.getByText('Step 1 of 7 · Basics')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('The round needs a name.')).toBeTruthy()
    expect(screen.getByText('Step 1 of 7 · Basics')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'First pass' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByText('Step 2 of 7 · Scorecard')).toBeTruthy()
    })
    expect(document.querySelectorAll('[data-step]')).toHaveLength(1)
  })

  it('keeps the draft when stepping back and forth', async () => {
    renderFlow()
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Second pass' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByText('Step 2 of 7 · Scorecard')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe(
      'Second pass',
    )
  })

  it('persists the round once the scorecard is settled, and blocks an empty pool', async () => {
    state.pool = []
    renderFlow()
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'First pass' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(screen.getByText('Step 2 of 7 · Scorecard')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => {
      expect(mutations['reviews:createRound']).toHaveBeenCalledTimes(1)
    })
    // Materialized as a DRAFT: it governs no review work until the launch.
    expect(mutations['reviews:createRound'].mock.calls[0][0]).toMatchObject({
      draft: true,
    })
    await waitFor(() => {
      expect(screen.getByText('Step 3 of 7 · Reviewers')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(
      screen.getByText('Add at least one reviewer to this round.'),
    ).toBeTruthy()
  })

  it('warns before abandoning unsaved answers, and stays put on Keep editing', () => {
    const onClose = vi.fn()
    renderFlow({ onClose })
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'First pass' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByText('Leave the launch flow?')).toBeTruthy()
    expect(
      screen.getByText(/not saved yet, and leaving discards them/),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByText('Leave the launch flow?')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers to delete the round the flow itself created', async () => {
    renderFlow()
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'First pass' },
    })
    await advanceTo('reviewers')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(
      screen.getByText(/exists as a DRAFT round/),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete the round' }))
    await waitFor(() => {
      expect(mutations['reviews:deleteRound']).toHaveBeenCalledTimes(1)
    })
  })
})

describe('RoundLaunchFlow preview and summary', () => {
  it('paints the server projection for a blind round without any withheld identity', async () => {
    renderFlow()
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'First pass' },
    })
    await advanceTo('preview')

    expect(
      screen.getByText(
        'This is exactly what a reviewer sees in this blind round',
      ),
    ).toBeTruthy()
    expect(screen.getByText(/Speaker bio/)).toBeTruthy()
    expect(screen.getByText('Session-only evaluation context.')).toBeTruthy()
    // The blind readout: no speaker card, and nothing the server removed.
    expect(screen.getByText('Blind review')).toBeTruthy()
    expect(screen.queryByText('Sam Whitfield')).toBeNull()
    expect(screen.queryByText(/Speaker0/)).toBeNull()
  })

  it('prints the summary sentences verbatim and launches the previewed plan', async () => {
    const onOpenProgress = vi.fn()
    renderFlow({ onOpenProgress })
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'First pass' },
    })
    await advanceTo('summary')

    for (const sentence of SUMMARY_SENTENCES) {
      expect(screen.getByText(sentence)).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('button', { name: 'Launch round' }))
    await waitFor(() => {
      expect(mutations['reviews:launchRound']).toHaveBeenCalledTimes(1)
    })
    // The fingerprint from the preview is what the launch echoes back.
    expect(mutations['reviews:launchRound'].mock.calls[0][0]).toMatchObject({
      fingerprint: 'abc123',
      roundId: 'round-1',
    })

    // The outcome explains itself, in the mutation's own words.
    await waitFor(() => {
      expect(
        screen.getByText('2 assignments created across 2 selected proposals.'),
      ).toBeTruthy()
    })
    expect(
      screen.getByText(
        '2 proposals assigned to Sam Whitfield — 2 in this round in total.',
      ),
    ).toBeTruthy()

    // Success lands on the per-reviewer progress dashboard.
    fireEvent.click(
      screen.getByRole('button', { name: 'Open reviewer progress' }),
    )
    expect(onOpenProgress).toHaveBeenCalledTimes(1)
  })

  it('states the zero outcome as a sentence rather than a count', async () => {
    mutations['reviews:launchRound'].mockResolvedValueOnce({
      assigned: 0,
      unplaced: 0,
      perReviewer: [],
      sentences: [
        'No new assignments: both selected proposals are already assigned.',
      ],
    })
    renderFlow()
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'First pass' },
    })
    await advanceTo('summary')
    fireEvent.click(screen.getByRole('button', { name: 'Launch round' }))

    await waitFor(() => {
      expect(
        screen.getByText(
          'No new assignments: both selected proposals are already assigned.',
        ),
      ).toBeTruthy()
    })
    expect(screen.queryByText('Assigned 0 · unplaced 0')).toBeNull()
    // An idempotent re-launch did everything that was asked for: nothing was
    // left unplaced, so this is a success, not a partial.
    expect(document.querySelector('.ss-callout--success')).not.toBeNull()
    expect(document.querySelector('.ss-callout--attention')).toBeNull()
  })

  it('is partial only when a slot could not be filled', async () => {
    mutations['reviews:launchRound'].mockResolvedValueOnce({
      assigned: 1,
      unplaced: 1,
      perReviewer: [],
      sentences: [
        '1 assignment created across 2 selected proposals.',
        '1 review slot cannot be filled — every eligible reviewer is already at the cap.',
      ],
    })
    renderFlow()
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'First pass' },
    })
    await advanceTo('summary')
    fireEvent.click(screen.getByRole('button', { name: 'Launch round' }))

    await waitFor(() => {
      expect(
        screen.getByText('1 assignment created across 2 selected proposals.'),
      ).toBeTruthy()
    })
    expect(document.querySelector('.ss-callout--attention')).not.toBeNull()
  })
})

describe('RoundLaunchFlow leaving', () => {
  it('arms the warning on a proposal-selection change, not only on the form', async () => {
    // A fresh flow over an EXISTING round: nothing is typed and nothing is
    // created here, so only the selection can make it dirty.
    render(
      <RoundLaunchFlow
        eventSlug="devconf"
        timezone="UTC"
        round={
          {
            roundId: 'round-1',
            name: 'First pass',
            order: 0,
            anonymized: true,
            reviewerCap: 2,
            scorecard: [
              { id: 'score', label: 'Score', kind: 'numeric', required: true },
            ],
            draft: false,
            pool: state.pool,
          } as never
        }
        members={MEMBERS as never}
        onClose={() => {}}
        onOpenProgress={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Leave the launch flow?')).toBeNull()

    await advanceTo('proposals')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Leave the launch flow?')).toBeTruthy()
  })

  it('intercepts a tab switch rather than being unmounted silently', async () => {
    const held: { guard: ((proceed: () => void) => boolean) | null } = {
      guard: null,
    }
    render(
      <RoundLaunchFlow
        eventSlug="devconf"
        timezone="UTC"
        round={null}
        members={MEMBERS as never}
        onClose={() => {}}
        onOpenProgress={() => {}}
        registerLeaveGuard={(fn) => {
          held.guard = fn
        }}
      />,
    )
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'First pass' },
    })
    await advanceTo('reviewers')

    const proceed = vi.fn()
    const guard = held.guard
    if (guard === null) throw new Error('the flow registered no leave guard')
    // The route asks first; the flow takes the navigation over.
    let intercepted = false
    act(() => {
      intercepted = guard(proceed)
    })
    expect(intercepted).toBe(true)
    expect(proceed).not.toHaveBeenCalled()
    expect(screen.getByText(/exists as a DRAFT round/)).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', { name: 'Leave, keep as a draft' }),
    )
    expect(proceed).toHaveBeenCalledTimes(1)
  })
})
