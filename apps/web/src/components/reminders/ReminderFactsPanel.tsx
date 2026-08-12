import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { nextSweepAt } from '@convex/shared/reminderSchedule'
import {
  REMINDER_EVALUATION_COPY,
  reminderCadenceBadge,
  reminderCadenceCopy,
  reminderDisabledCopy,
} from './copy'
import { Badge, Card, DescriptionList } from '~/ds'
import { useLastLoaded, useNow } from '~/components/tasks/useNow'
import { formatDateTime } from '~/lib/datetime'

// The reminder facts panel (W1): the same six facts, from the same producer,
// on every surface where reminders are configured or triggered. Nothing here
// re-derives a fact in TSX — the schedule comes from the shared cron module and
// everything else from `reminders.reminderFacts`.
//
// Two queries on purpose, not an oversight: `automationStatus` carries the
// ticking `now` (a per-minute re-subscribe, so it must stay cheap and read
// nothing), while `reminderFacts` does the scanning and takes no arguments, so
// it re-runs when the DATA changes rather than every minute. They cannot
// disagree — both derive their schedule answers from the one shared
// `nextSweepAt`/`automationQuietAfter` module that convex/crons.ts registers
// against.
//
// Mobile: `DescriptionList` already stacks term above value at 640px
// (ds/components/layout/layout.css), so this is a stacked list on a phone
// without a second rendering.

/**
 * "Last manual send" — where an ATTEMPT that accepted nothing must not be
 * reported as a send, and must not be silently dropped either: a reminder run
 * that reached nobody is exactly what an organizer needs to see.
 */
function manualSendCopy(
  sentAt: number | null,
  attemptedAt: number | null,
  lookupTruncated: boolean,
  when: (ms: number) => string,
): string {
  if (sentAt === null) {
    if (attemptedAt !== null) {
      return `No manual reminder has been accepted. The last attempt, ${when(attemptedAt)}, reached nobody.`
    }
    return lookupTruncated
      ? 'None in this event’s recent activity.'
      : 'Never — no reminder has been sent by hand.'
  }
  if (attemptedAt !== null && attemptedAt > sentAt) {
    return `${when(sentAt)} · a later attempt, ${when(attemptedAt)}, reached nobody.`
  }
  return when(sentAt)
}

export function ReminderFactsPanel({
  eventSlug,
  timezone,
}: {
  eventSlug: string
  timezone: string
}) {
  const now = useNow()
  const facts = useQuery(api.reminders.reminderFacts, { eventSlug })
  const status = useLastLoaded(
    useQuery(api.reminders.automationStatus, { eventSlug, now }),
  )

  if (facts === undefined) {
    return (
      <Card title="Reminder automation">
        <p style={{ color: 'var(--text-tertiary)' }}>Loading reminder facts…</p>
      </Card>
    )
  }

  const when = (ms: number) => formatDateTime(ms, timezone)

  // Why automation is off, produced by the backend (`sweepEligible`'s own two
  // conditions) rather than re-derived here. Falling back to the archived flag
  // only covers the instant before `automationStatus` first lands.
  const disabledReason =
    status === undefined
      ? facts.enabled
        ? null
        : ('archived' as const)
      : status.disabledReason
  const running = disabledReason === null

  // The next evaluation after the earliest cadence window elapses. Derived from
  // the cron schedule, so it cannot claim an instant the sweep never runs at.
  const eligibleEvaluationAt =
    facts.nextEligibleAt === null
      ? null
      : nextSweepAt(Math.max(facts.nextEligibleAt, now))

  const items = [
    {
      term: 'Automatic reminders',
      value: running
        ? `On${
            facts.quietAfter === null
              ? ''
              : ` · chasing stops after ${when(facts.quietAfter)}`
          }`
        : `Off — ${reminderDisabledCopy(disabledReason)}`,
    },
    {
      term: 'Evaluation interval',
      value: running
        ? `Every ${facts.evaluationIntervalHours === 1 ? 'hour' : `${facts.evaluationIntervalHours} hours`}${
            status === undefined || status.nextEvaluationAt === null
              ? ''
              : ` · next ${when(status.nextEvaluationAt)}`
          }`
        : 'This event is no longer evaluated.',
    },
    {
      term: 'Cadence floor',
      value: reminderCadenceCopy(facts.cadenceDays),
    },
    {
      term: 'Last automatic evaluation',
      value:
        facts.lastAutomaticAt === null
          ? 'This event has not been swept yet.'
          : when(facts.lastAutomaticAt),
    },
    {
      term: 'Last manual send',
      value: manualSendCopy(
        facts.lastManualAt,
        facts.lastManualAttemptAt,
        facts.manualLookupTruncated,
        when,
      ),
    },
    {
      term: 'Next eligible',
      value: !running
        ? 'Nothing is eligible: this event is no longer chased automatically.'
        : eligibleEvaluationAt === null
          ? `No outstanding task is waiting on a cadence window. ${facts.trackedTasks} tracked.`
          : `${when(eligibleEvaluationAt)} at the earliest — the first evaluation after a tracked task’s cadence window elapses. ${facts.trackedTasks} ${facts.trackedTasks === 1 ? 'task is' : 'tasks are'} tracked.`,
    },
  ]

  return (
    <Card
      title="Reminder automation"
      subtitle={REMINDER_EVALUATION_COPY}
      actions={
        <Badge tone={facts.cadenceDays === null ? 'neutral' : 'success'} dot>
          {reminderCadenceBadge(facts.cadenceDays)}
        </Badge>
      }
    >
      <DescriptionList items={items} />
    </Card>
  )
}
