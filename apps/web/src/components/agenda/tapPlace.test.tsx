import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { getFunctionName } from 'convex/server'
import { AgendaBoard } from './AgendaBoard'
import { PlaceDialog } from './PlaceDialog'
import {
  boardScheduledThings,
  eligibleSlots,
  hourRange,
  parseSlotDroppableId,
  placedBlocks,
  placementRequest,
  sessionBlock,
  sessionDurationMs,
  slotIsEligible,
} from './model'
import { parseAgendaSearch } from './search'
import type { Board, BoardSession } from './model'
import type { Id } from '@convex/_generated/dataModel'

// The board's only backend contact is `useMutation`. Mocking the module (rather
// than wrapping a provider) keeps these tests about the board's own behaviour,
// and lets them assert WHICH mutation each gesture called, with what — the
// point of the exercise, since tap-to-place must reach the same one a drop
// does.
const { mutationCalls, backend, spoken } = vi.hoisted(() => ({
  mutationCalls: [] as Array<{ fn: unknown; args: unknown }>,
  /** Flip to make every mutation refuse, the way a locked event does. */
  backend: { refuseWith: null as string | null },
  spoken: [] as Array<{ message: string; politeness: string }>,
}))
vi.mock('convex/react', () => ({
  useMutation: (fn: unknown) => (args: unknown) => {
    mutationCalls.push({ fn, args })
    return backend.refuseWith === null
      ? Promise.resolve(undefined)
      : Promise.reject(new Error(backend.refuseWith))
  },
}))
// The live region is the board's announcement channel for tap-to-place (W6),
// and `usePending` speaks failures through the same module — so one mock
// captures both and proves nothing is said twice or too early.
vi.mock('~/lib/announce', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  announce: (message: string, politeness = 'polite') => {
    spoken.push({ message, politeness })
  },
}))

/** Every `agenda:scheduleSession` call this test has provoked. Matched by
 * function NAME: the generated `api` object is a proxy, so two reads of the
 * same reference are not the same object. */
function scheduleCalls(): Array<unknown> {
  return mutationCalls
    .filter(
      (c) =>
        getFunctionName(c.fn as Parameters<typeof getFunctionName>[0]) ===
        'agenda:scheduleSession',
    )
    .map((c) => c.args)
}

// W13. Four promises, asserted here: the client's conflict input matches the
// server's rule (withdrawn/declined speakers cannot collide), an armed session
// highlights exactly the cells that are legal, a tap writes the SAME placement
// request a drop writes, and an ineligible tap says why in words.

const ZONE = 'UTC'
const DAY_START = Date.parse('2026-09-01T00:00:00Z')
const HOUR = 60 * 60 * 1000
const MIN = 60 * 1000
const EVENT_START = DAY_START + 9 * HOUR
const EVENT_END = DAY_START + 17 * HOUR
const ROOM1 = 'room1' as Id<'rooms'>
const ROOM2 = 'room2' as Id<'rooms'>

function session(overrides: Partial<BoardSession> = {}): BoardSession {
  return {
    sessionId: 's1' as Id<'sessions'>,
    title: 'Lightning talk',
    durationMinutes: 60,
    pendingRelease: false,
    participants: [],
    conflicts: [],
    ...overrides,
  }
}

function board(overrides: Partial<Board> = {}): Board {
  return {
    event: {
      slug: 'acme',
      name: 'Acme Summit',
      startsAt: EVENT_START,
      endsAt: EVENT_END,
      timezone: ZONE,
    },
    rooms: [
      { roomId: ROOM1, name: 'Main Stage', order: 0 },
      { roomId: ROOM2, name: 'Side Room', order: 1 },
    ],
    tracks: [],
    sessions: [],
    agendaItems: [],
    ...overrides,
  }
}

/** One placed keynote in Main Stage, 10:00–11:00, plus one tray session. */
function boardWithKeynote(trayOver: Partial<BoardSession> = {}): Board {
  return board({
    sessions: [
      session({
        sessionId: 'keynote' as Id<'sessions'>,
        title: 'Opening keynote',
        startsAt: DAY_START + 10 * HOUR,
        endsAt: DAY_START + 11 * HOUR,
        roomId: ROOM1,
      }),
      session(trayOver),
    ],
  })
}

