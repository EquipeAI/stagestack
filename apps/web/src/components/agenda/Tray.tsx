import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  PARTICIPANT_STATE_LABEL,
  TRAY_DROPPABLE,
  activeParticipants,
  participantName,
} from './model'
import type { BoardSession } from './model'
import { Badge, Button, Icon, StatusPill } from '~/ds'

// The unscheduled tray: sessions with no start time. Drag a card onto the grid
// to place it; drag a placed block back here to unschedule it. On a phone the
// "Place" button opens the same slot picker without any dragging.

export function Tray({
  sessions,
  activeId,
  disabled,
  onOpen,
  onPlace,
  selectedId = null,
  onSelect,
}: {
  sessions: Array<BoardSession>
  activeId: string | null
  disabled: boolean
  onOpen: (session: BoardSession) => void
  onPlace: (session: BoardSession) => void
  /** The session armed for tap-to-place, if any. */
  selectedId?: string | null
  /** Tap/click/Enter on a card arms it for tap-to-place; again disarms it. */
  onSelect?: (session: BoardSession) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: TRAY_DROPPABLE })
  const dragging = activeId !== null

  return (
    <aside className="agenda-tray">
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
              selected={selectedId === session.sessionId}
              disabled={disabled}
              onOpen={onOpen}
              onPlace={onPlace}
              onSelect={onSelect}
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
  selected,
  disabled,
  onOpen,
  onPlace,
  onSelect,
}: {
  session: BoardSession
  isSource: boolean
  selected: boolean
  disabled: boolean
  onOpen: (session: BoardSession) => void
  onPlace: (session: BoardSession) => void
  onSelect?: (session: BoardSession) => void
}) {
  // The card holds three real controls, so the CARD itself must not also be a
  // control: dnd-kit's `attributes` carry role="button" and a tab stop, and
  // buttons inside a button is invalid ARIA (and unusable — a screen reader
  // reads one node, a keyboard user tabs into a trap of ambiguous actions).
  // `setNodeRef` therefore stays on the card (it is what dnd-kit measures and
  // drags), while `setActivatorNodeRef` + listeners + attributes move to a
  // dedicated drag handle. Every gesture keeps its own control:
  //   • handle — pointer drag, and SPACE for the keyboard drag (keyboardDrag.ts)
  //   • Choose slot — arms tap-to-place, by tap or by Enter/Space on a button
  //   • Place… / Details — unchanged
  const { setNodeRef, setActivatorNodeRef, listeners, attributes } =
    useDraggable({
      id: `session:${session.sessionId}`,
      disabled,
    })
  const speakers = activeParticipants(session)

  return (
    <div
      ref={setNodeRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-md)',
        border: `var(--space-px) solid ${
          selected ? 'var(--border-brand)' : 'var(--border-default)'
        }`,
        background: selected ? 'var(--surface-selected)' : 'var(--surface-card)',
        boxShadow: selected ? 'var(--shadow-md)' : 'var(--shadow-xs)',
        opacity: isSource ? 0.4 : 1,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          minWidth: 0,
        }}
      >
        {/* The drag handle IS the draggable: dnd-kit's activator, its
            listeners and its aria live here rather than on the card, so the
            card can go back to being a container with controls in it.
            touch-action is a class so a coarse pointer can relax it to
            `manipulation` and keep the tray scrollable (app.css). */}
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          disabled={disabled}
          aria-label={`Drag "${session.title}" onto the grid`}
          className="agenda-draggable agenda-drag-handle"
        >
          <Icon name="menu" size={14} />
        </button>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            font: 'var(--type-label)',
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {session.title}
        </span>
      </div>

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

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-2)',
          marginTop: 'var(--space-1)',
        }}
      >
        {onSelect === undefined ? null : (
          <Button
            size="sm"
            variant={selected ? 'primary' : 'secondary'}
            iconLeft="map-pin"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => {
              onSelect(session)
            }}
          >
            {selected ? 'Choosing slot' : 'Choose slot'}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          iconLeft="calendar-days"
          disabled={disabled}
          onClick={() => {
            onPlace(session)
          }}
        >
          Place
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onOpen(session)
          }}
        >
          Details
        </Button>
      </div>
    </div>
  )
}
