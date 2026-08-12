import { useDraggable, useDroppable } from '@dnd-kit/core'
import { BlockCard } from './Block'
import {
  HOUR_MS,
  HOUR_PX,
  MIN_BLOCK_PX,
  MIN_COL_PX,
  SNAP_MIN,
  TIME_GUTTER_PX,
  clockLabel,
  columnSlotTimes,
  dayStartMs,
  draggableId,
  slotDroppableId,
  slotIsEligible,
} from './model'
import type { CSSProperties, KeyboardEvent } from 'react'
import type {
  BoardRoom,
  BoardTrack,
  HourRange,
  PlacedBlock,
  SlotEligibility,
} from './model'

// The shared time-axis grid behind the Room, Track, Day and Week views. Columns
// differ per view; the vertical axis and the drag mechanics do not. Slots are a
// grid of 15-minute droppables; blocks are absolutely positioned over them and
// laid into lanes so overlaps in one column are plainly visible.

export type GridColumn = {
  key: string
  label: string
  sublabel?: string
  accentColor?: string
  /** Which wall-clock day this column's slots and blocks live on. */
  dayKey: string
  blocks: Array<PlacedBlock>
}

type Lane = { laneIndex: number; laneCount: number }

/** Greedy interval colouring, per overlap cluster, so a lone block stays full
 * width and only genuine overlaps split. */
function layoutLanes(blocks: Array<PlacedBlock>): Map<string, Lane> {
  const out = new Map<string, Lane>()
  const sorted = [...blocks].sort(
    (a, b) => a.startsAt - b.startsAt || a.endsAt - b.endsAt,
  )
  let cluster: Array<PlacedBlock> = []
  let clusterEnd = -Infinity

  const flush = () => {
    if (cluster.length === 0) return
    const laneEnds: Array<number> = []
    const assigned: Array<{ id: string; lane: number }> = []
    for (const block of cluster) {
      let lane = laneEnds.findIndex((end) => end <= block.startsAt)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(block.endsAt)
      } else {
        laneEnds[lane] = block.endsAt
      }
      assigned.push({ id: block.id, lane })
    }
    const laneCount = laneEnds.length
    for (const a of assigned) {
      out.set(a.id, { laneIndex: a.lane, laneCount })
    }
    cluster = []
    clusterEnd = -Infinity
  }

  for (const block of sorted) {
    if (block.startsAt >= clusterEnd && cluster.length > 0) {
      flush()
    }
    cluster.push(block)
    clusterEnd = Math.max(clusterEnd, block.endsAt)
  }
  flush()
  return out
}

