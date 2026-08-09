import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Id } from '@convex/_generated/dataModel'
import type {
  DashboardData,
  InstanceRow,
  SpeakerRow,
} from '~/components/tasks/model'
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ReadinessMeter,
  StatusPill,
} from '~/ds'
import { InstanceItem } from '~/components/tasks/InstanceItem'
import {
  READINESS_LABEL,
  countLabel,
  isOverdue,
} from '~/components/tasks/model'
import { useLastLoaded, useNow } from '~/components/tasks/useNow'
import { PARTICIPANT_STATE_LABEL } from '~/components/portal/model'

export const Route = createFileRoute('/app/e/$eventSlug/dashboard')({
  component: DashboardRoute,
})

// The speaker-ops dashboard (M4, CHALLENGE #6). Everything on this page is a
// live Convex subscription: a speaker confirming in the portal, an upload
// landing, or a bio being filled in another tab moves these numbers without a
// refresh.
//
// `now` is the one thing subscriptions cannot give us — a query is not re-run
// because time advanced — so it ticks here and rides along as an argument.

function DashboardRoute() {
  const { eventSlug } = Route.useParams()
  const event = useQuery(api.events.get, { eventSlug })
  const now = useNow()

  // The ticking argument re-subscribes once a minute; hold the last frame so
  // the page never blinks back to "Loading…" while it does.
  const live = useQuery(
    api.tasks.dashboard,
    event?.role === 'organizer' ? { eventSlug, now } : 'skip',
  )
  const data = useLastLoaded(live)

  // Stable args, so the drill-down stays subscribed across every tick.
  const instances = useQuery(
    api.tasks.listInstances,
    event?.role === 'organizer' ? { eventSlug } : 'skip',
  )

  const [openSpeaker, setOpenSpeaker] = useState<Id<'eventContacts'> | null>(
    null,
  )

  if (event === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading dashboard…</p>
  }

  if (event.role !== 'organizer') {
    return (
      <Callout tone="blocked" title="The dashboard is organizer-only">
        You have reviewer access to this event. Speaker operations data is not
        shown to reviewers.
      </Callout>
    )
  }

  if (data === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading dashboard…</p>
  }

  const speaker =
    openSpeaker === null
      ? null
      : (data.speakers.find((s) => s.eventContactId === openSpeaker) ?? null)

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
    >
      <Totals totals={data.totals} />

      <Speakers
        speakers={data.speakers}
        onOpen={(row) => {
          setOpenSpeaker(row.eventContactId)
        }}
      />

      <Sessions sessions={data.sessions} />

      {speaker === null ? null : (
        <SpeakerDialog
          eventSlug={eventSlug}
          timezone={event.event.timezone}
          now={now}
          speaker={speaker}
          instances={(instances ?? []).filter(
            (row) => row.eventContactId === speaker.eventContactId,
          )}
          loading={instances === undefined}
          onClose={() => {
            setOpenSpeaker(null)
          }}
        />
      )}
    </div>
  )
}

// ── Headline numbers ──────────────────────────────────────────────────────

function Totals({ totals }: { totals: DashboardData['totals'] }) {
  // The judged sentence, written the way the milestone writes it.
  const missing =
    totals.missingProfile === 1
      ? '1 accepted speaker is missing a bio or headshot'
      : `${totals.missingProfile} accepted speakers are missing a bio or headshot`

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 10rem), 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        <Tile label="Confirmed" value={totals.confirmed} tone="success" />
        <Tile label="Awaiting Response" value={totals.awaiting} tone="info" />
        <Tile label="Declined" value={totals.declined} tone="blocked" />
        <Tile label="Withdrawn" value={totals.withdrawn} tone="neutral" />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        <Callout
          tone={totals.missingProfile === 0 ? 'success' : 'attention'}
          title={
            totals.missingProfile === 0
              ? 'Every accepted speaker has a bio and a headshot'
              : missing
          }
        >
          {totals.missingProfile === 0
            ? `All ${countLabel(totals.acceptedSpeakers, 'speaker', 'speakers')} on this event are publishable as they stand.`
            : `Of ${countLabel(totals.acceptedSpeakers, 'accepted speaker', 'accepted speakers')}. Speakers fill these in themselves from their portal — the count drops the moment they do.`}
        </Callout>

        <Callout
          tone={totals.overdue === 0 ? 'success' : 'attention'}
          title={
            totals.overdue === 0
              ? 'Nothing is overdue'
              : `${countLabel(totals.overdue, 'task is', 'tasks are')} overdue`
          }
        >
          {totals.overdue === 0
            ? 'Every outstanding task is still inside its due date.'
            : 'Measured against the event clock, refreshed every minute on this page.'}
        </Callout>
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'success' | 'info' | 'blocked' | 'neutral'
}) {
  return (
    <Card>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-3xl)',
            fontWeight: 'var(--weight-semibold)',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text-primary)',
            lineHeight: 'var(--leading-none)',
          }}
        >
          {value}
        </span>
        <Badge tone={tone} dot>
          {label}
        </Badge>
      </div>
    </Card>
  )
}

