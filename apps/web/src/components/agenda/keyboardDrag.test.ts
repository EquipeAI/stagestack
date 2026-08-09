import { describe, expect, it } from 'vitest'
import { agendaCollisionDetection, agendaKeyboardCoordinates } from './keyboardDrag'
import type {
  ClientRect,
  CollisionDetection,
  KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import type { Coordinates } from '@dnd-kit/utilities'

// A two-column grid of four 15-minute slots, with the tray to its left — the
// smallest shape that exercises "next slot down" and "next column over".

const SLOT_PX = 16
const COL_PX = 200
const GRID_LEFT = 300
const GRID_TOP = 100

function rect(left: number, top: number, width: number, height: number): ClientRect {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

const rects = new Map<string, ClientRect>()
for (const col of [0, 1]) {
  for (const slot of [0, 1, 2, 3]) {
    rects.set(
      `slot|c${col}|${slot}`,
      rect(GRID_LEFT + col * COL_PX, GRID_TOP + slot * SLOT_PX, COL_PX, SLOT_PX),
    )
  }
}
rects.set('tray', rect(0, GRID_TOP, 272, 4 * SLOT_PX))

const containers = [...rects.keys()].map((id) => ({ id }))

function move(
  code: string,
  collisionRect: ClientRect,
  currentCoordinates: Coordinates = { x: collisionRect.left, y: collisionRect.top },
) {
  const getter = agendaKeyboardCoordinates as unknown as (
    event: { code: string; preventDefault: () => void },
    args: {
      active: string
      currentCoordinates: Coordinates
      context: {
        collisionRect: ClientRect
        droppableRects: Map<string, ClientRect>
        droppableContainers: { getEnabled: () => Array<{ id: string }> }
      }
    },
  ) => ReturnType<KeyboardCoordinateGetter>
  return getter(
    { code, preventDefault: () => undefined },
    {
      active: 'session:1',
      currentCoordinates,
      context: {
        collisionRect,
        droppableRects: rects,
        droppableContainers: { getEnabled: () => containers },
      },
    },
  )
}

function collide(collisionRect: ClientRect, pointer: Coordinates | null) {
  const detect = agendaCollisionDetection as unknown as (args: {
    active: { id: string }
    collisionRect: ClientRect
    droppableRects: Map<string, ClientRect>
    droppableContainers: Array<{ id: string }>
    pointerCoordinates: Coordinates | null
  }) => ReturnType<CollisionDetection>
  return detect({
    active: { id: 'session:1' },
    collisionRect,
    droppableRects: rects,
    droppableContainers: containers,
    pointerCoordinates: pointer,
  })
}

/** A 60-minute block sitting on slot `slot` of column `col`. */
function block(col: number, slot: number): ClientRect {
  return rect(
    GRID_LEFT + col * COL_PX,
    GRID_TOP + slot * SLOT_PX,
    COL_PX,
    4 * SLOT_PX,
  )
}

describe('agendaKeyboardCoordinates', () => {
  it('steps down one slot at a time, not by a fixed pixel amount', () => {
    expect(move('ArrowDown', block(0, 0))?.y).toBe(GRID_TOP + SLOT_PX)
    expect(move('ArrowDown', block(0, 1))?.y).toBe(GRID_TOP + 2 * SLOT_PX)
  })

  it('steps up one slot and stops at the top of the grid', () => {
    expect(move('ArrowUp', block(0, 2))?.y).toBe(GRID_TOP + SLOT_PX)
    expect(move('ArrowUp', block(0, 0))).toBeUndefined()
  })

  it('keeps the column on a vertical move even though the block spans it', () => {
    const from = block(0, 0)
    expect(move('ArrowDown', from)?.x).toBe(from.left)
  })

  it('moves to the next column and holds the vertical position', () => {
    const from = block(0, 1)
    const next = move('ArrowRight', from)
    expect(next?.x).toBe(GRID_LEFT + COL_PX)
    expect(next?.y).toBe(from.top)
  })

  it('reaches the tray on a left move out of the first column', () => {
    expect(move('ArrowLeft', block(0, 0))?.x).toBe(0)
    expect(move('ArrowRight', block(1, 0))).toBeUndefined()
  })

  it('ignores keys that are not arrows', () => {
    expect(move('Space', block(0, 0))).toBeUndefined()
  })
})

describe('agendaCollisionDetection', () => {
  it('resolves the slot under the block top-left when there is no pointer', () => {
    // Where a keyboard drag leaves the block after one ArrowDown.
    const moved = rect(GRID_LEFT, GRID_TOP + SLOT_PX, COL_PX, 4 * SLOT_PX)
    expect(collide(moved, null)[0]?.id).toBe('slot|c0|1')
  })

  it('does not pick a slot the block merely overlaps', () => {
    const moved = rect(GRID_LEFT, GRID_TOP, COL_PX, 4 * SLOT_PX)
    expect(collide(moved, null).map((c) => c.id)).toEqual(['slot|c0|0'])
  })

  it('still follows the pointer when there is one', () => {
    const at = { x: GRID_LEFT + 10, y: GRID_TOP + 2 * SLOT_PX + 4 }
    expect(collide(block(0, 0), at)[0]?.id).toBe('slot|c0|2')
  })
})
