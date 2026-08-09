import { useEffect, useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { PARTICIPANT_STATE_LABEL, optionalText, personName } from './model'
import type { ManagedParticipant, ManagingItem } from './model'
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Input,
  StatusPill,
  Textarea,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import {
  ActionError,
  ButtonRow,
  PreviewLock,
} from '~/components/portal/PortalChrome'

// The primary manager's side of the portal: shared session content they may
// edit, and each speaker's participation, which they may answer on that
// speaker's behalf. Co-speakers appear as a name and a state only — the portal
// never exposes other people's contact details.

export function ManagedSessionCard({
  eventSlug,
  item,
  readOnly,
}: {
  eventSlug: string
  item: ManagingItem
  readOnly: boolean
}) {
  const updateSession = useMutation(api.portal.updateSessionContent)
  const { pending, error, setError, run } = usePending()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [description, setDescription] = useState(item.description ?? '')
  const [format, setFormat] = useState(item.format ?? '')

  const serverKey = JSON.stringify([item.title, item.description, item.format])
  // The key of the server values this form was last seeded from, so an
  // organizer saving the same session while a manager types can be noticed
  // without acting on it.
  const [seededKey, setSeededKey] = useState(serverKey)

  const reseed = () => {
    setTitle(item.title)
    setDescription(item.description ?? '')
    setFormat(item.format ?? '')
    setSeededKey(serverKey)
  }

  // `item` comes from a live subscription, so it changes under the form.
  // Re-seeding while the manager is editing would silently throw away their
  // unsaved typing, which is the one thing this card must not do — the local
  // copy wins for as long as the form is open (the same rule the autosaved
  // drafts follow). Closed, the card keeps tracking the server.
  useEffect(() => {
    if (editing) return
    setTitle(item.title)
    setDescription(item.description ?? '')
    setFormat(item.format ?? '')
    setSeededKey(serverKey)
  }, [serverKey, editing])

  const conflict = editing && serverKey !== seededKey

  const save = () => {
    if (title.trim().length === 0) {
      return setError('The session needs a title.')
    }
    void run(async () => {
      await updateSession({
        eventSlug,
        sessionId: item.sessionId,
        patch: {
          title: title.trim(),
          description: optionalText(description) ?? '',
          format: optionalText(format) ?? '',
        },
      })
      setEditing(false)
      pushToast(
        'Session updated',
        'The organizers see the new session content immediately.',
        'check',
      )
    })
  }

  return (
    <Card
      title={item.title}
      subtitle={item.format}
      actions={
        <>
          {item.source === 'cfp' ? (
            <Badge tone="info">From proposal</Badge>
          ) : (
            <Badge tone="neutral">Direct invitation</Badge>
          )}
          <StatusPill
            status={item.status === 'cancelled' ? 'Cancelled' : 'Planned'}
          />
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
        }}
      >
        <ActionError error={error} />

        {editing ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
            }}
          >
            {conflict ? (
              <Callout
                tone="attention"
                title="This session changed somewhere else"
                actions={
                  <Button size="sm" disabled={pending} onClick={reseed}>
                    Discard my edits
                  </Button>
                }
              >
                An organizer saved different content while you were editing.
                Saving replaces theirs with what is on this screen.
              </Callout>
            ) : null}
            <Field
              label="Session title"
              htmlFor={`session-${item.sessionId}-title`}
              required
            >
              <Input
                id={`session-${item.sessionId}-title`}
                value={title}
                disabled={pending}
                autoComplete="off"
                onChange={(e) => {
                  setTitle(e.target.value)
                }}
              />
            </Field>
            <Field
              label="Description"
              htmlFor={`session-${item.sessionId}-description`}
              hint="What attendees will see once the organizers publish the program."
            >
              <Textarea
                id={`session-${item.sessionId}-description`}
                rows={5}
                value={description}
                disabled={pending}
                onChange={(e) => {
                  setDescription(e.target.value)
                }}
              />
            </Field>
            <Field label="Format" htmlFor={`session-${item.sessionId}-format`}>
              <Input
                id={`session-${item.sessionId}-format`}
                value={format}
                disabled={pending}
                autoComplete="off"
                placeholder="Talk"
                onChange={(e) => {
                  setFormat(e.target.value)
                }}
              />
            </Field>
            <ButtonRow>
              <Button variant="primary" disabled={pending} onClick={save}>
                {pending ? 'Saving…' : 'Save session'}
              </Button>
              <Button
                disabled={pending}
                onClick={() => {
                  setEditing(false)
                  setError(null)
                  reseed()
                }}
              >
                Cancel
              </Button>
            </ButtonRow>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
            }}
          >
            <p
              style={{
                font: 'var(--type-body)',
                color:
                  item.description === undefined
                    ? 'var(--text-tertiary)'
                    : 'var(--text-secondary)',
                margin: 'var(--space-0)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {item.description ??
                'No description yet. You manage this session, so you can write one.'}
            </p>
            <ButtonRow>
              {readOnly ? (
                <PreviewLock>
                  <Button size="sm" iconLeft="pencil" disabled>
                    Edit session content
                  </Button>
                </PreviewLock>
              ) : (
                <Button
                  size="sm"
                  iconLeft="pencil"
                  onClick={() => {
                    setEditing(true)
                  }}
                >
                  Edit session content
                </Button>
              )}
            </ButtonRow>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          <span
            style={{
              font: 'var(--type-eyebrow)',
              letterSpacing: 'var(--tracking-caps)',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
            }}
          >
            Speakers
          </span>
          {item.participants.length === 0 ? (
            <span style={{ color: 'var(--text-tertiary)' }}>
              Speaker to be announced.
            </span>
          ) : (
            item.participants.map((participant) => (
              <ParticipantRow
                key={participant.participantId}
                eventSlug={eventSlug}
                participant={participant}
                readOnly={readOnly}
              />
            ))
          )}
          <Callout tone="neutral" title="Each speaker was asked to confirm">
            Speakers answer for themselves in their own portal. Record an answer
            here only when a speaker has told you directly — it is stored as
            your answer on their behalf.
          </Callout>
        </div>
      </div>
    </Card>
  )
}

