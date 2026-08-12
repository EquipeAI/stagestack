import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Id } from '@convex/_generated/dataModel'
import type { InstanceRow } from '~/components/tasks/model'
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  Input,
  StatusPill,
} from '~/ds'
import { PARTICIPANT_STATE_LABEL } from '~/lib/labels'
import { formatDateTime } from '~/lib/datetime'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import {
  WorkspacePanel,
  WorkspaceShell,
} from '~/components/workspace/WorkspaceShell'
import {
  SESSION_TABS,
  activeWorkspaceTab,
  parseSessionWorkspaceSearch,
} from '~/components/workspace/tabs'
import { SessionContentCell } from '~/components/sessions/SessionContentCell'
import { ContentHistoryPanel } from '~/components/sessions/ContentHistoryPanel'
import { InstanceActions } from '~/components/tasks/InstanceActions'
import { UploadVersionList } from '~/components/tasks/UploadVersionList'
import { TASK_STATUS_LABEL } from '~/components/tasks/model'
import { useNow } from '~/components/tasks/useNow'

// The session workspace (W9) — one session, everything about it, at a URL.
//
// This is the page W4's blockers link to. Its Publication tab prints the
// sentences `convex/model/readiness.ts` composed, VERBATIM, next to the repair
// target the same producer declared: nothing about publication is re-derived
// in TSX, here or anywhere else.
//
// Composition: content approval reuses the sessions table's own cell, history
// is the promoted `ContentHistoryDialog` body, and tasks and files come off
// `tasks.listInstances` / `tasks.listUploads`. The workspace query supplies
// only the spine — the session, its speakers, its room, its source proposal
// and its publication state.

/** Where a publication reason says the repair is made. */
const REPAIR: Record<
  'sessions' | 'agenda' | 'publish',
  { to: string; label: string }
> = {
  sessions: { to: '/app/e/$eventSlug/sessions', label: 'Open Sessions' },
  agenda: { to: '/app/e/$eventSlug/agenda', label: 'Open Agenda' },
  publish: { to: '/app/e/$eventSlug/publish', label: 'Open the public page' },
}

export const Route = createFileRoute('/app/e/$eventSlug/sessions/$sessionId')({
  component: SessionWorkspaceRoute,
  validateSearch: parseSessionWorkspaceSearch,
})

function SessionWorkspaceRoute() {
  const { eventSlug, sessionId } = Route.useParams()
  const event = useQuery(api.events.get, { eventSlug })

  if (event === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading session…</p>
  }
  if (event.role !== 'organizer') {
    return (
      <Callout tone="blocked" title="Sessions are organizer-only">
        Reviewers see the proposals assigned to them under Reviews. Ask an
        organizer if you need access to the session roster.
      </Callout>
    )
  }
  return (
    <SessionWorkspace
      eventSlug={eventSlug}
      sessionId={sessionId as Id<'sessions'>}
      timezone={event.event.timezone}
      archived={event.event.archivedAt !== undefined}
    />
  )
}

