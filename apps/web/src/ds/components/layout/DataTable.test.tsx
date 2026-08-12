import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DataTable } from './DataTable.jsx'

// W12, the DS half of the table standard:
//   · a table waiting on its query renders a skeleton AND says so in words;
//   · under 640px an operational table is a card list, not a scroller, and
//     selection and row activation work identically in both renderings.

/** jsdom ships no matchMedia; these tests supply one so the component can be
 * asked the same question a phone would ask it. */
function setViewport(narrow: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: narrow && query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
}

const COLUMNS = [
  { key: 'title', header: 'Session' },
  { key: 'owner', header: 'Owner' },
]
const ROWS = [
  { id: 's1', title: 'Convex in anger', owner: 'Ada' },
  { id: 's2', title: 'Signals', owner: 'Grace' },
]

beforeEach(() => {
  setViewport(false)
})

afterEach(() => {
  cleanup()
})

describe('DataTable loading state', () => {
  it('renders skeleton rows and an announced sentence, not a bare spinner', () => {
    render(
      <DataTable
        aria-label="Sessions"
        loading
        loadingLabel="Loading the session roster…"
        rows={[]}
        columns={COLUMNS}
        skeletonRows={4}
      />,
    )

    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Loading the session roster…')
    // The table is mid-update, and assistive tech is told so.
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBe('true')
    // The header row survives, so the table does not resize when rows land.
    expect(screen.getByText('Session')).toBeTruthy()
    expect(document.querySelectorAll('.ss-table__skeleton-row')).toHaveLength(4)
    // The placeholder bars themselves say nothing — the sentence above does.
    for (const row of document.querySelectorAll('.ss-table__skeleton-row')) {
      expect(row.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('stops being busy once the rows arrive', () => {
    render(<DataTable aria-label="Sessions" rows={ROWS} columns={COLUMNS} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBeNull()
  })
})

describe('DataTable card list under 640px', () => {
  it('renders a table on a desktop viewport even when cardRow is supplied', () => {
    render(
      <DataTable
        aria-label="Sessions"
        rows={ROWS}
        columns={COLUMNS}
        cardRow={(row: { title: string }) => <span>{row.title}</span>}
      />,
    )
    expect(screen.getByRole('table')).toBeTruthy()
    expect(document.querySelector('.ss-cardlist')).toBeNull()
  })

  it('renders one card per row instead of the table below the breakpoint', () => {
    setViewport(true)
    render(
      <DataTable
        aria-label="Sessions"
        rows={ROWS}
        columns={COLUMNS}
        cardRow={(row: { title: string }) => <span>{row.title}</span>}
      />,
    )
    // Not a table at all: no header row to scroll sideways past.
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('Convex in anger')).toBeTruthy()
  })

  it('keeps the horizontal scroller when no card rendering is offered', () => {
    // Comparison views (review results) are genuinely tabular — the columns
    // ARE the content, so they keep scrolling rather than becoming cards.
    setViewport(true)
    render(<DataTable aria-label="Review results" rows={ROWS} columns={COLUMNS} />)
    expect(screen.getByRole('table')).toBeTruthy()
  })

  it('selection and row activation work from the card list too', () => {
    setViewport(true)
    const opened: Array<string> = []
    const toggled: Array<string> = []
    render(
      <DataTable
        aria-label="Sessions"
        rows={ROWS}
        columns={COLUMNS}
        selectedIds={['s2']}
        onRowClick={(row: { id: string }) => opened.push(row.id)}
        cardRow={(row: { id: string; title: string }) => (
          <>
            <input
              type="checkbox"
              aria-label={`Select ${row.title}`}
              onChange={() => toggled.push(row.id)}
            />
            <span>{row.title}</span>
          </>
        )}
      />,
    )

    // The same `selectedIds` the table renders as a band marks the card.
    const cards = document.querySelectorAll('.ss-cardlist__card')
    expect(cards[0].getAttribute('data-selected')).toBe('false')
    expect(cards[1].getAttribute('data-selected')).toBe('true')

    // Ticking a box inside the card selects — it does not open the record.
    fireEvent.click(screen.getByLabelText('Select Signals'))
    expect(toggled).toEqual(['s2'])
    expect(opened).toEqual([])

    // Tapping the card itself opens the workspace…
    fireEvent.click(cards[0])
    expect(opened).toEqual(['s1'])

    // …and so does Enter, so the card list is not mouse-only.
    fireEvent.keyDown(cards[1], { key: 'Enter' })
    expect(opened).toEqual(['s1', 's2'])
  })

  it('shows the loading skeleton in the card rendering as well', () => {
    setViewport(true)
    render(
      <DataTable
        aria-label="Sessions"
        loading
        loadingLabel="Loading sessions…"
        rows={[]}
        columns={COLUMNS}
        cardRow={() => null}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('Loading sessions…')
    expect(document.querySelectorAll('.ss-skeleton-card').length).toBeGreaterThan(0)
  })
})
