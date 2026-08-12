import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { getFunctionName } from 'convex/server'

// W12 — the table & batch-action standard, asserted on the surfaces.
//
// The one thing these tests refuse to fake is the URL vocabulary. Every chip
// removal is fed back through the route's REAL `validateSearch`, because the
// bug this workstream closes is exactly a chip that changes the screen while
// the URL keeps saying something else (W8 left the tasks chips doing that on
// purpose and named W12 as the owner).
//
// They also pin the CRM page order, which carries an eval constraint: the
// analytics widget must be populated and screenshot-visible with no
// interaction, so it may move below the directory but may not collapse.

const { state, navigate } = vi.hoisted(() => ({
  state: {
    search: {},
    params: { eventSlug: 'devconf', orgSlug: 'equipe' },
    /** Set false for the "this event has no tasks at all" case. */
    hasTasks: true,
    /** Empty = reached the org through an event membership, not as an admin;
     * the query mock turns it into the null role the backend returns. */
    orgRole: 'owner',
  },
  navigate: vi.fn(() => Promise.resolve()),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => state.params,
    useSearch: () => state.search,
    useNavigate: () => navigate,
  }),
  useNavigate: () => navigate,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))

vi.mock('@clerk/tanstack-react-start', () => ({
  useAuth: () => ({ getToken: () => Promise.resolve('token') }),
}))

const CONTACTS = [
  {
    _id: 'c1',
    _creationTime: 1,
    orgId: 'o1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    company: 'Analytical',
    tags: ['keynote'],
  },
  {
    _id: 'c2',
    _creationTime: 2,
    orgId: 'o1',
    firstName: 'Grace',
    lastName: 'Hopper',
    company: 'Navy',
    tags: [],
  },
]

const ROSTER = [
  {
    eventContactId: 'ec1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    company: 'Analytical',
    claimed: false,
    sessions: [{ sessionId: 's1', title: 'Convex in anger', state: 'awaiting' }],
  },
  {
    eventContactId: 'ec2',
    firstName: 'Grace',
    lastName: 'Hopper',
    claimed: true,
    sessions: [{ sessionId: 's2', title: 'Signals', state: 'confirmed' }],
  },
]

const SESSIONS = [
  {
    session: {
      _id: 's1',
      title: 'Convex in anger',
      status: 'planned',
      source: 'cfp',
      contentStatus: 'draft',
    },
    participants: [],
  },
  {
    session: {
      _id: 's2',
      title: 'Signals',
      status: 'planned',
      source: 'direct',
      contentStatus: 'approved',
    },
    participants: [],
  },
]

const INSTANCES = [
  {
    instanceId: 'i1',
    requirementId: 'r1',
    requirementTitle: 'Headshot',
    sessionId: 's1',
    sessionTitle: 'Convex in anger',
    speakerName: 'Ada Lovelace',
    status: 'pending',
    evidence: 'file',
    // Comfortably in the future: nothing on this event is overdue, which is
    // the case the zero-count rule has to survive.
    dueAt: 4_102_444_800_000,
    uploadCount: 0,
  },
  {
    instanceId: 'i2',
    requirementId: 'r2',
    requirementTitle: 'Slides',
    sessionId: 's2',
    sessionTitle: 'Signals',
    speakerName: 'Grace Hopper',
    status: 'approved',
    evidence: 'manual',
    dueAt: 4_102_444_800_000,
    uploadCount: 0,
  },
]

const PROPOSALS = [
  {
    proposal: {
      _id: 'p1',
      _creationTime: 1,
      eventId: 'e1',
      submitterUserId: 'u1',
      status: 'pending',
      title: 'Convex in anger',
      answers: {},
      formVersion: 1,
      updatedAt: 1,
    },
    speakerCount: 1,
  },
  {
    proposal: {
      _id: 'p2',
      _creationTime: 2,
      eventId: 'e1',
      submitterUserId: 'u2',
      status: 'acceptQueue',
      title: 'Signals',
      answers: {},
      formVersion: 1,
      updatedAt: 2,
    },
    speakerCount: 1,
  },
]

vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args?: unknown) => {
    if (args === 'skip') return undefined
    const name = getFunctionName(ref)
    switch (name) {
      case 'events:get':
        return {
          role: 'organizer',
          event: { name: 'DevConf', timezone: 'UTC' },
        }
      case 'orgs:get':
        return {
          role: state.orgRole === '' ? null : state.orgRole,
          org: { name: 'Equipe', slug: 'equipe' },
        }
      case 'events:listForOrg':
        return []
      case 'contacts:list':
        return CONTACTS
      case 'contacts:overview':
        return {
          totalContacts: 2,
          withEmail: 1,
          enrolled: 0,
          capped: false,
          topCompanies: [{ company: 'Analytical', count: 1 }],
        }
      case 'contacts:nearDuplicates':
        return { pairs: [], scanned: 2, capped: false }
      case 'contacts:segments':
        return []
      case 'speakers:roster':
        return ROSTER
      case 'sessions:list':
        return SESSIONS
      case 'readiness:publication':
        return []
      case 'tasks:listInstances':
        return state.hasTasks ? INSTANCES : []
      case 'tasks:listRequirements':
        return [
          { requirementId: 'r1', title: 'Headshot' },
          { requirementId: 'r2', title: 'Slides' },
        ]
      case 'library:list':
        return { formats: [] }
      case 'cfp:listProposals':
        return { rows: PROPOSALS, capped: false }
      case 'cfp:getForm':
        return { published: null, working: null }
      case 'reviews:progress':
        return {}
      default:
        return undefined
    }
  },
  useMutation: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
}))

// eslint-disable-next-line import/first -- vi.mock is hoisted
import { Route as SpeakersRoute } from './app.e.$eventSlug.speakers.index'
// eslint-disable-next-line import/first
import { Route as SessionsRoute } from './app.e.$eventSlug.sessions.index'
// eslint-disable-next-line import/first
import { Route as TasksRoute } from './app.e.$eventSlug.tasks'
// eslint-disable-next-line import/first
import { Route as OrgRoute } from './app.org.$orgSlug'
// eslint-disable-next-line import/first
import { Route as ProposalsRoute } from './app.e.$eventSlug.proposals'
// eslint-disable-next-line import/first
import type * as React from 'react'
// eslint-disable-next-line import/first
import { parseSpeakersSearch } from '~/components/speakers/search'
// eslint-disable-next-line import/first
import { parseSessionsSearch } from '~/components/sessions/search'
// eslint-disable-next-line import/first
import { parseTasksSearch } from '~/components/tasks/search'
// eslint-disable-next-line import/first
import { parseOrgSearch } from '~/components/contacts/search'
 
// eslint-disable-next-line import/first
import { parseSearch } from '~/components/abstracts/model'

type RouteLike = { component: React.ComponentType }

function renderRoute(route: unknown, search: Record<string, unknown>) {
  state.search = search
  const Page = (route as RouteLike).component
  return render(<Page />)
}

/** What the LAST navigate() call would put in the URL, run back through the
 * route's own validateSearch — the round trip the organizer actually gets. */
function urlAfterNavigate(
  parse: (input: Record<string, unknown>) => Record<string, unknown>,
) {
  const calls = navigate.mock.calls as unknown as Array<
    [{ search: unknown; replace?: boolean }]
  >
  expect(calls.length).toBeGreaterThan(0)
  const call = calls[calls.length - 1][0]
  const next =
    typeof call.search === 'function'
      ? (call.search as (prev: unknown) => Record<string, unknown>)(state.search)
      : (call.search as Record<string, unknown>)
  // Filter tweaks REPLACE. Every surface in this workstream agrees on that, so
  // back leaves the page instead of walking back through the organizer's own
  // filter presses.
  expect(call.replace).toBe(true)
  return parse(
    Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined),
    ),
  )
}

afterEach(() => {
  cleanup()
  navigate.mockClear()
  state.hasTasks = true
  state.orgRole = 'owner'
})

