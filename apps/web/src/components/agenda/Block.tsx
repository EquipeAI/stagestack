import {
  ACK_LABEL,
  activeParticipants,
  blockerConflicts,
  clockLabel,
  hasBlocker,
  hasWarning,
  releaseBadge,
  releaseState,
} from './model'
import type { CSSProperties } from 'react'
import type {
  BoardRoom,
  BoardTrack,
  PlacedBlock,
} from './model'
import { Badge, Icon, Tooltip } from '~/ds'

// One block on the grid — a session or a muted agenda item. Status first: a
// blocker paints the left edge and card rust, a same-track warning paints it
// ember. The full conflict message rides a tooltip; the detail dialog carries
// the rest.

export function BlockCard({
  block,
  zone,
  roomsById,
  tracksById,
  secondary,
  fill,
  dragging,
}: {
  block: PlacedBlock
  zone: string
  roomsById: Map<string, BoardRoom>
  tracksById: Map<string, BoardTrack>
  /** Which cross-reference to show under the title. */
  secondary: 'room' | 'track'
  /** Stretch to the positioned wrapper's height (grid use). */
  fill?: boolean
  dragging?: boolean
}) {
  const isItem = block.kind === 'item'
  const blocker = hasBlocker(block.conflicts)
  const warning = !blocker && hasWarning(block.conflicts)
  const track =
    block.trackId === undefined ? undefined : tracksById.get(block.trackId)

  const accent = blocker
    ? 'var(--status-blocked-fg)'
    : warning
      ? 'var(--status-attention-fg)'
      : isItem
        ? 'var(--border-strong)'
        : (track?.color ?? 'var(--border-strong)')

  const background = blocker
    ? 'var(--status-blocked-bg)'
    : warning
      ? 'var(--status-attention-bg)'
      : isItem
        ? 'var(--surface-sunken)'
        : 'var(--surface-card)'

  const style: CSSProperties = {
    height: fill ? '100%' : undefined,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-half)',
    overflow: 'hidden',
    padding: 'var(--space-1) var(--space-2)',
    borderRadius: 'var(--radius-md)',
    border: 'var(--space-px) solid var(--border-default)',
    borderLeft: `3px solid ${accent}`,
    background,
    boxShadow: dragging ? 'var(--shadow-lg)' : 'var(--shadow-xs)',
    cursor: 'grab',
    userSelect: 'none',
  }

  const secondaryLabel =
    secondary === 'room'
      ? block.roomId === undefined
        ? isItem
          ? 'All rooms'
          : 'No room'
        : (roomsById.get(block.roomId)?.name ?? 'Unknown room')
      : isItem
        ? 'Agenda item'
        : (track?.name ?? 'No track')

  const rel = block.session === undefined ? undefined : releaseState(block.session)
  const relBadge = rel === undefined ? undefined : releaseBadge(rel)

  return (
    <div style={style}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 'var(--space-1)',
          minWidth: 0,
        }}
      >
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
          {block.title}
        </span>
        {block.conflicts.length > 0 ? (
          <ConflictMark block={block} />
        ) : null}
      </div>

      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-2xs)',
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--text-secondary)',
          whiteSpace: 'nowrap',
        }}
      >
        {clockLabel(block.startsAt, zone)}–{clockLabel(block.endsAt, zone)}
      </span>

      <span
        style={{
          font: 'var(--type-caption)',
          color: 'var(--text-tertiary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {secondaryLabel}
      </span>

      {block.session !== undefined ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--space-1)',
          }}
        >
          {relBadge !== undefined && rel?.kind !== 'notReleased' ? (
            <Badge tone={relBadge.tone} size="sm">
              {relBadge.label}
            </Badge>
          ) : null}
          <AckSummary session={block.session} />
        </div>
      ) : null}
    </div>
  )
}

function ConflictMark({ block }: { block: PlacedBlock }) {
  const blockers = blockerConflicts(block.conflicts)
  const isBlocker = blockers.length > 0
  const source = isBlocker ? blockers : block.conflicts
  const message = source[0]?.message ?? ''
  return (
    <Tooltip label={message}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-half)',
          color: isBlocker ? 'var(--status-blocked-fg)' : 'var(--status-attention-fg)',
        }}
      >
        <Icon name="triangle-alert" size={14} />
        {source.length > 1 ? (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {source.length}
          </span>
        ) : null}
      </span>
    </Tooltip>
  )
}

/** A compact roll-up of acknowledgement across a session's active speakers. */
function AckSummary({
  session,
}: {
  session: NonNullable<PlacedBlock['session']>
}) {
  const active = activeParticipants(session)
  const withAck = active.filter((p) => p.ack !== undefined)
  if (withAck.length === 0) return null
  const conflict = withAck.filter((p) => p.ack === 'conflict').length
  const acked = withAck.filter((p) => p.ack === 'acknowledged').length
  if (conflict > 0) {
    return (
      <Badge tone="blocked" size="sm" dot>
        {`${conflict} ${ACK_LABEL.conflict}`}
      </Badge>
    )
  }
  if (acked === withAck.length) {
    return (
      <Badge tone="success" size="sm" dot>
        {ACK_LABEL.acknowledged}
      </Badge>
    )
  }
  return (
    <Badge tone="info" size="sm" dot>
      {`${acked}/${withAck.length} acknowledged`}
    </Badge>
  )
}
