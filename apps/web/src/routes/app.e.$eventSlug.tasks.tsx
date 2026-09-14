import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { InstanceRow, TaskStatus } from '~/components/tasks/model'
import type { TaskFilter, TaskTab, TasksSearch } from '~/components/tasks/search'
import type { ActiveFilter } from '~/ds'
import type { FilterOption } from '~/lib/filters'
import {
  ActiveFilters,
  Button,
  Callout,
  Card,
  DataTable,
  EmptyState,
  Select,
  Tabs,
  Toolbar,
} from '~/ds'
import {
  DueCell,
  InstanceNotes,
  StatusCell,
} from '~/components/tasks/InstanceItem'
import { FilesPanel } from '~/components/tasks/FilesPanel'
import { InstanceActions } from '~/components/tasks/InstanceActions'
import { NewRequirementDialog } from '~/components/tasks/NewRequirementDialog'
import { RequirementCard } from '~/components/tasks/RequirementCard'
import {
  TASK_STATUS_LABEL,
  isOpen,
  isOverdue,
  speakerLabel,
} from '~/components/tasks/model'
import { parseTasksSearch } from '~/components/tasks/search'
import { SavedViewsMenu } from '~/components/views/SavedViewsMenu'
import { paramsFromSearch } from '~/components/views/model'
import { visibleFilters } from '~/lib/filters'
import { useLastLoaded, useNow } from '~/components/tasks/useNow'
import { ReminderFactsPanel } from '~/components/reminders/ReminderFactsPanel'
import { SendRemindersDialog } from '~/components/reminders/SendRemindersDialog'
import {
  REMINDER_EVALUATION_COPY,
  REMINDER_MANUAL_COPY,
  reminderCadenceCopy,
  reminderDisabledCopy,
} from '~/components/reminders/copy'
import { usePending } from '~/lib/usePending'
import { formatDateTime } from '~/lib/datetime'
import { pushToast } from '~/components/toast'

export const Route = createFileRoute('/app/e/$eventSlug/tasks')({
  component: TasksRoute,
  // Tab and status filter live in the URL so "12 tasks are outstanding" on
  // the control center opens the tasks tab already filtered to those twelve.
  validateSearch: parseTasksSearch,
})

// Speaker ops admin (M4): the requirements an organizer defines, and the
// concrete obligations those requirements created. Both live on one page
// because the only useful question about a definition is what it produced.

const STATUS_ORDER: Array<TaskStatus> = [
  'pending',
  'provided',
  'changesRequested',
  'approved',
  'complete',
  'notApplicable',
]

type Filter = TaskFilter

/** What each filter is CALLED. Separate from the counted chip options because
 * an active filter has to be nameable even when there are no rows to count —
 * that is exactly the state in which the organizer most needs to remove it. */
const FILTER_LABEL: Record<Filter, string> = {
  all: 'All',
  outstanding: 'Outstanding work',
  overdue: 'Overdue',
  ...TASK_STATUS_LABEL,
}

function TasksRoute() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tab: TaskTab = search.tab ?? 'requirements'
  const setTab = (next: string) => {
    void navigate({
      search: (prev) => ({ ...prev, tab: next as TaskTab }),
      replace: true,
    })
  }

  if (data === undefined) {
    return (
      <p style={{ color: 'var(--text-tertiary)' }}>Loading speaker tasks…</p>
    )
  }

  if (data.role !== 'organizer') {
    return (
      <Callout tone="blocked" title="Speaker tasks are organizer-only">
        You have reviewer access to this event. Task evidence is operational
        data, so it is not shown to reviewers.
      </Callout>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <Tabs
        variant="underline"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'requirements', label: 'Requirements', icon: 'list-checks' },
          { id: 'instances', label: 'Tasks', icon: 'table-2' },
          { id: 'files', label: 'Files', icon: 'file-text' },
        ]}
      />
      {tab === 'requirements' ? (
        <RequirementsPanel
          eventSlug={eventSlug}
          timezone={data.event.timezone}
        />
      ) : tab === 'files' ? (
        <FilesPanel eventSlug={eventSlug} timezone={data.event.timezone} />
      ) : (
        <InstancesPanel eventSlug={eventSlug} timezone={data.event.timezone} />
      )}
    </div>
  )
}

// ── Requirements ──────────────────────────────────────────────────────────

