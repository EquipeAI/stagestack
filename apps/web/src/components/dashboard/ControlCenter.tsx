import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { linkTarget } from './links'
import { PanelBoundary } from './PanelBoundary'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import type {
  DashboardData,
  InstanceRow,
  SpeakerRow,
} from '~/components/tasks/model'
import type { ControlLink } from './links'
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  Panel,
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
import { formatDateTime } from '~/lib/datetime'

// ─────────────────────────────────────────────────────────────────────────
// The event control center (W8) — the organizer's home, at the event root.
//
// ONE SCREEN, FOUR QUESTIONS: what needs my attention · what is blocked ·
// what changed recently · what happens next. Each is a collapsible panel with
// its OWN bounded query and its OWN error boundary, because readiness reads
// refuse rather than truncate: one over-ceiling table must cost one panel, not
// the screen.
//
// The subscription split is deliberate and inherited from the page this
// replaces: the ticking `now` rides on the queries that genuinely need it
// (attention, blocked, next) and the drill-down keeps STABLE args so it stays
// subscribed across every tick instead of re-fetching once a minute.
//
// Every sentence here is printed verbatim from the model layer — the attention
// rows from convex/model/controlCenter.ts, the blocked rows from
// convex/model/readiness.ts (`dashboard.blockers.rows`). This file counts
// nothing and words nothing.
// ─────────────────────────────────────────────────────────────────────────

type AttentionPanelData = FunctionReturnType<typeof api.readiness.attentionPanel>
type ChecklistStep = AttentionPanelData['checklist'][number]
type ControlRow = AttentionPanelData['rows'][number]
type UpNextData = FunctionReturnType<typeof api.readiness.upNext>
type ChangeRow = FunctionReturnType<
  typeof api.readiness.recentChanges
>['rows'][number]

export function ControlCenter({ eventSlug }: { eventSlug: string }) {
  const event = useQuery(api.events.get, { eventSlug })

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

  return <Screen eventSlug={eventSlug} timezone={event.event.timezone} />
}

/**
 * The screen. EVERY panel sits behind its own boundary, including the first —
 * a boundary the attention panel skipped would be the one hole through which a
 * single failure still blanks the whole control center, which is the exact
 * failure this architecture exists to prevent.
 *
 * That is why the first-event decision is REPORTED upward rather than branched
 * on here: the query that answers it lives inside the boundary, so when it
 * fails there is no answer to branch on. The default is the returning-event
 * layout — if we cannot prove an event is new, showing it the operational
 * panels is the safe wrong answer, and the checklist is not.
 *
 * Boundaries are keyed by event so a failure never outlives the event that
 * caused it.
 */
function Screen({
  eventSlug,
  timezone,
}: {
  eventSlug: string
  timezone: string
}) {
  const now = useNow()
  const [firstEvent, setFirstEvent] = useState(false)

  // A failure belongs to the event it happened on; so does the first-event
  // verdict. Clearing on the way out stops one event's answer labelling the
  // next one's screen.
  useEffect(() => {
    return () => {
      setFirstEvent(false)
    }
  }, [eventSlug])

  return (
    <div className="cc">
      <PanelBoundary key={`attention-${eventSlug}`} title="What needs your attention">
        <AttentionSection
          eventSlug={eventSlug}
          now={now}
          onFirstEvent={setFirstEvent}
        />
      </PanelBoundary>

      {/* A first event has no blockers, no history and nothing published;
          three panels of empty states would bury the one thing it needs. */}
      {firstEvent ? null : (
        <>
          <PanelBoundary key={`blocked-${eventSlug}`} title="What is blocked">
            <BlockedPanel eventSlug={eventSlug} timezone={timezone} now={now} />
          </PanelBoundary>

          <PanelBoundary key={`changes-${eventSlug}`} title="What changed recently">
            <ChangesPanel eventSlug={eventSlug} timezone={timezone} />
          </PanelBoundary>

          <PanelBoundary key={`next-${eventSlug}`} title="What happens next">
            <NextPanel eventSlug={eventSlug} now={now} timezone={timezone} />
          </PanelBoundary>
        </>
      )}
    </div>
  )
}

