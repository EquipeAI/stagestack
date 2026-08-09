import { InstanceActions } from './InstanceActions'
import {
  EVIDENCE_LABEL,
  TASK_STATUS_LABEL,
  isOverdue,
  speakerLabel,
} from './model'
import type { InstanceRow } from './model'
import { StatusPill } from '~/ds'
import { formatDateTime } from '~/lib/datetime'

// Shared cells so the tasks table and the dashboard drill-down state a task
// the same way. Overdue is an overlay on the status, never a replacement for
// it: a task is Awaiting Review *and* overdue.

export function StatusCell({
  instance,
  now,
}: {
  instance: InstanceRow
  now: number
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        flexWrap: 'wrap',
      }}
    >
      <StatusPill status={TASK_STATUS_LABEL[instance.status]} />
      {isOverdue(instance, now) ? <StatusPill status="Overdue" /> : null}
    </span>
  )
}

export function DueCell({
  instance,
  timezone,
  now,
}: {
  instance: InstanceRow
  timezone: string
  now: number
}) {
  const overdue = isOverdue(instance, now)
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        fontVariantNumeric: 'tabular-nums',
        color: overdue ? 'var(--text-danger)' : 'var(--text-tertiary)',
      }}
    >
      {formatDateTime(instance.dueAt, timezone)}
    </span>
  )
}

/** The organizer's note trail: why it was sent back, or why it was waived. */
export function InstanceNotes({ instance }: { instance: InstanceRow }) {
  const note =
    instance.status === 'notApplicable'
      ? instance.naReason
      : instance.reviewNote
  if (note === undefined || note.trim() === '') return null
  return (
    <p
      style={{
        font: 'var(--type-caption)',
        color: 'var(--text-secondary)',
        margin: 'var(--space-0)',
      }}
    >
      {instance.status === 'notApplicable' ? 'Waived: ' : 'Sent back: '}
      {note}
    </p>
  )
}

/** One obligation as a stacked row — used inside the speaker drill-down,
 * where a table would not fit. */
export function InstanceItem({
  eventSlug,
  instance,
  timezone,
  now,
}: {
  eventSlug: string
  instance: InstanceRow
  timezone: string
  now: number
}) {
  return (
    <li
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
          alignItems: 'baseline',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}>
          {instance.requirementTitle}
        </span>
        <StatusCell instance={instance} now={now} />
        <span style={{ marginLeft: 'auto' }}>
          <DueCell instance={instance} timezone={timezone} now={now} />
        </span>
      </div>
      <span style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
        {instance.sessionTitle} · {speakerLabel(instance)} ·{' '}
        {EVIDENCE_LABEL[instance.evidence]}
        {instance.reviewRequired ? ' · Review required' : ''}
      </span>
      <InstanceNotes instance={instance} />
      <InstanceActions
        eventSlug={eventSlug}
        instance={instance}
        timezone={timezone}
        now={now}
      />
    </li>
  )
}
