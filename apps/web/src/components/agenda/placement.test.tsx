import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TimeGrid } from './TimeGrid'
import {
  DEFAULT_DURATION_MS,
  HOUR_MS,
  HOUR_PX,
  HOUR_PX_PLACING,
  MIN_BLOCK_PX,
  MIN_MS,
  SLOT_TAP_PX,
  SNAP_MIN,
  dayKey,
  dayStartMs,
  durationOf,
  eventDayKeys,
  hourRange,
  parseSlotDroppableId,
  sessionBlock,
  slotDroppableId,
} from './model'
import type { BoardEvent, PlacedBlock } from './model'
import type { Id } from '@convex/_generated/dataModel'

// The placement math convex-test can never reach: the 15-minute snap encoded
// in the slot-droppable lattice, and the overlap-lane layout that keeps two
// clashing blocks side by side instead of hidden under each other.

const DAY = '2026-08-09'
const ZONE = 'UTC'
const dayStart = dayStartMs(DAY, ZONE)

/** A placed block `h0`:`m0`–`h1`:`m1` on the test day. No session/item payload:
 * lane math and geometry only read the interval. */
function blk(id: string, h0: number, m0: number, h1: number, m1: number): PlacedBlock {
  return {
    kind: 'item',
    id,
    title: id,
    startsAt: dayStart + h0 * HOUR_MS + m0 * MIN_MS,
    endsAt: dayStart + h1 * HOUR_MS + m1 * MIN_MS,
    conflicts: [],
  }
}

describe('slot droppable ids (the snap lattice)', () => {
  it('round-trips a column key that itself contains the separator', () => {
    const key = `${DAY}|room:abc`
    const ms = dayStart + 9 * HOUR_MS + SNAP_MIN * MIN_MS
    expect(parseSlotDroppableId(slotDroppableId(key, ms))).toEqual({
      columnKey: key,
      ms,
    })
  })

  it('rejects anything that is not a slot id', () => {
    expect(parseSlotDroppableId('tray')).toBeNull()
    expect(parseSlotDroppableId('slot|')).toBeNull()
    expect(parseSlotDroppableId('slot|c1|not-a-number')).toBeNull()
  })
})

describe('durationOf (drop keeps the block length)', () => {
  it('preserves a real duration and falls back to the default for degenerate ones', () => {
    expect(durationOf(blk('a', 9, 0, 9, 30))).toBe(30 * MIN_MS)
    expect(durationOf(blk('z', 9, 0, 9, 0))).toBe(DEFAULT_DURATION_MS)
  })

  // W13/W2. A tray card has no interval, so before the format library every
  // dragged Lightning Talk landed as an hour. The session's own resolved
  // duration answers instead; the hour is the last fallback.
  it('uses the session’s resolved duration for a card that has no interval', () => {
    const tray = sessionBlock({
      sessionId: 's1' as Id<'sessions'>,
      title: 'Lightning talk',
      durationMinutes: 10,
      pendingRelease: false,
      participants: [],
      conflicts: [],
    })
    expect(durationOf(tray)).toBe(10 * MIN_MS)
  })
})