describe('chip round-trip: speaker roster', () => {
  it('shows a chip for a filter arrived at by deep link', () => {
    renderRoute(SpeakersRoute, parseSpeakersSearch({ state: 'awaiting', q: 'ada' }))
    expect(screen.getByText('Participation: Awaiting Response')).toBeTruthy()
    expect(screen.getByText('Search: ada')).toBeTruthy()
  })

  it('removing the participation chip takes it out of the URL', () => {
    renderRoute(SpeakersRoute, parseSpeakersSearch({ state: 'awaiting', q: 'ada' }))
    fireEvent.click(
      screen.getByLabelText('Remove filter: Participation: Awaiting Response'),
    )
    expect(urlAfterNavigate(parseSpeakersSearch)).toEqual({ q: 'ada' })
  })

  it('removing the search chip takes it out of the URL', () => {
    renderRoute(SpeakersRoute, parseSpeakersSearch({ state: 'awaiting', q: 'ada' }))
    fireEvent.click(screen.getByLabelText('Remove filter: Search: ada'))
    expect(urlAfterNavigate(parseSpeakersSearch)).toEqual({ state: 'awaiting' })
  })

  it('hides an empty participation filter but keeps the meaningful zero', () => {
    // Nobody has declined or withdrawn on this roster; somebody is awaiting.
    renderRoute(SpeakersRoute, parseSpeakersSearch({}))
    const options = Array.from(
      document.querySelectorAll('option'),
      (o) => o.textContent,
    )
    expect(options).toContain('Awaiting Response (1)')
    expect(options).toContain('Confirmed (1)')
    // An empty Withdrawn is noise and goes; the empty Declined with it.
    expect(options.some((o) => o.startsWith('Withdrawn'))).toBe(false)
    expect(options.some((o) => o.startsWith('Declined'))).toBe(false)
  })
})

describe('chip round-trip: session roster', () => {
  it('shows and removes the content filter, writing the URL', () => {
    renderRoute(SessionsRoute, parseSessionsSearch({ content: 'draft' }))
    expect(screen.getByText('Content: Draft')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Remove filter: Content: Draft'))
    expect(urlAfterNavigate(parseSessionsSearch)).toEqual({})
  })

  it('offers only the content states that exist, and Draft even at zero', () => {
    renderRoute(SessionsRoute, parseSessionsSearch({}))
    const options = Array.from(
      document.querySelectorAll('option'),
      (o) => o.textContent,
    )
    expect(options).toContain('Draft content (1)')
    expect(options).toContain('Approved content (1)')
  })

  it('keeps at most two visible row actions, the rest in a keyboard menu', () => {
    renderRoute(SessionsRoute, parseSessionsSearch({}))
    // "Manage" is the visible one; everything else moved into the overflow.
    expect(screen.getAllByText('Manage')).toHaveLength(2)
    const trigger = screen.getByRole('button', {
      name: 'More actions for Convex in anger',
    })
    fireEvent.click(trigger)
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent)
    expect(items).toContain('Open the session workspace')
    // Only a CFP-sourced session offers its source proposal.
    expect(items).toContain('Open the source proposal')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })
})

