import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  StatusPill,
  Textarea,
  Toolbar,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { PARTICIPANT_STATE_LABEL } from '~/lib/labels'
import { pushToast } from '~/components/toast'
import { SessionPortalDialog } from '~/components/portal/SessionPortalDialog'
import { SessionContentCell } from '~/components/sessions/SessionContentCell'
import { FormatField } from '~/components/sessions/FormatField'

// The event's sessions (M2). A session is what a proposal becomes once it is
// accepted, or what a directly invited speaker is invited to — scheduling
// arrives with the agenda in a later milestone, so this is the roster, not a
// calendar.

export const Route = createFileRoute('/app/e/$eventSlug/sessions')({
  component: Sessions,
})

type SessionRow = FunctionReturnType<typeof api.sessions.list>[number]
type Row = SessionRow & { id: string }

function Sessions() {
  const { eventSlug } = Route.useParams()
  const event = useQuery(api.events.get, { eventSlug })
  const isOrganizer = event?.role === 'organizer'
  const sessions = useQuery(
    api.sessions.list,
    isOrganizer ? { eventSlug } : 'skip',
  )
  const [inviting, setInviting] = useState(false)
  const [portalFor, setPortalFor] = useState<string | null>(null)
  const archived = event?.event.archivedAt !== undefined

  if (event === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading sessions…</p>
  }

  if (!isOrganizer) {
    return (
      <Callout tone="blocked" title="Sessions are organizer-only">
        Reviewers see the proposals assigned to them under Reviews. Ask an
        organizer if you need access to the session roster.
      </Callout>
    )
  }

  if (sessions === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading sessions…</p>
  }

  const rows: Array<Row> = sessions.map((row) => ({
    ...row,
    id: row.session._id,
  }))
  const portalRow = rows.find((row) => row.session._id === portalFor) ?? null
  const inviteButton = (
    <Button
      variant="primary"
      iconLeft="plus"
      disabled={archived}
      onClick={() => {
        setInviting(true)
      }}
    >
      Invite a speaker
    </Button>
  )

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <Toolbar
        left={
          <span
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              gap: 'var(--space-3)',
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
              {rows.length} session{rows.length === 1 ? '' : 's'}
            </span>
            <span
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
              }}
            >
              Draft content never appears on the public program.
            </span>
          </span>
        }
        right={inviteButton}
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="presentation"
            title="No sessions yet"
            description="A session appears here the moment a proposal is accepted, or when you invite a speaker directly."
            action={inviteButton}
          />
        </Card>
      ) : (
        <Card padded={false}>
          <DataTable
            rowKey="id"
            columns={[
              {
                key: 'title',
                header: 'Session',
                cell: (row: Row) => (
                  <span
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-half)',
                    }}
                  >
                    <span style={{ color: 'var(--text-primary)' }}>
                      {row.session.title}
                    </span>
                    {row.session.format === undefined ? null : (
                      <span
                        style={{
                          font: 'var(--type-caption)',
                          color: 'var(--text-tertiary)',
                        }}
                      >
                        {row.session.format}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'source',
                header: 'Source',
                width: '9rem',
                cell: (row: Row) =>
                  row.session.source === 'cfp' ? (
                    <Link
                      to="/app/e/$eventSlug/proposals"
                      params={{ eventSlug }}
                      style={{ textDecoration: 'none' }}
                    >
                      <Badge tone="info">From proposal</Badge>
                    </Link>
                  ) : (
                    <Badge tone="neutral">Direct invitation</Badge>
                  ),
              },
              {
                key: 'status',
                header: 'Status',
                width: '8rem',
                cell: (row: Row) => (
                  <StatusPill
                    status={
                      row.session.status === 'cancelled'
                        ? 'Cancelled'
                        : 'Planned'
                    }
                  />
                ),
              },
              {
                key: 'content',
                header: 'Content',
                cell: (row: Row) => (
                  <SessionContentCell
                    eventSlug={eventSlug}
                    session={row.session}
                    archived={archived}
                  />
                ),
              },
              {
                key: 'participants',
                header: 'Participants',
                cell: (row: Row) =>
                  row.participants.length === 0 ? (
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      Speaker to be announced
                    </span>
                  ) : (
                    <span
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 'var(--space-2)',
                      }}
                    >
                      {row.participants.map((participant) => (
                        <span
                          key={participant.participantId}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 'var(--space-2)',
                          }}
                        >
                          <span style={{ color: 'var(--text-primary)' }}>
                            {`${participant.firstName} ${participant.lastName}`.trim() ||
                              'Unnamed contact'}
                          </span>
                          <StatusPill
                            status={PARTICIPANT_STATE_LABEL[participant.state]}
                          />
                        </span>
                      ))}
                    </span>
                  ),
              },
              {
                key: 'portal',
                header: 'Speaker portal',
                width: '10rem',
                cell: (row: Row) => (
                  <Button
                    size="sm"
                    iconLeft="mic-vocal"
                    onClick={() => {
                      setPortalFor(row.session._id)
                    }}
                  >
                    Manage
                  </Button>
                ),
              },
            ]}
            rows={rows}
          />
        </Card>
      )}

      {portalRow === null ? null : (
        <SessionPortalDialog
          eventSlug={eventSlug}
          row={portalRow}
          archived={archived}
          onClose={() => {
            setPortalFor(null)
          }}
        />
      )}

      {inviting ? (
        <InviteSpeakerDialog
          eventSlug={eventSlug}
          onClose={() => {
            setInviting(false)
          }}
        />
      ) : null}
    </div>
  )
}

