import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { getFunctionName } from 'convex/server'

// W9 — the routed record workspaces.
//
// What these pin down:
//   · a table row is a NAVIGATION, and it is reachable from the keyboard;
//   · the tab a URL asks for is the tab that renders, including W4's
//     `?tab=content` deep link;
//   · the publication tab prints the model's sentences VERBATIM and offers
//     the repair target the model declared — no re-wording in TSX;
//   · the history tab shows the W3 snapshots;
//   · there is exactly ONE full detail surface per record. The dialogs that
//     used to compete with these pages are gone or reduced, and that is
//     asserted against the source, because a promotion that leaves the old
//     surface behind still renders perfectly well.

const { state, navigate, mutations } = vi.hoisted(() => ({
  state: {
    pathname: '/app/e/devconf/sessions/s1',
    search: {},
    role: 'organizer',
    // The speaker query's answer. `undefined` is the real loading state, and
    // the blocker below is entirely about what the form does while it lasts.
    speakerLoaded: true,
  },
  navigate: vi.fn(() => Promise.resolve()),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({
      eventSlug: 'devconf',
      sessionId: 's1',
      eventContactId: 'c1',
    }),
    useSearch: () => state.search,
    useNavigate: () => navigate,
  }),
  useNavigate: () => navigate,
  Link: ({
    children,
    to,
    search,
  }: {
    children: React.ReactNode
    to: string
    search?: Record<string, unknown>
  }) => (
    <a
      href={to}
      data-search={search === undefined ? '' : JSON.stringify(search)}
    >
      {children}
    </a>
  ),
}))

vi.mock('@clerk/tanstack-react-start', () => ({
  useAuth: () => ({ getToken: () => Promise.resolve('token') }),
}))

const PUBLICATION = {
  inLineup: false,
  inAgenda: false,
  toBeAnnounced: false,
  // These strings are what convex/model/readiness.ts composes. The test asserts
  // they reach the screen unchanged; it does not re-derive them.
  reasons: [
    {
      code: 'content_draft',
      blocks: 'both',
      sentence: 'Content is Draft.',
      repair: { tab: 'sessions', params: { sessionId: 's1' } },
    },
    {
      code: 'lineup_not_published',
      blocks: 'lineup',
      sentence: 'The public page is off.',
      repair: { tab: 'publish', params: {} },
    },
  ],
  summary: 'Not public: content is Draft. Speaker and schedule are ready.',
}

const SNAPSHOTS = {
  truncated: false,
  entries: [
    {
      key: 'current',
      label: 'Current',
      origin: 'edit',
      originLabel: null,
      editorName: null,
      revisionId: null,
      content: { title: 'Agents in Production', description: 'Now', format: 'Talk' },
    },
    {
      key: 'r1',
      label: 'Edited 2 March',
      origin: 'edit',
      originLabel: 'Title and description changed',
      editorName: 'Alice',
      revisionId: 'rev1',
      content: { title: 'Agents', description: 'Then', format: 'Talk' },
    },
  ],
}

const SESSION_DOC = {
  _id: 's1',
  title: 'Agents in Production',
  description: 'War stories.',
  format: 'Talk',
  source: 'cfp',
  status: 'planned',
  contentStatus: 'draft',
  eventId: 'e1',
}

vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args?: unknown) => {
    const name = getFunctionName(ref)
    if (args === 'skip') return undefined
    if (name === 'events:get') {
      return {
        role: state.role,
        org: { name: 'Acme', slug: 'acme' },
        event: {
          name: 'DevConf',
          startsAt: 1_000,
          endsAt: 2_000,
          timezone: 'UTC',
        },
      }
    }
    if (name === 'workspaces:session') {
      return {
        session: SESSION_DOC,
        roomName: 'Grand Hall',
        participants: [
          {
            participantId: 'p1',
            eventContactId: 'c1',
            firstName: 'Grace',
            lastName: 'Hopper',
            headshotUrl: null,
            role: 'speaker',
            state: 'confirmed',
          },
        ],
        proposal: null,
        publication: PUBLICATION,
      }
    }
    if (name === 'workspaces:speaker') {
      if (!state.speakerLoaded) return undefined
      return {
        eventContactId: 'c1',
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.com',
        jobTitle: 'Rear Admiral',
        company: 'US Navy',
        tagline: 'Compiler pioneer',
        bio: 'Invented the compiler.',
        headshotUrl: null,
        claimed: false,
        customValues: {},
        sessionsTruncated: false,
        sessions: [
          {
            participantId: 'p1',
            sessionId: 's1',
            title: 'Agents in Production',
            role: 'speaker',
            state: 'confirmed',
            status: 'planned',
            contentStatus: 'draft',
            released: false,
          },
        ],
        readiness: {
          missingBio: true,
          missingHeadshot: true,
          missingTagline: false,
          reasons: ['No headshot — the program falls back to initials.'],
        },
      }
    }
    if (name === 'sessions:listSnapshots') return SNAPSHOTS
    if (name === 'sessions:list') {
      return [{ session: SESSION_DOC, participants: [] }]
    }
    if (name === 'speakers:roster') {
      return [
        {
          eventContactId: 'c1',
          firstName: 'Grace',
          lastName: 'Hopper',
          headshotUrl: null,
          claimed: false,
          customValues: {},
          sessions: [],
        },
      ]
    }
    if (name === 'tasks:listInstances') return []
    if (name === 'comms:contactLog') return []
    if (name === 'templates:list') return []
    if (name === 'library:list') return { customFields: [], formats: [] }
    if (name === 'readiness:publication') return []
    return undefined
  },
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref)
    const existing = mutations.get(name)
    if (existing !== undefined) return existing
    const spy = vi.fn(() => Promise.resolve(null))
    mutations.set(name, spy)
    return spy
  },
}))

// eslint-disable-next-line import/first -- vi.mock is hoisted
import { Route as SessionWorkspaceRoute } from './app.e.$eventSlug.sessions.$sessionId'
// eslint-disable-next-line import/first -- same
import { Route as SpeakerWorkspaceRoute } from './app.e.$eventSlug.speakers.$eventContactId'
// eslint-disable-next-line import/first -- same
import { Route as SpeakersListRoute } from './app.e.$eventSlug.speakers.index'
// eslint-disable-next-line import/first -- same
import { Route as SessionsListRoute } from './app.e.$eventSlug.sessions.index'
// eslint-disable-next-line import/first -- same
import type * as React from 'react'
// eslint-disable-next-line import/first -- same
import { EventHeaderProvider } from '~/components/shell/EventHeader'
 

const SpeakerWorkspacePage = (
  SpeakerWorkspaceRoute as unknown as { component: React.ComponentType }
).component

function renderRoute(route: unknown) {
  const Page = (route as { component: React.ComponentType }).component
  return render(
    <EventHeaderProvider>
      <Page />
    </EventHeaderProvider>,
  )
}

const SRC = `${process.cwd()}/src`
const read = (path: string) => readFileSync(`${SRC}/${path}`, 'utf8')

beforeEach(() => {
  state.search = {}
  state.role = 'organizer'
  state.speakerLoaded = true
  navigate.mockClear()
  mutations.clear()
})
afterEach(cleanup)

