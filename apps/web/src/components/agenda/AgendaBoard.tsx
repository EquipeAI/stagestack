import { useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { Link } from '@tanstack/react-router'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { TimeGrid } from './TimeGrid'
import { Tray } from './Tray'
import { ListView } from './ListView'
import { BlockCard } from './Block'
import { ConflictLegend } from './ConflictLegend'
import { PlaceDialog } from './PlaceDialog'
import { AgendaItemDialog } from './AgendaItemDialog'
import { ReleaseDialog } from './ReleaseDialog'
import { SessionDetailDialog } from './SessionDetailDialog'
import {
  DEFAULT_DURATION_MS,
  TRAY_DROPPABLE,
  VIEW_ICON,
  VIEW_LABEL,
  dayKey,
  dayLabel,
  durationOf,
  eventDayKeys,
  hourRange,
  parseDraggableId,
  parseSlotDroppableId,
  placedBlocks,
  sessionBlock,
  traySessions,
} from './model'
import type { GridColumn } from './TimeGrid'
import type {
  Board,
  BoardAgendaItem,
  BoardSession,
  PlacedBlock,
  ViewId,
} from './model'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import type { Id } from '@convex/_generated/dataModel'
import { Button, Callout, Card, EmptyState, Select, Tabs, Toolbar } from '~/ds'

// The whole agenda builder (M6): one board subscription, five projections of
// it, and a single drag surface shared by the Room/Track/Day/Week grids. Drops
// snap to 15 minutes; a session dragged to the tray is unscheduled. Only one
// dialog is open at a time, so nothing stacks.

const VIEW_ORDER: Array<ViewId> = ['list', 'day', 'week', 'track', 'room']

type Modal =
  | { type: 'detail'; session: BoardSession }
  | { type: 'place'; session: BoardSession }
  | { type: 'item'; item?: BoardAgendaItem }
  | { type: 'release'; sessions: Array<BoardSession> }
  | null

export function AgendaBoard({
  eventSlug,
  board,
  view,
  day,
  onView,
  onDay,
}: {
  eventSlug: string
  board: Board
  view: ViewId
  day: string | undefined
  onView: (view: ViewId) => void
  onDay: (day: string) => void
}) {
  const scheduleSession = useMutation(api.agenda.scheduleSession)
  const updateItem = useMutation(api.agenda.updateAgendaItem)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  // A completed drag fires a synthetic click on the block; swallow it so a
  // reschedule doesn't also open the detail dialog.
  const draggedAt = useRef(0)

  const zone = board.event.timezone
  const days = useMemo(() => eventDayKeys(board.event), [board.event])
  const selectedDay = day !== undefined && days.includes(day) ? day : days[0]

  const roomsById = useMemo(
    () => new Map(board.rooms.map((r) => [r.roomId as string, r])),
    [board.rooms],
  )
  const tracksById = useMemo(
    () => new Map(board.tracks.map((t) => [t.trackId as string, t])),
    [board.tracks],
  )

  const allPlaced = useMemo(() => placedBlocks(board), [board])
  const tray = useMemo(() => traySessions(board), [board])
  const hours = useMemo(
    () => hourRange(board.event, allPlaced),
    [board.event, allPlaced],
  )

  // Fast lookup for a dragged element's duration and current room.
  const blockLookup = useMemo(() => {
    const map = new Map<string, PlacedBlock>()
    for (const block of allPlaced) map.set(`${block.kind}:${block.id}`, block)
    for (const session of tray) map.set(`session:${session.sessionId}`, sessionBlock(session))
    return map
  }, [allPlaced, tray])

  const columns = useMemo(
    () => buildColumns(view, board, allPlaced, selectedDay, days, roomsById, tracksById),
    [view, board, allPlaced, selectedDay, days, roomsById, tracksById],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  const pendingSessions = board.sessions.filter(
    (s) => s.pendingRelease && s.startsAt !== undefined,
  )

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id))
  }

  const onDragEnd = (e: DragEndEvent) => {
    const activeRaw = String(e.active.id)
    const overId = e.over === null ? null : String(e.over.id)
    setActiveId(null)
    draggedAt.current = Date.now()
    const parsed = parseDraggableId(activeRaw)
    if (parsed === null || overId === null) return

    if (overId === TRAY_DROPPABLE) {
      // Agenda items always carry a time; only sessions return to the tray.
      if (parsed.kind === 'session') {
        void scheduleSession({
          eventSlug,
          sessionId: parsed.id as Id<'sessions'>,
          slot: null,
        })
      }
      return
    }

    const slot = parseSlotDroppableId(overId)
    if (slot === null) return
    const dragged = blockLookup.get(activeRaw)
    const duration = dragged === undefined ? DEFAULT_DURATION_MS : durationOf(dragged)
    const startsAt = slot.ms
    const endsAt = startsAt + duration
    // Only the Room view rewrites the room on drop; the other grids keep it.
    const roomId =
      view === 'room'
        ? slot.columnKey === 'noroom'
          ? undefined
          : (slot.columnKey as Id<'rooms'>)
        : dragged?.roomId

    if (parsed.kind === 'session') {
      void scheduleSession({
        eventSlug,
        sessionId: parsed.id as Id<'sessions'>,
        slot: { startsAt, endsAt, roomId },
      })
    } else {
      void updateItem({
        eventSlug,
        itemId: parsed.id as Id<'agendaItems'>,
        patch: { startsAt, endsAt, roomId },
      })
    }
  }

  const openBlock = (block: PlacedBlock) => {
    if (Date.now() - draggedAt.current < 250) return
    if (block.session !== undefined) setModal({ type: 'detail', session: block.session })
    else if (block.item !== undefined) setModal({ type: 'item', item: block.item })
  }

  const showDaySelect = view === 'day' || view === 'room' || view === 'track'
  const noRooms = board.rooms.length === 0

  const toolbar = (
    <Toolbar
      left={
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <Tabs
            variant="pill"
            value={view}
            onChange={(id) => onView(id as ViewId)}
            tabs={VIEW_ORDER.map((v) => ({ id: v, label: VIEW_LABEL[v], icon: VIEW_ICON[v] }))}
          />
          {showDaySelect && days.length > 1 ? (
            <Select
              options={days.map((d) => ({ value: d, label: dayLabel(d, zone) }))}
              value={selectedDay}
              onChange={(e) => onDay(e.target.value)}
            />
          ) : null}
        </div>
      }
      right={
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button iconLeft="plus" onClick={() => setModal({ type: 'item' })}>
            Add block
          </Button>
          <Button
            variant="primary"
            iconLeft="mail"
            disabled={pendingSessions.length === 0}
            onClick={() => setModal({ type: 'release', sessions: pendingSessions })}
          >
            {pendingSessions.length === 0
              ? 'Release slots'
              : `Release ${pendingSessions.length} slot${pendingSessions.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      }
    />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {toolbar}

      {noRooms ? (
        <Callout
          tone="attention"
          title="No rooms yet"
          actions={
            <Link to="/app/e/$eventSlug/settings" params={{ eventSlug }} style={{ textDecoration: 'none' }}>
              <Button size="sm">Add rooms in Settings</Button>
            </Link>
          }
        >
          Add rooms to build the Room grid. You can still place sessions on the
          timeline and use the List, Day and Week views without them.
        </Callout>
      ) : null}

      {view === 'list' ? (
        <ListView
          board={board}
          zone={zone}
          roomsById={roomsById}
          tracksById={tracksById}
          onOpenBlock={openBlock}
          onOpenSession={(session) => setModal({ type: 'detail', session })}
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <ConflictLegend />
          <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-start' }}>
            <Tray
              sessions={tray}
              activeId={activeId}
              disabled={false}
              onOpen={(session) => setModal({ type: 'detail', session })}
              onPlace={(session) => setModal({ type: 'place', session })}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              {view === 'room' && noRooms ? (
                <Card>
                  <EmptyState
                    icon="presentation"
                    title="No rooms to lay out"
                    description="The Room grid needs at least one room. Add rooms in Settings, or switch to the Day or List view."
                    action={
                      <Link to="/app/e/$eventSlug/settings" params={{ eventSlug }} style={{ textDecoration: 'none' }}>
                        <Button variant="primary">Add rooms in Settings</Button>
                      </Link>
                    }
                  />
                </Card>
              ) : columns.length === 0 ? (
                <Card>
                  <EmptyState
                    icon="calendar-days"
                    title="Nothing on this day"
                    description="Drag a session from the tray onto the grid, or use Place to set a time."
                  />
                </Card>
              ) : (
                <Card padded={false}>
                  <div style={{ padding: 'var(--space-3)' }}>
                    <TimeGrid
                      columns={columns}
                      hours={hours}
                      zone={zone}
                      roomsById={roomsById}
                      tracksById={tracksById}
                      secondary={view === 'room' ? 'track' : 'room'}
                      activeId={activeId}
                      onOpenBlock={openBlock}
                    />
                  </div>
                </Card>
              )}
            </div>
          </div>

          <DragOverlay dropAnimation={null}>
            {activeId === null ? null : (
              <DragOverlayCard
                block={blockLookup.get(activeId)}
                zone={zone}
                roomsById={roomsById}
                tracksById={tracksById}
                secondary={view === 'room' ? 'track' : 'room'}
              />
            )}
          </DragOverlay>
        </DndContext>
      )}

      {/* Modals — one at a time */}
      {modal?.type === 'detail' ? (
        <SessionDetailDialog
          eventSlug={eventSlug}
          event={board.event}
          session={
            board.sessions.find((s) => s.sessionId === modal.session.sessionId) ??
            modal.session
          }
          rooms={board.rooms}
          onClose={() => setModal(null)}
          onEditPlacement={(session) => setModal({ type: 'place', session })}
          onRelease={(session) => setModal({ type: 'release', sessions: [session] })}
        />
      ) : null}

      {modal?.type === 'place' ? (
        <PlaceDialog
          eventSlug={eventSlug}
          event={board.event}
          session={modal.session}
          rooms={board.rooms}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal?.type === 'item' ? (
        <AgendaItemDialog
          eventSlug={eventSlug}
          event={board.event}
          rooms={board.rooms}
          item={modal.item}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal?.type === 'release' ? (
        <ReleaseDialog
          eventSlug={eventSlug}
          sessions={modal.sessions}
          onClose={() => setModal(null)}
        />
      ) : null}
    </div>
  )
}

function DragOverlayCard({
  block,
  zone,
  roomsById,
  tracksById,
  secondary,
}: {
  block: PlacedBlock | undefined
  zone: string
  roomsById: Map<string, Board['rooms'][number]>
  tracksById: Map<string, Board['tracks'][number]>
  secondary: 'room' | 'track'
}) {
  if (block === undefined) return null
  return (
    <div style={{ width: '15rem', cursor: 'grabbing' }}>
      <BlockCard
        block={block}
        zone={zone}
        roomsById={roomsById}
        tracksById={tracksById}
        secondary={secondary}
        dragging
      />
    </div>
  )
}

// ── Column projections ─────────────────────────────────────────────────────

function buildColumns(
  view: ViewId,
  board: Board,
  allPlaced: Array<PlacedBlock>,
  selectedDay: string,
  days: Array<string>,
  roomsById: Map<string, Board['rooms'][number]>,
  tracksById: Map<string, Board['tracks'][number]>,
): Array<GridColumn> {
  const zone = board.event.timezone
  const onDay = (block: PlacedBlock) => dayKey(block.startsAt, zone) === selectedDay

  if (view === 'week') {
    return days.map((d) => ({
      key: `day|${d}`,
      label: dayLabel(d, zone),
      dayKey: d,
      blocks: allPlaced.filter((b) => dayKey(b.startsAt, zone) === d),
    }))
  }

  if (view === 'day') {
    return [
      {
        key: 'day',
        label: dayLabel(selectedDay, zone),
        sublabel: 'All rooms',
        dayKey: selectedDay,
        blocks: allPlaced.filter(onDay),
      },
    ]
  }

  const dayBlocks = allPlaced.filter(onDay)

  if (view === 'track') {
    const cols: Array<GridColumn> = board.tracks.map((track) => ({
      key: track.trackId,
      label: track.name,
      accentColor: track.color,
      dayKey: selectedDay,
      blocks: dayBlocks.filter((b) => b.trackId === track.trackId),
    }))
    const untracked = dayBlocks.filter(
      (b) => b.trackId === undefined || !tracksById.has(b.trackId),
    )
    if (untracked.length > 0 || cols.length === 0) {
      cols.push({
        key: 'notrack',
        label: 'No track',
        dayKey: selectedDay,
        blocks: untracked,
      })
    }
    return cols
  }

  // Room view.
  const cols: Array<GridColumn> = board.rooms.map((room) => ({
    key: room.roomId,
    label: room.name,
    sublabel: room.capacity === undefined ? undefined : `${room.capacity} seats`,
    dayKey: selectedDay,
    blocks: dayBlocks.filter((b) => b.roomId === room.roomId),
  }))
  const noRoom = dayBlocks.filter(
    (b) => b.roomId === undefined || !roomsById.has(b.roomId),
  )
  if (noRoom.length > 0) {
    cols.push({
      key: 'noroom',
      label: 'Unassigned',
      sublabel: 'No room',
      dayKey: selectedDay,
      blocks: noRoom,
    })
  }
  return cols
}
