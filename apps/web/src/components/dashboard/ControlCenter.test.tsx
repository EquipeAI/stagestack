import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConvexError } from 'convex/values'
import { getFunctionName } from 'convex/server'

// The control center (W8): one screen, four questions.
//
// What these tests hold:
//   • the four panels render, and every sentence on screen comes from the
//     model layer verbatim — this file never re-words a count;
//   • a count is a deep link into already-filtered work;
//   • a PANEL that refuses (`event_too_large`) contains its own failure, and
//     the other three questions still get answered;
//   • the first-event checklist and the returning-event summary are one
//     decision, made once.

const { state, navigate } = vi.hoisted(() => ({
  navigate: vi.fn(),
  state: {
    firstEvent: false,
    dashboardThrows: false,
    attentionThrows: false,
    turnaroundThrows: false,
  },
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

const ATTENTION_PANEL = {
  rows: [
    {
      id: 'cfp',
      label: 'Call for speakers',
      count: 2,
      capped: false,
      sentence:
        'The call for speakers closes in 6 days; 2 submissions are waiting for a decision.',
      tone: 'attention',
      link: { tab: 'proposals', search: { status: 'pending' } },
    },
    {
      id: 'decisions',
      label: 'Decisions staged',
      count: 3,
      capped: false,
      sentence:
        '3 staged decisions have not been released, so nobody has been told yet.',
      tone: 'attention',
      link: {
        tab: 'proposals',
        search: { status: 'acceptQueue,declineQueue' },
      },
    },
  ],
  firstEvent: false,
  checklist: [
    {
      id: 'setup',
      label: 'Set up the event',
      state: 'todo',
      sentence:
        'Add a location and a description so the public page can say what this is.',
      action: { label: 'Open settings', link: { tab: 'settings' } },
    },
    {
      id: 'cfp',
      label: 'Open the call for speakers',
      state: 'todo',
      sentence: 'Build the submission form and publish it.',
      action: { label: 'Open the CFP builder', link: { tab: 'cfp' } },
    },
  ],
  capped: false,
}

const DASHBOARD = {
  speakers: [],
  sessions: [],
  totals: {
    confirmed: 1,
    awaiting: 0,
    declined: 0,
    withdrawn: 0,
    acceptedSpeakers: 1,
    missingProfile: 0,
    overdue: 0,
  },
  blockers: {
    contentDrafts: 4,
    unscheduled: 0,
    scheduleConflicts: 0,
    blockedSessions: 0,
    rows: [
      {
        id: 'contentDrafts',
        label: 'Content still in Draft',
        count: 4,
        capped: false,
        sentence:
          '4 sessions are held out of the public program until the content is approved.',
        tone: 'blocked',
        link: { tab: 'sessions', search: { content: 'draft' } },
      },
      {
        id: 'unscheduled',
        label: 'Sessions unscheduled',
        count: 0,
        capped: false,
        sentence: 'Every planned session has a released slot.',
        tone: 'success',
        link: { tab: 'agenda', search: { view: 'list' } },
      },
      {
        id: 'scheduleConflicts',
        label: 'Schedule conflicts',
        count: 0,
        capped: false,
        sentence: 'No session collides with another.',
        tone: 'success',
        link: { tab: 'agenda', search: { view: 'room' } },
      },
    ],
  },
}

const CHANGES = {
  rows: [
    {
      auditId: 'audit1',
      at: 1_700_000_000_000,
      actor: 'Jordan Alvarez',
      viaAgent: false,
      action: 'decision.release',
      sentence: 'Jordan Alvarez released a decision.',
      link: { tab: 'proposals' },
    },
    {
      auditId: 'audit2',
      at: 1_700_000_000_000,
      actor: 'Jordan Alvarez',
      viaAgent: false,
      action: 'quantum.entangleSchedule',
      sentence:
        'Jordan Alvarez performed a recorded action: quantum entangle schedule.',
      link: null,
    },
  ],
  capped: false,
}

const UP_NEXT = {
  milestones: [
    {
      id: 'cfpCloses',
      label: 'Call for speakers closes',
      at: 1_700_000_000_000,
      past: false,
      sentence: 'The call for speakers closes in 6 days.',
    },
  ],
  channels: [
    {
      id: 'lineup',
      label: 'Lineup',
      published: true,
      sentence:
        'The public page is on, so the lineup is being served. Last published by Jordan Alvarez 2 hours ago.',
      link: { tab: 'publish' },
    },
    {
      id: 'agenda',
      label: 'Schedule',
      published: false,
      sentence:
        'The schedule is not published, so no times are public. Last published by Jordan Alvarez 2 hours ago.',
      link: { tab: 'publish' },
    },
  ],
  version: 3,
}

// W4 — every figure already composed into a sentence with its population.
const TURNAROUND = {
  stats: [
    {
      id: 'decision',
      label: 'Decision turnaround',
      count: 24,
      openCount: 5,
      p50: 3 * 86_400_000,
      p90: 9 * 86_400_000,
      capped: false,
      sentence:
        'Decisions released in a median of 3 days after the proposal arrived, across 24 proposals; the slowest tenth took 9 days; 5 proposals are still undecided.',
    },
    {
      id: 'confirmation',
      label: 'Speaker confirmation',
      count: 0,
      openCount: 0,
      p50: null,
      p90: null,
      capped: false,
      sentence:
        'No decision has reached a speaker yet, so there is no confirmation turnaround to report.',
    },
  ],
  capped: false,
  summary:
    "Measured from this event's own history. Only intervals that actually closed are counted; anything still running is named, never averaged in.",
}

vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args?: unknown) => {
    const name = getFunctionName(ref)
    if (name === 'events:get') {
      return {
        role: 'organizer',
        org: { name: 'Acme', slug: 'acme' },
        event: {
          name: 'DevConf',
          slug: 'devconf',
          startsAt: 1_000,
          endsAt: 2_000,
          timezone: 'UTC',
          cfpPublished: false,
        },
      }
    }
    if (args === 'skip') return undefined
    if (name === 'readiness:attentionPanel') {
      if (state.attentionThrows) {
        throw new ConvexError({
          code: 'event_too_large',
          message: 'This event has more than 500 proposals.',
        })
      }
      return { ...ATTENTION_PANEL, firstEvent: state.firstEvent }
    }
    if (name === 'tasks:dashboard') {
      if (state.dashboardThrows) {
        // Exactly how the backend refuses, and exactly how Convex reports it
        // to a component: by throwing during render.
        throw new ConvexError({
          code: 'event_too_large',
          message: 'This event has more than 1000 sessions.',
        })
      }
      return DASHBOARD
    }
    if (name === 'tasks:listInstances') return []
    if (name === 'readiness:recentChanges') return CHANGES
    if (name === 'readiness:upNext') return UP_NEXT
    if (name === 'analytics:turnaround') {
      if (state.turnaroundThrows) {
        throw new ConvexError({
          code: 'event_too_large',
          message: 'This event has more than 4000 recorded actions.',
        })
      }
      return TURNAROUND
    }
    return undefined
  },
  useMutation: () => vi.fn(),
}))

