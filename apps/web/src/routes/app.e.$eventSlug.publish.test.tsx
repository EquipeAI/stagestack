import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { getFunctionName } from 'convex/server'

// W10 — the publish center.
//
// What these pin down:
//   · lineup and schedule are SEPARATE decisions on screen: two cards, each
//     with its own state sentence, its own blockers and its own diff;
//   · every sentence reaches the screen VERBATIM — the state line (composed in
//     convex/model/controlCenter.ts, attribution included), the blockers (W4)
//     and the diff and eligibility arithmetic (W10's model functions);
//   · an empty diff disables publishing instead of pretending;
//   · a session-scoped repair lands on the session WORKSPACE tab, and the URL
//     it builds survives the workspace's own validateSearch.

const { state, mutations } = vi.hoisted(() => ({
  state: {
    lineupPublished: true,
    agendaPublished: false,
    lineupDiffEmpty: false,
    planLoading: false,
  },
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ eventSlug: 'devconf' }),
    useSearch: () => ({}),
    useNavigate: () => vi.fn(),
  }),
  Link: ({
    children,
    to,
    params,
    search,
  }: {
    children: React.ReactNode
    to: string
    params?: Record<string, string>
    search?: Record<string, unknown>
  }) => (
    <a
      href={to}
      data-params={JSON.stringify(params ?? {})}
      data-search={JSON.stringify(search ?? {})}
    >
      {children}
    </a>
  ),
}))

vi.mock('@clerk/tanstack-react-start', () => ({
  useAuth: () => ({ getToken: () => Promise.resolve('token') }),
}))

// Composed by convex/model/readiness.ts. The test asserts they reach the
// screen unchanged; it never re-derives them.
const PUBLICATION = [
  {
    sessionId: 's1',
    title: 'Agents in Production',
    publication: {
      inLineup: false,
      inAgenda: false,
      toBeAnnounced: false,
      reasons: [
        {
          code: 'content_draft',
          blocks: 'both',
          sentence: 'Content is Draft.',
          repair: {
            tab: 'sessions',
            params: { sessionId: 's1' },
            sessionTab: 'content',
          },
        },
      ],
      summary: 'Not public: content is Draft. Speaker and schedule are ready.',
    },
  },
  {
    sessionId: 's2',
    title: 'Beyond the Prompt',
    publication: {
      inLineup: true,
      inAgenda: false,
      toBeAnnounced: false,
      reasons: [
        {
          code: 'slot_not_released',
          blocks: 'agenda',
          sentence: 'The slot has not been released.',
          repair: { tab: 'agenda', params: { sessionId: 's2' } },
        },
      ],
      summary:
        'Public in lineup, not agenda: its session is approved and lineup-enabled, but the slot has not been released.',
    },
  },
]

const emptyDiff = (channel: 'lineup' | 'agenda', published: boolean) => ({
  added: [],
  changed: [],
  removed: [],
  empty: true,
  // Composed in convex/model/publish.ts: an empty diff on a channel that is
  // still OFF is not a no-op, and the sentence says what the action does.
  doesNothing: published,
  servedCount: 2,
  wouldBeCount: 2,
  sentence: published
    ? 'No changes to publish.'
    : channel === 'lineup'
      ? 'Turns the public page on. Nothing is eligible to appear yet.'
      : 'Publishes the schedule. Nothing is eligible to appear yet.',
  unpublishSentence: `Unpublishing the ${channel === 'lineup' ? 'lineup' : 'schedule'} removes 2 sessions from the public page.`,
})

const lineupDiff = () =>
  state.lineupDiffEmpty
    ? emptyDiff('lineup', state.lineupPublished)
    : {
        added: [{ id: 's2', title: 'Beyond the Prompt', changes: [] }],
        changed: [
          { id: 's1', title: 'Agents in Production', changes: ['title'] },
        ],
        removed: [],
        empty: false,
        doesNothing: false,
        servedCount: 1,
        wouldBeCount: 2,
        sentence:
          'Publishing the lineup adds 1 session, changes 1 (title), removes 0.',
        unpublishSentence:
          'Unpublishing the lineup removes 1 session from the public page.',
      }

vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args?: unknown) => {
    const name = getFunctionName(ref)
    if (args === 'skip') return undefined
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
        },
      }
    }
    if (name === 'publish:state') {
      return {
        lineupPublished: state.lineupPublished,
        agendaPublished: state.agendaPublished,
        stale: true,
        version: 4,
        publishedAt: 1_700_000_000_000,
        publishedSessionIds: ['s2'],
        publishedAgendaItemIds: [],
        acceptedSessions: 2,
        releasedSessions: 1,
        preview: {
          event: {
            name: 'DevConf',
            slug: 'devconf',
            startsAt: 1_000,
            endsAt: 2_000,
            timezone: 'UTC',
          },
          lineupPublished: state.lineupPublished,
          agendaPublished: state.agendaPublished,
          lineup: [],
          agenda: [],
        },
      }
    }
    if (name === 'publish:diff') {
      return {
        neverPublished: false,
        lineup: lineupDiff(),
        agenda: emptyDiff('agenda', state.agendaPublished),
      }
    }
    if (name === 'publish:bulkPlan') {
      if (state.planLoading) return undefined
      const channel = (args as { channel: string }).channel
      return channel === 'lineup'
        ? {
            channel: 'lineup',
            enablesChannel: false,
            targets: [
              {
                kind: 'session',
                id: 's2',
                title: 'Beyond the Prompt',
                alreadyPublished: true,
              },
            ],
            eligible: 1,
            alreadyPublished: 1,
            excluded: [
              {
                sessionId: 's1',
                title: 'Agents in Production',
                sentence: 'Content is Draft.',
              },
            ],
            sentence:
              '1 entry is eligible for the lineup — 1 already published, 0 would change. 1 session is excluded: 1 because content is Draft.',
          }
        : {
            channel: 'agenda',
            enablesChannel: true,
            targets: [],
            eligible: 0,
            alreadyPublished: 0,
            excluded: [],
            sentence: '0 entries are eligible for the schedule.',
          }
    }
    if (name === 'readiness:publication') return PUBLICATION
    if (name === 'readiness:upNext') {
      return {
        milestones: [],
        channels: [
          {
            id: 'lineup',
            label: 'Lineup',
            published: state.lineupPublished,
            sentence:
              'The public page is on, so the lineup is being served. Last published by Jordan Alvarez 3 hours ago.',
            link: { tab: 'publish' },
          },
          {
            id: 'agenda',
            label: 'Schedule',
            published: state.agendaPublished,
            sentence:
              'The schedule is not published, so no times are public. Last published by Jordan Alvarez 3 hours ago.',
            link: { tab: 'publish' },
          },
        ],
        version: 4,
      }
    }
    if (name === 'agenda:board') {
      return {
        sessions: [
          { sessionId: 's1', title: 'Agents in Production' },
          { sessionId: 's2', title: 'Beyond the Prompt' },
        ],
        agendaItems: [],
      }
    }
    if (name === 'embeds:list') return []
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
import { Route } from './app.e.$eventSlug.publish'
// eslint-disable-next-line import/first -- same
import type * as React from 'react'
// eslint-disable-next-line import/first -- same
import { parseSessionWorkspaceSearch } from '~/components/workspace/tabs'

const renderPage = () => {
  const Page = (Route as unknown as { component: React.ComponentType })
    .component
  return render(<Page />)
}

/** The card whose heading is `title` — the unit of the restructure. */
const card = (title: string): HTMLElement => {
  const heading = screen
    .getAllByText(title)
    .find((el) => el.className === 'ss-card__title')
  if (heading === undefined) throw new Error(`no card titled ${title}`)
  return heading.closest('section') as HTMLElement
}

beforeEach(() => {
  state.lineupPublished = true
  state.agendaPublished = false
  state.lineupDiffEmpty = false
  state.planLoading = false
  mutations.clear()
})

afterEach(cleanup)

describe('the publish center is two decisions', () => {
  it('gives each channel its own card, state sentence and diff', () => {
    renderPage()

    const lineup = card('Lineup')
    const schedule = card('Schedule')

    // The state sentence, including the attribution, printed verbatim from
    // the one producer (convex/model/controlCenter.ts).
    expect(
      within(lineup).getByText(
        'The public page is on, so the lineup is being served. Last published by Jordan Alvarez 3 hours ago.',
      ),
    ).toBeTruthy()
    expect(
      within(schedule).getByText(
        'The schedule is not published, so no times are public. Last published by Jordan Alvarez 3 hours ago.',
      ),
    ).toBeTruthy()

    // Each card carries its OWN diff sentence, composed by the model.
    expect(
      within(lineup).getByText(
        'Publishing the lineup adds 1 session, changes 1 (title), removes 0.',
      ),
    ).toBeTruthy()
    // The schedule is off, so its own sentence says what publishing it does
    // rather than "no changes" — the diff is empty, the action is not.
    expect(
      within(schedule).getByText(
        'Publishes the schedule. Nothing is eligible to appear yet.',
      ),
    ).toBeTruthy()
  })

  it('expands the diff into per-session rows with the changed fields named', () => {
    renderPage()
    const lineup = card('Lineup')
    fireEvent.click(
      within(lineup).getByRole('button', { name: /Show the lineup changes/ }),
    )
    const rows = within(lineup).getAllByRole('listitem')
    const text = rows.map((row) => row.textContent)
    expect(text.some((line) => line.includes('Beyond the Prompt'))).toBe(true)
    // A changed row names WHICH field changed.
    expect(
      text.some(
        (line) =>
          line.includes('Agents in Production') && line.includes('title'),
      ),
    ).toBe(true)
  })

  it('lists each channel’s blockers with W4’s sentences, verbatim', () => {
    renderPage()

    // Content approval blocks BOTH channels; the unreleased slot blocks only
    // the schedule, and the lineup card must not claim otherwise.
    const lineup = card('Lineup')
    expect(within(lineup).getByText('Content is Draft.')).toBeTruthy()
    expect(within(lineup).queryByText('The slot has not been released.')).toBe(
      null,
    )

    const schedule = card('Schedule')
    expect(within(schedule).getByText('Content is Draft.')).toBeTruthy()
    expect(
      within(schedule).getByText('The slot has not been released.'),
    ).toBeTruthy()
  })

  it('sends a session-scoped repair to the session workspace tab', () => {
    renderPage()
    const lineup = card('Lineup')
    const link = within(lineup)
      .getAllByRole('link')
      .find((a) => a.textContent === 'Open Content')!
    expect(link.getAttribute('href')).toBe(
      '/app/e/$eventSlug/sessions/$sessionId',
    )
    expect(JSON.parse(link.getAttribute('data-params')!)).toEqual({
      eventSlug: 'devconf',
      sessionId: 's1',
    })
    const search = JSON.parse(link.getAttribute('data-search')!)
    expect(search).toEqual({ tab: 'content' })
    // The link is built through the workspace's own validateSearch, so what it
    // asks for is what the route will parse.
    expect(parseSessionWorkspaceSearch(search)).toEqual(search)

    // An event-level repair still points at the board that owns it.
    const schedule = card('Schedule')
    const agendaLink = within(schedule)
      .getAllByRole('link')
      .find((a) => a.textContent === 'Open Agenda')!
    expect(agendaLink.getAttribute('href')).toBe('/app/e/$eventSlug/agenda')
  })
})

