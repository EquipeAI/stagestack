import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { PARTICIPANT_STATE_LABEL, personName } from './model'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import {
  Button,
  Callout,
  Card,
  Dialog,
  Field,
  Icon,
  Input,
  Select,
  StatusPill,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { ActionError, ButtonRow } from '~/components/portal/PortalChrome'

// The organizer's controls over one session's speaker portal (M3): each
// speaker's participation, their portal invitation, a read-only preview of
// what they see, and the primary-manager handoff.
//
// One dialog per session rather than controls inside the roster table: these
// are consequential, they send email, and they need their consequence spelled
// out next to the button.

type SessionRow = FunctionReturnType<typeof api.sessions.list>[number]
type Participant = SessionRow['participants'][number]

const STATE_OPTIONS = [
  { value: 'awaiting', label: 'Awaiting Response' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'declined', label: 'Declined' },
]

/** "speaker" → "Speaker": the roster stores the raw role. */
function roleLabel(role: string): string {
  return role.length === 0 ? 'Speaker' : role[0].toUpperCase() + role.slice(1)
}

export function portalPreviewHref(
  eventSlug: string,
  eventContactId: Id<'eventContacts'>,
): string {
  return `/portal/${encodeURIComponent(eventSlug)}?previewAs=${encodeURIComponent(
    eventContactId,
  )}`
}

export function SessionPortalDialog({
  eventSlug,
  row,
  archived,
  onClose,
}: {
  eventSlug: string
  row: SessionRow
  archived: boolean
  onClose: () => void
}) {
  return (
    <Dialog
      open
      width={640}
      title={row.session.title}
      description="Speaker portal: participation, invitations and the primary manager for this session."
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
        }}
      >
        {archived ? (
          <Callout tone="neutral" title="This event is archived">
            Its speaker portal is read-only. Nothing here can be changed or
            sent.
          </Callout>
        ) : null}

        {row.participants.length === 0 ? (
          <Callout tone="attention" title="No speakers on this session">
            Speaker to be announced. Invite a speaker from the sessions page to
            give this session someone to confirm.
          </Callout>
        ) : (
          row.participants.map((participant) => (
            <ParticipantControls
              key={participant.participantId}
              eventSlug={eventSlug}
              participant={participant}
              archived={archived}
            />
          ))
        )}

        <ManagerHandoff
          eventSlug={eventSlug}
          sessionId={row.session._id}
          archived={archived}
        />
      </div>
    </Dialog>
  )
}

function ParticipantControls({
  eventSlug,
  participant,
  archived,
}: {
  eventSlug: string
  participant: Participant
  archived: boolean
}) {
  const setState = useMutation(api.sessions.setParticipationState)
  const invitePortal = useMutation(api.sessions.invitePortal)
  const { pending, error, run } = usePending()
  const name = personName(participant) || 'Unnamed contact'
  const withdrawn = participant.state === 'withdrawn'

  const change = (to: string) => {
    if (to !== 'awaiting' && to !== 'confirmed' && to !== 'declined') return
    void run(async () => {
      await setState({
        eventSlug,
        participantId: participant.participantId,
        to,
      })
      pushToast(
        `${name} — ${PARTICIPANT_STATE_LABEL[to]}`,
        'Recorded as your decision on their behalf, with your name and the time.',
        'check',
      )
    })
  }

  const invite = () => {
    void run(async () => {
      await invitePortal({ eventSlug, eventContactId: participant.eventContactId })
      pushToast(
        'Invitation sent',
        `${name} was emailed a link to their speaker portal. They sign in with that address to claim it.`,
        'mail',
      )
    })
  }

  return (
    <Card variant="flat" title={name} subtitle={roleLabel(participant.role)}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        <ActionError error={error} />
        {withdrawn ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              flexWrap: 'wrap',
            }}
          >
            <StatusPill status="Withdrawn" />
            <span style={{ color: 'var(--text-secondary)' }}>
              They withdrew themselves. Their participation can no longer be
              changed here.
            </span>
          </div>
        ) : (
          <Field
            label="Participation"
            htmlFor={`state-${participant.participantId}`}
            hint="Recorded with your name and the time — speakers can also answer for themselves in their portal."
          >
            <Select
              id={`state-${participant.participantId}`}
              size="sm"
              value={participant.state}
              disabled={pending || archived}
              options={STATE_OPTIONS}
              onChange={(e) => {
                change(e.target.value)
              }}
            />
          </Field>
        )}

        <ButtonRow>
          <Button
            size="sm"
            iconLeft="mail"
            disabled={pending || archived}
            onClick={invite}
          >
            Invite to portal
          </Button>
          <a
            href={portalPreviewHref(eventSlug, participant.eventContactId)}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              color: 'var(--text-link)',
              font: 'var(--type-label)',
            }}
          >
            <Icon name="external-link" size={14} />
            Preview portal
          </a>
        </ButtonRow>
      </div>
    </Card>
  )
}

