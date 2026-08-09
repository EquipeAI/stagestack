import { useDraggable, useDroppable } from '@dnd-kit/core'
import { BlockCard } from './Block'
import {
  HOUR_MS,
  HOUR_PX,
  MIN_BLOCK_PX,
  MIN_COL_PX,
  MIN_MS,
  SNAP_MIN,
  TIME_GUTTER_PX,
  dayStartMs,
  draggableId,
  slotDroppableId,
} from './model'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { BoardRoom, BoardTrack, HourRange, PlacedBlock } from './model'

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
}) {
  const span = Math.max(1, hours.endHour - hours.startHour)
  const totalPx = span * HOUR_PX
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
                  top: `${i * HOUR_PX}px`,
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
}) {
  const base = dayStartMs(column.dayKey, zone) + hours.startHour * HOUR_MS
  const span = Math.max(1, hours.endHour - hours.startHour)
  const slotCount = (span * 60) / SNAP_MIN
  const slots = Array.from({ length: slotCount }, (_, i) => ({
    index: i,
    ms: base + i * SNAP_MIN * MIN_MS,
  }))
  const lanes = layoutLanes(column.blocks)

  return (
    <div
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
        {slots.map((slot) => (
          <SlotCell
            key={slot.index}
            id={slotDroppableId(column.key, slot.ms)}
            onHour={slot.index % (60 / SNAP_MIN) === 0}
            dropping={activeId !== null}
          />
        ))}

        {/* Positioned blocks */}
        {column.blocks.map((block) => {
          const lane = lanes.get(block.id) ?? { laneIndex: 0, laneCount: 1 }
          const top = Math.max(
            0,
            ((block.startsAt - base) / HOUR_MS) * HOUR_PX,
          )
          const rawHeight = ((block.endsAt - block.startsAt) / HOUR_MS) * HOUR_PX
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

function SlotCell({
  id,
  onHour,
  dropping,
}: {
  id: string
  onHour: boolean
  dropping: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{
        height: `${(SNAP_MIN / 60) * HOUR_PX}px`,
        borderTop: onHour
          ? 'var(--space-px) solid var(--border-default)'
          : 'var(--space-px) solid transparent',
        background:
          dropping && isOver ? 'var(--surface-selected)' : 'transparent',
        transition: 'background var(--dur-1, 80ms) linear',
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
  style,
}: {
  block: PlacedBlock
  zone: string
  roomsById: Map<string, BoardRoom>
  tracksById: Map<string, BoardTrack>
  secondary: 'room' | 'track'
  activeId: string | null
  onOpenBlock: (block: PlacedBlock) => void
  style: CSSProperties
}) {
  const id = draggableId(block)
  const { setNodeRef, listeners, attributes } = useDraggable({ id })
  const isSource = activeId === id

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
    onOpenBlock(block)
  }

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onKeyDown={onKeyDown}
      onClick={() => {
        onOpenBlock(block)
      }}
      style={{ ...style, opacity: isSource ? 0.4 : 1, touchAction: 'none' }}
    >
      <BlockCard
        block={block}
        zone={zone}
        roomsById={roomsById}
        tracksById={tracksById}
        secondary={secondary}
        fill
      />
    </div>
  )
}
