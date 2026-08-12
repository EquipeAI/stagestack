import { describe, expect, it } from 'vitest'
import {
  LAUNCH_STEPS,
  blankDraft,
  emptyDraft,
  scorecardFromDrafts,
  stepProblem,
  stepProgressLabel,
} from './launchFlow'
import type { StepFacts } from './launchFlow'

// The flow's gates, tested without a DOM. Each of these mirrors a validator in
// convex/model/reviews.ts — when one drifts, the backend still refuses, but
// the organizer finds out seven steps later, which is the failure this file
// exists to prevent.

const OK: StepFacts = {
  opens: null,
  closes: null,
  poolSize: 2,
  selectedCount: 3,
  perProposal: '1',
}

describe('stepProblem', () => {
  it('lets a well-formed draft through every step', () => {
    const draft = { ...emptyDraft(), name: 'First pass' }
    for (const step of LAUNCH_STEPS) {
      expect(stepProblem(step.id, draft, OK)).toBeNull()
    }
  })

  it('names the round before anything else', () => {
    expect(stepProblem('basics', emptyDraft(), OK)).toBe(
      'The round needs a name.',
    )
  })

  it('refuses a window that closes before it opens, and an unreadable one', () => {
    const draft = { ...emptyDraft(), name: 'First pass' }
    expect(
      stepProblem('basics', draft, { ...OK, opens: 2_000, closes: 1_000 }),
    ).toBe('The round must close after it opens.')
    expect(
      stepProblem('basics', draft, { ...OK, closes: 'unreadable' }),
    ).toBe('The close date is unreadable.')
  })

  it('refuses a cap that is not a whole number of at least 1', () => {
    const draft = { ...emptyDraft(), name: 'First pass', reviewerCap: '0' }
    expect(stepProblem('basics', draft, OK)).toBe(
      'The per-reviewer cap must be a whole number, at least 1.',
    )
  })

  it('refuses an empty scorecard, an unlabelled criterion and bad bounds', () => {
    const named = { ...emptyDraft(), name: 'First pass' }
    expect(stepProblem('scorecard', { ...named, criteria: [] }, OK)).toBe(
      'The scorecard needs at least one criterion.',
    )
    expect(
      stepProblem('scorecard', { ...named, criteria: [blankDraft()] }, OK),
    ).toBe('Every criterion needs a label.')
    expect(
      stepProblem(
        'scorecard',
        {
          ...named,
          criteria: [{ ...blankDraft(), label: 'Score', min: '5', max: '1' }],
        },
        OK,
      ),
    ).toBe('"Score" needs whole-number bounds with max above min.')
  })

  it('refuses an empty pool, an empty selection and a nonsense policy', () => {
    const draft = { ...emptyDraft(), name: 'First pass' }
    expect(stepProblem('reviewers', draft, { ...OK, poolSize: 0 })).toBe(
      'Add at least one reviewer to this round.',
    )
    expect(stepProblem('proposals', draft, { ...OK, selectedCount: 0 })).toBe(
      'Select at least one proposal for this round.',
    )
    expect(stepProblem('policy', draft, { ...OK, perProposal: '0' })).toBe(
      'Reviews per proposal must be a whole number, at least 1.',
    )
  })
})

describe('scorecardFromDrafts', () => {
  it('requires two dropdown options, like the backend does', () => {
    expect(
      scorecardFromDrafts([
        { ...blankDraft(), label: 'Verdict', kind: 'dropdown', options: 'Yes' },
      ]),
    ).toEqual({ problem: '"Verdict" needs at least two dropdown options.' })
  })

  it('refuses duplicate criterion ids', () => {
    const one = { ...blankDraft(), id: 'score', label: 'Score' }
    expect(scorecardFromDrafts([one, { ...one, label: 'Score again' }])).toEqual(
      { problem: 'Criterion ids must be unique.' },
    )
  })
})

describe('stepProgressLabel', () => {
  it('says where you are in words', () => {
    expect(stepProgressLabel(0)).toBe('Step 1 of 7 · Basics')
    expect(stepProgressLabel(6)).toBe('Step 7 of 7 · Launch')
  })
})