/**
 * Handing the session's primary manager to someone else. `sessions.list` does
 * not carry handoff rows, so a pending invitation is only shown for as long as
 * this dialog stays open — long enough to correct a typo, and the backend
 * revokes any earlier pending invitation when a new one is sent.
 */
function ManagerHandoff({
  eventSlug,
  sessionId,
  archived,
}: {
  eventSlug: string
  sessionId: Id<'sessions'>
  archived: boolean
}) {
  const startHandoff = useMutation(api.sessions.startManagerHandoff)
  const revokeHandoff = useMutation(api.sessions.revokeHandoff)
  const { pending, error, setError, run } = usePending()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState<{
    handoffId: Id<'managerHandoffs'>
    email: string
  } | null>(null)

  const start = () => {
    const address = email.trim()
    if (address.length === 0) {
      return setError('Enter the email address the invitation should go to.')
    }
    void run(async () => {
      const handoffId = await startHandoff({ eventSlug, sessionId, email: address })
      setSent({ handoffId, email: address })
      setEmail('')
      pushToast(
        'Handoff invitation sent',
        `${address} was invited to become the primary manager. The current manager keeps access until they accept.`,
        'mail',
      )
    })
  }

  const revoke = () => {
    if (sent === null) return
    void run(async () => {
      await revokeHandoff({ eventSlug, handoffId: sent.handoffId })
      setSent(null)
      pushToast(
        'Handoff revoked',
        'That invitation can no longer be accepted.',
        'circle-alert',
      )
    })
  }

  return (
    <Card variant="flat" title="Primary manager">
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        <ActionError error={error} />
        <Callout tone="info" title="The current manager keeps access until the new one accepts">
          The invitee becomes primary manager the first time they open the
          portal with this address. Sending a new invitation revokes any earlier
          one, and only one invitation can be live per session.
        </Callout>

        {sent === null ? null : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              flexWrap: 'wrap',
            }}
          >
            <StatusPill status="Awaiting Response" />
            <span style={{ color: 'var(--text-secondary)' }}>{sent.email}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || archived}
              onClick={revoke}
            >
              Revoke invitation
            </Button>
          </div>
        )}

        <Field
          label="Hand off to"
          htmlFor={`handoff-${sessionId}`}
          hint="They will be able to edit this session's shared content and record each speaker's participation."
        >
          <Input
            id={`handoff-${sessionId}`}
            type="email"
            size="sm"
            value={email}
            placeholder="person@example.com"
            disabled={pending || archived}
            autoComplete="off"
            onChange={(e) => {
              setEmail(e.target.value)
            }}
          />
        </Field>
        <ButtonRow>
          <Button
            size="sm"
            iconLeft="users"
            disabled={pending || archived}
            onClick={start}
          >
            {pending ? 'Sending…' : 'Hand off manager'}
          </Button>
        </ButtonRow>
      </div>
    </Card>
  )
}