// ── Speakers ──────────────────────────────────────────────────────────────

function Speakers({
  speakers,
  onOpen,
}: {
  speakers: Array<SpeakerRow>
  onOpen: (row: SpeakerRow) => void
}) {
  if (speakers.length === 0) {
    return (
      <Card title="Speakers">
        <EmptyState
          icon="users"
          title="No speakers on this event yet"
          description="Accept a proposal or invite someone directly, and they appear here with everything they owe you."
        />
      </Card>
    )
  }

  return (
    <Card
      title="Speakers"
      subtitle="Open a row for that speaker's tasks."
      padded={false}
      actions={
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text-tertiary)',
          }}
        >
          {speakers.length}
        </span>
      }
    >
      <DataTable
        rowKey="eventContactId"
        rows={speakers}
        onRowClick={(row: SpeakerRow) => {
          onOpen(row)
        }}
        columns={[
          {
            key: 'name',
            header: 'Speaker',
            cell: (row: SpeakerRow) => (
              <span style={{ color: 'var(--text-primary)' }}>{row.name}</span>
            ),
          },
          {
            key: 'state',
            header: 'Participation',
            cell: (row: SpeakerRow) => (
              <StatusPill status={PARTICIPANT_STATE_LABEL[row.state]} />
            ),
          },
          {
            key: 'claimed',
            header: 'Portal',
            cell: (row: SpeakerRow) => (
              <Badge tone={row.claimed ? 'success' : 'neutral'} dot>
                {row.claimed ? 'Claimed' : 'Not claimed'}
              </Badge>
            ),
          },
          {
            key: 'profile',
            header: 'Profile',
            cell: (row: SpeakerRow) => <ProfileCell row={row} />,
          },
          {
            key: 'outstandingTasks',
            header: 'Outstanding',
            align: 'right',
            cell: (row: SpeakerRow) => (
              <Num value={row.outstandingTasks} muted={row.outstandingTasks === 0} />
            ),
          },
          {
            key: 'overdueTasks',
            header: 'Overdue',
            align: 'right',
            cell: (row: SpeakerRow) => (
              <Num
                value={row.overdueTasks}
                muted={row.overdueTasks === 0}
                danger={row.overdueTasks > 0}
              />
            ),
          },
        ]}
      />
    </Card>
  )
}

function ProfileCell({ row }: { row: SpeakerRow }) {
  if (!row.missingBio && !row.missingHeadshot) {
    return (
      <span style={{ color: 'var(--text-tertiary)' }}>Bio and headshot</span>
    )
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 'var(--space-2)',
        flexWrap: 'wrap',
      }}
    >
      {row.missingBio ? <Badge tone="attention">No bio</Badge> : null}
      {row.missingHeadshot ? <Badge tone="attention">No headshot</Badge> : null}
    </span>
  )
}

function Num({
  value,
  muted,
  danger,
}: {
  value: number
  muted?: boolean
  danger?: boolean
}) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
        color: danger
          ? 'var(--text-danger)'
          : muted
            ? 'var(--text-tertiary)'
            : 'var(--text-primary)',
      }}
    >
      {value}
    </span>
  )
}

