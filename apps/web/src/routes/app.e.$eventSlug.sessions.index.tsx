import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { ActiveFilter } from '~/ds'
import type { ContentFilter } from '~/components/sessions/search'
import {
  ActiveFilters,
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  MenuButton,
  Select,
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
import {
  CONTENT_FILTERS,
  matchesContent,
  parseSessionsSearch,
} from '~/components/sessions/search'
import { visibleFilters } from '~/lib/filters'

// The event's sessions (M2). A session is what a proposal becomes once it is
// accepted, or what a directly invited speaker is invited to — scheduling
// arrives with the agenda in a later milestone, so this is the roster, not a
// calendar.
//
// W9: a row opens the session's workspace (/sessions/$sessionId), which is
// where the whole record lives — source proposal, speakers, content approval,
// tasks, schedule, publication, history. This list keeps the batch columns and
// the in-cell controls an organizer uses across many rows at once; it is not a
// second detail surface.

export const Route = createFileRoute('/app/e/$eventSlug/sessions/')({
  component: Sessions,
  // Content approval is the gate that holds publication back quietly, so the
  // control center's "4 sessions have Draft content" needs to land on four
  // rows, not on the roster.
  validateSearch: parseSessionsSearch,
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
  // W4: one producer for publication state. The Public column prints the
  // sentence convex/model/readiness.ts composed — this file derives nothing
  // from flags, slots or content status.
  const publication = useQuery(
    api.readiness.publication,
    isOrganizer ? { eventSlug } : 'skip',
  )
  const { content } = Route.useSearch()
  const navigate = Route.useNavigate()
  // Filter changes REPLACE: narrowing the roster is a view of this page, not a
  // journey to another one, so back still returns to wherever the organizer
  // came from rather than walking back through their own filter presses.
  const setContent = (next: ContentFilter | undefined) => {
    void navigate({ search: (prev) => ({ ...prev, content: next }), replace: true })
  }
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

  const loading = sessions === undefined
  const all = sessions ?? []

  const summaries = new Map(
    (publication ?? []).map((row) => [row.sessionId as string, row.publication]),
  )
  const rows: Array<Row> = all
    .filter((row) => matchesContent(row.session.contentStatus, content))
    .map((row) => ({
      ...row,
      id: row.session._id,
    }))
  const portalRow = rows.find((row) => row.session._id === portalFor) ?? null

  // Counted on the unfiltered roster so narrowing never makes the option that
  // produced the view read zero. Draft keeps its place at zero (W12): that
  // zero is the answer to "is anything being held back from the program?" —
  // an empty Approved is not news anybody came here for.
  const contentOptions = visibleFilters(
    CONTENT_FILTERS.map((id) => ({
      id,
      label: id === 'draft' ? 'Draft content' : 'Approved content',
      count: all.filter((row) => matchesContent(row.session.contentStatus, id))
        .length,
      meaningfulZero: id === 'draft',
    })),
    content === undefined ? [] : [content],
  )

  const chips: Array<ActiveFilter> =
    content === undefined
      ? []
      : [
          {
            id: `content:${content}`,
            label: `Content: ${content === 'draft' ? 'Draft' : 'Approved'}`,
            onRemove: () => {
              setContent(undefined)
            },
          },
        ]
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
        // Slot order (W12): filters first — the roster has no free-text
        // search, no saved views and no export, and none is invented here.
        left={
          <span
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 'var(--space-3)',
            }}
          >
            <Select
              size="sm"
              aria-label="Filter by content approval"
              value={content ?? ''}
              options={[
                { value: '', label: 'Any content state' },
                ...contentOptions.map((option) => ({
                  value: option.id,
                  label: `${option.label} (${option.count})`,
                })),
              ]}
              onChange={(e) => {
                setContent(
                  e.target.value === ''
                    ? undefined
                    : (e.target.value as ContentFilter),
                )
              }}
            />
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--text-tertiary)',
              }}
            >
              {loading ? '—' : rows.length} session
              {rows.length === 1 ? '' : 's'}
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

      {/* A filtered view arrived at by link must say so and offer the way out;
          a silently short list reads as missing data. */}
      <ActiveFilters chips={chips} />

      {loading ? (
        <Card padded={false}>
          <DataTable
            aria-label="Sessions"
            loading
            loadingLabel="Loading the session roster…"
            rows={[]}
            columns={SKELETON_COLUMNS}
          />
        </Card>
      ) : rows.length === 0 ? (
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
            aria-label="Sessions"
            rowKey="id"
            // Under 640px the roster is a card list: the session, its content
            // state, who is speaking, and the one action an organizer takes
            // from a list. Tapping the card opens the workspace.
            cardRow={(row: Row) => (
              <>
                <span style={{ color: 'var(--text-primary)' }}>
                  {row.session.title}
                </span>
                <span
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                  }}
                >
                  <StatusPill
                    status={
                      row.session.status === 'cancelled'
                        ? 'Cancelled'
                        : 'Planned'
                    }
                  />
                  <Badge
                    tone={
                      (row.session.contentStatus ?? 'approved') === 'draft'
                        ? 'attention'
                        : 'success'
                    }
                  >
                    {(row.session.contentStatus ?? 'approved') === 'draft'
                      ? 'Draft content'
                      : 'Approved content'}
                  </Badge>
                  <span
                    style={{
                      font: 'var(--type-caption)',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    {row.participants.length === 0
                      ? 'Speaker to be announced'
                      : row.participants
                          .map((p) =>
                            `${p.firstName} ${p.lastName}`.trim() ||
                            'Unnamed contact',
                          )
                          .join(', ')}
                  </span>
                </span>
                <span>
                  <Button
                    size="sm"
                    iconLeft="mic-vocal"
                    onClick={() => {
                      setPortalFor(row.session._id)
                    }}
                  >
                    Manage speaker portal
                  </Button>
                </span>
              </>
            )}
            // Focusable rows that activate on Enter/Space (W6) — clicks that
            // land on a cell's own control are left to that control.
            onRowClick={(row: Row) => {
              void navigate({
                to: '/app/e/$eventSlug/sessions/$sessionId',
                params: { eventSlug, sessionId: row.session._id },
              })
            }}
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
                    // The proposal a session came from is part of the session's
                    // record, so the link lands on the workspace tab that shows
                    // it rather than on the whole proposals table.
                    <Link
                      to="/app/e/$eventSlug/sessions/$sessionId"
                      params={{ eventSlug, sessionId: row.session._id }}
                      search={{ tab: 'proposal' }}
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
                key: 'public',
                header: 'Public',
                cell: (row: Row) => {
                  // While the publication query is still loading, say so —
                  // a dash would read as "no publication state", which is a
                  // different (and false) claim.
                  if (publication === undefined) {
                    return (
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        Loading…
                      </span>
                    )
                  }
                  const summary = summaries.get(row.session._id)?.summary
                  return summary === undefined ? (
                    <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                  ) : (
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {summary}
                    </span>
                  )
                },
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
                key: 'actions',
                header: 'Actions',
                width: '11rem',
                // W12: at most two visible row actions. "Manage" is the one an
                // organizer reaches for from a list; everything else that used
                // to compete for the row lives in the overflow menu, which is
                // keyboard-operable (arrows, Home/End, Escape back to trigger).
                cell: (row: Row) => (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 'var(--space-1)',
                    }}
                  >
                    <Button
                      size="sm"
                      iconLeft="mic-vocal"
                      onClick={() => {
                        setPortalFor(row.session._id)
                      }}
                    >
                      Manage
                    </Button>
                    <MenuButton
                      label={`More actions for ${row.session.title}`}
                      items={[
                        {
                          id: 'workspace',
                          label: 'Open the session workspace',
                          onSelect: () => {
                            void navigate({
                              to: '/app/e/$eventSlug/sessions/$sessionId',
                              params: {
                                eventSlug,
                                sessionId: row.session._id,
                              },
                            })
                          },
                        },
                        {
                          id: 'content',
                          label: 'Review the content approval',
                          onSelect: () => {
                            void navigate({
                              to: '/app/e/$eventSlug/sessions/$sessionId',
                              params: {
                                eventSlug,
                                sessionId: row.session._id,
                              },
                              search: { tab: 'content' },
                            })
                          },
                        },
                        row.session.source === 'cfp' && {
                          id: 'proposal',
                          label: 'Open the source proposal',
                          onSelect: () => {
                            void navigate({
                              to: '/app/e/$eventSlug/sessions/$sessionId',
                              params: {
                                eventSlug,
                                sessionId: row.session._id,
                              },
                              search: { tab: 'proposal' },
                            })
                          },
                        },
                      ]}
                    />
                  </span>
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

/** Headers only: the skeleton holds the shape the rows will take, so the
 * table does not jump a column wider the moment the roster arrives. */
const SKELETON_COLUMNS = [
  { key: 'title', header: 'Session' },
  { key: 'source', header: 'Source', width: '9rem' },
  { key: 'status', header: 'Status', width: '8rem' },
  { key: 'content', header: 'Content' },
  { key: 'public', header: 'Public' },
  { key: 'participants', header: 'Participants' },
  { key: 'actions', header: 'Actions', width: '11rem' },
]

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
