import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { getFunctionName } from 'convex/server'

// The command palette (W1). What is worth breaking the build over:
//   • the BUTTON. A palette only a keyboard shortcut can open is invisible to
//     anyone who was not told about it;
//   • the keyboard model — arrows move the highlight, Enter opens it, and the
//     field never loses focus;
//   • the deep links. A row that lands on an unfiltered list is a row that
//     did not answer the question;
//   • the sentence under the field is the SERVER's, verbatim.

type SearchResults = {
  groups: Array<{
    kind: string
    label: string
    hits: Array<{
      kind: string
      id: string
      eventSlug: string
      title: string
      subtitle?: string
      query?: string
    }>
    capped: boolean
    sentence: string
  }>
  summary: string
}

const { state, navigate } = vi.hoisted(() => {
  const shell: {
    eventSlug: string | undefined
    role: string
    results: SearchResults | undefined
    lastArgs: unknown
  } = {
    eventSlug: 'devconf',
    role: 'organizer',
    results: undefined,
    lastArgs: undefined,
  }
  return { state: shell, navigate: vi.fn(() => Promise.resolve()) }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ eventSlug: state.eventSlug }),
}))

vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(ref)
    if (args === 'skip') return undefined
    if (name === 'search:everything') {
      state.lastArgs = args
      return state.results
    }
    if (name === 'events:get') return { role: state.role }
    return undefined
  },
  useMutation: () => vi.fn(),
}))

vi.mock('~/lib/useProvisioning', () => ({
  useProvisioning: () => ({
    isLoading: false,
    isAuthenticated: true,
    provisioned: true,
    error: null,
    retry: () => {},
  }),
}))

// eslint-disable-next-line import/first -- vi.mock is hoisted above this
import { GlobalSearch } from './GlobalSearch'

function open() {
  render(<GlobalSearch />)
  fireEvent.click(screen.getByRole('button', { name: 'Search StageStack' }))
  return screen.getByRole('combobox')
}

/** Type and let the 150ms debounce elapse, as a real keystroke would. */
function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } })
  act(() => {
    vi.advanceTimersByTime(200)
  })
}