describe('chip round-trip: speaker tasks', () => {
  it('closes W8s gap — a chip press writes the URL', () => {
    renderRoute(TasksRoute, parseTasksSearch({ tab: 'instances' }))
    fireEvent.click(screen.getByText('Overdue (0)'))
    expect(urlAfterNavigate(parseTasksSearch)).toEqual({
      tab: 'instances',
      status: 'overdue',
    })
  })

  it('shows the active status as a removable chip, and removes it', () => {
    renderRoute(
      TasksRoute,
      parseTasksSearch({ tab: 'instances', status: 'outstanding' }),
    )
    expect(screen.getByText('Status: Outstanding work')).toBeTruthy()
    fireEvent.click(
      screen.getByLabelText('Remove filter: Status: Outstanding work'),
    )
    expect(urlAfterNavigate(parseTasksSearch)).toEqual({ tab: 'instances' })
  })

  it('puts the requirement filter in the URL — it was in the UI but not the vocabulary', () => {
    renderRoute(
      TasksRoute,
      parseTasksSearch({ tab: 'instances', requirement: 'r1' }),
    )
    expect(screen.getByText('Requirement: Headshot')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Remove filter: Requirement: Headshot'))
    expect(urlAfterNavigate(parseTasksSearch)).toEqual({ tab: 'instances' })
  })

  it('an event with no tasks at all says so, with no filter row to explain', () => {
    state.hasTasks = false
    renderRoute(TasksRoute, parseTasksSearch({ tab: 'instances' }))
    expect(screen.getByText('No tasks yet')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Active filters' })).toBeNull()
  })

  it('a stale deep link into an empty event can still be undone', () => {
    // The control-center count that produced this link has since been
    // satisfied. Without the chip row the organizer gets an empty table, no
    // reason for it, and no way out — the exact stranding the zero-count rule
    // exists to prevent.
    state.hasTasks = false
    renderRoute(
      TasksRoute,
      parseTasksSearch({ tab: 'instances', status: 'overdue' }),
    )
    expect(screen.getByText('No tasks match these filters')).toBeTruthy()
    expect(screen.queryByText('No tasks yet')).toBeNull()
    expect(screen.getByText('Status: Overdue')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Remove filter: Status: Overdue'))
    expect(urlAfterNavigate(parseTasksSearch)).toEqual({ tab: 'instances' })
  })

  it('offers one press out of an empty filtered view', () => {
    state.hasTasks = false
    renderRoute(
      TasksRoute,
      parseTasksSearch({ tab: 'instances', status: 'overdue', requirement: 'r1' }),
    )
    fireEvent.click(screen.getByText('Clear the filters'))
    expect(urlAfterNavigate(parseTasksSearch)).toEqual({ tab: 'instances' })
  })

  it('a requirement id that matches nothing is still shown and removable', () => {
    // A deleted requirement, or a link from another event. The view narrows to
    // nothing either way; an unexplained empty table is the only unacceptable
    // outcome.
    renderRoute(
      TasksRoute,
      parseTasksSearch({ tab: 'instances', requirement: 'gone' }),
    )
    expect(screen.getByText('Unknown requirement')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Remove filter: Unknown requirement'))
    expect(urlAfterNavigate(parseTasksSearch)).toEqual({ tab: 'instances' })
  })

  it('hides statuses nobody is in, and keeps the operational zeros', () => {
    renderRoute(TasksRoute, parseTasksSearch({ tab: 'instances' }))
    // Zeroes that answer "is anyone behind?" stay …
    expect(screen.getByText('Overdue (0)')).toBeTruthy()
    expect(screen.getByText('Outstanding work (1)')).toBeTruthy()
    // … while a status with nobody in it is noise and goes.
    expect(screen.queryByText(/^Withdrawn/)).toBeNull()
    expect(screen.queryByText(/^Not Applicable \(0\)/)).toBeNull()
  })
})

describe('the contact directory', () => {
  const contactsSearch = () => parseOrgSearch({ tab: 'contacts' })

  it('leads the page — the analytics widget follows it, populated and open', () => {
    const { container } = renderRoute(OrgRoute, contactsSearch())

    const directory = screen.getByRole('region', { name: 'Contact directory' })
    // The KPI card is a Card title; it is on screen with no interaction, which
    // is what specs/07-speaker-crm.yaml requires of the analytics widget.
    const kpi = screen.getByText('Reachable')
    expect(screen.getByText('In pipeline')).toBeTruthy()
    // Populated, not a placeholder: one of the two contacts has an address.
    expect(kpi.closest('.ss-card')?.textContent).toContain('1')

    // Document order: the directory comes first now.
    const position = directory.compareDocumentPosition(kpi)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('details')).toBeNull()
  })

  it('reflects search, tag and company filters into the URL as chips', () => {
    renderRoute(OrgRoute, parseOrgSearch({ tab: 'contacts', tag: 'keynote' }))
    expect(screen.getByText('Tag: keynote')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Remove filter: Tag: keynote'))
    expect(urlAfterNavigate(parseOrgSearch)).toEqual({ tab: 'contacts' })
  })

  it('selection reveals the batch bar, stating the backends own arithmetic', () => {
    renderRoute(OrgRoute, contactsSearch())
    // Grace has no email on file; Ada does.
    fireEvent.click(screen.getByLabelText('Select Ada Lovelace'))
    fireEvent.click(screen.getByLabelText('Select Grace Hopper'))

    const bar = screen.getByRole('region', { name: 'Contact bulk actions' })
    expect(bar.textContent).toContain('2 contacts selected · 1 eligible')
    expect(bar.textContent).toContain('1 has no email address on file — skipped')
  })

  it('falls back to the default tab when a URL asks for a tab that is not theirs', () => {
    // Someone who reached the org through an event membership. The tab strip
    // never offers Team to them, so a link that asks for it falls back rather
    // than rendering a blank third panel.
    state.orgRole = ''
    renderRoute(OrgRoute, parseOrgSearch({ tab: 'team' }))
    expect(screen.getByRole('tab', { name: /Events/ })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /Team/ })).toBeNull()
    // The Events tab is what rendered — not an empty page.
    expect(screen.getByText('No events yet')).toBeTruthy()
  })

  it('has no batch bar until something is selected', () => {
    renderRoute(OrgRoute, contactsSearch())
    expect(screen.queryByRole('region', { name: 'Contact bulk actions' })).toBeNull()
  })
})

describe('chip round-trip: proposals', () => {
  it('shows the search and each active status as removable chips', () => {
    renderRoute(ProposalsRoute, parseSearch({ q: 'convex', status: 'pending' }))
    expect(screen.getByText('Search: convex')).toBeTruthy()
    expect(screen.getByText('Status: Submitted')).toBeTruthy()
  })

  it('removing a status chip takes that status out of the URL', () => {
    renderRoute(
      ProposalsRoute,
      parseSearch({ status: 'pending,acceptQueue' }),
    )
    fireEvent.click(screen.getByLabelText('Remove filter: Status: Submitted'))
    expect(urlAfterNavigate(parseSearch)).toEqual({ status: 'acceptQueue' })
  })

  it('removing the search chip clears q in the URL', () => {
    renderRoute(ProposalsRoute, parseSearch({ q: 'convex' }))
    fireEvent.click(screen.getByLabelText('Remove filter: Search: convex'))
    expect(urlAfterNavigate(parseSearch)).toEqual({})
  })

  it('hides a status nobody is in, and keeps the pipeline zeros', () => {
    renderRoute(ProposalsRoute, parseSearch({}))
    // Nothing is withdrawn or drafted on this event, so those chips are gone.
    expect(screen.queryByText('Withdrawn')).toBeNull()
    expect(screen.queryByText('Draft')).toBeNull()
    // "0 in the decline queue" is an answer an organizer came for, so it stays.
    // (Scoped to the chip row: "Submitted" is also a status pill on a row.)
    const chips = Array.from(
      document.querySelectorAll('button[aria-pressed]'),
      (b) => b.textContent,
    )
    expect(chips.some((c) => c.startsWith('Decline queue'))).toBe(true)
    expect(chips.some((c) => c.startsWith('Submitted'))).toBe(true)
  })
})

describe('proposals: clearing filters is not clearing the table', () => {
  it('clears q and status but keeps sort, direction and columns', () => {
    renderRoute(
      ProposalsRoute,
      parseSearch({
        q: 'convex',
        status: 'pending',
        sort: 'title',
        dir: 'asc',
        cols: 'title,status',
      }),
    )
    fireEvent.click(screen.getByText('Clear all'))
    // Sort and columns are how this organizer READS the table, kept per event
    // — "show me everything again" must not undo a set-up they never touched.
    expect(urlAfterNavigate(parseSearch)).toEqual({
      sort: 'title',
      dir: 'asc',
      cols: 'title,status',
    })
  })
})