function ParticipantRow({
  eventSlug,
  participant,
  readOnly,
}: {
  eventSlug: string
  participant: ManagedParticipant
  readOnly: boolean
}) {
  const confirm = useMutation(api.portal.confirmParticipation)
  const { pending, error, run } = usePending()

  const decide = (to: 'confirmed' | 'declined') => {
    void run(async () => {
      await confirm({
        eventSlug,
        participantId: participant.participantId,
        to,
      })
      pushToast(
        to === 'confirmed' ? 'Recorded as Confirmed' : 'Recorded as Declined',
        `${personName(participant) || 'This speaker'} — answered on their behalf.`,
        'check',
      )
    })
  }

  const name = personName(participant) || 'Unnamed speaker'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        padding: 'var(--space-3)',
        background: 'var(--surface-sunken)',
        borderRadius: 'var(--radius-control)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ color: 'var(--text-primary)' }}>{name}</span>
        <StatusPill status={PARTICIPANT_STATE_LABEL[participant.state]} />
      </div>
      <ActionError error={error} />
      {participant.state === 'awaiting' ? (
        <ButtonRow>
          {readOnly ? (
            <>
              <PreviewLock>
                <Button size="sm" disabled>
                  Confirm on their behalf
                </Button>
              </PreviewLock>
              <PreviewLock>
                <Button size="sm" disabled>
                  Decline on their behalf
                </Button>
              </PreviewLock>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={pending}
                onClick={() => {
                  decide('confirmed')
                }}
              >
                Confirm on their behalf
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  decide('declined')
                }}
              >
                Decline on their behalf
              </Button>
            </>
          )}
        </ButtonRow>
      ) : null}
    </div>
  )
}
