import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ConflictList, conflictSummary } from './ConflictList'
import { BlockCard } from './Block'
import { HOUR_MS, MIN_MS, dayStartMs } from './model'
import type { BoardConflict, PlacedBlock } from './model'

// W6. A conflict used to be readable in exactly one place per kind: a session's
// in its detail dialog, an agenda item's only in a hover tooltip on the board —
// which a touch device never opens and a screen reader never sees. These cover
// the two halves of the fix: the mark carries the whole reason in its
// accessible name and distinguishes blocker from warning by shape, and the
// sentences render as text in a list both dialogs use.

const DAY = '2026-08-09'
const dayStart = dayStartMs(DAY, 'UTC')

function conflict(over: Partial<BoardConflict> = {}): BoardConflict {
  return {
    kind: 'room',
    level: 'blocker',
    withType: 'session',
    withId: 'x1',
    withTitle: 'Opening keynote',
    message: 'Same room as "Opening keynote".',
    ...over,
  }
}

function block(conflicts: Array<BoardConflict>): PlacedBlock {
  return {
    kind: 'item',
    id: 'b1',
    title: 'Lunch',
    startsAt: dayStart + 12 * HOUR_MS,
    endsAt: dayStart + 12 * HOUR_MS + 45 * MIN_MS,
    conflicts,
  }
}

/** BlockCard with the board context a conflict mark does not depend on. */
function Card({ block: b }: { block: PlacedBlock }) {
  return (
    <BlockCard
      block={b}
      zone="UTC"
      roomsById={new Map()}
      tracksById={new Map()}
      secondary="room"
    />
  )
}

afterEach(cleanup)

describe('conflictSummary', () => {
  it('leads with the level and carries the reason', () => {
    expect(conflictSummary([conflict()])).toBe(
      'Blocker: Same room as "Opening keynote".',
    )
  })

  it('says warning when nothing is a blocker', () => {
    const summary = conflictSummary([
      conflict({ kind: 'track', level: 'warning', message: 'Same track as "A".' }),
    ])
    expect(summary).toBe('Warning: Same track as "A".')
  })

  it('reports the count and every blocking reason when there are several', () => {
    const summary = conflictSummary([
      conflict({ message: 'Same room as "A".' }),
      conflict({ kind: 'speaker', message: 'The same speaker is booked on "B".' }),
      conflict({ kind: 'track', level: 'warning', message: 'Same track as "C".' }),
    ])
    // Warnings are dropped once a blocker exists: the blocker is what has to
    // be fixed, and the summary is one spoken sentence, not the whole list.
    expect(summary).toBe(
      'Blocker (3 conflicts): Same room as "A". The same speaker is booked on "B".',
    )
  })

  it('is empty when there is nothing to say', () => {
    expect(conflictSummary([])).toBe('')
  })
})

describe('the conflict mark on a block', () => {
  it('names the reason rather than leaving it in a hover-only tooltip', () => {
    render(<Card block={block([conflict()])} />)

    expect(
      screen.getByRole('img', {
        name: 'Blocker: Same room as "Opening keynote".',
      }),
    ).toBeTruthy()
  })

  it('distinguishes blocker from warning by shape, not only by colour', () => {
    const { container: blocker } = render(<Card block={block([conflict()])} />)
    const { container: warning } = render(
      <Card
        block={block([
          conflict({ kind: 'track', level: 'warning', message: 'Same track as "A".' }),
        ])}
      />,
    )

    const glyph = (root: HTMLElement) =>
      root.querySelector('[role="img"] svg')?.getAttribute('data-icon') ??
      root.querySelector('[role="img"] svg path')?.getAttribute('d')

    expect(glyph(blocker)).toBeTruthy()
    expect(glyph(blocker)).not.toBe(glyph(warning))
  })

  it('renders no mark at all when there is no conflict', () => {
    const { container } = render(<Card block={block([])} />)
    expect(container.querySelector('[role="img"]')).toBeNull()
  })
})

describe('ConflictList', () => {
  it('prints the level as a word and the sentence verbatim', () => {
    render(
      <ConflictList
        conflicts={[
          conflict(),
          conflict({ kind: 'track', level: 'warning', message: 'Same track as "A".' }),
        ]}
      />,
    )

    expect(screen.getByText('Blocker')).toBeTruthy()
    expect(screen.getByText('Warning')).toBeTruthy()
    expect(screen.getByText('Same room as "Opening keynote".')).toBeTruthy()
    expect(screen.getByText('Same track as "A".')).toBeTruthy()
  })

  it('renders nothing when there are no conflicts', () => {
    const { container } = render(<ConflictList conflicts={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
