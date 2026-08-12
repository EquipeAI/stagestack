import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { getFunctionName } from 'convex/server'

// The facts panel is the one producer of what the product says about reminder
// automation, and it must say it in EVENT time with the zone labelled — the
// task page used to render a browser-local clock with no zone at all.

const NOW = Date.parse('2026-08-10T09:05:00Z')

const { state } = vi.hoisted(() => ({
  state: {
    facts: undefined as Record<string, unknown> | undefined,
    status: undefined as Record<string, unknown> | undefined,
  },
}))

vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref)
    if (name === 'reminders:reminderFacts') return state.facts
    if (name === 'reminders:automationStatus') return state.status
    return undefined
  },
  useMutation: () => vi.fn(),
}))

vi.mock('~/lib/useNow', () => ({ useNow: () => NOW }))

// eslint-disable-next-line import/first -- vi.mock is hoisted above this
import { nextSweepAt } from '@convex/shared/reminderSchedule'
// eslint-disable-next-line import/first
import { ReminderFactsPanel } from './ReminderFactsPanel'
// eslint-disable-next-line import/first
import { formatDateTime } from '~/lib/datetime'

afterEach(cleanup)

function setUp(overrides: Record<string, unknown> = {}) {
  state.facts = {
    enabled: true,
    cadenceDays: null,
    evaluationIntervalHours: 1,
    sweepMinuteUtc: 20,
    safetyCadenceDays: 1,
    lastAutomaticAt: null,
    lastManualAt: null,
    lastManualAttemptAt: null,
    manualLookupTruncated: false,
    nextEligibleAt: null,
    trackedTasks: 0,
    quietAfter: Date.parse('2026-09-01T00:00:00Z'),
    ...overrides,
  }
  state.status = {
    enabled: true,
    cadenceDays: state.facts.cadenceDays,
    nextEvaluationAt: nextSweepAt(NOW),
    evaluationIntervalHours: 1,
    sweepMinuteUtc: 20,
    safetyCadenceDays: 1,
    disabledReason: null,
    quietAfter: state.facts.quietAfter,
  }
}

describe('ReminderFactsPanel', () => {
  test('renders the next evaluation in event time, with the zone labelled', () => {
    setUp()
    const zone = 'Asia/Tokyo'
    render(<ReminderFactsPanel eventSlug="devconf" timezone={zone} />)
    const expected = formatDateTime(nextSweepAt(NOW), zone)
    // 18:20 JST, not 09:20 UTC, and the zone is part of the string.
    expect(expected).toContain('18:20')
    expect(document.body.textContent).toContain(expected)
    expect(document.body.textContent).not.toContain(
      formatDateTime(nextSweepAt(NOW), 'UTC'),
    )
  })

  test('states all six facts', () => {
    setUp({
      cadenceDays: 7,
      lastAutomaticAt: Date.parse('2026-08-10T08:20:00Z'),
      lastManualAt: Date.parse('2026-08-09T11:00:00Z'),
      lastManualAttemptAt: Date.parse('2026-08-09T11:00:00Z'),
      nextEligibleAt: Date.parse('2026-08-12T00:00:00Z'),
      trackedTasks: 3,
    })
    render(<ReminderFactsPanel eventSlug="devconf" timezone="UTC" />)
    for (const term of [
      'Automatic reminders',
      'Evaluation interval',
      'Cadence floor',
      'Last automatic evaluation',
      'Last manual send',
      'Next eligible',
    ]) {
      expect(screen.getByText(term)).toBeTruthy()
    }
    expect(document.body.textContent).toContain('every 7 days')
    expect(document.body.textContent).toContain('3 tasks are tracked')
  })

  test('an archived event says so instead of predicting a run', () => {
    setUp({ enabled: false, quietAfter: null })
    state.status = {
      ...state.status,
      enabled: false,
      nextEvaluationAt: null,
      disabledReason: 'archived',
      quietAfter: null,
    }
    render(<ReminderFactsPanel eventSlug="devconf" timezone="UTC" />)
    expect(document.body.textContent).toContain('archived')
    expect(document.body.textContent).toContain('no longer evaluated')
  })

  test('past the post-event grace window it reports the quiet state, not a run', () => {
    setUp()
    state.status = {
      ...state.status,
      enabled: false,
      nextEvaluationAt: null,
      disabledReason: 'postEvent',
    }
    render(<ReminderFactsPanel eventSlug="devconf" timezone="UTC" />)
    // Named as the post-event window, not misreported as archiving.
    expect(document.body.textContent).toContain('after an event ends')
    expect(document.body.textContent).not.toContain('this event is archived')
    expect(document.body.textContent).toContain('no longer chased')
  })

  test('a running event says when chasing will stop', () => {
    setUp()
    render(<ReminderFactsPanel eventSlug="devconf" timezone="UTC" />)
    expect(document.body.textContent).toContain('chasing stops after')
  })

  test('a manual attempt that reached nobody is not reported as a send', () => {
    setUp({
      lastManualAt: null,
      lastManualAttemptAt: Date.parse('2026-08-09T11:00:00Z'),
    })
    render(<ReminderFactsPanel eventSlug="devconf" timezone="UTC" />)
    expect(document.body.textContent).toContain(
      'No manual reminder has been accepted',
    )
    expect(document.body.textContent).toContain('reached nobody')
  })

  test('a later failed attempt is shown alongside the last real send', () => {
    setUp({
      lastManualAt: Date.parse('2026-08-08T11:00:00Z'),
      lastManualAttemptAt: Date.parse('2026-08-09T11:00:00Z'),
    })
    render(<ReminderFactsPanel eventSlug="devconf" timezone="UTC" />)
    expect(document.body.textContent).toContain('a later attempt')
    expect(document.body.textContent).toContain('reached nobody')
  })

  test('a truncated manual lookup does not claim "never"', () => {
    setUp({ manualLookupTruncated: true })
    render(<ReminderFactsPanel eventSlug="devconf" timezone="UTC" />)
    expect(document.body.textContent).toContain('recent activity')
    expect(document.body.textContent).not.toContain('Never — no reminder')
  })
})
