import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { getFunctionName } from 'convex/server'
import type * as React from 'react'

// The abstracts surface is the organizer's primary CFP view, and the query
// behind it is CAPPED. H5's frontend half: when the cap bites, the organizer
// must SEE it — the old page rendered "Showing 500 of 500" for a 700-proposal
// event, which is data loss nobody can notice. These tests pin the visible
// half of that fix (the backend half lives in convex/cfp.test.ts).

const { state, navigate } = vi.hoisted(() => ({
  // Mutable per test: what `cfp:listProposals` answers, and which status chip
  // the URL has selected.
  state: {
    capped: false,
    rows: [] as Array<unknown>,
    queue: undefined as undefined | { rows: Array<unknown>; capped: boolean },
    statuses: undefined as string | undefined,
    /** Args of every listProposals subscription, in order. */
    calls: [] as Array<unknown>,
  },
  navigate: vi.fn(() => Promise.resolve()),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ eventSlug: 'devconf' }),
    useSearch: () => (state.statuses === undefined ? {} : { status: state.statuses }),
    useNavigate: () => navigate,
  }),
}))

vi.mock('convex/react', () => ({
  useQuery: (
    ref: Parameters<typeof getFunctionName>[0],
    args?: 'skip' | { status?: string },
  ) => {
    const name = getFunctionName(ref)
    if (name === 'events:get') {
      return { role: 'organizer', event: { name: 'DevConf', timezone: 'UTC' } }
    }
    if (name === 'cfp:listProposals') {
      if (args === 'skip') return undefined
      state.calls.push(args)
      // A single-status chip re-reads that status on its own index: that second
      // subscription is what makes narrowing actually reach past the cap.
      if (args !== undefined && args.status !== undefined) return state.queue
      return { rows: state.rows, capped: state.capped }
    }
    if (name === 'cfp:getForm') return { published: null, working: null }
    if (name === 'reviews:progress') return []
    return undefined
  },
  useMutation: () => vi.fn(),
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { Route } from './app.e.$eventSlug.proposals'

function proposal(id: string, title: string, status = 'pending') {
  return {
    proposal: {
      _id: id,
      _creationTime: 1,
      eventId: 'e1',
      submitterUserId: 'u1',
      status,
      title,
      answers: {},
      formVersion: 1,
      updatedAt: 1,
    },
    speakerCount: 1,
  }
}

function renderPage() {
  const Page = (Route as unknown as { component: React.ComponentType }).component
  return render(<Page />)
}

afterEach(() => {
  cleanup()
  navigate.mockClear()
  state.capped = false
  state.rows = []
  state.queue = undefined
  state.statuses = undefined
  state.calls.length = 0
})

describe('abstracts read cap (H5)', () => {
  it('says so, and stops claiming a total it does not have, when the list is capped', () => {
    state.rows = [proposal('p1', 'Convex in anger'), proposal('p2', 'Signals')]
    state.capped = true
    renderPage()

    expect(screen.getByText('This list is not the whole CFP')).toBeTruthy()
    // The count must not read "2 of 2" while two more pages exist behind it.
    expect(screen.getByText(/Showing 2 of 2\+/)).toBeTruthy()
    expect(screen.queryByText('Showing 2 of 2', { exact: true })).toBeNull()
  })

  it('tells the organizer what to DO about it, not just that rows are missing', () => {
    state.rows = [proposal('p1', 'Convex in anger')]
    state.capped = true
    renderPage()

    const callout = screen.getByText('This list is not the whole CFP').parentElement
    const copy = callout?.textContent ?? ''
    // The actionable instruction, and the honest scope of what is on screen.
    expect(copy).toMatch(/Narrow to a single status/)
    expect(copy).toMatch(/search, sorting and export cover just those/)
  })

  it('narrowing to one status subscribes to that status on its own index', () => {
    state.rows = [proposal('p1', 'Convex in anger')]
    state.capped = true
    state.statuses = 'accepted'
    state.queue = { rows: [proposal('p9', 'From the queue', 'accepted')], capped: false }
    renderPage()

    expect(state.calls).toContainEqual({ eventSlug: 'devconf', status: 'accepted' })
    // The queue's own rows are what the table shows…
    expect(screen.getByText('From the queue')).toBeTruthy()
    // …the queue itself is complete, so the "not the whole CFP" warning goes…
    expect(screen.queryByText('This list is not the whole CFP')).toBeNull()
    expect(screen.getByText(/Showing 1 of 1$/)).toBeTruthy()
    // …but the chips still count a capped page, and that is said out loud
    // rather than left to look exact.
    expect(screen.getByText('Status counts are partial')).toBeTruthy()
  })

  it('shows no callout at all when the list is whole, so it never becomes furniture', () => {
    state.rows = [proposal('p1', 'Convex in anger')]
    renderPage()

    expect(screen.queryByText('This list is not the whole CFP')).toBeNull()
    expect(screen.getByText(/Showing 1 of 1$/)).toBeTruthy()
  })
})