export function TimeGrid({
  columns,
  hours,
  zone,
  roomsById,
  tracksById,
  secondary,
  activeId,
  onOpenBlock,
  eligibility = null,
  onSlotTap,
  hourPx = HOUR_PX,
}: {
  columns: Array<GridColumn>
  hours: HourRange
  zone: string
  roomsById: Map<string, BoardRoom>
  tracksById: Map<string, BoardTrack>
  secondary: 'room' | 'track'
  /** The draggable currently being dragged, so its source can be dimmed. */
  activeId: string | null
  onOpenBlock: (block: PlacedBlock) => void
  /** Non-null while a session is armed for tap-to-place: every visible cell's
   * would-be conflicts, keyed by droppable id. Cells become buttons. */
  eligibility?: SlotEligibility | null
  onSlotTap?: (slotId: string, ms: number) => void
  /** Taller while armed, so one 15-minute cell is a thumb-sized target. */
  hourPx?: number
}) {
  const span = Math.max(1, hours.endHour - hours.startHour)
  const totalPx = span * hourPx
  const hourMarks = Array.from({ length: span + 1 }, (_, i) => hours.startHour + i)

  return (
    <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
      <div style={{ display: 'flex', minWidth: 'min-content' }}>
        {/* Time gutter */}
        <div
          style={{
            width: `${TIME_GUTTER_PX}px`,
            flex: 'none',
            position: 'relative',
            paddingTop: 'var(--space-6)',
          }}
        >
          <div style={{ position: 'relative', height: `${totalPx}px` }}>
            {hourMarks.map((hour, i) => (
              <span
                key={hour}
                style={{
                  position: 'absolute',
                  top: `${i * hourPx}px`,
                  right: 'var(--space-2)',
                  transform: 'translateY(-50%)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-2xs)',
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--text-tertiary)',
                }}
              >
                {`${String(hour % 24).padStart(2, '0')}:00`}
              </span>
            ))}
          </div>
        </div>

        {/* Columns */}
        <div style={{ display: 'flex', flex: 1, gap: 'var(--space-px)' }}>
          {columns.map((column) => (
            <Column
              key={column.key}
              column={column}
              hours={hours}
              totalPx={totalPx}
              zone={zone}
              roomsById={roomsById}
              tracksById={tracksById}
              secondary={secondary}
              activeId={activeId}
              onOpenBlock={onOpenBlock}
              eligibility={eligibility}
              onSlotTap={onSlotTap}
              hourPx={hourPx}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function Column({
  column,
  hours,
  totalPx,
  zone,
  roomsById,
  tracksById,
  secondary,
  activeId,
  onOpenBlock,
  eligibility,
  onSlotTap,
  hourPx,
}: {
  column: GridColumn
  hours: HourRange
  totalPx: number
  zone: string
  roomsById: Map<string, BoardRoom>
  tracksById: Map<string, BoardTrack>
  secondary: 'room' | 'track'
  activeId: string | null
  onOpenBlock: (block: PlacedBlock) => void
  eligibility: SlotEligibility | null
  onSlotTap?: (slotId: string, ms: number) => void
  hourPx: number
}) {
  const base = dayStartMs(column.dayKey, zone) + hours.startHour * HOUR_MS
  // One walk of the lattice, shared with the eligibility map (model.ts).
  const slots = columnSlotTimes(column.dayKey, hours, zone).map((ms, index) => ({
    index,
    ms,
  }))
  const lanes = layoutLanes(column.blocks)
  const slotPx = (SNAP_MIN / 60) * hourPx

  /**
   * The lattice cell `offsetPx` down this column. Blocks are painted OVER the
   * cells, so while a session is armed a tap that lands on a block has to
   * resolve to the cell underneath it — otherwise the block's own footprint is
   * a dead zone that can neither be placed into nor asked why not. Derived
   * from the geometry the column already computed, so it needs no measurement.
   */
  const slotAt = (offsetPx: number): { id: string; ms: number } | null => {
    if (slots.length === 0) return null
    const index = Math.min(
      slots.length - 1,
      Math.max(0, Math.floor(offsetPx / slotPx)),
    )
    const ms = slots[index].ms
    return { id: slotDroppableId(column.key, ms), ms }
  }

  return (
    <div
      data-column={column.key}
      style={{
        flex: `1 1 ${MIN_COL_PX}px`,
        minWidth: `${MIN_COL_PX}px`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 'var(--space-6)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          paddingLeft: 'var(--space-2)',
          borderBottom: 'var(--space-px) solid var(--border-default)',
          borderLeft: column.accentColor
            ? `3px solid ${column.accentColor}`
            : undefined,
        }}
      >
        <span
          style={{
            font: 'var(--type-label)',
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {column.label}
        </span>
        {column.sublabel === undefined ? null : (
          <span
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-tertiary)',
            }}
          >
            {column.sublabel}
          </span>
        )}
      </div>

      <div
        style={{
          position: 'relative',
          height: `${totalPx}px`,
          background: 'var(--surface-canvas)',
        }}
      >
        {/* Droppable slot lattice */}
        {slots.map((slot) => {
          const id = slotDroppableId(column.key, slot.ms)
          const conflicts = eligibility?.get(id)
          return (
            <SlotCell
              key={slot.index}
              id={id}
              onHour={slot.index % (60 / SNAP_MIN) === 0}
              dropping={activeId !== null}
              hourPx={hourPx}
              tap={
                conflicts === undefined || onSlotTap === undefined
                  ? undefined
                  : {
                      eligible: slotIsEligible(conflicts),
                      label: `${clockLabel(slot.ms, zone)} in ${column.label}`,
                      onTap: () => {
                        onSlotTap(id, slot.ms)
                      },
                    }
              }
            />
          )
        })}

        {/* Positioned blocks */}
        {column.blocks.map((block) => {
          const lane = lanes.get(block.id) ?? { laneIndex: 0, laneCount: 1 }
          const top = Math.max(0, ((block.startsAt - base) / HOUR_MS) * hourPx)
          const rawHeight = ((block.endsAt - block.startsAt) / HOUR_MS) * hourPx
          // Duration-accurate, with one floor: below MIN_BLOCK_PX the block is
          // drawn taller than it is, and BlockCard says so rather than lying.
          const height = Math.max(MIN_BLOCK_PX, rawHeight)
          const widthPct = 100 / lane.laneCount
          return (
            <GridBlock
              key={`${block.kind}:${block.id}`}
              block={block}
              zone={zone}
              roomsById={roomsById}
              tracksById={tracksById}
              secondary={secondary}
              activeId={activeId}
              onOpenBlock={onOpenBlock}
              clamped={rawHeight < MIN_BLOCK_PX}
              // While armed, a tap on this block belongs to the cell under the
              // finger, not to the block: `top` locates the block in the
              // column, the pointer's own offset locates the finger in the
              // block. With no geometry (jsdom, a synthetic event) that
              // resolves to the block's first cell, which is the honest answer
              // for "somewhere on this block".
              onArmedTap={
                eligibility === null || onSlotTap === undefined
                  ? undefined
                  : (offsetWithinBlock) => {
                      const cell = slotAt(top + offsetWithinBlock)
                      if (cell !== null) onSlotTap(cell.id, cell.ms)
                    }
              }
              style={{
                position: 'absolute',
                top: `${top}px`,
                height: `${height}px`,
                left: `calc(${lane.laneIndex * widthPct}% + var(--space-half))`,
                width: `calc(${widthPct}% - var(--space-1))`,
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

/** One 15-minute cell: always a droppable, and additionally a button while a
 * session is armed for tap-to-place. An ineligible cell stays tappable on
 * purpose — tapping it is how a phone asks "why not here?". */
function SlotCell({
  id,
  onHour,
  dropping,
  hourPx,
  tap,
}: {
  id: string
  onHour: boolean
  dropping: boolean
  hourPx: number
  tap?: { eligible: boolean; label: string; onTap: () => void }
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const style: CSSProperties = {
    display: 'block',
    boxSizing: 'border-box',
    width: '100%',
    height: `${(SNAP_MIN / 60) * hourPx}px`,
    padding: 'var(--space-0)',
    borderTop: onHour
      ? 'var(--space-px) solid var(--border-default)'
      : 'var(--space-px) solid transparent',
    background:
      dropping && isOver ? 'var(--surface-selected)' : 'transparent',
    transition: 'background var(--dur-1, 80ms) linear',
  }
  if (tap === undefined) {
    return <div ref={setNodeRef} style={style} />
  }
  return (
    <button
      ref={setNodeRef}
      type="button"
      // The state is in the name, not only in the fill: "free" and "taken" are
      // what a screen reader hears, and colour is never the only signal (W6).
      aria-label={`${tap.eligible ? 'Free' : 'Taken'} — ${tap.label}`}
      data-slot-eligible={tap.eligible ? 'true' : 'false'}
      onClick={tap.onTap}
      style={{
        ...style,
        borderLeft: 'var(--space-0) solid transparent',
        borderRight: 'var(--space-0) solid transparent',
        borderBottom: 'var(--space-0) solid transparent',
        cursor: 'pointer',
        background: tap.eligible
          ? 'var(--status-success-bg)'
          : 'var(--surface-sunken)',
        boxShadow: tap.eligible
          ? 'inset 0 0 0 var(--space-px) var(--status-success-fg)'
          : undefined,
        opacity: tap.eligible ? 1 : 0.6,
      }}
    />
  )
}

function GridBlock({
  block,
  zone,
  roomsById,
  tracksById,
  secondary,
  activeId,
  onOpenBlock,
  clamped,
  onArmedTap,
  style,
}: {
  block: PlacedBlock
  zone: string
  roomsById: Map<string, BoardRoom>
  tracksById: Map<string, BoardTrack>
  secondary: 'room' | 'track'
  activeId: string | null
  onOpenBlock: (block: PlacedBlock) => void
  /** Drawn taller than its real duration (see MIN_BLOCK_PX). */
  clamped: boolean
  /** Set while a session is armed for tap-to-place: a tap on this block is a
   * tap on the cell beneath it, at `offset` px from the block's own top. */
  onArmedTap?: (offset: number) => void
  style: CSSProperties
}) {
  const id = draggableId(block)
  const { setNodeRef, listeners, attributes } = useDraggable({ id })
  const isSource = activeId === id
  const armed = onArmedTap !== undefined

  // dnd-kit already makes the block a focusable role="button"; space is its
  // pick-up key (see keyboardDrag.ts), so Enter is what opens the block. While
  // any drag is running both keys belong to the sensor, which ends the drag.
  // The sensor's own handler has to run first — spreading `listeners` after
  // this one would drop it.
  const startDrag = listeners?.onKeyDown as
    | ((event: KeyboardEvent<HTMLDivElement>) => void)
    | undefined
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    startDrag?.(e)
    if (e.defaultPrevented || activeId !== null) return
    if (e.key !== 'Enter') return
    e.preventDefault()
    // While armed, Enter means the same thing a tap does: the cell this block
    // starts on. Opening the dialog would strand a keyboard user mid-placement.
    if (armed) onArmedTap(0)
    else onOpenBlock(block)
  }

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onKeyDown={onKeyDown}
      // A block never swallows a tap while a session is armed: the tap is for
      // the cell underneath, which either places or explains what is in the
      // way. `offsetY` is the finger's position inside this block.
      onClick={(e) => {
        if (armed) onArmedTap(e.nativeEvent.offsetY)
        else onOpenBlock(block)
      }}
      aria-label={
        armed ? `${block.title} — choose the slot underneath it` : undefined
      }
      // `touch-action` lives in a class, not here: on a coarse pointer it has
      // to become `manipulation` so a finger that lands on a block can still
      // scroll the grid (see .agenda-draggable in app.css). An inline
      // `touchAction:'none'` would be unoverridable by that media query.
      className="agenda-draggable"
      style={{ ...style, opacity: isSource ? 0.4 : 1 }}
    >
      <BlockCard
        block={block}
        zone={zone}
        roomsById={roomsById}
        tracksById={tracksById}
        secondary={secondary}
        clamped={clamped}
        fill
      />
    </div>
  )
}
