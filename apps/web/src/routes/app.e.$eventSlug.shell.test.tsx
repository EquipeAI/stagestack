import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { getFunctionName } from 'convex/server'
import type * as React from 'react'

// The event shell (W7): lifecycle groups, attention badges, the mobile drawer,
// and the Decisions deep link. These are the behaviours a broken shell would
// take the whole product down with, so each one is pinned here rather than
// left to a browser pass.

type ShellState = {
  pathname: string
  search: { status?: string }
  role: string
  /** What `readiness:attention` answers. `throw` simulates an outage. */
  attention: undefined | 'throw' | { counts: Record<string, number>; capped: boolean }
}

const { state, navigate } = vi.hoisted(() => {
  const shell: ShellState = {
    pathname: '/app/e/devconf',
    search: {},
    role: 'organizer',
    attention: undefined,
  }
  return { state: shell, navigate: vi.fn(() => Promise.resolve()) }
})

/** Stands in for whatever child route is rendered under the layout. */
let child: React.ComponentType | null = null

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ eventSlug: 'devconf' }),
  }),
  useLocation: ({ select }: { select: (l: unknown) => unknown }) =>
    select({ pathname: state.pathname, search: state.search }),
  useNavigate: () => navigate,
  Outlet: () => (child === null ? <div data-testid="outlet" /> : <Child />),
}))

vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref)
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
    if (name === 'readiness:attention') {
      if (state.attention === 'throw') throw new Error('event_too_large')
      return state.attention
    }
    return undefined
  },
  useMutation: () => vi.fn(),
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { Route } from './app.e.$eventSlug'
// eslint-disable-next-line import/first -- same
import { useEventHeaderSlot } from '~/components/shell/EventHeader'

function Child() {
  const Rendered = child
  return Rendered === null ? null : <Rendered />
}

function renderShell() {
  const Page = (Route as unknown as { component: React.ComponentType }).component
  return render(<Page />)
}

function counts(overrides: Record<string, number> = {}) {
  return {
    counts: {
      proposals: 0,
      reviews: 0,
      sessions: 0,
      speakers: 0,
      agenda: 0,
      tasks: 0,
      publish: 0,
      ...overrides,
    },
    capped: false,
  }
}

beforeEach(() => {
  state.pathname = '/app/e/devconf'
  state.search = {}
  state.role = 'organizer'
  state.attention = undefined
  child = null
  navigate.mockClear()
})

afterEach(cleanup)

describe('the lifecycle rail', () => {
  it('groups the entries by lifecycle step', () => {
    renderShell()
    for (const label of [
      'Setup',
      'Collect',
      'Select',
      'Prepare',
      'Schedule',
      'Publish',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('marks the active entry with aria-current, by prefix', () => {
    state.pathname = '/app/e/devconf/sessions/abc123'
    renderShell()
    const current = screen.getAllByRole('button', { current: 'page' })
    expect(current.length).toBe(1)
    expect(current[0].textContent).toContain('Sessions')
  })

  it('keeps a renamed entry findable by its old label', () => {
    renderShell()
    // "Speaker tasks" is now "Tasks", and "Publish" is now "Public page" —
    // both still answer to the old wording by accessible name.
    expect(
      screen.getByRole('button', { name: /^Tasks, also called Speaker tasks$/ }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /^Public page, also called Publish$/ }),
    ).toBeTruthy()
    // The merged root answers to the page it absorbed.
    expect(
      screen.getByRole('button', { name: /^Overview, also called Dashboard$/ }),
    ).toBeTruthy()
  })
})

describe('role-conditional entries', () => {
  it('shows a reviewer only the entries that are theirs', () => {
    state.role = 'reviewer'
    renderShell()
    expect(screen.queryByRole('button', { name: /Proposals/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Decisions/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Settings/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Reviews/ })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /^Overview, also called Dashboard$/ }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /Event details/ })).toBeTruthy()
  })

  it('drops an emptied group rather than showing an empty heading', () => {
    state.role = 'reviewer'
    renderShell()
    // Collect, Schedule and Publish are organizer-only in their entirety.
    expect(screen.queryByText('Collect')).toBeNull()
    expect(screen.queryByText('Schedule')).toBeNull()
    expect(screen.getAllByText('Select').length).toBeGreaterThan(0)
  })
})

describe('attention counts', () => {
  it('renders a count on the entry it belongs to', () => {
    state.attention = counts({ proposals: 7 })
    renderShell()
    expect(
      screen.getByRole('button', { name: /^Proposals, 7 needing attention$/ }),
    ).toBeTruthy()
  })

  it('renders nothing for an empty queue', () => {
    state.attention = counts()
    renderShell()
    const reviews = screen.getByRole('button', { name: /^Reviews$/ })
    expect(reviews.querySelector('.ss-navitem__count')).toBeNull()
  })

  it('renders a capped read as a floor, not an exact total', () => {
    state.attention = { ...counts({ sessions: 500 }), capped: true }
    renderShell()
    expect(
      screen.getByRole('button', {
        name: /^Sessions, at least 500 needing attention$/,
      }),
    ).toBeTruthy()
  })

  it('degrades to no badges when the counts query fails, and never blocks navigation', () => {
    state.attention = 'throw'
    renderShell()
    // The whole rail is still here and still navigable.
    const agenda = screen.getByRole('button', { name: /^Agenda$/ })
    expect(agenda.querySelector('.ss-navitem__count')).toBeNull()
    fireEvent.click(agenda)
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/agenda',
      params: { eventSlug: 'devconf' },
    })
  })

  it('never asks for counts as a reviewer', () => {
    state.role = 'reviewer'
    // A reviewer asking the organizer-only query would fail every time; the
    // shell must not ask at all. If it did, this would throw.
    state.attention = 'throw'
    expect(() => renderShell()).not.toThrow()
  })
})

