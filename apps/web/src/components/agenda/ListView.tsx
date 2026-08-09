import {
  PARTICIPANT_STATE_LABEL,
  activeParticipants,
  dayKey,
  dayLabel,
  hasBlocker,
  hasWarning,
  participantName,
  releaseBadge,
  releaseState,
  slotClock,
} from './model'
import type {
  Board,
  BoardRoom,
  BoardSession,
  BoardTrack,
  PlacedBlock,
} from './model'
import { Badge, Card, DataTable, StatusPill } from '~/ds'

// The chronological fallback. Always works — even with nothing scheduled — and
// carries the same click-through to the detail dialog as the grid. Sessions and
// agenda items interleave by start time; the unscheduled tray trails at the end.

type ListRow = {
  id: string
  block?: PlacedBlock
  session?: BoardSession
  sortKey: number
}

export function ListView({
  board,
  zone,
  roomsById,
  tracksById,
  onOpenBlock,
  onOpenSession,
}: {
  board: Board
  zone: string
  roomsById: Map<string, BoardRoom>
  tracksById: Map<string, BoardTrack>
  onOpenBlock: (block: PlacedBlock) => void
  onOpenSession: (session: BoardSession) => void
}) {
  const placed: Array<ListRow> = []
  for (const session of board.sessions) {
    if (session.startsAt !== undefined && session.endsAt !== undefined) {
      placed.push({
        id: session.sessionId,
        block: {
          kind: 'session',
          id: session.sessionId,
          title: session.title,
          startsAt: session.startsAt,
          endsAt: session.endsAt,
          roomId: session.roomId,
          trackId: session.trackId,
          conflicts: session.conflicts,
          session,
        },
        session,
        sortKey: session.startsAt,
      })
    }
  }
  for (const item of board.agendaItems) {
    placed.push({
      id: item.itemId,
      block: {
        kind: 'item',
        id: item.itemId,
        title: item.title,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        roomId: item.roomId,
        conflicts: item.conflicts,
        item,
      },
      sortKey: item.startsAt,
    })
  }
  placed.sort((a, b) => a.sortKey - b.sortKey)

  const unscheduled: Array<ListRow> = board.sessions
    .filter((s) => s.startsAt === undefined)
    .map((session) => ({ id: session.sessionId, session, sortKey: Infinity }))

  const rows = [...placed, ...unscheduled]

  return (
    <Card padded={false}>
      <DataTable
        rowKey="id"
        onRowClick={(row: ListRow) => {
          if (row.block !== undefined) onOpenBlock(row.block)
          else if (row.session !== undefined) onOpenSession(row.session)
        }}
        columns={[
          {
            key: 'time',
            header: 'Time',
            width: '13rem',
            cell: (row: ListRow) => <TimeCell row={row} zone={zone} />,
          },
          {
            key: 'title',
            header: 'Session',
            cell: (row: ListRow) => (
              <span
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-half)',
                }}
              >
                <span style={{ color: 'var(--text-primary)' }}>
                  {row.block?.title ?? row.session?.title}
                </span>
                {row.block?.kind === 'item' ? (
                  <span style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
                    Agenda item
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            key: 'room',
            header: 'Room',
            width: '10rem',
            cell: (row: ListRow) => (
              <span style={{ color: 'var(--text-secondary)' }}>
                {roomName(row, roomsById)}
              </span>
            ),
          },
          {
            key: 'track',
            header: 'Track',
            width: '9rem',
            cell: (row: ListRow) => (
              <span style={{ color: 'var(--text-secondary)' }}>
                {trackName(row, tracksById)}
              </span>
            ),
          },
          {
            key: 'speakers',
            header: 'Speakers',
            cell: (row: ListRow) => <SpeakersCell row={row} />,
          },
          {
            key: 'status',
            header: 'Status',
            width: '12rem',
            cell: (row: ListRow) => <StatusCell row={row} />,
          },
        ]}
        rows={rows}
      />
    </Card>
  )
}

function TimeCell({ row, zone }: { row: ListRow; zone: string }) {
  if (row.block === undefined) {
    return <span style={{ color: 'var(--text-tertiary)' }}>Unscheduled</span>
  }
  return (
    <span
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-half)',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--text-tertiary)',
        }}
      >
        {dayLabel(dayKey(row.block.startsAt, zone), zone)}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-sm)',
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--text-primary)',
        }}
      >
        {slotClock(row.block.startsAt, row.block.endsAt, zone)}
      </span>
    </span>
  )
}

function roomName(row: ListRow, roomsById: Map<string, BoardRoom>): string {
  const roomId = row.block?.roomId ?? row.session?.roomId
  if (roomId === undefined) return '—'
  return roomsById.get(roomId)?.name ?? 'Unknown room'
}

function trackName(row: ListRow, tracksById: Map<string, BoardTrack>): string {
  const trackId = row.block?.trackId ?? row.session?.trackId
  if (trackId === undefined) return '—'
  return tracksById.get(trackId)?.name ?? '—'
}

function SpeakersCell({ row }: { row: ListRow }) {
  const session = row.session ?? row.block?.session
  if (session === undefined) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>
  const speakers = activeParticipants(session)
  if (speakers.length === 0) {
    return (
      <span style={{ color: 'var(--text-tertiary)' }}>Speaker to be announced</span>
    )
  }
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      {speakers.map((p) => (
        <span
          key={p.participantId}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
          }}
        >
          <span style={{ color: 'var(--text-primary)' }}>{participantName(p)}</span>
          <StatusPill status={PARTICIPANT_STATE_LABEL[p.state]} />
        </span>
      ))}
    </span>
  )
}

function StatusCell({ row }: { row: ListRow }) {
  if (row.block?.kind === 'item') {
    return <Badge tone="neutral">Agenda item</Badge>
  }
  const session = row.session ?? row.block?.session
  if (session === undefined) return null
  const badge = releaseBadge(releaseState(session))
  const blocker = hasBlocker(session.conflicts)
  const warning = hasWarning(session.conflicts)
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
      <Badge tone={badge.tone}>{badge.label}</Badge>
      {blocker ? (
        <Badge tone="blocked" dot>
          Blocked
        </Badge>
      ) : warning ? (
        <Badge tone="attention" dot>
          Warning
        </Badge>
      ) : null}
    </span>
  )
}
