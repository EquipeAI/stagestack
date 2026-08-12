import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { getFunctionName } from 'convex/server'
import type * as React from 'react'

// The Dashboard/Overview merge (W7, decision 5). The event root is now
// role-conditional, and that is the whole point of the test: the root was a
// page reviewers and speakers could always open, while the dashboard was
// organizer-only, so a plain route swap would have greeted every non-organizer
// with a refusal.

const { state } = vi.hoisted(() => ({
  state: { role: 'organizer' },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ eventSlug: 'devconf' }),
  }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args?: unknown) => {
    const name = getFunctionName(ref)
    if (name === 'events:get') {
      return {
        role: state.role,
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
    if (name === 'tasks:dashboard') {
      return {
        totals: {
          confirmed: 1,
          awaiting: 0,
          declined: 0,
          withdrawn: 0,
          acceptedSpeakers: 1,
          missingProfile: 0,
          overdue: 0,
        },
        speakers: [],
        sessions: [],
      }
    }
    if (name === 'tasks:listInstances') return []
    return undefined
  },
  useMutation: () => vi.fn(),
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { Route } from './app.e.$eventSlug.index'

function renderRoot() {
  const Page = (Route as unknown as { component: React.ComponentType }).component
  return render(<Page />)
}

beforeEach(() => {
  state.role = 'organizer'
})
afterEach(cleanup)

describe('the event root', () => {
  it('gives an organizer the operational control center', () => {
    renderRoot()
    // What `/dashboard` used to render, now at the root.
    expect(screen.getByText('Session readiness')).toBeTruthy()
    expect(screen.getByText('Confirmed')).toBeTruthy()
    // …and not the stable facts, which have their own page now.
    expect(screen.queryByText('Archive')).toBeNull()
  })

  it('gives a reviewer the event facts rather than an organizer-only refusal', () => {
    state.role = 'reviewer'
    renderRoot()
    expect(screen.getByText('Event details')).toBeTruthy()
    expect(screen.getAllByText('Call for speakers').length).toBeGreaterThan(0)
    expect(screen.queryByText('Session readiness')).toBeNull()
    expect(screen.queryByText(/organizer-only/)).toBeNull()
  })
})