function RequirementsPanel({
  eventSlug,
  timezone,
}: {
  eventSlug: string
  timezone: string
}) {
  const requirements = useQuery(api.tasks.listRequirements, { eventSlug })
  const [creating, setCreating] = useState(false)

  const newButton = (
    <Button
      variant="primary"
      iconLeft="plus"
      onClick={() => {
        setCreating(true)
      }}
    >
      New requirement
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
          <span style={{ color: 'var(--text-secondary)' }}>
            What every speaker or session owes you, and when.
          </span>
        }
        right={newButton}
      />

      <ReminderFactsPanel eventSlug={eventSlug} timezone={timezone} />

      <ReminderControls eventSlug={eventSlug} timezone={timezone} />

      {requirements === undefined ? (
        <p style={{ color: 'var(--text-tertiary)' }}>Loading requirements…</p>
      ) : requirements.length === 0 ? (
        <Card>
          <EmptyState
            icon="list-checks"
            title="No requirements yet — define what speakers owe you"
            description="A bio, a headshot, a signed release, a slide deck. Creating one instantiates a task for every accepted speaker or session straight away, and for every acceptance after that."
            action={newButton}
          />
        </Card>
      ) : (
        requirements.map((requirement) => (
          <RequirementCard
            key={requirement.requirementId}
            eventSlug={eventSlug}
            requirement={requirement}
            timezone={timezone}
          />
        ))
      )}

      {creating ? (
        <NewRequirementDialog
          eventSlug={eventSlug}
          timezone={timezone}
          onClose={() => {
            setCreating(false)
          }}
        />
      ) : null}
    </div>
  )
}

function ReminderControls({
  eventSlug,
  timezone,
}: {
  eventSlug: string
  timezone: string
}) {
  const now = useNow()
  // `useLastLoaded`: the ticking `now` re-subscribes every minute, and without
  // it this card blinks back to "Loading…" once a minute.
  const status = useLastLoaded(
    useQuery(api.reminders.automationStatus, { eventSlug, now }),
  )
  const sendNow = useMutation(api.reminders.sendOutstandingNow)
  const { pending, error, run } = usePending()
  const [confirming, setConfirming] = useState(false)
  // Subscribed only while the confirmation is open: the preview reads the event
  // graph, which is not a cost worth paying on every render of this page.
  const preview = useQuery(
    api.reminders.outstandingReminderPreview,
    confirming ? { eventSlug } : 'skip',
  )

  // Event time, labelled with its zone — the product's own rule for every
  // organizer surface. The hedge stays: this is the next EVALUATION, and the
  // sweep decides then whether anyone is actually due.
  const nextEvaluation =
    status === undefined || status.nextEvaluationAt === null
      ? null
      : formatDateTime(status.nextEvaluationAt, timezone)

  return (
    <Card
      title="Task reminders"
      subtitle={
        status === undefined
          ? 'Loading reminder automation…'
          : status.enabled
            ? `${REMINDER_EVALUATION_COPY} ${reminderCadenceCopy(status.cadenceDays)}${
                nextEvaluation === null
                  ? ''
                  : ` Next evaluation ${nextEvaluation}.`
              }`
            : reminderDisabledCopy(status.disabledReason ?? 'archived')
      }
      actions={
        <Button
          iconLeft="mail"
          disabled={pending}
          onClick={() => {
            setConfirming(true)
          }}
        >
          {pending ? 'Sending…' : 'Send reminders now'}
        </Button>
      }
    >
      {error === null ? (
        <span style={{ color: 'var(--text-tertiary)' }}>
          {REMINDER_MANUAL_COPY}
        </span>
      ) : (
        <Callout tone="blocked">{error}</Callout>
      )}

      {confirming ? (
        <SendRemindersDialog
          preview={preview}
          pending={pending}
          onCancel={() => {
            setConfirming(false)
          }}
          onConfirm={() => {
            void run(async () => {
              const result = await sendNow({ eventSlug })
              setConfirming(false)
              pushToast(
                `${result.sent} accepted · ${result.failed} failed · ${result.skipped} skipped`,
                `${result.includedTasks} outstanding ${result.includedTasks === 1 ? 'task was' : 'tasks were'} included in the attempts. Only provider-accepted reminders reset their tasks' cadence clock.`,
                'mail',
              )
            })
          }}
        />
      ) : null}
    </Card>
  )
}

// ── Instances ─────────────────────────────────────────────────────────────

