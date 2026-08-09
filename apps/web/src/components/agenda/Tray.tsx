import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  PARTICIPANT_STATE_LABEL,
  TRAY_DROPPABLE,
  activeParticipants,
  participantName,
} from './model'
import type { BoardSession } from './model'
import { Badge, Button, StatusPill } from '~/ds'

// The unscheduled tray: sessions with no start time. Drag a card onto the grid
// to place it; drag a placed block back here to unschedule it. On a phone the
// "Place" button opens the same slot picker without any dragging.

export function Tray({
  sessions,
  activeId,
  disabled,
  onOpen,
  onPlace,
}: {
  sessions: Array<BoardSession>
  activeId: string | null
  disabled: boolean
  onOpen: (session: BoardSession) => void
  onPlace: (session: BoardSession) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: TRAY_DROPPABLE })
  const dragging = activeId !== null

  return (
    <aside
      style={{
        flex: 'none',
        width: '17rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
        }}
      >
        <span style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}>
          Unscheduled
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text-tertiary)',
          }}
        >
          {sessions.length}
        </span>
      </div>

      <div
        ref={setNodeRef}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          padding: 'var(--space-2)',
          minHeight: '6rem',
          borderRadius: 'var(--radius-lg)',
          border: `var(--space-px) dashed ${
            dragging && isOver ? 'var(--border-brand)' : 'var(--border-default)'
          }`,
          background:
            dragging && isOver
              ? 'var(--surface-selected)'
              : 'var(--surface-canvas)',
        }}
      >
        {sessions.length === 0 ? (
          <p
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-tertiary)',
              margin: 'var(--space-0)',
              padding: 'var(--space-2)',
            }}
          >
            Every session is placed. Drag a block back here to unschedule it.
          </p>
        ) : (
          sessions.map((session) => (
            <TrayCard
              key={session.sessionId}
              session={session}
              isSource={activeId === `session:${session.sessionId}`}
              disabled={disabled}
              onOpen={onOpen}
              onPlace={onPlace}
            />
          ))
        )}
      </div>
    </aside>
  )
}

function TrayCard({
  session,
  isSource,
  disabled,
  onOpen,
  onPlace,
}: {
  session: BoardSession
  isSource: boolean
  disabled: boolean
  onOpen: (session: BoardSession) => void
  onPlace: (session: BoardSession) => void
}) {
  const { setNodeRef, listeners, attributes } = useDraggable({
    id: `session:${session.sessionId}`,
    disabled,
  })
  const speakers = activeParticipants(session)

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-md)',
        border: 'var(--space-px) solid var(--border-default)',
        background: 'var(--surface-card)',
        boxShadow: 'var(--shadow-xs)',
        cursor: disabled ? 'default' : 'grab',
        opacity: isSource ? 0.4 : 1,
        touchAction: 'none',
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
        {session.title}
      </span>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--space-1)',
        }}
      >
        {session.format === undefined ? null : (
          <Badge tone="neutral" size="sm">
            {session.format}
          </Badge>
        )}
        {speakers.length === 0 ? (
          <span style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
            Speaker to be announced
          </span>
        ) : (
          <span style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>
            {speakers.map((p) => participantName(p)).join(', ')}
          </span>
        )}
      </div>

      {speakers.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
          {speakers.slice(0, 2).map((p) => (
            <StatusPill
              key={p.participantId}
              status={PARTICIPANT_STATE_LABEL[p.state]}
            />
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
        <Button
          size="sm"
          variant="secondary"
          iconLeft="calendar-days"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation()
            onPlace(session)
          }}
        >
          Place
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation()
            onOpen(session)
          }}
        >
          Details
        </Button>
      </div>
    </div>
  )
}