function results(): SearchResults {
  return {
    summary: '3 results in 3 groups. Use the arrow keys to pick one, Enter to open it.',
    groups: [
      {
        kind: 'session',
        label: 'Sessions',
        capped: false,
        sentence: '1 session match.',
        hits: [
          {
            kind: 'session',
            id: 'sess_1',
            eventSlug: 'devconf',
            title: 'Agents in Production',
            subtitle: 'Talk',
          },
        ],
      },
      {
        kind: 'speaker',
        label: 'Speakers',
        capped: false,
        sentence: '1 speaker match.',
        hits: [
          {
            kind: 'speaker',
            id: 'contact_1',
            eventSlug: 'devconf',
            title: 'Grace Hopper',
            subtitle: 'Rear Admiral, US Navy',
          },
        ],
      },
      {
        kind: 'proposal',
        label: 'Proposals',
        capped: false,
        sentence: '1 proposal match.',
        hits: [
          {
            kind: 'proposal',
            id: 'prop_1',
            eventSlug: 'devconf',
            title: 'Agentic testing',
            subtitle: 'Submitted',
            query: 'Agentic testing',
          },
        ],
      },
    ],
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  state.eventSlug = 'devconf'
  state.role = 'organizer'
  state.results = undefined
  state.lastArgs = undefined
  navigate.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('opening it', () => {
  it('has a visible button in the topbar, not only a shortcut', () => {
    render(<GlobalSearch />)
    const button = screen.getByRole('button', { name: 'Search StageStack' })
    expect(button.textContent).toContain('Search')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('keeps its name when the word collapses on a phone', () => {
    // REGRESSION (browser walk, W1): the 86px button landed on top of the
    // event title at 375px [measured]. Below 640px `.topbar__search-label` is
    // display:none, so the word has to be a separate element — and the
    // accessible name has to come from `aria-label`, never from that word, or
    // the collapse would take the name with it.
    render(<GlobalSearch />)
    const button = screen.getByRole('button', { name: 'Search StageStack' })
    expect(button.getAttribute('aria-label')).toBe('Search StageStack')
    expect(button.className).toContain('topbar__search')
    const word = button.querySelector('.topbar__search-label')
    expect(word?.textContent).toBe('Search')
    // The icon is what remains once the word is hidden: it is not the label.
    expect(button.querySelector('svg')).toBeTruthy()
  })

  it('opens on Cmd-K and on Ctrl-K', () => {
    render(<GlobalSearch />)
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    cleanup()

    render(<GlobalSearch />)
    fireEvent.keyDown(document, { key: 'K', ctrlKey: true })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('closes on Escape', () => {
    open()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('labels the field and lists the results as a listbox', () => {
    const field = open()
    expect(field.getAttribute('aria-label')).toBe(
      'Search events, sessions, speakers and proposals',
    )
    expect(field.getAttribute('aria-controls')).toBe(
      screen.getByRole('listbox').getAttribute('id'),
    )
  })
})

describe('with nothing typed', () => {
  it('offers the event nav destinations', () => {
    open()
    const go = screen.getByRole('group', { name: 'Go to' })
    const labels = within(go)
      .getAllByRole('option')
      .map((row) => String(row.textContent))
    expect(labels.some((l) => l.includes('Sessions'))).toBe(true)
    expect(labels.some((l) => l.includes('Agenda'))).toBe(true)
  })

  it('offers a reviewer only what a reviewer can open', () => {
    state.role = 'reviewer'
    open()
    const labels = screen
      .getAllByRole('option')
      .map((row) => String(row.textContent))
    expect(labels.some((l) => l.includes('Reviews'))).toBe(true)
    expect(labels.some((l) => l.includes('Settings'))).toBe(false)
    expect(labels.some((l) => l.includes('Proposals'))).toBe(false)
  })

  it('does not query the backend for an empty term', () => {
    open()
    expect(state.lastArgs).toBeUndefined()
  })
})

describe('jumping to a destination', () => {
  it('finds a renamed surface by its old label and navigates there', () => {
    const field = open()
    type(field, 'speaker tasks')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/tasks',
      params: { eventSlug: 'devconf' },
    })
  })

  it('sends Decisions to the proposals route with its staged filter', () => {
    const field = open()
    type(field, 'decisions')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/proposals',
      params: { eventSlug: 'devconf' },
      search: { status: 'acceptQueue,declineQueue' },
    })
  })
})

describe('with results', () => {
  it('groups them and prints the server sentence verbatim', () => {
    state.results = results()
    const field = open()
    type(field, 'ag')

    expect(state.lastArgs).toEqual({ term: 'ag', eventSlug: 'devconf' })
    expect(screen.getByRole('group', { name: 'Sessions' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Speakers' })).toBeTruthy()
    expect(
      screen.getByText(
        '3 results in 3 groups. Use the arrow keys to pick one, Enter to open it.',
      ),
    ).toBeTruthy()
  })

  it('moves the highlight with the arrow keys, keeping focus in the field', () => {
    state.results = results()
    const field = open()
    type(field, 'ag')
    // The first destination is highlighted to begin with.
    const first = screen.getAllByRole('option')[0]
    expect(first.getAttribute('aria-selected')).toBe('true')
    expect(field.getAttribute('aria-activedescendant')).toBe(first.id)

    fireEvent.keyDown(field, { key: 'ArrowDown' })
    const second = screen.getAllByRole('option')[1]
    expect(second.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(field)

    fireEvent.keyDown(field, { key: 'End' })
    const rows = screen.getAllByRole('option')
    expect(rows[rows.length - 1].getAttribute('aria-selected')).toBe('true')
  })

  it('opens a session in its workspace', () => {
    state.results = results()
    const field = open()
    type(field, 'ag')
    fireEvent.click(screen.getByRole('option', { name: /Agents in Production/ }))
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/sessions/$sessionId',
      params: { eventSlug: 'devconf', sessionId: 'sess_1' },
    })
  })

  it('opens a speaker in their workspace', () => {
    state.results = results()
    const field = open()
    type(field, 'ag')
    fireEvent.click(screen.getByRole('option', { name: /Grace Hopper/ }))
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/speakers/$eventContactId',
      params: { eventSlug: 'devconf', eventContactId: 'contact_1' },
    })
  })

  it('lands a proposal on the proposals table already filtered to it', () => {
    state.results = results()
    const field = open()
    type(field, 'ag')
    fireEvent.click(screen.getByRole('option', { name: /Agentic testing/ }))
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/proposals',
      params: { eventSlug: 'devconf' },
      search: { q: 'Agentic testing' },
    })
  })

  it("sends a reviewer's assignment to Reviews", () => {
    state.role = 'reviewer'
    state.results = {
      summary: '1 result in 1 group. Use the arrow keys to pick one, Enter to open it.',
      groups: [
        {
          kind: 'review',
          label: 'Your reviews',
          capped: false,
          sentence: '1 assigned proposal match.',
          hits: [
            {
              kind: 'review',
              id: 'prop_9',
              eventSlug: 'devconf',
              title: 'Agentic testing',
              subtitle: 'Assigned to you',
            },
          ],
        },
      ],
    }
    const field = open()
    type(field, 'agentic')
    fireEvent.click(screen.getByRole('option', { name: /Agentic testing/ }))
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug/reviews',
      params: { eventSlug: 'devconf' },
    })
  })

  it('jumps between events when the palette is open outside one', () => {
    state.eventSlug = undefined
    state.results = {
      summary: '1 result in 1 group. Use the arrow keys to pick one, Enter to open it.',
      groups: [
        {
          kind: 'event',
          label: 'Events',
          capped: false,
          sentence: '1 event match.',
          hits: [
            {
              kind: 'event',
              id: 'event_1',
              eventSlug: 'other-conf',
              title: 'Other Conf',
            },
          ],
        },
      ],
    }
    const field = open()
    type(field, 'other')
    // No destinations without an event — the palette is not in one.
    expect(screen.queryByRole('group', { name: 'Go to' })).toBeNull()
    expect(state.lastArgs).toEqual({ term: 'other', eventSlug: undefined })
    fireEvent.click(screen.getByRole('option', { name: /Other Conf/ }))
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/e/$eventSlug',
      params: { eventSlug: 'other-conf' },
    })
  })
})