/**
 * The one decision point: a first event gets the lifecycle as a visible
 * checklist, an event with history gets the collapsed readiness summary.
 *
 * "First" is measured, not guessed — no proposal has ever arrived, no session
 * exists, and the call for speakers has never opened (see
 * convex/model/controlCenter.ts). Any one of those makes it a returning event,
 * and a returning event is never shown a checklist of things it has already
 * done.
 */
function AttentionSection({
  eventSlug,
  now,
  onFirstEvent,
}: {
  eventSlug: string
  now: number
  onFirstEvent: (value: boolean) => void
}) {
  // The ticking argument re-subscribes once a minute; hold the last frame so
  // the screen never blinks back to "Loading…" while it does.
  const panel = useLastLoaded(
    useQuery(api.readiness.attentionPanel, { eventSlug, now }),
  )
  const firstEvent = panel?.firstEvent === true
  useEffect(() => {
    onFirstEvent(firstEvent)
  }, [firstEvent, onFirstEvent])

  if (panel === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading dashboard…</p>
  }

  if (panel.firstEvent) {
    return <Checklist eventSlug={eventSlug} steps={panel.checklist} />
  }

  return (
    <Panel
      title="What needs your attention"
      subtitle="Work waiting on a person. Every count opens the filtered list."
      meta={<Total rows={panel.rows} capped={panel.capped} />}
    >
      <RowList eventSlug={eventSlug} rows={panel.rows} />
    </Panel>
  )
}

// ── The lifecycle checklist (first event only) ────────────────────────────

/**
 * GOV.UK's task list, with its own warning applied: the smallest useful set of
 * statuses, one line of truth each, and exactly one next action. Six steps,
 * because six is what an event runs through.
 */
function Checklist({
  eventSlug,
  steps,
}: {
  eventSlug: string
  steps: ReadonlyArray<ChecklistStep>
}) {
  const done = steps.filter((step) => step.state === 'done').length
  return (
    <Card
      title="Set up your first event"
      subtitle={`${done} of ${steps.length} steps done. Nothing has been proposed or scheduled yet, so this is the whole map.`}
    >
      <ol className="cc-checklist">
        {steps.map((step) => (
          <li key={step.id} className="cc-checklist__item">
            <span className="cc-checklist__head">
              <span className="cc-checklist__label">{step.label}</span>
              {/* Text first: the state is spoken, and the tone only
                  reinforces it — never carries it alone. */}
              <Badge
                dot
                tone={
                  step.state === 'done'
                    ? 'success'
                    : step.state === 'active'
                      ? 'info'
                      : 'neutral'
                }
              >
                {step.state === 'done'
                  ? 'Done'
                  : step.state === 'active'
                    ? 'In progress'
                    : 'To do'}
              </Badge>
            </span>
            <span className="cc-checklist__sentence">{step.sentence}</span>
            {step.action === null ? null : (
              <span>
                <GoButton
                  eventSlug={eventSlug}
                  link={step.action.link}
                  label={step.action.label}
                />
              </span>
            )}
          </li>
        ))}
      </ol>
    </Card>
  )
}

// ── Panel 1: what needs your attention ────────────────────────────────────

function Total({
  rows,
  capped,
}: {
  rows: ReadonlyArray<ControlRow>
  capped: boolean
}) {
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  if (total === 0) return <Badge tone="success">Nothing waiting</Badge>
  return (
    <Badge tone="attention" dot>
      {capped ? `${total}+` : total} waiting
    </Badge>
  )
}