describe('publishing a channel', () => {
  it('states the eligibility arithmetic before it runs, then calls the bulk mutation', () => {
    renderPage()
    const lineup = card('Lineup')
    fireEvent.click(
      within(lineup).getByRole('button', { name: 'Republish the lineup' }),
    )

    const dialog = screen.getByRole('dialog')
    // W5's before-arithmetic, composed by the same model code the mutation
    // enforces — eligible, already published, and why the rest are excluded.
    expect(
      within(dialog).getByText(
        '1 entry is eligible for the lineup — 1 already published, 0 would change. 1 session is excluded: 1 because content is Draft.',
      ),
    ).toBeTruthy()
    expect(
      within(dialog).getByText(/Agents in Production — Content is Draft\./),
    ).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Republish' }))
    const call = mutations.get('publish:bulkPublish')
    expect(call).toBeDefined()
    expect(call!.mock.calls[0][0]).toEqual({
      eventSlug: 'devconf',
      channel: 'lineup',
    })
  })

  it('disables publishing when the diff is empty, and says so', () => {
    state.lineupDiffEmpty = true
    renderPage()
    const lineup = card('Lineup')
    // Already on, nothing to serve differently: the only honest no-op.
    expect(within(lineup).getByText('No changes to publish.')).toBeTruthy()
    expect(
      within(lineup)
        .getByRole('button', { name: 'Republish the lineup' })
        .hasAttribute('disabled'),
    ).toBe(true)
  })

  it('still lets an organizer turn an empty channel ON, and says what that does', () => {
    renderPage()
    // The schedule is off and nothing is eligible for it yet. Turning it on is
    // a real action the mutation supports — publishing it now means the next
    // released session appears without a second decision.
    const schedule = card('Schedule')
    const button = within(schedule).getByRole('button', {
      name: 'Publish the schedule',
    })
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(
      within(schedule).getByText(
        'Publishes the schedule. Nothing is eligible to appear yet.',
      ),
    ).toBeTruthy()
    // And it does not pretend a content change is coming.
    expect(within(schedule).queryByText(/adds \d+ entr/)).toBe(null)
  })

  it('waits for the arithmetic rather than confirming against numbers it lacks', () => {
    state.planLoading = true
    renderPage()
    const lineup = card('Lineup')
    fireEvent.click(
      within(lineup).getByRole('button', { name: 'Republish the lineup' }),
    )
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Counting what is eligible…')).toBeTruthy()
    expect(
      within(dialog)
        .getByRole('button', { name: 'Republish' })
        .hasAttribute('disabled'),
    ).toBe(true)
  })

  it('offers unpublish only where something is being served, with the count', () => {
    renderPage()
    const schedule = card('Schedule')
    // The schedule is off: there is nothing to take down.
    expect(within(schedule).queryByRole('button', { name: 'Unpublish' })).toBe(
      null,
    )

    const lineup = card('Lineup')
    fireEvent.click(within(lineup).getByRole('button', { name: 'Unpublish' }))
    const dialog = screen.getByRole('dialog')
    expect(
      within(dialog).getByText(
        'Unpublishing the lineup removes 1 session from the public page.',
      ),
    ).toBeTruthy()
  })
})

describe('what the restructure keeps', () => {
  it('keeps the embed console and the per-entry toggles on the same route', () => {
    renderPage()
    expect(card('Embeds')).toBeTruthy()
    expect(card('Share')).toBeTruthy()
    // The per-session toggles now live inside the lineup card.
    const lineup = card('Lineup')
    fireEvent.click(
      within(lineup).getByRole('button', { name: /Per-session toggles/ }),
    )
    expect(
      within(lineup).getByRole('switch', {
        name: 'Release to the public page: Agents in Production',
      }),
    ).toBeTruthy()
  })
})