function InstancesPanel({
  eventSlug,
  timezone,
}: {
  eventSlug: string
  timezone: string
}) {
  const instances = useQuery(api.tasks.listInstances, { eventSlug })
  const requirements = useQuery(api.tasks.listRequirements, { eventSlug })
  const now = useNow()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const filter: Filter = search.status ?? 'all'
  const requirementId = search.requirement ?? 'all'

  // W8 left the chips writing to component state only, and said W12 owned the
  // question. This is the answer: every filter on this table is in the URL, so
  // the view is a link, a reload keeps it, and the chip row can undo it.
  //
  // REPLACE, not push. A filter tweak is a view of the page the organizer is
  // standing on; pushing one entry per chip press would mean six back presses
  // to leave a page they reached in one click.
  const patch = (part: TasksSearch) => {
    void navigate({
      search: (prev: TasksSearch) => ({ ...prev, ...part }),
      replace: true,
    })
  }

  const rows = useMemo(() => {
    if (instances === undefined) return []
    return instances
      .filter((row) =>
        requirementId === 'all' ? true : row.requirementId === requirementId,
      )
      .filter((row) => {
        if (filter === 'all') return true
        // `outstanding` is the same `isOpen` predicate the backend counts
        // with, so the control center's "N tasks are outstanding" and this
        // list can never be different lengths.
        if (filter === 'outstanding') return isOpen(row.status)
        if (filter === 'overdue') return isOverdue(row, now)
        return row.status === filter
      })
      .sort((a, b) => a.dueAt - b.dueAt)
  }, [instances, filter, requirementId, now])

  if (instances === undefined || requirements === undefined) {
    return (
      <Card padded={false}>
        <DataTable
          aria-label="Speaker tasks"
          loading
          loadingLabel="Loading speaker tasks…"
          rows={[]}
          columns={SKELETON_COLUMNS}
        />
      </Card>
    )
  }

  const requirementTitle = requirements.find(
    (r) => r.requirementId === requirementId,
  )?.title
  const activeChips: Array<ActiveFilter> = [
    ...(filter === 'all'
      ? []
      : [
          {
            id: `status:${filter}`,
            label: `Status: ${FILTER_LABEL[filter]}`,
            onRemove: () => patch({ status: undefined }),
          },
        ]),
    ...(requirementId === 'all'
      ? []
      : [
          {
            // A requirement id from the URL that matches nothing on this event
            // (a deleted requirement, a link from another event, a typo) still
            // narrows the list to nothing. Without a chip that view is
            // unexplained AND unremovable — the organizer sees an empty table
            // and no reason for it, which is the same stranding the
            // zero-count rule exists to prevent.
            id: `requirement:${requirementId}`,
            label:
              requirementTitle === undefined
                ? 'Unknown requirement'
                : `Requirement: ${requirementTitle}`,
            onRemove: () => patch({ requirement: undefined }),
          },
        ]),
  ]
  const filtering = activeChips.length > 0

  // Nothing on the event at all. The chip row still renders when a filter is
  // in force, because a stale deep link (a control-center count that has since
  // been satisfied) lands here, and an empty state with no way out of the
  // filter that produced it is a dead end.
  if (instances.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <ActiveFilters
          chips={activeChips}
          onClearAll={() => {
            patch({ status: undefined, requirement: undefined })
          }}
        />
        <Card>
          <EmptyState
            icon={filtering ? 'list-filter' : 'list-checks'}
            title={filtering ? 'No tasks match these filters' : 'No tasks yet'}
            description={
              filtering
                ? 'There are no tasks on this event at all yet, so no filter can match. Tasks appear the moment a requirement exists and a speaker is accepted.'
                : 'Tasks appear the moment a requirement exists and a speaker is accepted. Define a requirement first.'
            }
            action={
              filtering ? (
                <Button
                  onClick={() => {
                    patch({ status: undefined, requirement: undefined })
                  }}
                >
                  Clear the filters
                </Button>
              ) : undefined
            }
          />
        </Card>
      </div>
    )
  }

  const counts: Record<Filter, number> = {
    all: instances.length,
    outstanding: instances.filter((row) => isOpen(row.status)).length,
    overdue: instances.filter((row) => isOverdue(row, now)).length,
    pending: 0,
    provided: 0,
    changesRequested: 0,
    approved: 0,
    complete: 0,
    notApplicable: 0,
  }
  for (const row of instances) counts[row.status] += 1

  // W12's zero-count rule. `Outstanding work` and `Overdue` keep their place
  // when empty, because those zeros are the answer to the question the
  // organizer opened this tab with — "is anyone behind?" — and a chip row that
  // silently drops them turns "nobody is overdue" into no statement at all.
  // A status nobody is in is just noise, so it goes.
  const statusChips = visibleFilters<FilterOption<Filter>>(
    [
      { id: 'all', label: 'All', count: counts.all, meaningfulZero: true },
      {
        id: 'outstanding',
        label: 'Outstanding work',
        count: counts.outstanding,
        meaningfulZero: true,
      },
      {
        id: 'overdue',
        label: 'Overdue',
        count: counts.overdue,
        meaningfulZero: true,
      },
      ...STATUS_ORDER.map((status) => ({
        id: status,
        label: TASK_STATUS_LABEL[status],
        count: counts[status],
        meaningfulZero: false,
      })),
    ],
    [filter],
  )

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      <Toolbar
        // Slot order (W12): saved view (W2), filters, then the requirement
        // narrowing. This tab has no free-text search or export of its own —
        // the Files tab owns the bundle download — so that slot stays empty.
        left={
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
              alignItems: 'center',
            }}
          >
            <SavedViewsMenu
              eventSlug={eventSlug}
              module="tasks"
              params={paramsFromSearch(search)}
              onApply={(next) => {
                // The tab is part of a tasks view, so applying one can move
                // the organizer between tabs — which is what "open the view I
                // saved" has to mean on a page whose tabs are in the URL.
                void navigate({
                  search: () => ({ tab: 'instances', ...parseTasksSearch(next) }),
                  replace: true,
                })
              }}
            />
            {statusChips.map((chip) => (
              <Button
                key={chip.id}
                size="sm"
                variant={filter === chip.id ? 'secondary' : 'ghost'}
                // Which chip is active is otherwise carried by the variant's
                // styling alone, which a screen reader never sees.
                aria-pressed={filter === chip.id}
                onClick={() => {
                  patch({ status: chip.id === 'all' ? undefined : chip.id })
                }}
              >
                {`${chip.label} (${chip.count})`}
              </Button>
            ))}
          </div>
        }
        right={
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
            }}
          >
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
                whiteSpace: 'nowrap',
              }}
            >
              Requirement
              <Select
                size="sm"
                value={requirementId}
                options={[
                  { value: 'all', label: 'Every requirement' },
                  ...requirements.map((r) => ({
                    value: r.requirementId,
                    label: r.title,
                  })),
                ]}
                onChange={(e) => {
                  patch({
                    requirement:
                      e.target.value === 'all' ? undefined : e.target.value,
                  })
                }}
              />
            </label>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--text-tertiary)',
                whiteSpace: 'nowrap',
              }}
            >
              Showing {rows.length} of {instances.length}
            </span>
          </div>
        }
      />

      <ActiveFilters
        chips={activeChips}
        onClearAll={() => {
          patch({ status: undefined, requirement: undefined })
        }}
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="list-filter"
            title="No tasks match these filters"
            description="Widen the status or requirement filter to see the rest."
            action={
              filtering ? (
                <Button
                  onClick={() => {
                    patch({ status: undefined, requirement: undefined })
                  }}
                >
                  Clear the filters
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card padded={false}>
          <DataTable
            aria-label="Speaker tasks"
            rowKey="instanceId"
            rows={rows}
            // On a phone a task is: what is owed, by whom, its state, when it
            // is due, and the actions — which are already collapsed to two
            // plus an overflow menu, so they fit.
            cardRow={(row: InstanceRow) => (
              <>
                <span style={{ color: 'var(--text-primary)' }}>
                  {row.requirementTitle}
                </span>
                <span
                  style={{
                    font: 'var(--type-caption)',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  {speakerLabel(row)} · {row.sessionTitle}
                </span>
                <span
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                  }}
                >
                  <StatusCell instance={row} now={now} />
                  <DueCell instance={row} timezone={timezone} now={now} />
                </span>
                <InstanceActions
                  eventSlug={eventSlug}
                  instance={row}
                  timezone={timezone}
                  now={now}
                />
              </>
            )}
            columns={[
              {
                key: 'requirementTitle',
                header: 'Requirement',
                cell: (row: InstanceRow) => (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-1)',
                    }}
                  >
                    <span style={{ color: 'var(--text-primary)' }}>
                      {row.requirementTitle}
                    </span>
                    <InstanceNotes instance={row} />
                  </div>
                ),
              },
              {
                key: 'speaker',
                header: 'Speaker',
                cell: (row: InstanceRow) => speakerLabel(row),
              },
              {
                key: 'sessionTitle',
                header: 'Session',
                cell: (row: InstanceRow) => (
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {row.sessionTitle}
                  </span>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (row: InstanceRow) => (
                  <StatusCell instance={row} now={now} />
                ),
              },
              {
                key: 'dueAt',
                header: 'Due',
                cell: (row: InstanceRow) => (
                  <DueCell instance={row} timezone={timezone} now={now} />
                ),
              },
              {
                key: 'actions',
                header: 'Actions',
                cell: (row: InstanceRow) => (
                  <InstanceActions
                    eventSlug={eventSlug}
                    instance={row}
                    timezone={timezone}
                    now={now}
                  />
                ),
              },
            ]}
          />
        </Card>
      )}
    </div>
  )
}

/** Headers only — the skeleton holds the shape the rows will take. */
const SKELETON_COLUMNS = [
  { key: 'requirementTitle', header: 'Requirement' },
  { key: 'speaker', header: 'Speaker' },
  { key: 'sessionTitle', header: 'Session' },
  { key: 'status', header: 'Status' },
  { key: 'dueAt', header: 'Due' },
  { key: 'actions', header: 'Actions' },
]