afterEach(() => {
  cleanup()
  mutationCalls.length = 0
  spoken.length = 0
  backend.refuseWith = null
})

// ── The adapter ────────────────────────────────────────────────────────────

describe('boardScheduledThings (client → conflict engine)', () => {
  test('skips unplaced sessions and carries room, track and speakers', () => {
    const things = boardScheduledThings(
      board({
        sessions: [
          session({
            sessionId: 'placed' as Id<'sessions'>,
            startsAt: DAY_START + 10 * HOUR,
            endsAt: DAY_START + 11 * HOUR,
            roomId: ROOM1,
            trackId: 't1' as Id<'tracks'>,
            participants: [
              {
                participantId: 'p1' as Id<'sessionParticipants'>,
                eventContactId: 'c1' as Id<'eventContacts'>,
                firstName: 'Bob',
                lastName: 'Speaker',
                state: 'confirmed',
              },
            ],
          }),
          session({ sessionId: 'tray' as Id<'sessions'> }),
        ],
        agendaItems: [
          {
            itemId: 'lunch' as Id<'agendaItems'>,
            title: 'Lunch',
            startsAt: DAY_START + 12 * HOUR,
            endsAt: DAY_START + 13 * HOUR,
            roomId: ROOM2,
            conflicts: [],
          },
        ],
      }),
    )

    expect(things.map((t) => t.id)).toEqual(['placed', 'lunch'])
    expect(things[0]).toMatchObject({
      type: 'session',
      roomId: ROOM1,
      trackId: 't1',
      speakerIds: ['c1'],
    })
    expect(things[1]).toMatchObject({ type: 'agendaItem', speakerIds: [] })
  })

  test('excludes withdrawn and declined speakers — they hold no slot', () => {
    const states = ['awaiting', 'confirmed', 'declined', 'withdrawn'] as const
    const things = boardScheduledThings(
      board({
        sessions: [
          session({
            startsAt: DAY_START + 10 * HOUR,
            endsAt: DAY_START + 11 * HOUR,
            participants: states.map((state, i) => ({
              participantId: `p${i}` as Id<'sessionParticipants'>,
              eventContactId: `c-${state}` as Id<'eventContacts'>,
              firstName: 'A',
              lastName: 'B',
              state,
            })),
          }),
        ],
      }),
    )

    expect(things[0].speakerIds).toEqual(['c-awaiting', 'c-confirmed'])
  })
})

// ── Eligibility ────────────────────────────────────────────────────────────