// ── Direct invitation ────────────────────────────────────────────────────

function InviteSpeakerDialog({
  eventSlug,
  onClose,
}: {
  eventSlug: string
  onClose: () => void
}) {
  const createDirect = useMutation(api.sessions.createDirect)
  const library = useQuery(api.library.list, { eventSlug })
  const { pending, error, setError, run } = usePending()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [format, setFormat] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [tagline, setTagline] = useState('')
  const [bio, setBio] = useState('')

  const optional = (value: string) => {
    const text = value.trim()
    return text === '' ? undefined : text
  }

  const send = () => {
    if (title.trim() === '') return setError('The session needs a title.')
    if (firstName.trim() === '' || lastName.trim() === '') {
      return setError("Enter the speaker's first and last name.")
    }
    if (email.trim() === '') {
      return setError('The invitation needs an email address to go to.')
    }
    void run(async () => {
      await createDirect({
        eventSlug,
        title: title.trim(),
        description: optional(description),
        format: optional(format),
        speaker: {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          tagline: optional(tagline),
          bio: optional(bio),
        },
      })
      pushToast(
        'Invitation sent',
        `${email.trim()} was invited to speak. The email left immediately, and the session shows Awaiting Response until they answer.`,
        'mail',
      )
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={640}
      title="Invite a speaker"
      description="This creates the session and emails the speaker an invitation immediately."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={send} disabled={pending}>
            {pending ? 'Sending…' : 'Invite a speaker'}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}

        <Field label="Session title" htmlFor="session-title" required>
          <Input
            id="session-title"
            value={title}
            autoFocus
            placeholder="Opening keynote"
            onChange={(e) => {
              setTitle(e.target.value)
            }}
          />
        </Field>

        <Field label="Description" htmlFor="session-description" optional>
          <Textarea
            id="session-description"
            rows={3}
            value={description}
            placeholder="What the session covers. The speaker sees this later in their portal."
            onChange={(e) => {
              setDescription(e.target.value)
            }}
          />
        </Field>

        <FormatField
          id="session-format"
          value={format}
          formats={library?.formats ?? []}
          disabled={pending}
          onChange={setFormat}
        />

        <div
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: '1 1 12rem' }}>
            <Field label="First name" htmlFor="speaker-first" required>
              <Input
                id="speaker-first"
                value={firstName}
                onChange={(e) => {
                  setFirstName(e.target.value)
                }}
              />
            </Field>
          </div>
          <div style={{ flex: '1 1 12rem' }}>
            <Field label="Last name" htmlFor="speaker-last" required>
              <Input
                id="speaker-last"
                value={lastName}
                onChange={(e) => {
                  setLastName(e.target.value)
                }}
              />
            </Field>
          </div>
        </div>

        <Field
          label="Email"
          htmlFor="speaker-email"
          required
          hint="The invitation goes here as soon as you send it."
        >
          <Input
            id="speaker-email"
            type="email"
            value={email}
            placeholder="person@example.com"
            onChange={(e) => {
              setEmail(e.target.value)
            }}
          />
        </Field>

        <Field label="Tagline" htmlFor="speaker-tagline" optional>
          <Input
            id="speaker-tagline"
            value={tagline}
            placeholder="Head of Platform, Example"
            onChange={(e) => {
              setTagline(e.target.value)
            }}
          />
        </Field>

        <Field label="Bio" htmlFor="speaker-bio" optional>
          <Textarea
            id="speaker-bio"
            rows={3}
            value={bio}
            onChange={(e) => {
              setBio(e.target.value)
            }}
          />
        </Field>
      </div>
    </Dialog>
  )
}
