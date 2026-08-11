import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { InstanceRow, TaskStatus } from '~/components/tasks/model'
import {
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
  isOverdue,
  speakerLabel,
} from '~/components/tasks/model'
import { useNow } from '~/components/tasks/useNow'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'

export const Route = createFileRoute('/app/e/$eventSlug/tasks')({
  component: TasksRoute,
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

type Filter = TaskStatus | 'all' | 'overdue'

function TasksRoute() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })
  const [tab, setTab] = useState('requirements')

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

      <ReminderControls eventSlug={eventSlug} />

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

function ReminderControls({ eventSlug }: { eventSlug: string }) {
  const now = useNow()
  const status = useQuery(api.reminders.automationStatus, { eventSlug, now })
  const sendNow = useMutation(api.reminders.sendOutstandingNow)
  const { pending, error, run } = usePending()

  return (
    <Card
      title="Task reminders"
      subtitle={
        status === undefined
          ? 'Loading reminder automation…'
          : status.enabled
            ? status.cadenceDays === null
              ? `Due-soon and overdue tasks are evaluated hourly and retried no more than daily. No general reminder cadence is set. Next evaluation around ${new Date(status.nextEvaluationAt ?? now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
              : `Automatic reminders are evaluated hourly and respect the ${status.cadenceDays}-day cadence. If that cadence is turned off, due-soon and overdue tasks still use a daily safety reminder. Next evaluation around ${new Date(status.nextEvaluationAt ?? now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
            : 'Automatic reminders are off because this event is archived.'
      }
      actions={
        <Button
          iconLeft="mail"
          disabled={pending}
          onClick={() => {
            if (
              !window.confirm(
                'Send one consolidated reminder now to everyone with an outstanding, reminder-enabled task?',
              )
            ) {
              return
            }
            void run(async () => {
              const result = await sendNow({ eventSlug })
              pushToast(
                `${result.sent} accepted · ${result.failed} failed · ${result.skipped} skipped`,
                `${result.includedTasks} outstanding ${result.includedTasks === 1 ? 'task was' : 'tasks were'} included in the attempts. Only provider-accepted reminders reset their tasks' cadence clock.`,
                'mail',
              )
            })
          }}
        >
          {pending ? 'Sending…' : 'Send reminders now'}
        </Button>
      }
    >
      {error === null ? (
        <span style={{ color: 'var(--text-tertiary)' }}>
          Manual sends are marked separately in the comms log and reset the
          cadence clock for included tasks to avoid a duplicate automatic send.
        </span>
      ) : (
        <Callout tone="blocked">{error}</Callout>
      )}
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
  const [filter, setFilter] = useState<Filter>('all')
  const [requirementId, setRequirementId] = useState('all')

  const rows = useMemo(() => {
    if (instances === undefined) return []
    return instances
      .filter((row) =>
        requirementId === 'all' ? true : row.requirementId === requirementId,
      )
      .filter((row) => {
        if (filter === 'all') return true
        if (filter === 'overdue') return isOverdue(row, now)
        return row.status === filter
      })
      .sort((a, b) => a.dueAt - b.dueAt)
  }, [instances, filter, requirementId, now])

  if (instances === undefined || requirements === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading tasks…</p>
  }

  if (instances.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="list-checks"
          title="No tasks yet"
          description="Tasks appear the moment a requirement exists and a speaker is accepted. Define a requirement first."
        />
      </Card>
    )
  }

  const counts: Record<Filter, number> = {
    all: instances.length,
    overdue: instances.filter((row) => isOverdue(row, now)).length,
    pending: 0,
    provided: 0,
    changesRequested: 0,
    approved: 0,
    complete: 0,
    notApplicable: 0,
  }
  for (const row of instances) counts[row.status] += 1

  const chips: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'overdue', label: 'Overdue' },
    ...STATUS_ORDER.map((status) => ({
      id: status,
      label: TASK_STATUS_LABEL[status],
    })),
  ]

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      <Toolbar
        left={
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
              alignItems: 'center',
            }}
          >
            {chips.map((chip) => (
              <Button
                key={chip.id}
                size="sm"
                variant={filter === chip.id ? 'secondary' : 'ghost'}
                disabled={counts[chip.id] === 0 && chip.id !== 'all'}
                onClick={() => {
                  setFilter(chip.id)
                }}
              >
                {chip.label} ({counts[chip.id]})
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
                  setRequirementId(e.target.value)
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

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="list-filter"
            title="Nothing matches these filters"
            description="Widen the status or requirement filter to see the rest."
          />
        </Card>
      ) : (
        <Card padded={false}>
          <DataTable
            rowKey="instanceId"
            rows={rows}
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