describe('eligibleSlots', () => {
  const hours = hourRange(boardWithKeynote().event, placedBlocks(boardWithKeynote()))
  const columns = [
    { key: ROOM1 as string, dayKey: '2026-09-01' },
    { key: ROOM2 as string, dayKey: '2026-09-01' },
  ]

  test('marks exactly the cells a 60-minute block would collide in', () => {
    const map = eligibleSlots({
      board: boardWithKeynote(),
      session: session(),
      view: 'room',
      columns,
      hours,
      zone: ZONE,
    })

    // 09:00–17:00 at four cells an hour, per column.
    expect(map.size).toBe(2 * 8 * 4)
    const blocked = [...map.entries()]
      .filter(([, conflicts]) => !slotIsEligible(conflicts))
      .map(([id]) => parseSlotDroppableId(id))
    // Only Main Stage, and only the starts whose hour-long block runs into the
    // keynote: 09:15 (ends 10:15) through 10:45. 09:00 ends exactly at 10:00,
    // and a half-open interval does not overlap.
    expect(blocked.every((s) => s?.columnKey === ROOM1)).toBe(true)
    expect(blocked.map((s) => (s === null ? 0 : (s.ms - DAY_START) / MIN))).toEqual(
      [555, 570, 585, 600, 615, 630, 645],
    )
    expect(blocked).toHaveLength(7)
  })

  test('a shorter session fits where an hour does not', () => {
    const map = eligibleSlots({
      board: boardWithKeynote({ durationMinutes: 15 }),
      session: session({ durationMinutes: 15 }),
      view: 'room',
      columns,
      hours,
      zone: ZONE,
    })
    const blocked = [...map.entries()].filter(
      ([, conflicts]) => !slotIsEligible(conflicts),
    )
    // 10:00, 10:15, 10:30, 10:45 — the keynote's own hour, nothing before it.
    expect(blocked).toHaveLength(4)
  })

  test('a withdrawn co-speaker does not make a cell ineligible', () => {
    const shared = 'c-shared' as Id<'eventContacts'>
    const speaker = (state: 'confirmed' | 'withdrawn') => ({
      participantId: `p-${state}` as Id<'sessionParticipants'>,
      eventContactId: shared,
      firstName: 'Wanda',
      lastName: 'Withdrawn',
      state,
    })
    const base = board({
      sessions: [
        session({
          sessionId: 'placed' as Id<'sessions'>,
          title: 'Opening keynote',
          startsAt: DAY_START + 10 * HOUR,
          endsAt: DAY_START + 11 * HOUR,
          roomId: ROOM2,
          participants: [speaker('withdrawn')],
        }),
        session({ participants: [speaker('withdrawn')] }),
      ],
    })
    const map = eligibleSlots({
      board: base,
      session: session({ participants: [speaker('withdrawn')] }),
      view: 'room',
      // Side Room only, so the keynote's own room is the column under test.
      columns: [{ key: ROOM2, dayKey: '2026-09-01' }],
      hours,
      zone: ZONE,
    })
    const blocked = [...map.values()].filter((c) => !slotIsEligible(c))
    // Every refusal is the ROOM, never the shared withdrawn speaker.
    expect(blocked.length).toBeGreaterThan(0)
    expect(blocked.flat().every((c) => c.kind === 'room')).toBe(true)
  })
})

// ── One placement request, three gestures ──────────────────────────────────

describe('placementRequest', () => {
  test('a tray card dropped and the same card tapped write the same request', () => {
    const tray = session({ durationMinutes: 10 })
    const ms = DAY_START + 14 * HOUR
    const dropped = placementRequest({
      view: 'room',
      block: sessionBlock(tray),
      columnKey: ROOM1,
      ms,
    })
    const tapped = placementRequest({
      view: 'room',
      block: sessionBlock(tray),
      columnKey: ROOM1,
      ms,
    })
    expect(tapped).toEqual(dropped)
    // …and the block is the session's own length, not a default hour.
    expect(dropped).toEqual({
      kind: 'session',
      sessionId: 's1',
      slot: { startsAt: ms, endsAt: ms + 10 * MIN, roomId: ROOM1 },
    })
  })

  test('only the Room view rewrites the room', () => {
    const placed = sessionBlock(
      session({ startsAt: DAY_START + 9 * HOUR, endsAt: DAY_START + 10 * HOUR, roomId: ROOM2 }),
    )
    const ms = DAY_START + 15 * HOUR
    expect(
      placementRequest({ view: 'day', block: placed, columnKey: 'day', ms }),
    ).toMatchObject({ slot: { roomId: ROOM2 } })
    expect(
      placementRequest({ view: 'room', block: placed, columnKey: 'noroom', ms }),
    ).toMatchObject({ slot: { roomId: undefined } })
  })
})

// ── The board, driven ──────────────────────────────────────────────────────

function renderBoard(props: Partial<Parameters<typeof AgendaBoard>[0]> = {}) {
  return render(
    <AgendaBoard
      eventSlug="acme"
      board={boardWithKeynote()}
      view="room"
      day="2026-09-01"
      room={undefined}
      onView={vi.fn()}
      onDay={vi.fn()}
      onRoom={vi.fn()}
      {...props}
    />,
  )
}

/** The grid columns actually rendered, in order. */
function columnKeys(container: HTMLElement): Array<string> {
  return [...container.querySelectorAll('[data-column]')].map(
    (el) => el.getAttribute('data-column') ?? '',
  )
}

/** Arm the tray session for tap-to-place, the way a finger does. The card is
 * NOT the control — it holds three of them (drag handle, Choose slot, Place…),
 * so it is a plain container. */
function armTrayCard() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose slot' }))
}