describe('the Decisions entry', () => {
  it('deep-links into Proposals with the staged-decision filter', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: /Decisions/ }))
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/proposals',
      params: { eventSlug: 'devconf' },
      search: { status: 'acceptQueue,declineQueue' },
    })
  })

  it('is the entry that reads as current on that URL', () => {
    state.pathname = '/app/e/devconf/proposals'
    state.search = { status: 'acceptQueue,declineQueue' }
    renderShell()
    const current = screen.getAllByRole('button', { current: 'page' })
    expect(current.length).toBe(1)
    expect(current[0].textContent).toContain('Decisions')
  })

  it('leaves Proposals current under any other filter', () => {
    state.pathname = '/app/e/devconf/proposals'
    state.search = { status: 'pending' }
    renderShell()
    const current = screen.getAllByRole('button', { current: 'page' })
    expect(current[0].textContent).toContain('Proposals')
  })
})

describe('the mobile drawer', () => {
  const menu = () =>
    screen.getByRole('button', { name: /^Event menu/ })

  it('names itself with the attention total before it is opened', () => {
    state.attention = counts({ proposals: 2, tasks: 1 })
    renderShell()
    expect(menu().getAttribute('aria-label')).toBe(
      'Event menu · 3 items need attention',
    )
    expect(menu().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens a modal drawer holding the groups and counts', () => {
    state.attention = counts({ proposals: 4 })
    renderShell()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(menu())
    const drawer = screen.getByRole('dialog')
    expect(drawer.getAttribute('aria-modal')).toBe('true')
    expect(drawer.className).toContain('ss-drawer')
    expect(within(drawer).getByText('Prepare')).toBeTruthy()
    expect(
      within(drawer).getByRole('button', { name: /^Proposals, 4 needing attention$/ }),
    ).toBeTruthy()
    expect(menu().getAttribute('aria-expanded')).toBe('true')
  })

  it('moves focus into the drawer on open and back to the button on close', () => {
    renderShell()
    const button = menu()
    button.focus()
    fireEvent.click(button)
    const drawer = screen.getByRole('dialog')
    expect(drawer.contains(document.activeElement)).toBe(true)

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(menu())
  })

  it('traps Tab inside the drawer', () => {
    renderShell()
    fireEvent.click(menu())
    const drawer = screen.getByRole('dialog')
    const focusables = within(drawer).getAllByRole('button')
    const last = focusables[focusables.length - 1]
    last.focus()
    fireEvent.keyDown(drawer, { key: 'Tab' })
    expect(drawer.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(focusables[0])
  })

  it('closes on Escape', () => {
    renderShell()
    fireEvent.click(menu())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes when an entry is chosen, and navigates', () => {
    renderShell()
    fireEvent.click(menu())
    const drawer = screen.getByRole('dialog')
    fireEvent.click(within(drawer).getByRole('button', { name: /^Team$/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/team',
      params: { eventSlug: 'devconf' },
    })
  })

  it('says where you are without being opened', () => {
    state.pathname = '/app/e/devconf/agenda'
    const { container } = renderShell()
    const bar = container.querySelector('.app-shell__bar')
    expect(bar?.textContent).toContain('Schedule')
    expect(bar?.textContent).toContain('Agenda')
  })
})

describe('the route-aware header', () => {
  it('keeps the three levels when no route contributes', () => {
    const { container } = renderShell()
    const crumbs = container.querySelector('.ss-pageheader__crumbs') as HTMLElement
    expect(crumbs.textContent).toContain('My StageStack')
    expect(crumbs.textContent).toContain('Acme')
    expect(crumbs.textContent).toContain('DevConf')
    // The event is the last crumb, so it is not a link to itself.
    expect(
      within(crumbs).queryByRole('link', { name: 'DevConf' }),
    ).toBeNull()
  })

  it('lets a deeper route contribute a crumb and a title', () => {
    child = function Workspace() {
      useEventHeaderSlot({
        title: 'Keynote: the long now',
        description: 'Session workspace',
        crumbs: [
          { label: 'Sessions', href: '/app/e/devconf/sessions' },
          { label: 'Keynote' },
        ],
      })
      return <p>workspace</p>
    }
    const { container } = renderShell()
    const crumbs = container.querySelector('.ss-pageheader__crumbs') as HTMLElement
    // Four levels, and the event becomes the way back up rather than the leaf.
    expect(within(crumbs).getByRole('link', { name: 'DevConf' })).toBeTruthy()
    expect(within(crumbs).getByRole('link', { name: 'Sessions' })).toBeTruthy()
    expect(crumbs.textContent).toContain('Keynote')
    // One header, not two: the route's title replaces the event's.
    expect(
      screen.getByRole('heading', { name: /Keynote: the long now/ }),
    ).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^DevConf/ })).toBeNull()
    expect(screen.getByText('Session workspace')).toBeTruthy()
  })

  it('goes back to the event name when that route unmounts', () => {
    child = function Workspace() {
      useEventHeaderSlot({ title: 'Keynote', crumbs: [{ label: 'Keynote' }] })
      return null
    }
    const { unmount } = renderShell()
    expect(screen.getByRole('heading', { name: /Keynote/ })).toBeTruthy()
    unmount()
    child = null
    renderShell()
    expect(screen.getByRole('heading', { name: /DevConf/ })).toBeTruthy()
  })
})
