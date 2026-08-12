import { useState } from 'react'
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
import {
  Badge,
  Button,
  Callout,
  Dialog,
  Field,
  Input,
  StatusPill,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'

// The click-through for a session block (M6): its placement and release state,
// its virtual/hybrid links with explicit audiences, and every speaker's
// acknowledgement — with the organizer's on-behalf override. Editing placement
// and releasing are handled by the board (one dialog at a time); this owns the
// draft-only edits and the per-session cancel.

const AUDIENCE: Array<{
  key: 'attendee' | 'backstage' | 'host'
  label: string
  hint: string
  placeholder: string
}> = [
  {
    key: 'attendee',
    label: 'Attendee — publishable',
    hint: 'Shown on the public program once published.',
    placeholder: 'https://example.com/watch',
  },
  {
    key: 'backstage',
    label: 'Backstage — confirmed speakers + managers',
    hint: 'Reaches confirmed participants and their primary managers.',
    placeholder: 'https://example.com/greenroom',
  },
  {
    key: 'host',
    label: 'Host — organizers only',
    hint: 'Never leaves this screen.',
    placeholder: 'https://example.com/host',
  },
]

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
  const setLinks = useMutation(api.agenda.setVirtualLinks)
  const setAck = useMutation(api.agenda.setAck)
  const cancelRelease = useMutation(api.agenda.cancelRelease)
  const { pending, error, run } = usePending()
  const zone = event.timezone

  const links = session.virtualLinks ?? {}
  const [attendee, setAttendee] = useState(links.attendee ?? '')
  const [backstage, setBackstage] = useState(links.backstage ?? '')
  const [host, setHost] = useState(links.host ?? '')
  const [confirmingCancel, setConfirmingCancel] = useState(false)

  const linkValues = { attendee, backstage, host }
  const setters = { attendee: setAttendee, backstage: setBackstage, host: setHost }

  const rel = releaseState(session)
  const relBadge = releaseBadge(rel)
  const roomName =
    session.roomId === undefined
      ? undefined
      : rooms.find((r) => r.roomId === session.roomId)?.name
  const scheduled = session.startsAt !== undefined && session.endsAt !== undefined
  const blocker = hasBlocker(session.conflicts)
  const speakers = activeParticipants(session)

  const saveLinks = () => {
    void run(async () => {
      await setLinks({
        eventSlug,
        sessionId: session.sessionId,
        links: {
          attendee: attendee.trim() === '' ? undefined : attendee.trim(),
          backstage: backstage.trim() === '' ? undefined : backstage.trim(),
          host: host.trim() === '' ? undefined : host.trim(),
        },
      })
      pushToast('Links saved', 'Virtual links were updated for this session.', 'link')
    })
  }

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
        <Button disabled={pending} onClick={onClose}>
          Close
        </Button>
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

        {/* Virtual links */}
        <Section title="Virtual links">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {AUDIENCE.map((a) => (
              <Field key={a.key} label={a.label} htmlFor={`link-${a.key}`} optional hint={a.hint}>
                <Input
                  id={`link-${a.key}`}
                  type="url"
                  value={linkValues[a.key]}
                  placeholder={a.placeholder}
                  onChange={(e) => {
                    setters[a.key](e.target.value)
                  }}
                />
              </Field>
            ))}
            <div>
              <Button size="sm" variant="secondary" iconLeft="link" disabled={pending} onClick={saveLinks}>
                {pending ? 'Saving…' : 'Save links'}
              </Button>
            </div>
          </div>
        </Section>

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
