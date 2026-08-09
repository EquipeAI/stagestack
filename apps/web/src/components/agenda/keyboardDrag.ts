import { KeyboardCode, pointerWithin } from '@dnd-kit/core'
import type {
  ClientRect,
  CollisionDetection,
  KeyboardCoordinateGetter,
  ScreenReaderInstructions,
} from '@dnd-kit/core'

// Keyboard parity for the agenda's drag surface. The grid is a lattice of
// 15-minute droppables, so an arrow key means "the next droppable that way",
// not "25px that way" — dnd-kit's default getter would land between slots.

/** Space picks a block up and drops it; Enter is left to the block itself, which
 * opens the detail dialog when no drag is running. */
export const AGENDA_KEYBOARD_CODES = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
}

export const AGENDA_SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'Press Enter to open this block. Press the space bar to pick it up, then use the arrow keys to move it by 15 minutes or one column at a time. Press space again to drop it, or escape to cancel.',
}

/** The collision probe sits one pixel inside the dragged block's top-left
 * corner, so it can never land on the edge shared by two droppables. */
const INSET = 1
/** Slack for float rounding when deciding a droppable is "further along". */
const EPSILON = 0.5

const ARROWS: Array<string> = [
  KeyboardCode.Down,
  KeyboardCode.Up,
  KeyboardCode.Left,
  KeyboardCode.Right,
]

function overlaps(aMin: number, aMax: number, bMin: number, bMax: number) {
  return aMin < bMax && aMax > bMin
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export const agendaKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates, context },
) => {
  if (!ARROWS.includes(event.code)) return
  event.preventDefault()

  const { collisionRect, droppableRects, droppableContainers } = context
  if (collisionRect === null) return

  const vertical = event.code === KeyboardCode.Up || event.code === KeyboardCode.Down
  const forward = event.code === KeyboardCode.Down || event.code === KeyboardCode.Right

  // Nearest droppable strictly in the pressed direction; ties on the primary
  // axis (every slot in a grid row shares a top) break towards the column the
  // block is already in, so a vertical move never drifts sideways.
  let best: ClientRect | undefined
  let bestStep = Infinity
  let bestCross = Infinity
  for (const entry of droppableContainers.getEnabled()) {
    const rect = droppableRects.get(entry.id)
    if (rect === undefined) continue
    const delta = vertical
      ? rect.top - collisionRect.top
      : rect.left - collisionRect.left
    if (forward ? delta <= EPSILON : delta >= -EPSILON) continue
    if (
      vertical
        ? !overlaps(rect.left, rect.right, collisionRect.left, collisionRect.right)
        : !overlaps(rect.top, rect.bottom, collisionRect.top, collisionRect.bottom)
    ) {
      continue
    }
    const step = Math.abs(delta)
    const cross = vertical
      ? Math.abs(rect.left - collisionRect.left)
      : Math.abs(rect.top - collisionRect.top)
    if (step < bestStep - EPSILON || (step <= bestStep + EPSILON && cross < bestCross)) {
      best = rect
      bestStep = step
      bestCross = cross
    }
  }
  if (best === undefined) return

  // Park the block's top-left on the target so the probe below resolves it.
  // Only the pressed axis moves; the other one is left alone, or clamped just
  // far enough into the target to keep the probe inside it.
  return vertical
    ? { x: currentCoordinates.x, y: best.top }
    : {
        x: best.left,
        y: clamp(currentCoordinates.y, best.top, best.bottom - 2 * INSET),
      }
}

/** `pointerWithin` alone returns nothing for a keyboard drag — there is no
 * pointer. Resolve the droppable under the dragged block's top-left corner
 * instead, which is exactly where the coordinate getter parks it, so the drop
 * lands on the slot the arrow keys walked to. */
export const agendaCollisionDetection: CollisionDetection = (args) => {
  if (args.pointerCoordinates !== null) return pointerWithin(args)
  return pointerWithin({
    ...args,
    pointerCoordinates: {
      x: args.collisionRect.left + INSET,
      y: args.collisionRect.top + INSET,
    },
  })
}