function RowList({
  eventSlug,
  rows,
}: {
  eventSlug: string
  rows: ReadonlyArray<ControlRow>
}) {
  return (
    <ul className="cc-rows">
      {rows.map((row) => (
        <li key={row.id}>
          <CountRow eventSlug={eventSlug} row={row} />
        </li>
      ))}
    </ul>
  )
}

/**
 * A full-width tap target: the count, the sentence that explains it, and the
 * navigation, all one control. Nothing here is a hover affordance and nothing
 * is a tile that shrinks to an unreadable number on a phone.
 */
function CountRow({ eventSlug, row }: { eventSlug: string; row: ControlRow }) {
  const navigate = useNavigate()
  const target = linkTarget(row.link, eventSlug)
  return (
    <button
      type="button"
      className="cc-row"
      data-tone={row.tone}
      onClick={() => {
        void navigate(target as never)
      }}
    >
      <span className="cc-row__count" aria-hidden>
        {row.capped ? `${row.count}+` : row.count}
      </span>
      <span className="cc-row__body">
        <span className="cc-row__label">{row.label}</span>
        <span className="cc-row__sentence">{row.sentence}</span>
      </span>
      <Icon name="chevron-right" size={16} className="cc-row__go" />
    </button>
  )
}

function GoButton({
  eventSlug,
  link,
  label,
}: {
  eventSlug: string
  link: ControlLink
  label: string
}) {
  const navigate = useNavigate()
  const target = linkTarget(link, eventSlug)
  return (
    <Button
      size="sm"
      variant="secondary"
      iconRight="arrow-right"
      onClick={() => {
        void navigate(target as never)
      }}
    >
      {label}
    </Button>
  )
}

// ── Panel 2: what is blocked ──────────────────────────────────────────────

/**
 * Backed by `api.tasks.dashboard`, which REFUSES over-ceiling events on
 * purpose — a dropped participation would report a session Ready that nobody
 * verified. That is why this panel, alone among the four, sits behind a
 * boundary that can actually fire.
 *
 * The per-speaker drill-down lives here rather than in its own panel because
 * "what is blocked" and "who owes you what" are the same question read from
 * two ends, and they are the same subscription.
 */