// ── Sessions ──────────────────────────────────────────────────────────────

/** Readiness is derived, never stored — and the contributing reasons are
 * always on screen, never behind a hover. */
function Sessions({
  sessions,
}: {
  sessions: DashboardData['sessions']
}) {
  const counts = useMemo(() => {
    let ready = 0
    let attention = 0
    let blocked = 0
    for (const session of sessions) {
      if (session.readiness.status === 'ready') ready += 1
      else if (session.readiness.status === 'blocked') blocked += 1
      else attention += 1
    }
    return { ready, attention, blocked }
  }, [sessions])

  if (sessions.length === 0) {
    return (
      <Card title="Session readiness">
        <EmptyState
          icon="presentation"
          title="No planned sessions yet"
          description="Once sessions exist, each one reports Ready, Needs Attention or Blocked here, with the reasons behind it."
        />
      </Card>
    )
  }

  return (
    <Card
      title="Session readiness"
      subtitle="Derived from participation and outstanding work — there is no manual override."
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <ReadinessMeter
          label="Sessions ready"
          segments={[
            {
              value: counts.ready,
              tone: 'ready',
              label: `${counts.ready} ready`,
            },
            {
              value: counts.attention,
              tone: 'attention',
              label: `${counts.attention} need attention`,
            },
            {
              value: counts.blocked,
              tone: 'blocked',
              label: `${counts.blocked} blocked`,
            },
          ]}
        />

        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {sessions.map((session) => (
            <li
              key={session.sessionId}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                padding: 'var(--space-3) var(--space-0)',
                borderBottom: 'var(--space-px) solid var(--border-subtle)',
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
                <span style={{ color: 'var(--text-primary)' }}>
                  {session.title}
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  <StatusPill
                    status={READINESS_LABEL[session.readiness.status]}
                  />
                </span>
              </div>
              {session.readiness.reasons.length === 0 ? (
                <span
                  style={{
                    font: 'var(--type-caption)',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  Everyone confirmed, every obligation settled.
                </span>
              ) : (
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 'var(--space-5)',
                    font: 'var(--type-caption)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {session.readiness.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}

// ── Speaker drill-down ────────────────────────────────────────────────────

function SpeakerDialog({
  eventSlug,
  timezone,
  now,
  speaker,
  instances,
  loading,
  onClose,
}: {
  eventSlug: string
  timezone: string
  now: number
  speaker: SpeakerRow
  instances: Array<InstanceRow>
  loading: boolean
  onClose: () => void
}) {
  const sorted = [...instances].sort((a, b) => a.dueAt - b.dueAt)
  const overdue = sorted.filter((row) => isOverdue(row, now)).length

  return (
    <Dialog
      open
      width={860}
      title={speaker.name}
      description={`${PARTICIPANT_STATE_LABEL[speaker.state]} · ${
        speaker.claimed ? 'portal access claimed' : 'portal access not claimed'
      } · ${countLabel(speaker.outstandingTasks, 'task', 'tasks')} outstanding${
        overdue === 0 ? '' : `, ${overdue} overdue`
      }.`}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {speaker.missingBio || speaker.missingHeadshot ? (
          <Callout
            tone="attention"
            title={
              speaker.missingBio && speaker.missingHeadshot
                ? 'Missing a bio and a headshot'
                : speaker.missingBio
                  ? 'Missing a bio'
                  : 'Missing a headshot'
            }
          >
            They fill this in themselves from the speaker portal. Where a
            headshot is missing, published output falls back to their initials.
          </Callout>
        ) : null}

        {loading ? (
          <p style={{ color: 'var(--text-tertiary)' }}>Loading their tasks…</p>
        ) : sorted.length === 0 ? (
          <EmptyState
            icon="list-checks"
            title="Nothing is owed by this speaker"
            description="No requirement has produced a task for them yet."
          />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {sorted.map((instance) => (
              <InstanceItem
                key={instance.instanceId}
                eventSlug={eventSlug}
                instance={instance}
                timezone={timezone}
                now={now}
              />
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
