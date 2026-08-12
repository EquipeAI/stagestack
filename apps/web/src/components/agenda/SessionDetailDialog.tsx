import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import {
  ACK_LABEL,
  PARTICIPANT_STATE_LABEL,
  activeParticipants,
  dayKey,
  dayLabel,
  hasBlocker,
  participantName,
  releaseBadge,
  releaseState,
  slotClock,
} from './model'
import { ConflictList } from './ConflictList'
import type { ReactNode } from 'react'
import type { BoardEvent, BoardRoom, BoardSession } from './model'
import type { Id } from '@convex/_generated/dataModel'
import { Badge, Button, Callout, Dialog, StatusPill } from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'

// The click-through for a session block (M6), REDUCED to a board quick-peek by
// W9: placement and release state, the conflicts that block a release, and
// every speaker's acknowledgement with the organizer's on-behalf override.
//
// Those are all BOARD operations — they are only decidable with the rest of the
// day on screen, which is why they stayed. Everything that is a property of the
// record rather than of the schedule (content, source proposal, tasks, files,
// publication, history, and the audience-scoped virtual links that used to be
// edited here) moved to the session's workspace, which this dialog links to.
// There is no second full detail surface for a session any more.

export function SessionDetailDialog({
  eventSlug,
  event,
  session,
  rooms,
  onClose,
  onEditPlacement,
  onRelease,
}: {
  eventSlug: string
  event: BoardEvent
  session: BoardSession
  rooms: Array<BoardRoom>
  onClose: () => void
  onEditPlacement: (session: BoardSession) => void
  onRelease: (session: BoardSession) => void
}) {
  const setAck = useMutation(api.agenda.setAck)
  const cancelRelease = useMutation(api.agenda.cancelRelease)
  const { pending, error, run } = usePending()
  const zone = event.timezone

  const [confirmingCancel, setConfirmingCancel] = useState(false)

  const rel = releaseState(session)
  const relBadge = releaseBadge(rel)
  const roomName =
    session.roomId === undefined
      ? undefined
      : rooms.find((r) => r.roomId === session.roomId)?.name
  const scheduled = session.startsAt !== undefined && session.endsAt !== undefined
  const blocker = hasBlocker(session.conflicts)
  const speakers = activeParticipants(session)

  const override = (
    participantId: string,
    response: 'acknowledged' | 'conflict',
  ) => {
    void run(async () => {
      await setAck({
        eventSlug,
        participantId: participantId as Id<'sessionParticipants'>,
        response,
      })
      pushToast(
        response === 'acknowledged' ? 'Marked acknowledged' : 'Flagged a conflict',
        'The acknowledgement was recorded on the speaker’s behalf, with you as the actor.',
        response === 'acknowledged' ? 'circle-check' : 'triangle-alert',
      )
    })
  }

  const doCancel = () => {
    void run(async () => {
      const notified = await cancelRelease({ eventSlug, sessionId: session.sessionId })
      pushToast(
        'Release cancelled',
        `A calendar cancellation was sent to ${notified} holder${notified === 1 ? '' : 's'}. The draft placement stays on the board.`,
        'circle-alert',
      )
      setConfirmingCancel(false)
      onClose()
    })
  }

  if (confirmingCancel) {
    return (
      <Dialog
        open
        width={480}
        title="Cancel this release?"
        description="Sends a calendar cancellation to everyone on this session. The draft placement stays on the board."
        onClose={pending ? undefined : () => setConfirmingCancel(false)}
        footer={
          <>
            <Button disabled={pending} onClick={() => setConfirmingCancel(false)}>
              Keep released
            </Button>
            <Button variant="danger" disabled={pending} onClick={doCancel}>
              {pending ? 'Cancelling…' : 'Cancel release'}
            </Button>
          </>
        }
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      width={640}
      title={session.title}
      description={session.format}
      onClose={pending ? undefined : onClose}
      footer={
        <>
          {/* The one hop out of the board and into the whole record. */}
          <Link
            to="/app/e/$eventSlug/sessions/$sessionId"
            params={{ eventSlug, sessionId: session.sessionId }}
            style={{ textDecoration: 'none' }}
          >
            <Button iconLeft="presentation">Open the session workspace</Button>
          </Link>
          <Button disabled={pending} onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}

        {/* Placement + release */}
        <Section title="Placement">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
            }}
          >
            <span style={{ font: 'var(--type-body)', color: 'var(--text-primary)' }}>
              {scheduled
                ? `${dayLabel(dayKey(session.startsAt as number, zone), zone)}, ${slotClock(session.startsAt as number, session.endsAt as number, zone)}`
                : 'Unscheduled'}
            </span>
            {roomName === undefined ? null : (
              <Badge tone="neutral">{roomName}</Badge>
            )}
            <Badge tone={relBadge.tone}>{relBadge.label}</Badge>
            <span style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
              {zone}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <Button
              size="sm"
              iconLeft="calendar-days"
              onClick={() => onEditPlacement(session)}
            >
              {scheduled ? 'Edit placement' : 'Place session'}
            </Button>
            {scheduled && rel.kind !== 'released' ? (
              <Button
                size="sm"
                variant="primary"
                iconLeft="mail"
                disabled={blocker}
                onClick={() => onRelease(session)}
              >
                Release slot
              </Button>
            ) : null}
            {session.releasedSlot !== undefined ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => setConfirmingCancel(true)}
              >
                Cancel release
              </Button>
            ) : null}
          </div>
          {blocker ? (
            <Callout tone="blocked" title="This session cannot be released">
              Resolve the speaker or room clash below first — those collisions are
              non-overridable.
            </Callout>
          ) : null}
        </Section>

        {/* Conflicts */}
        {session.conflicts.length > 0 ? (
          <Section title="Conflicts">
            <ConflictList conflicts={session.conflicts} />
          </Section>
        ) : null}

        {/* Speakers + acknowledgement */}
        <Section title="Speakers">
          {speakers.length === 0 ? (
            <p style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)', margin: 'var(--space-0)' }}>
              Speaker to be announced.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              {speakers.map((p) => (
                <div
                  key={p.participantId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-2)',
                    borderRadius: 'var(--radius-md)',
                    border: 'var(--space-px) solid var(--border-default)',
                    background: 'var(--surface-card)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: '8rem', color: 'var(--text-primary)' }}>
                    {participantName(p)}
                  </span>
                  <StatusPill status={PARTICIPANT_STATE_LABEL[p.state]} />
                  {p.ack === undefined ? (
                    <span style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
                      Not yet notified
                    </span>
                  ) : (
                    <StatusPill status={ACK_LABEL[p.ack]} />
                  )}
                  {session.releasedSlot !== undefined ? (
                    <span style={{ display: 'flex', gap: 'var(--space-1)' }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || p.ack === 'acknowledged'}
                        onClick={() => override(p.participantId, 'acknowledged')}
                      >
                        Acknowledge
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || p.ack === 'conflict'}
                        onClick={() => override(p.participantId, 'conflict')}
                      >
                        Flag conflict
                      </Button>
                    </span>
                  ) : null}
                </div>
              ))}
              {session.releasedSlot !== undefined ? (
                <span style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
                  Acknowledging on a speaker&rsquo;s behalf records you as the actor.
                </span>
              ) : null}
            </div>
          )}
        </Section>
      </div>
    </Dialog>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <span
        style={{
          font: 'var(--type-eyebrow)',
          letterSpacing: 'var(--tracking-caps)',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
        }}
      >
        {title}
      </span>
      {children}
    </section>
  )
}