describe('day + hour extent', () => {
  const event = {
    startsAt: dayStart + 9 * HOUR_MS + 30 * MIN_MS,
    endsAt: dayStart + 17 * HOUR_MS + 30 * MIN_MS,
    timezone: ZONE,
  } as BoardEvent

  it('rounds the event hours outward to whole hours', () => {
    expect(hourRange(event, [])).toEqual({ startHour: 9, endHour: 18 })
  })

  it('widens for blocks scheduled outside event hours', () => {
    expect(hourRange(event, [blk('setup', 7, 15, 8, 0)])).toEqual({
      startHour: 7,
      endHour: 18,
    })
  })

  it('enumerates every event day, across a spring-forward DST day', () => {
    const zone = 'America/New_York'
    const start = dayStartMs('2026-03-07', zone) + 9 * HOUR_MS
    // March 8 2026 is only 23h long in New York; day math must not skip it.
    const end = dayStartMs('2026-03-09', zone) + 17 * HOUR_MS
    const dstEvent = { startsAt: start, endsAt: end, timezone: zone } as BoardEvent
    expect(eventDayKeys(dstEvent)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09'])
    expect(dayKey(end, zone)).toBe('2026-03-09')
  })
})

describe('TimeGrid lane layout', () => {
  afterEach(cleanup)

  function renderGrid(blocks: Array<PlacedBlock>) {
    const { container } = render(
      <TimeGrid
        columns={[{ key: `${DAY}|c0`, label: 'Room A', dayKey: DAY, blocks }]}
        hours={{ startHour: 9, endHour: 12 }}
        zone={ZONE}
        roomsById={new Map()}
        tracksById={new Map()}
        secondary="room"
        activeId={null}
        onOpenBlock={() => undefined}
      />,
    )
    return container
  }

  /** The absolutely-positioned wrapper TimeGrid gave the block titled `id`. */
  function blockEl(container: HTMLElement, id: string): HTMLElement {
    const spans = [...container.querySelectorAll('span')].filter(
      (s) => s.textContent === id,
    )
    let el: HTMLElement | null = spans[0] ?? null
    while (el !== null && el.style.position !== 'absolute') {
      el = el.parentElement
    }
    if (el === null) throw new Error(`no positioned block for "${id}"`)
    return el
  }

  // W13. Height IS the duration on this grid, so it has to be proportional —
  // and where it cannot be (a block shorter than MIN_BLOCK_PX is unreadable at
  // its true height), the block says it was drawn taller rather than lying.
  it('draws a block’s height in proportion to its duration', () => {
    const container = renderGrid([blk('half', 9, 0, 9, 30), blk('quarter', 10, 0, 10, 45)])
    expect(blockEl(container, 'half').style.height).toBe(`${HOUR_PX / 2}px`)
    expect(blockEl(container, 'quarter').style.height).toBe(`${HOUR_PX * 0.75}px`)
  })

  it('clamps a block below the readable floor and marks it as drawn taller', () => {
    const container = renderGrid([blk('lightning', 9, 0, 9, 10)])
    // 10 minutes is 10.67px at HOUR_PX — its own title would not fit.
    expect(blockEl(container, 'lightning').style.height).toBe(`${MIN_BLOCK_PX}px`)
    // Named as an image, not a bare span with an aria-label AT may ignore —
    // the accessible name has to resolve for the clamp to be readable at all.
    const mark = screen.getByRole('img', {
      name: '10 minutes — drawn taller so it stays readable.',
    })
    expect(mark.textContent).toBe('10m')
    expect(container.querySelector('[data-clamped="true"]')).toBe(mark)
  })

  it('leaves a block at or above the floor unmarked', () => {
    const container = renderGrid([blk('talk', 9, 0, 9, 30)])
    expect(container.querySelector('[data-clamped="true"]')).toBeNull()
  })

  // Tap-to-place zooms the time axis so one 15-minute cell clears W6's coarse
  // pointer target floor. Same lattice, same ids — only the pixels change.
  it('gives every armed cell a thumb-sized target', () => {
    const { container } = render(
      <TimeGrid
        columns={[{ key: `${DAY}|c0`, label: 'Room A', dayKey: DAY, blocks: [] }]}
        hours={{ startHour: 9, endHour: 10 }}
        zone={ZONE}
        roomsById={new Map()}
        tracksById={new Map()}
        secondary="room"
        activeId={null}
        onOpenBlock={() => undefined}
        hourPx={HOUR_PX_PLACING}
        eligibility={
          new Map(
            [0, 1, 2, 3].map((i) => [
              slotDroppableId(`${DAY}|c0`, dayStart + 9 * HOUR_MS + i * 15 * MIN_MS),
              [],
            ]),
          )
        }
        onSlotTap={() => undefined}
      />,
    )
    const cells = [...container.querySelectorAll('[data-slot-eligible]')]
    expect(cells).toHaveLength(4)
    for (const cell of cells) {
      expect((cell as HTMLElement).style.height).toBe(`${SLOT_TAP_PX}px`)
    }
  })

  it('renders a droppable cell per 15-minute snap increment', () => {
    const container = renderGrid([])
    const slotPx = `${(SNAP_MIN / 60) * HOUR_PX}px`
    const cells = [...container.querySelectorAll('div')].filter(
      (d) => d.style.height === slotPx,
    )
    // 3 hours × 4 slots — the lattice IS the snap: a drop can only land on one.
    expect(cells).toHaveLength(12)
  })

  it('keeps a lone block full width and positions it by time', () => {
    const container = renderGrid([blk('C', 11, 0, 12, 0)])
    const c = blockEl(container, 'C')
    expect(c.style.left).toBe('calc(0% + var(--space-half))')
    expect(c.style.width).toBe('calc(100% - var(--space-1))')
    expect(c.style.top).toBe(`${2 * HOUR_PX}px`)
    expect(c.style.height).toBe(`${HOUR_PX}px`)
  })

  it('splits genuine overlaps into lanes and reuses a freed lane', () => {
    const container = renderGrid([
      blk('A', 9, 0, 10, 0),
      blk('B', 9, 30, 10, 30),
      blk('E', 10, 0, 11, 0), // overlaps B only — must reuse A's lane
      blk('C', 11, 0, 12, 0), // separate cluster — stays full width
    ])
    const a = blockEl(container, 'A')
    const b = blockEl(container, 'B')
    const e = blockEl(container, 'E')
    const c = blockEl(container, 'C')

    expect(a.style.left).toBe('calc(0% + var(--space-half))')
    expect(a.style.width).toBe('calc(50% - var(--space-1))')
    expect(b.style.left).toBe('calc(50% + var(--space-half))')
    expect(b.style.width).toBe('calc(50% - var(--space-1))')
    expect(e.style.left).toBe('calc(0% + var(--space-half))')
    expect(e.style.width).toBe('calc(50% - var(--space-1))')
    // The lone block is untouched by the neighbouring cluster.
    expect(c.style.width).toBe('calc(100% - var(--space-1))')

    expect(a.style.top).toBe('0px')
    expect(b.style.top).toBe(`${HOUR_PX / 2}px`)
    expect(e.style.top).toBe(`${HOUR_PX}px`)
  })
})