// eslint-disable-next-line import/first -- vi.mock is hoisted above this
import { ControlCenter } from './ControlCenter'

beforeEach(() => {
  state.firstEvent = false
  state.dashboardThrows = false
  state.attentionThrows = false
  state.turnaroundThrows = false
  navigate.mockClear()
  // The boundary logs the caught error; the test asserts the rendering.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the four questions', () => {
  it('answers all four on one screen', () => {
    render(<ControlCenter eventSlug="devconf" />)
    expect(screen.getByText('What needs your attention')).toBeTruthy()
    expect(screen.getByText('What is blocked')).toBeTruthy()
    expect(screen.getByText('What changed recently')).toBeTruthy()
    expect(screen.getByText('What happens next')).toBeTruthy()
  })

  it('prints the model layer sentences verbatim', () => {
    render(<ControlCenter eventSlug="devconf" />)
    expect(
      screen.getByText(
        'The call for speakers closes in 6 days; 2 submissions are waiting for a decision.',
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        '3 staged decisions have not been released, so nobody has been told yet.',
      ),
    ).toBeTruthy()
    // "last published by … at …", one producer.
    expect(
      screen.getByText(
        'The public page is on, so the lineup is being served. Last published by Jordan Alvarez 2 hours ago.',
      ),
    ).toBeTruthy()
  })

  it('renders an unknown audit action honestly rather than crashing', () => {
    render(<ControlCenter eventSlug="devconf" />)
    expect(
      screen.getByText(
        'Jordan Alvarez performed a recorded action: quantum entangle schedule.',
      ),
    ).toBeTruthy()
  })

  it('preserves the readiness meter and the blocker counts', () => {
    render(<ControlCenter eventSlug="devconf" />)
    expect(screen.getByText('Content still in Draft')).toBeTruthy()
    expect(screen.getByText('Schedule conflicts')).toBeTruthy()
  })
})