function SessionWorkspace({
  eventSlug,
  sessionId,
  timezone,
  archived,
}: {
  eventSlug: string
  sessionId: Id<'sessions'>
  timezone: string
  archived: boolean
}) {
  const navigate = Route.useNavigate()
  const search = Route.useSearch()
  const tab = activeWorkspaceTab(SESSION_TABS, search)

  const data = useQuery(api.workspaces.session, { eventSlug, sessionId })
  const instances = useQuery(api.tasks.listInstances, { eventSlug })
  const sessions = useQuery(api.sessions.list, { eventSlug })
  const now = useNow()

  if (data === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading session…</p>
  }

  const { session, publication } = data
  const mine = (instances ?? []).filter((row) => row.sessionId === sessionId)
  const withFiles = mine.filter((row) => row.uploadCount > 0)
  // The table's own row for this session, so the content controls are the very
  // same component the sessions list renders rather than a second copy.
  const listRow = (sessions ?? []).find((row) => row.session._id === sessionId)

  return (
    <WorkspaceShell
      title={session.title}
      description={session.format}
      crumbs={[
        { label: 'Sessions', href: `/app/e/${eventSlug}/sessions` },
        { label: session.title },
      ]}
      tabs={SESSION_TABS}
      activeTab={tab}
      tabsLabel="Session workspace"
      onTabChange={(next) => {
        void navigate({
          search: next === SESSION_TABS[0].id ? {} : { tab: next as never },
        })
      }}
      primaryAction={
        <Link
          to="/app/e/$eventSlug/agenda"
          params={{ eventSlug }}
          search={{ view: 'room' }}
          style={{ textDecoration: 'none' }}
        >
          <Button variant="primary" iconLeft="calendar-days">
            Open on the board
          </Button>
        </Link>
      }
    >
      {tab === 'overview' ? (
        <WorkspacePanel label="Overview">
          <Card title="This session">
            <dl style={defs}>
              <Def label="Status">
                <StatusPill
                  status={session.status === 'cancelled' ? 'Cancelled' : 'Planned'}
                />
              </Def>
              <Def label="Source">
                {session.source === 'cfp' ? (
                  <Badge tone="info">From proposal</Badge>
                ) : (
                  <Badge tone="neutral">Direct invitation</Badge>
                )}
              </Def>
              <Def label="Room">{data.roomName ?? '—'}</Def>
              <Def label="Content">
                <StatusPill
                  status={session.contentStatus === 'draft' ? 'Draft' : 'Approved'}
                  tone={session.contentStatus === 'draft' ? 'attention' : 'success'}
                />
              </Def>
              <Def label="Speakers">
                {data.participants.length === 0
                  ? 'Speaker to be announced'
                  : data.participants
                      .map((p) => `${p.firstName} ${p.lastName}`.trim())
                      .join(', ')}
              </Def>
            </dl>
          </Card>
          <Card title="Description">
            <p style={{ margin: 0, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
              {session.description === undefined || session.description === ''
                ? 'No description yet.'
                : session.description}
            </p>
          </Card>
          <Card title="Publication">
            {/* The one-line summary, verbatim. The Publication tab carries the
                blockers and their repairs. */}
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              {publication.summary}
            </p>
          </Card>
        </WorkspacePanel>
      ) : null}

      {tab === 'proposal' ? (
        <WorkspacePanel label="Source proposal">
          {data.proposal === null ? (
            <Card>
              <EmptyState
                icon="inbox"
                title="No source proposal"
                description="This session was created by inviting a speaker directly, so there is no CFP submission behind it."
              />
            </Card>
          ) : (
            <Card
              title={data.proposal.title}
              subtitle="The submission this session was materialized from."
            >
              <dl style={defs}>
                <Def label="Status">{data.proposal.status}</Def>
                <Def label="Submitted">
                  {data.proposal.submittedAt === undefined
                    ? 'Never submitted'
                    : formatDateTime(data.proposal.submittedAt, timezone)}
                </Def>
                <Def label="Submitter">
                  {data.proposal.submitterName ??
                    data.proposal.submitterEmail ??
                    'Unknown'}
                </Def>
              </dl>
              <p style={{ marginBottom: 0 }}>
                <Link to="/app/e/$eventSlug/proposals" params={{ eventSlug }}>
                  Open it in Proposals
                </Link>{' '}
                — the full answers, review scores and the decision live there,
                where a proposal is reviewed.
              </p>
            </Card>
          )}
        </WorkspacePanel>
      ) : null}

      {tab === 'speakers' ? (
        <WorkspacePanel label="Speakers">
          {data.participants.length === 0 ? (
            <Card>
              <EmptyState
                icon="user-round"
                title="Speaker to be announced"
                description="Until someone is confirmed on this session, the public program says so explicitly rather than showing an empty line."
              />
            </Card>
          ) : (
            <Card padded={false}>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {data.participants.map((p) => (
                  <li key={p.participantId} style={row}>
                    <span style={{ flex: 1, minWidth: '10rem' }}>
                      <Link
                        to="/app/e/$eventSlug/speakers/$eventContactId"
                        params={{ eventSlug, eventContactId: p.eventContactId }}
                      >
                        {`${p.firstName} ${p.lastName}`.trim() ||
                          'Unnamed contact'}
                      </Link>
                      {p.tagline === undefined ? null : (
                        <span style={caption}> · {p.tagline}</span>
                      )}
                    </span>
                    <StatusPill status={PARTICIPANT_STATE_LABEL[p.state]} />
                    {p.ack === undefined ? null : (
                      <Badge tone={p.ack === 'conflict' ? 'attention' : 'info'}>
                        {p.ack === 'acknowledged'
                          ? 'Acknowledged'
                          : p.ack === 'conflict'
                            ? 'Flagged a conflict'
                            : 'Awaiting acknowledgement'}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </WorkspacePanel>
      ) : null}

      {tab === 'content' ? (
        <WorkspacePanel label="Content approval">
          <Card
            title="Approval"
            subtitle="Draft content never appears on the public program, however every other toggle is set."
          >
            {listRow === undefined ? (
              <p style={{ color: 'var(--text-tertiary)' }}>Loading content…</p>
            ) : (
              <SessionContentCell
                eventSlug={eventSlug}
                session={listRow.session}
                archived={archived}
              />
            )}
          </Card>
          <Card title="What the program would print">
            <dl style={defs}>
              <Def label="Title">{session.title}</Def>
              <Def label="Format">{session.format ?? '—'}</Def>
              <Def label="Description">
                {session.description === undefined || session.description === ''
                  ? '—'
                  : session.description}
              </Def>
            </dl>
          </Card>
        </WorkspacePanel>
      ) : null}

      {tab === 'tasks' ? (
        <WorkspacePanel label="Tasks and files">
          {instances === undefined ? (
            <p style={{ color: 'var(--text-tertiary)' }}>Loading tasks…</p>
          ) : mine.length === 0 ? (
            <Card>
              <EmptyState
                icon="list-checks"
                title="No tasks on this session"
                description="Requirements create a task per confirmed participation. Define them under Tasks."
              />
            </Card>
          ) : (
            mine.map((instance) => (
              <Card
                key={instance.instanceId}
                title={instance.requirementTitle}
                subtitle={`${instance.speakerName ?? 'Whole session'} · due ${formatDateTime(instance.dueAt, timezone)}`}
              >
                <div style={stack}>
                  <span>
                    <StatusPill status={TASK_STATUS_LABEL[instance.status]} />
                  </span>
                  <InstanceActions
                    eventSlug={eventSlug}
                    instance={instance}
                    timezone={timezone}
                    now={now}
                  />
                </div>
              </Card>
            ))
          )}
          {withFiles.map((instance) => (
            <SessionInstanceFiles
              key={instance.instanceId}
              eventSlug={eventSlug}
              instance={instance}
              timezone={timezone}
            />
          ))}
        </WorkspacePanel>
      ) : null}

      {tab === 'schedule' ? (
        <WorkspacePanel label="Schedule">
          <Card title="Placement">
            <dl style={defs}>
              <Def label="Slot">
                {session.startsAt === undefined || session.endsAt === undefined
                  ? 'Unscheduled'
                  : `${formatDateTime(session.startsAt, timezone)} – ${formatDateTime(session.endsAt, timezone)}`}
              </Def>
              <Def label="Room">{data.roomName ?? '—'}</Def>
              <Def label="Released">
                {session.releasedSlot === undefined
                  ? 'Not released — speakers have not been told a time.'
                  : `Released ${formatDateTime(session.releasedSlot.releasedAt, timezone)}`}
              </Def>
            </dl>
            <p style={{ marginBottom: 0, color: 'var(--text-secondary)' }}>
              Placing, releasing and cancelling a release are board operations —
              they need the rest of the day in view.{' '}
              <Link
                to="/app/e/$eventSlug/agenda"
                params={{ eventSlug }}
                search={{ view: 'room' }}
              >
                Open the agenda board
              </Link>
              .
            </p>
          </Card>
          <VirtualLinks
            eventSlug={eventSlug}
            sessionId={sessionId}
            links={session.virtualLinks}
            disabled={archived}
          />
        </WorkspacePanel>
      ) : null}

      {tab === 'publication' ? (
        <WorkspacePanel label="Publication state">
          <Card title="Right now">
            {/* VERBATIM. Every string below was composed in
                convex/model/readiness.ts; this file interpolates none of them
                and derives nothing from flags, slots or content status. */}
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              {publication.summary}
            </p>
            <div
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                flexWrap: 'wrap',
                marginTop: 'var(--space-3)',
              }}
            >
              <Badge tone={publication.inLineup ? 'success' : 'neutral'}>
                {publication.inLineup ? 'In the lineup' : 'Not in the lineup'}
              </Badge>
              <Badge tone={publication.inAgenda ? 'success' : 'neutral'}>
                {publication.inAgenda ? 'In the agenda' : 'Not in the agenda'}
              </Badge>
            </div>
          </Card>
          {publication.reasons.length === 0 ? null : (
            <Card
              title="What is holding it back"
              subtitle="In dependency order — the first one is the one to fix."
              padded={false}
            >
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {publication.reasons.map((reason) => (
                  <li key={reason.code} style={row}>
                    <span style={{ flex: 1, minWidth: '12rem' }}>
                      {reason.sentence}
                    </span>
                    <Link
                      to={REPAIR[reason.repair.tab].to}
                      params={{ eventSlug }}
                      style={{ textDecoration: 'none' }}
                    >
                      <Button size="sm">{REPAIR[reason.repair.tab].label}</Button>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </WorkspacePanel>
      ) : null}

      {tab === 'history' ? (
        <WorkspacePanel label="Content history">
          <Card>
            <ContentHistoryPanel
              eventSlug={eventSlug}
              sessionId={sessionId}
              sessionTitle={session.title}
              archived={archived}
            />
          </Card>
        </WorkspacePanel>
      ) : null}
    </WorkspaceShell>
  )
}

// ── Virtual links ────────────────────────────────────────────────────────
//
// Moved here from the agenda board's session dialog (W9). Audience-scoped
// links are a property of the RECORD, not an operation on the board, and
// leaving them in the dialog would have been exactly the second detail
// surface this workstream exists to remove.

const AUDIENCE = [
  {
    key: 'attendee' as const,
    label: 'Attendee — publishable',
    hint: 'Shown on the public program once published.',
    placeholder: 'https://example.com/watch',
  },
  {
    key: 'backstage' as const,
    label: 'Backstage — confirmed speakers + managers',
    hint: 'Reaches confirmed participants and their primary managers.',
    placeholder: 'https://example.com/greenroom',
  },
  {
    key: 'host' as const,
    label: 'Host — organizers only',
    hint: 'Never leaves this screen.',
    placeholder: 'https://example.com/host',
  },
]

function VirtualLinks({
  eventSlug,
  sessionId,
  links,
  disabled,
}: {
  eventSlug: string
  sessionId: Id<'sessions'>
  links: { attendee?: string; backstage?: string; host?: string } | undefined
  disabled: boolean
}) {
  const setLinks = useMutation(api.agenda.setVirtualLinks)
  const { pending, error, run } = usePending()
  const [draft, setDraft] = useState({
    attendee: links?.attendee ?? '',
    backstage: links?.backstage ?? '',
    host: links?.host ?? '',
  })

  const save = () => {
    void run(async () => {
      await setLinks({
        eventSlug,
        sessionId,
        links: {
          attendee: draft.attendee.trim() === '' ? undefined : draft.attendee.trim(),
          backstage:
            draft.backstage.trim() === '' ? undefined : draft.backstage.trim(),
          host: draft.host.trim() === '' ? undefined : draft.host.trim(),
        },
      })
      pushToast(
        'Links saved',
        'Virtual links were updated for this session.',
        'link',
      )
    })
  }

  return (
    <Card
      title="Virtual links"
      subtitle="Each audience is separate — only the attendee link is ever publishable."
    >
      <div style={stack}>
        {error === null ? null : <Callout tone="blocked">{error}</Callout>}
        {AUDIENCE.map((a) => (
          <Field
            key={a.key}
            label={a.label}
            htmlFor={`link-${a.key}`}
            optional
            hint={a.hint}
          >
            <Input
              id={`link-${a.key}`}
              type="url"
              value={draft[a.key]}
              placeholder={a.placeholder}
              disabled={disabled || pending}
              onChange={(e) => {
                setDraft((current) => ({ ...current, [a.key]: e.target.value }))
              }}
            />
          </Field>
        ))}
        <div>
          <Button
            size="sm"
            variant="secondary"
            iconLeft="link"
            disabled={disabled || pending}
            onClick={save}
          >
            {pending ? 'Saving…' : 'Save links'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function SessionInstanceFiles({
  eventSlug,
  instance,
  timezone,
}: {
  eventSlug: string
  instance: InstanceRow
  timezone: string
}) {
  const uploads = useQuery(api.tasks.listUploads, {
    eventSlug,
    instanceId: instance.instanceId,
  })
  return (
    <Card
      title={`Files · ${instance.requirementTitle}`}
      subtitle={instance.speakerName ?? undefined}
      padded={false}
    >
      {uploads === undefined ? (
        <p style={{ padding: 'var(--space-4)', color: 'var(--text-tertiary)' }}>
          Loading files…
        </p>
      ) : (
        <UploadVersionList uploads={uploads} timezone={timezone} />
      )}
    </Card>
  )
}

function Def({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
      <dt style={{ minWidth: '7rem', ...caption }}>{label}</dt>
      <dd style={{ margin: 0, color: 'var(--text-primary)' }}>{children}</dd>
    </div>
  )
}

const defs = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
  margin: 0,
} as const

const stack = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
} as const

const row = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--space-3)',
  padding: 'var(--space-3) var(--space-5)',
  borderTop: 'var(--space-px) solid var(--border-subtle)',
} as const

const caption = {
  font: 'var(--type-caption)',
  color: 'var(--text-tertiary)',
} as const