describe('tap to place', () => {
  test('arming a tray session highlights only the free cells', () => {
    const { container } = renderBoard()
    expect(container.querySelectorAll('[data-slot-eligible]')).toHaveLength(0)

    armTrayCard()

    const cells = container.querySelectorAll('[data-slot-eligible]')
    expect(cells).toHaveLength(2 * 8 * 4)
    const free = container.querySelectorAll('[data-slot-eligible="true"]')
    expect(free).toHaveLength(2 * 8 * 4 - 7)
    // The banner states the same arithmetic the cells draw.
    expect(document.body.textContent).toContain('Placing "Lightning talk"')
    expect(document.body.textContent).toContain('57 slots are free')
  })

  test('tapping a free cell sends the same request a drop would', () => {
    renderBoard()
    armTrayCard()

    const ms = DAY_START + 14 * HOUR
    const cell = screen.getByRole('button', { name: 'Free — 14:00 in Main Stage' })
    fireEvent.click(cell)

    const expected = placementRequest({
      view: 'room',
      block: sessionBlock(session()),
      columnKey: ROOM1,
      ms,
    })
    // The mutation reference itself is asserted, not just the payload: the tap
    // path goes through the board's one `submitPlacement`, exactly as a drop
    // does.
    expect(scheduleCalls()).toEqual([
      {
        eventSlug: 'acme',
        sessionId: 's1',
        slot: expected.kind === 'session' ? expected.slot : null,
      },
    ])
  })

  test('tapping a taken cell explains why, in the conflict engine’s own words', () => {
    renderBoard()
    armTrayCard()

    fireEvent.click(
      screen.getByRole('button', { name: 'Taken — 10:00 in Main Stage' }),
    )

    expect(scheduleCalls()).toEqual([])
    expect(document.body.textContent).toContain(
      'Same room as "Opening keynote".',
    )
    expect(document.body.textContent).toContain("10:00 in Main Stage isn't free")
  })

  test('escape cancels, and so does tapping the arming control again', () => {
    const { container } = renderBoard()

    armTrayCard()
    expect(container.querySelectorAll('[data-slot-eligible]').length).toBe(64)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelectorAll('[data-slot-eligible]')).toHaveLength(0)

    armTrayCard()
    fireEvent.click(screen.getByRole('button', { name: 'Choosing slot' }))
    expect(container.querySelectorAll('[data-slot-eligible]')).toHaveLength(0)
    expect(scheduleCalls()).toEqual([])
  })

  test('the arming control is a real button, so Enter and Space reach it', () => {
    const { container } = renderBoard()
    const choose = screen.getByRole('button', { name: 'Choose slot' })
    // A native <button> is activated by Enter and Space by the platform; the
    // keyboard path needs no handler of its own, and none is registered.
    expect(choose.tagName).toBe('BUTTON')
    expect(choose.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(choose)

    expect(
      screen.getByRole('button', { name: 'Choosing slot' }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(container.querySelectorAll('[data-slot-eligible]')).toHaveLength(64)
  })

  test('the tray card is a container, not a button wrapping buttons', () => {
    renderBoard()
    const card = screen.getByText('Lightning talk').closest('div') as HTMLElement
    // No ancestor of the card's own controls is itself interactive.
    for (const control of card.querySelectorAll('button')) {
      expect(control.closest('[role="button"]')).toBe(control.closest('button'))
    }
    // The drag handle is the draggable, and it names itself.
    expect(
      screen.getByRole('button', { name: 'Drag "Lightning talk" onto the grid' }),
    ).toBeTruthy()
  })
})

describe('taps that land on a block', () => {
  /** Main Stage keynote 10:00–11:00, plus an UNASSIGNED block at the same time
   * (no room, so it collides with nothing), plus the tray session. */
  function boardWithBlockedAndFreeFootprints(): Board {
    return board({
      sessions: [
        session({
          sessionId: 'keynote' as Id<'sessions'>,
          title: 'Opening keynote',
          startsAt: DAY_START + 10 * HOUR,
          endsAt: DAY_START + 11 * HOUR,
          roomId: ROOM1,
        }),
        session({
          sessionId: 'roomless' as Id<'sessions'>,
          title: 'Sponsor demo',
          startsAt: DAY_START + 10 * HOUR,
          endsAt: DAY_START + 11 * HOUR,
        }),
        session(),
      ],
    })
  }

  /** The absolutely-positioned wrapper the grid gave the block titled `title`. */
  function blockEl(container: HTMLElement, title: string): HTMLElement {
    const label = [...container.querySelectorAll('span')].find(
      (el) => el.textContent === title,
    )
    let node: HTMLElement | null = label ?? null
    while (node !== null && node.style.position !== 'absolute') {
      node = node.parentElement
    }
    if (node === null) throw new Error(`no positioned block for "${title}"`)
    return node
  }

  test('a block does not swallow the tap — an occupied cell still explains itself', () => {
    const { container } = renderBoard({
      board: boardWithBlockedAndFreeFootprints(),
    })
    armTrayCard()

    fireEvent.click(blockEl(container, 'Opening keynote'))

    // Routed to the cell under the block, which is taken by that same block.
    expect(scheduleCalls()).toEqual([])
    expect(document.body.textContent).toContain(
      'Same room as "Opening keynote".',
    )
    expect(document.body.textContent).toContain("10:00 in Main Stage isn't free")
    // …and the block's own detail dialog did not open over the placement
    // (it would have rendered its title into the document).
    expect(screen.queryByText('Edit placement')).toBeNull()
  })

  test('a block over a LEGAL cell places into it rather than blocking the tap', async () => {
    const { container } = renderBoard({
      board: boardWithBlockedAndFreeFootprints(),
    })
    armTrayCard()

    // The Unassigned column's block holds no room, so nothing collides there.
    fireEvent.click(blockEl(container, 'Sponsor demo'))
    await Promise.resolve()

    expect(scheduleCalls()).toEqual([
      {
        eventSlug: 'acme',
        sessionId: 's1',
        slot: {
          startsAt: DAY_START + 10 * HOUR,
          endsAt: DAY_START + 11 * HOUR,
          roomId: undefined,
        },
      },
    ])
  })

  test('a block goes back to being itself once nothing is armed', () => {
    const { container } = renderBoard({
      board: boardWithBlockedAndFreeFootprints(),
    })
    const keynote = blockEl(container, 'Opening keynote')
    // Unarmed, the block is not a placement target and says nothing about
    // slots — its click opens the detail dialog, as it always did.
    expect(keynote.getAttribute('aria-label')).toBeNull()

    armTrayCard()
    expect(blockEl(container, 'Opening keynote').getAttribute('aria-label')).toBe(
      'Opening keynote — choose the slot underneath it',
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(blockEl(container, 'Opening keynote').getAttribute('aria-label')).toBeNull()
    expect(scheduleCalls()).toEqual([])
  })
})

describe('what the board says out loud', () => {
  test('says “placed” only after the backend has taken it', async () => {
    renderBoard()
    armTrayCard()
    spoken.length = 0

    fireEvent.click(
      screen.getByRole('button', { name: 'Free — 14:00 in Main Stage' }),
    )
    // Nothing claimed yet — the mutation has not resolved.
    expect(spoken.map((s) => s.message)).toEqual([])

    await Promise.resolve()
    await Promise.resolve()
    expect(spoken.filter((s) => s.message.includes('placed at 14:00'))).toHaveLength(1)
  })

  test('a refused placement never claims success, and is announced once', async () => {
    backend.refuseWith = 'This event is archived.'
    renderBoard()
    armTrayCard()
    spoken.length = 0

    fireEvent.click(
      screen.getByRole('button', { name: 'Free — 14:00 in Main Stage' }),
    )
    for (let i = 0; i < 5; i += 1) await Promise.resolve()

    expect(spoken.some((s) => s.message.includes('placed'))).toBe(false)
    // Exactly one failure sentence, from usePending, assertively.
    expect(spoken).toEqual([
      { message: 'This event is archived.', politeness: 'assertive' },
    ])
  })

  test('an ineligible tap speaks the conflict once, assertively', () => {
    renderBoard()
    armTrayCard()
    spoken.length = 0

    fireEvent.click(
      screen.getByRole('button', { name: 'Taken — 10:00 in Main Stage' }),
    )

    expect(spoken).toEqual([
      {
        message:
          '10:00 in Main Stage is not free. Same room as "Opening keynote".',
        politeness: 'assertive',
      },
    ])
  })
})

// ── Scoping pickers ────────────────────────────────────────────────────────

describe('day and room scoping', () => {
  test('the search vocabulary round-trips view, day and room', () => {
    expect(
      parseAgendaSearch({ view: 'track', day: '2026-09-01', room: 'room1' }),
    ).toEqual({ view: 'track', day: '2026-09-01', room: 'room1' })
    // Junk is dropped rather than passed to the board.
    expect(parseAgendaSearch({ room: 'slot|room1|123' }).room).toBeUndefined()
    expect(parseAgendaSearch({}).room).toBeUndefined()
  })

  test('the picker writes the chosen column to the URL', () => {
    const onRoom = vi.fn()
    renderBoard({ onRoom })
    fireEvent.change(screen.getByLabelText('Room'), { target: { value: ROOM2 } })
    expect(onRoom).toHaveBeenCalledWith(ROOM2)

    fireEvent.change(screen.getByLabelText('Room'), { target: { value: '' } })
    expect(onRoom).toHaveBeenLastCalledWith(undefined)
  })

  test('a scoped board renders one column, and still places into it', () => {
    const { container } = renderBoard({ room: ROOM2 })
    expect(columnKeys(container)).toEqual([ROOM2])

    armTrayCard()
    // One column of cells, every one of them free (the keynote is elsewhere).
    expect(container.querySelectorAll('[data-slot-eligible]')).toHaveLength(32)
    expect(container.querySelectorAll('[data-slot-eligible="true"]')).toHaveLength(32)

    fireEvent.click(
      screen.getByRole('button', { name: 'Free — 10:00 in Side Room' }),
    )
    expect(scheduleCalls()).toEqual([
      {
        eventSlug: 'acme',
        sessionId: 's1',
        slot: {
          startsAt: DAY_START + 10 * HOUR,
          endsAt: DAY_START + 11 * HOUR,
          roomId: ROOM2,
        },
      },
    ])
  })

  test('a scope pointing at a column that no longer exists shows the whole board', () => {
    const { container } = renderBoard({ room: 'deleted' })
    expect(columnKeys(container)).toEqual([ROOM1, ROOM2])
  })
})

// ── Duration-accurate defaults ─────────────────────────────────────────────

describe('PlaceDialog default end', () => {
  const event = board().event

  function endValue(): string {
    return screen.getByLabelText<HTMLInputElement>(/End/).value
  }

  test('offers the session’s own duration, not a fixed hour', () => {
    render(
      <PlaceDialog
        eventSlug="acme"
        event={event}
        session={session({ durationMinutes: 10 })}
        rooms={[]}
        onClose={vi.fn()}
      />,
    )
    // The event opens at 09:00, so a 10-minute Lightning Talk ends at 09:10.
    expect(endValue()).toBe('2026-09-01T09:10')
  })

  test('a 120-minute format gets two hours', () => {
    render(
      <PlaceDialog
        eventSlug="acme"
        event={event}
        session={session({ durationMinutes: 120 })}
        rooms={[]}
        onClose={vi.fn()}
      />,
    )
    expect(endValue()).toBe('2026-09-01T11:00')
  })

  test('an already placed session keeps the times it has', () => {
    render(
      <PlaceDialog
        eventSlug="acme"
        event={event}
        session={session({
          durationMinutes: 10,
          startsAt: DAY_START + 13 * HOUR,
          endsAt: DAY_START + 14 * HOUR,
        })}
        rooms={[]}
        onClose={vi.fn()}
      />,
    )
    expect(endValue()).toBe('2026-09-01T14:00')
  })

  test('sessionDurationMs falls back to an hour only when there is no duration', () => {
    expect(sessionDurationMs(session({ durationMinutes: 45 }))).toBe(45 * MIN)
    expect(
      sessionDurationMs(session({ durationMinutes: 0 as unknown as number })),
    ).toBe(HOUR)
  })
})