describe('turnaround analytics (W4)', () => {
  it('sits below the four answers, collapsed, as a stacked list of sentences', () => {
    const { container } = render(<ControlCenter eventSlug="devconf" />)

    const sections = [...container.querySelectorAll('details')]
    const analytics = sections[sections.length - 1]
    expect(analytics.textContent).toContain('How long things are taking')
    // Collapsed by default: a retrospective must not dilute the answer above.
    expect(analytics.open).toBe(false)
    // A disclosure, from the platform — not a div pretending to be one.
    expect(analytics.querySelector('summary')).toBeTruthy()

    // Sentences, printed verbatim. No chart, no sparkline, no tile grid.
    expect(
      screen.getByText(
        'Decisions released in a median of 3 days after the proposal arrived, across 24 proposals; the slowest tenth took 9 days; 5 proposals are still undecided.',
      ),
    ).toBeTruthy()
    // The empty population says so instead of printing a zero.
    expect(
      screen.getByText(
        'No decision has reached a speaker yet, so there is no confirmation turnaround to report.',
      ),
    ).toBeTruthy()
    expect(analytics.querySelector('svg.chart, canvas')).toBeNull()
  })

  it('degrades to nothing when it fails — the four answers are untouched', () => {
    state.turnaroundThrows = true
    render(<ControlCenter eventSlug="devconf" />)

    expect(screen.queryByText('How long things are taking')).toBeNull()
    // No red callout for a nice-to-have: the section simply is not there.
    expect(screen.queryByText(/too large to answer in one pass/)).toBeNull()
    expect(screen.getByText('What needs your attention')).toBeTruthy()
    expect(screen.getByText('What is blocked')).toBeTruthy()
    expect(screen.getByText('What changed recently')).toBeTruthy()
    expect(screen.getByText('What happens next')).toBeTruthy()
  })

  it('a first event is never shown a retrospective', () => {
    state.firstEvent = true
    render(<ControlCenter eventSlug="devconf" />)
    expect(screen.queryByText('How long things are taking')).toBeNull()
  })
})

describe('deep links', () => {
  it('sends a count to already-filtered work, not to the page', () => {
    render(<ControlCenter eventSlug="devconf" />)
    fireEvent.click(screen.getByText('Decisions staged'))
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/proposals',
      params: { eventSlug: 'devconf' },
      search: { status: 'acceptQueue,declineQueue' },
    })
  })

  it('sends the draft-content blocker to the filtered session roster', () => {
    render(<ControlCenter eventSlug="devconf" />)
    fireEvent.click(screen.getByText('Content still in Draft'))
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/sessions',
      params: { eventSlug: 'devconf' },
      search: { content: 'draft' },
    })
  })
})

