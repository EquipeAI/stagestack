import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PlanReview } from './SuggestDialog'
import { ListView } from './ListView'
import type { Plan } from './SuggestDialog'
import type { Board, BoardSession } from './model'
import type { Id } from '@convex/_generated/dataModel'

// W2's two visible promises: the suggestion is reviewable as a list before
// anything is written, and there is a Place… button on every unscheduled row
// so dragging is never the only way to schedule.

afterEach(cleanup)

const ZONE = 'UTC'
const START = Date.parse('2026-09-01T09:00:00Z')
const HOUR = 60 * 60 * 1000

const ROOMS = new Map([['room1', 'Main Stage']])

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    fingerprint: 'abc123',
    placements: [
      {
        sessionId: 's1' as Id<'sessions'>,
        title: 'Reactive backends',
        startsAt: START,
        endsAt: START + 15 * 60 * 1000,
        roomId: 'room1' as Id<'rooms'>,
        durationMinutes: 15,
        why: 'First free 15-minute slot with no conflicts.',
      },
    ],
    unplaced: [],
    ...overrides,
  }
}

describe('PlanReview (suggest → review → apply)', () => {
  test('lists each placement with its day, time, room, length and reason', () => {
    render(<PlanReview plan={plan()} zone={ZONE} roomName={ROOMS} />)
    const text = document.body.textContent
    expect(text).toContain('1 to place')
    expect(text).toContain('Reactive backends')
    expect(text).toContain('Main Stage')
    expect(text).toContain('15 min')
    // The reason sentence is the backend's, rendered verbatim.
    expect(text).toContain('First free 15-minute slot with no conflicts.')
  })

  test('a placement with no room says so rather than showing nothing', () => {
    render(
      <PlanReview
        plan={plan({
          placements: [
            { ...plan().placements[0], roomId: undefined, durationMinutes: 60 },
          ],
        })}
        zone={ZONE}
        roomName={ROOMS}
      />,
    )
    expect(document.body.textContent).toContain('No room')
  })

  test('every leftover carries the backend’s explanation, not a bare count', () => {
    render(
      <PlanReview
        plan={plan({
          unplaced: [
            {
              sessionId: 's2' as Id<'sessions'>,
              title: 'Ten-hour marathon',
              reason: 'outside_event_bounds',
              message:
                "The event's dates leave no 600-minute window for this session.",
            },
            {
              sessionId: 's3' as Id<'sessions'>,
              title: 'Grace again',
              reason: 'speaker_double_booked',
              message:
                'Every free 60-minute slot collides with a speaker who is already booked elsewhere.',
            },
          ],
        })}
        zone={ZONE}
        roomName={ROOMS}
      />,
    )
    const text = document.body.textContent
    expect(text).toContain('2 without a slot')
    expect(text).toContain(
      "The event's dates leave no 600-minute window for this session.",
    )
    expect(text).toContain(
      'Every free 60-minute slot collides with a speaker who is already booked elsewhere.',
    )
  })

  test('an empty plan explains itself instead of rendering a blank list', () => {
    render(
      <PlanReview
        plan={plan({ placements: [], unplaced: [] })}
        zone={ZONE}
        roomName={ROOMS}
      />,
    )
    expect(document.body.textContent).toContain('Everything is already placed')
  })
})

function session(overrides: Partial<BoardSession> = {}): BoardSession {
  return {
    sessionId: 's1' as Id<'sessions'>,
    title: 'Reactive backends',
    durationMinutes: 60,
    pendingRelease: false,
    participants: [],
    conflicts: [],
    ...overrides,
  }
}

function board(sessions: Array<BoardSession>): Board {
  return {
    event: {
      slug: 'acme',
      name: 'Acme Summit',
      startsAt: START,
      endsAt: START + 2 * 24 * HOUR,
      timezone: ZONE,
    },
    rooms: [{ roomId: 'room1' as Id<'rooms'>, name: 'Main Stage', order: 0 }],
    tracks: [],
    sessions,
    agendaItems: [],
  }
}

describe('ListView Place… affordance', () => {
  test('every unscheduled row offers Place… and hands the session to the dialog', () => {
    const onPlace = vi.fn()
    render(
      <ListView
        board={board([session()])}
        zone={ZONE}
        roomsById={new Map()}
        tracksById={new Map()}
        onOpenBlock={vi.fn()}
        onOpenSession={vi.fn()}
        onPlace={onPlace}
      />,
    )
    const button = screen.getByRole('button', { name: 'Place…' })
    fireEvent.click(button)
    expect(onPlace).toHaveBeenCalledTimes(1)
    expect(onPlace.mock.calls[0][0].sessionId).toBe('s1')
  })

  test('a placed session shows no Place… button — it is the tray path only', () => {
    render(
      <ListView
        board={board([
          session({
            sessionId: 's9' as Id<'sessions'>,
            startsAt: START,
            endsAt: START + HOUR,
          }),
        ])}
        zone={ZONE}
        roomsById={new Map()}
        tracksById={new Map()}
        onOpenBlock={vi.fn()}
        onOpenSession={vi.fn()}
        onPlace={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Place…' })).toBeNull()
  })
})