describe('rows open workspaces', () => {
  it('navigates from a speaker row, by click and by keyboard', () => {
    renderRoute(SpeakersListRoute)
    const row = screen.getByText('Grace Hopper').closest('tr')
    expect(row).not.toBeNull()

    fireEvent.click(row as HTMLElement)
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/speakers/$eventContactId',
      params: { eventSlug: 'devconf', eventContactId: 'c1' },
    })

    navigate.mockClear()
    // The row itself is focusable (W6), so Enter on it is the keyboard path.
    expect((row as HTMLElement).tabIndex).toBe(0)
    fireEvent.keyDown(row as HTMLElement, { key: 'Enter' })
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('navigates from a session row', () => {
    renderRoute(SessionsListRoute)
    const row = screen.getByText('Agents in Production').closest('tr')
    fireEvent.click(row as HTMLElement)
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/sessions/$sessionId',
      params: { eventSlug: 'devconf', sessionId: 's1' },
    })
  })

  it('leaves a click on a cell control to that control', () => {
    // The sessions row carries in-cell controls (approve, manage). A click on
    // one of them has already been answered; navigating as well would move the
    // organizer somewhere they did not ask to go.
    renderRoute(SessionsListRoute)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('the session workspace', () => {
  it('opens the tab the URL asks for', () => {
    state.search = { tab: 'publication' }
    renderRoute(SessionWorkspaceRoute)
    expect(
      screen.getByRole('tabpanel', { name: 'Publication state' }),
    ).toBeTruthy()
  })

  it('switches tab by writing to the URL, never by local state', () => {
    renderRoute(SessionWorkspaceRoute)
    fireEvent.click(screen.getByRole('tab', { name: /Source proposal/ }))
    expect(navigate).toHaveBeenCalledWith({ search: { tab: 'proposal' } })
  })

  it('writes the default tab as an absent param', () => {
    state.search = { tab: 'history' }
    renderRoute(SessionWorkspaceRoute)
    fireEvent.click(screen.getByRole('tab', { name: /Overview/ }))
    expect(navigate).toHaveBeenCalledWith({ search: {} })
  })

  it('renders the W4 publication sentences verbatim, with their repair links', () => {
    state.search = { tab: 'publication' }
    renderRoute(SessionWorkspaceRoute)

    // The summary and every reason, exactly as the model composed them.
    expect(screen.getByText(PUBLICATION.summary)).toBeTruthy()
    for (const reason of PUBLICATION.reasons) {
      expect(screen.getByText(reason.sentence)).toBeTruthy()
    }
    // And the repair target the model declared, one per reason.
    const hrefs = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/app/e/$eventSlug/sessions')
    expect(hrefs).toContain('/app/e/$eventSlug/publish')
  })

  it('renders the W3 snapshots in the history tab', () => {
    state.search = { tab: 'history' }
    renderRoute(SessionWorkspaceRoute)
    expect(screen.getByText('Current')).toBeTruthy()
    expect(screen.getByText('Edited 2 March')).toBeTruthy()
    expect(screen.getByText('Title and description changed')).toBeTruthy()
    // The restore flow came with it, not just the list.
    expect(
      screen.getByRole('button', { name: /Restore this snapshot/ }),
    ).toBeTruthy()
  })

  it('refuses a reviewer', () => {
    state.role = 'reviewer'
    renderRoute(SessionWorkspaceRoute)
    expect(screen.getByText(/organizer-only/)).toBeTruthy()
  })
})

describe('the speaker workspace', () => {
  it('opens on identity and carries the profile fields, not a dialog', () => {
    renderRoute(SpeakerWorkspaceRoute)
    expect(
      screen.getByRole('tabpanel', { name: 'Identity and contact details' }),
    ).toBeTruthy()
    expect(screen.getByLabelText(/First name/)).toBeTruthy()
    // The promoted form's save is the workspace's primary action.
    expect(screen.getByRole('button', { name: 'Save speaker' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('links each participation to that session workspace', () => {
    state.search = { tab: 'sessions' }
    renderRoute(SpeakerWorkspaceRoute)
    const link = screen.getByRole('link', { name: 'Agents in Production' })
    expect(link.getAttribute('href')).toBe(
      '/app/e/$eventSlug/sessions/$sessionId',
    )
  })

  it('states the readiness gaps in the model\'s words', () => {
    state.search = { tab: 'readiness' }
    renderRoute(SpeakerWorkspaceRoute)
    expect(
      screen.getByText('No headshot — the program falls back to initials.'),
    ).toBeTruthy()
  })

  it('refuses a reviewer', () => {
    state.role = 'reviewer'
    renderRoute(SpeakerWorkspaceRoute)
    expect(screen.getByText(/organizer-only/)).toBeTruthy()
  })
})

describe('the profile form never opens on a placeholder', () => {
  // The bug this pins down would have been silent and destructive: a form
  // mounted while the query was in flight seeds its draft from whatever it was
  // given, so Save would write empty strings over a real bio, tagline, company
  // and every link the speaker had.

  it('shows nothing editable until the record has arrived', () => {
    state.speakerLoaded = false
    renderRoute(SpeakerWorkspaceRoute)
    expect(screen.getByText('Loading speaker…')).toBeTruthy()
    expect(screen.queryByLabelText(/First name/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save speaker' })).toBeNull()
  })

  it('holds the real values once it does, and saves those', () => {
    state.speakerLoaded = false
    const view = renderRoute(SpeakerWorkspaceRoute)

    state.speakerLoaded = true
    view.rerender(
      <EventHeaderProvider>
        <SpeakerWorkspacePage />
      </EventHeaderProvider>,
    )

    // Every field carries the stored value — not a blank waiting to be saved.
    expect(screen.getByLabelText<HTMLInputElement>(/First name/).value).toBe(
      'Grace',
    )
    expect(screen.getByLabelText<HTMLInputElement>(/Bio/).value).toBe(
      'Invented the compiler.',
    )
    expect(screen.getByLabelText<HTMLInputElement>(/Company/).value).toBe(
      'US Navy',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save speaker' }))
    const save = mutations.get('speakers:updateProfile')
    expect(save).toBeDefined()
    expect(save).toHaveBeenCalledTimes(1)
    const patch = (save as ReturnType<typeof vi.fn>).mock.calls[0][0].patch
    expect(patch.firstName).toBe('Grace')
    expect(patch.bio).toBe('Invented the compiler.')
    expect(patch.company).toBe('US Navy')
    expect(patch.tagline).toBe('Compiler pioneer')
  })
})

describe('one detail surface per record', () => {
  it('promoted the speaker profile dialog away entirely', () => {
    expect(() => read('components/speakers/SpeakerProfileDialog.tsx')).toThrow()
    // Its body survived as the workspace's Identity tab.
    const form = read('components/speakers/SpeakerProfileForm.tsx')
    expect(form).toContain('SpeakerProfileFields')
    expect(form).not.toContain('<Dialog')
  })

  it('promoted the content history dialog into the history tab', () => {
    expect(() => read('components/sessions/ContentHistoryDialog.tsx')).toThrow()
    const panel = read('components/sessions/ContentHistoryPanel.tsx')
    expect(panel).toContain('ContentHistoryPanel')
    expect(panel).not.toContain('<Dialog')
    // …and the sessions table stopped offering its own copy.
    expect(read('components/sessions/SessionContentCell.tsx')).not.toContain(
      'ContentHistory',
    )
  })

  it('reduced the agenda session dialog to a board quick-peek', () => {
    const dialog = read('components/agenda/SessionDetailDialog.tsx')
    // What stayed is board work: placement, release, acknowledgement.
    expect(dialog).toContain('Edit placement')
    expect(dialog).toContain('Acknowledge')
    // What left is record detail — the audience-scoped links now live in the
    // workspace's Schedule tab, and nowhere else.
    expect(dialog).not.toContain('setVirtualLinks')
    expect(dialog).toContain('Open the session workspace')
    expect(
      read('routes/app.e.$eventSlug.sessions.$sessionId.tsx'),
    ).toContain('setVirtualLinks')
  })

  it('keeps the proposal detail a dialog, linking to the session it became', () => {
    // A proposal is a different record class — a submission, reviewed in the
    // CFP flow — so it keeps its dialog rather than gaining a third workspace.
    // What it owes the organizer is the hop to the session it materialized as.
    const dialog = read('components/abstracts/ProposalDetailDialog.tsx')
    expect(dialog).toContain('/app/e/$eventSlug/sessions/$sessionId')
  })

  it('keeps the top-level modules as batch views', () => {
    // Nothing was removed: the roster, the session list and the tasks module
    // are all still routes of their own.
    expect(read('routes/app.e.$eventSlug.speakers.index.tsx')).toContain(
      'Speaker roster',
    )
    expect(read('routes/app.e.$eventSlug.sessions.index.tsx')).toContain(
      'DataTable',
    )
  })
})