describe('panel-level containment', () => {
  it('an over-ceiling table blanks ONE panel, not the screen', () => {
    state.dashboardThrows = true
    render(<ControlCenter eventSlug="devconf" />)

    // The refusing panel says so, in the backend's own words.
    expect(
      screen.getByText('What is blocked is too large to answer in one pass'),
    ).toBeTruthy()
    expect(screen.getByText(/more than 1000 sessions/)).toBeTruthy()

    // …and the other three questions are still answered.
    expect(screen.getByText('What needs your attention')).toBeTruthy()
    expect(screen.getByText('What changed recently')).toBeTruthy()
    expect(screen.getByText('What happens next')).toBeTruthy()
    expect(
      screen.getByText(
        '3 staged decisions have not been released, so nobody has been told yet.',
      ),
    ).toBeTruthy()
  })

  it('contains a failure of the ATTENTION panel too', () => {
    // The panel that owns the first-event decision is the easiest one to
    // leave unwrapped, and the only one whose failure could blank everything.
    state.attentionThrows = true
    render(<ControlCenter eventSlug="devconf" />)

    expect(
      screen.getByText(
        'What needs your attention is too large to answer in one pass',
      ),
    ).toBeTruthy()
    expect(screen.getByText(/more than 500 proposals/)).toBeTruthy()

    // The other three questions are still on screen and still answered.
    expect(screen.getByText('What is blocked')).toBeTruthy()
    expect(screen.getByText('What changed recently')).toBeTruthy()
    expect(screen.getByText('What happens next')).toBeTruthy()
    expect(screen.getByText('Jordan Alvarez released a decision.')).toBeTruthy()
  })

  it('recovers: Try again clears the error and re-subscribes', () => {
    state.dashboardThrows = true
    const { rerender } = render(<ControlCenter eventSlug="devconf" />)
    expect(
      screen.getByText('What is blocked is too large to answer in one pass'),
    ).toBeTruthy()

    // The event dropped back under its ceiling (or the outage ended). Without
    // reset semantics this panel would stay dead for the rest of the session.
    state.dashboardThrows = false
    fireEvent.click(screen.getByText('Try again'))
    rerender(<ControlCenter eventSlug="devconf" />)

    expect(
      screen.queryByText('What is blocked is too large to answer in one pass'),
    ).toBeNull()
    expect(screen.getByText('Content still in Draft')).toBeTruthy()
  })

  it('a failure never outlives the event it belonged to', () => {
    state.dashboardThrows = true
    const { rerender } = render(<ControlCenter eventSlug="devconf" />)
    expect(
      screen.getByText('What is blocked is too large to answer in one pass'),
    ).toBeTruthy()

    // Switching events remounts the boundary by key: the new event must not
    // inherit the old one's dead panel.
    state.dashboardThrows = false
    rerender(<ControlCenter eventSlug="otherconf" />)

    expect(
      screen.queryByText('What is blocked is too large to answer in one pass'),
    ).toBeNull()
    expect(screen.getByText('Content still in Draft')).toBeTruthy()
  })
})

describe('first event vs returning event', () => {
  it('shows the lifecycle checklist and not the panels', () => {
    state.firstEvent = true
    render(<ControlCenter eventSlug="devconf" />)
    expect(screen.getByText('Set up your first event')).toBeTruthy()
    expect(screen.getByText('Set up the event')).toBeTruthy()
    expect(screen.getByText('Open the call for speakers')).toBeTruthy()
    // The summary is the OTHER branch of one decision.
    expect(screen.queryByText('What needs your attention')).toBeNull()
    expect(screen.queryByText('What is blocked')).toBeNull()
  })

  it('gives each checklist step one next action', () => {
    state.firstEvent = true
    render(<ControlCenter eventSlug="devconf" />)
    fireEvent.click(screen.getByText('Open settings'))
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/settings',
      params: { eventSlug: 'devconf' },
      search: {},
    })
  })

  it('shows the panels once the event has history', () => {
    render(<ControlCenter eventSlug="devconf" />)
    expect(screen.queryByText('Set up your first event')).toBeNull()
    expect(screen.getByText('What needs your attention')).toBeTruthy()
  })
})