function BlockedPanel({
  eventSlug,
  timezone,
  now,
}: {
  eventSlug: string
  timezone: string
  now: number
}) {
  const data = useLastLoaded(useQuery(api.tasks.dashboard, { eventSlug, now }))
  // Stable args, so the drill-down stays subscribed across every tick.
  const instances = useQuery(api.tasks.listInstances, { eventSlug })
  const [openSpeaker, setOpenSpeaker] = useState<Id<'eventContacts'> | null>(
    null,
  )

  const counts = useMemo(() => {
    let ready = 0
    let attention = 0
    let blocked = 0
    for (const session of data?.sessions ?? []) {
      if (session.readiness.status === 'ready') ready += 1
      else if (session.readiness.status === 'blocked') blocked += 1
      else attention += 1
    }
    return { ready, attention, blocked }
  }, [data])

  if (data === undefined) {
    return (
      <Panel title="What is blocked">
        <p style={{ color: 'var(--text-tertiary)' }}>Loading blockers…</p>
      </Panel>
    )
  }

  const speaker =
    openSpeaker === null
      ? null
      : (data.speakers.find((s) => s.eventContactId === openSpeaker) ?? null)

  // W4: composed in convex/model/readiness.ts, rendered verbatim.
  const blockerRows: Array<ControlRow> = data.blockers.rows

  return (
    <Panel
      title="What is blocked"
      subtitle="Derived from participation, content and the schedule — there is no manual override."
      meta={
        data.blockers.blockedSessions === 0 ? (
          <Badge tone="success">Nothing blocked</Badge>
        ) : (
          <Badge tone="blocked" dot>
            {countLabel(
              data.blockers.blockedSessions,
              'session blocked',
              'sessions blocked',
            )}
          </Badge>
        )
      }
    >
      <div className="cc-stack">
        <RowList eventSlug={eventSlug} rows={blockerRows} />

        {data.sessions.length === 0 ? (
          <EmptyState
            icon="presentation"
            title="No planned sessions yet"
            description="Once sessions exist, each one reports Ready, Needs Attention or Blocked here, with the reasons behind it."
          />
        ) : (
          <>
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
            <SessionList sessions={data.sessions} />
          </>
        )}

        <Speakers
          speakers={data.speakers}
          totals={data.totals}
          onOpen={(row) => {
            setOpenSpeaker(row.eventContactId)
          }}
        />
      </div>

      {speaker === null ? null : (
        <SpeakerDialog
          eventSlug={eventSlug}
          timezone={timezone}
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
    </Panel>
  )
}

/** Readiness is derived, never stored — and the contributing reasons are
 * always on screen, never behind a hover. */
function SessionList({
  sessions,
}: {
  sessions: DashboardData['sessions']
}) {
  return (
    <ul className="cc-sessions">
      {sessions.map((session) => (
        <li key={session.sessionId} className="cc-sessions__item">
          <div className="cc-sessions__head">
            <span style={{ color: 'var(--text-primary)' }}>
              {session.title}
            </span>
            <span style={{ marginLeft: 'auto' }}>
              <StatusPill status={READINESS_LABEL[session.readiness.status]} />
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
  )
}

function Speakers({
  speakers,
  totals,
  onOpen,
}: {
  speakers: Array<SpeakerRow>
  totals: DashboardData['totals']
  onOpen: (row: SpeakerRow) => void
}) {
  if (speakers.length === 0) {
    return (
      <Card variant="flat" title="Speakers">
        <EmptyState
          icon="users"
          title="No speakers on this event yet"
          description="Accept a proposal or invite someone directly, and they appear here with everything they owe you."
        />
      </Card>
    )
  }

  // The judged sentence, written the way the milestone writes it.
  const missing =
    totals.missingProfile === 1
      ? '1 accepted speaker is missing a bio or headshot'
      : `${totals.missingProfile} accepted speakers are missing a bio or headshot`

  return (
    <Card
      variant="flat"
      title="Speakers"
      subtitle={`${totals.confirmed} confirmed · ${totals.awaiting} awaiting · ${totals.declined} declined · ${totals.withdrawn} withdrawn. Open a row for that speaker's tasks.`}
      padded={false}
    >
      <div style={{ padding: 'var(--pad-card)' }}>
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
      </div>
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
              <Num
                value={row.outstandingTasks}
                muted={row.outstandingTasks === 0}
              />
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

// ── Panel 3: what changed recently ────────────────────────────────────────

/**
 * The audit rows every capability already writes, rendered. No new write path.
 * The sentence and the attribution are composed in the model layer — including
 * the honest generic one for an action code this build has never seen, which
 * is why an unrecognised row prints a readable line instead of crashing the
 * panel.
 */
function ChangesPanel({
  eventSlug,
  timezone,
}: {
  eventSlug: string
  timezone: string
}) {
  const changes = useQuery(api.readiness.recentChanges, { eventSlug })

  if (changes === undefined) {
    return (
      <Panel title="What changed recently">
        <p style={{ color: 'var(--text-tertiary)' }}>Loading the log…</p>
      </Panel>
    )
  }

  return (
    <Panel
      title="What changed recently"
      subtitle={`The event's audit trail, newest first, in ${timezone}.`}
      meta={
        changes.capped ? (
          <Badge tone="neutral">Latest {changes.rows.length}</Badge>
        ) : null
      }
    >
      {changes.rows.length === 0 ? (
        <EmptyState
          icon="file-text"
          title="Nothing has happened on this event yet"
          description="Every consequential action — a decision, a placement, an upload, a publish — is recorded here with who did it and when."
        />
      ) : (
        <ul className="cc-changes">
          {changes.rows.map((row) => (
            <ChangeItem
              key={row.auditId}
              eventSlug={eventSlug}
              row={row}
              timezone={timezone}
            />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function ChangeItem({
  eventSlug,
  row,
  timezone,
}: {
  eventSlug: string
  row: ChangeRow
  timezone: string
}) {
  const navigate = useNavigate()
  const target = row.link === null ? null : linkTarget(row.link, eventSlug)
  return (
    <li className="cc-changes__item">
      <span className="cc-changes__when">
        {formatDateTime(row.at, timezone)}
      </span>
      <span className="cc-changes__what">
        {row.sentence}
        {row.viaAgent ? (
          <>
            {' '}
            <Badge tone="agent">Agent-assisted</Badge>
          </>
        ) : null}
      </span>
      {target === null ? null : (
        <Button
          size="sm"
          variant="ghost"
          iconRight="arrow-right"
          onClick={() => {
            void navigate(target as never)
          }}
        >
          Open
        </Button>
      )}
    </li>
  )
}

// ── Panel 4: what happens next ────────────────────────────────────────────

function NextPanel({
  eventSlug,
  now,
  timezone,
}: {
  eventSlug: string
  now: number
  timezone: string
}) {
  const next = useLastLoaded(
    useQuery(api.readiness.upNext, { eventSlug, now }),
  )

  if (next === undefined) {
    return (
      <Panel title="What happens next">
        <p style={{ color: 'var(--text-tertiary)' }}>Loading the timeline…</p>
      </Panel>
    )
  }

  const upcoming = next.milestones.find((m) => !m.past) ?? null

  return (
    <Panel
      title="What happens next"
      subtitle={`Dates in ${timezone}, the event's own clock.`}
      meta={
        upcoming === null ? (
          <Badge tone="neutral">Nothing scheduled</Badge>
        ) : (
          <Badge tone="info" dot>
            {upcoming.label}
          </Badge>
        )
      }
    >
      <div className="cc-stack">
        <Timeline milestones={next.milestones} timezone={timezone} />
        <Channels eventSlug={eventSlug} channels={next.channels} />
      </div>
    </Panel>
  )
}

function Timeline({
  milestones,
  timezone,
}: {
  milestones: UpNextData['milestones']
  timezone: string
}) {
  if (milestones.length === 0) {
    return (
      <EmptyState
        icon="calendar-days"
        title="No dates are set"
        description="Event dates and the CFP window are set under Settings."
      />
    )
  }
  // A labelled vertical list, never a horizontal stepper — it has to read at
  // 375px as well as it does on a desktop.
  return (
    <ol className="cc-timeline">
      {milestones.map((milestone) => (
        <li
          key={milestone.id}
          className="cc-timeline__item"
          data-past={milestone.past ? 'true' : 'false'}
        >
          <Icon
            name={milestone.past ? 'check' : 'clock'}
            size={16}
            className="cc-timeline__mark"
          />
          <span className="cc-timeline__body">
            <span className="cc-timeline__sentence">{milestone.sentence}</span>
            <span className="cc-timeline__when">
              {formatDateTime(milestone.at, timezone)}
            </span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function Channels({
  eventSlug,
  channels,
}: {
  eventSlug: string
  channels: UpNextData['channels']
}) {
  return (
    <Card variant="flat" title="Published channels">
      <ul className="cc-channels">
        {channels.map((channel) => (
          <li key={channel.id} className="cc-channels__item">
            <span className="cc-channels__head">
              <span style={{ color: 'var(--text-primary)' }}>
                {channel.label}
              </span>
              <Badge tone={channel.published ? 'success' : 'neutral'} dot>
                {channel.published ? 'Published' : 'Not published'}
              </Badge>
            </span>
            <span className="cc-channels__sentence">{channel.sentence}</span>
            <span>
              <GoButton
                eventSlug={eventSlug}
                link={channel.link}
                label="Open the publish console"
              />
            </span>
          </li>
        ))}
      </ul>
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
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
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
