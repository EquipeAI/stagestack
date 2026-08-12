import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import {
  ActionResult,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  Input,
  Toolbar,
} from '~/ds'
import { usePending } from '~/lib/usePending'

// Per-reviewer completion, grouped by round: who is assigned what, who has
// finished, and the two levers an organizer pulls when the numbers lag —
// a consolidated reminder and auto-distribution across the round's pool.

type ProgressRow = FunctionReturnType<
  typeof api.reviews.reviewerProgress
>[number]

export function ProgressPanel({ eventSlug }: { eventSlug: string }) {
  const rows = useQuery(api.reviews.reviewerProgress, { eventSlug })
  const remind = useMutation(api.reviews.remind)
  const reminder = usePending()
  // Selection is by reviewer, not by row — the reminder is one consolidated
  // message per person, however many rounds they appear in.
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [reminderResult, setReminderResult] = useState<{
    status: 'success' | 'partial' | 'failed'
    title: string
    lines: Array<string>
  } | null>(null)

  if (rows === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading progress…</p>
  }

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="users"
          title="No reviewers assigned yet"
          description="Assign proposals — by hand or with auto-distribute — and per-reviewer progress shows up here."
        />
      </Card>
    )
  }

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  // Grouped in server order (round order, then name) — a Map keeps it.
  const groups = new Map<string, Array<ProgressRow>>()
  for (const row of rows) {
    const key = row.roundId ?? 'legacy'
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [row])
    else group.push(row)
  }

  const sendReminder = () => {
    const reviewerUserIds = [...selected] as Array<Id<'users'>>
    const requested = reviewerUserIds.length
    setReminderResult(null)
    void reminder.run(async () => {
      const result = await remind({ eventSlug, reviewerUserIds })
      // Every count comes from the mutation, which is where eligibility is
      // decided — the panel adds no arithmetic of its own (W5).
      setReminderResult({
        status:
          result.failed > 0
            ? result.sent === 0
              ? 'failed'
              : 'partial'
            : result.skipped > 0
              ? 'partial'
              : 'success',
        title: `${result.sent} reminder${result.sent === 1 ? '' : 's'} sent`,
        lines: [
          `${requested} reviewer${requested === 1 ? '' : 's'} selected · ${result.sent + result.failed} eligible.`,
          ...(result.failed > 0
            ? [
                `${result.failed} could not be delivered — the message is logged as failed.`,
              ]
            : []),
          ...(result.skippedNothingOutstanding > 0
            ? [
                `${result.skippedNothingOutstanding} skipped: nothing outstanding to remind them about.`,
              ]
            : []),
          ...(result.skippedNoAddress > 0
            ? [
                `${result.skippedNoAddress} skipped: no email address on file.`,
              ]
            : []),
        ],
      })
      setSelected(new Set())
    })
  }

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
              color: 'var(--text-tertiary)',
              font: 'var(--type-caption)',
            }}
          >
            {selected.size === 0
              ? 'Select reviewers to send a consolidated reminder.'
              : `${selected.size} reviewer${selected.size === 1 ? '' : 's'} selected`}
          </span>
        }
        right={
          <Button
            iconLeft="send"
            disabled={selected.size === 0 || reminder.pending}
            onClick={sendReminder}
          >
            {reminder.pending ? 'Sending…' : 'Send reminder'}
          </Button>
        }
      />
      {reminder.error !== null ? (
        <Callout tone="blocked">{reminder.error}</Callout>
      ) : null}
      {reminderResult === null ? null : (
        <ActionResult
          status={reminderResult.status}
          title={reminderResult.title}
          details={reminderResult.lines}
          onDismiss={() => setReminderResult(null)}
        />
      )}

      {[...groups.entries()].map(([key, group]) => (
        <RoundGroup
          key={key}
          eventSlug={eventSlug}
          roundId={group[0].roundId}
          roundName={group[0].roundName}
          rows={group}
          selected={selected}
          onToggle={toggle}
        />
      ))}
    </div>
  )
}

function RoundGroup({
  eventSlug,
  roundId,
  roundName,
  rows,
  selected,
  onToggle,
}: {
  eventSlug: string
  roundId: Id<'reviewRounds'> | null
  roundName: string
  rows: Array<ProgressRow>
  selected: Set<string>
  onToggle: (userId: string) => void
}) {
  const assigned = rows.reduce((sum, row) => sum + row.assigned, 0)
  const submitted = rows.reduce((sum, row) => sum + row.submitted, 0)
  const conflicts = rows.reduce((sum, row) => sum + row.conflicts, 0)

  const tableRows = rows.map((row) => ({
    ...row,
    key: `${row.userId}:${row.roundId ?? 'legacy'}`,
  }))

  return (
    <Card
      title={roundName}
      subtitle={`${submitted} of ${assigned} actionable reviews submitted across ${rows.length} reviewer${rows.length === 1 ? '' : 's'}${conflicts === 0 ? '.' : ` · ${conflicts} conflict${conflicts === 1 ? '' : 's'} excluded.`}`}
      actions={
        roundId === null ? null : (
          <AutoDistribute eventSlug={eventSlug} roundId={roundId} />
        )
      }
    >
      <DataTable
        rowKey="key"
        selectedIds={tableRows
          .filter((row) => selected.has(row.userId))
          .map((row) => row.key)}
        columns={[
          {
            key: 'pick',
            header: '',
            width: 40,
            cell: (row: ProgressRow) => (
              <Checkbox
                name={`select-${row.userId}`}
                checked={selected.has(row.userId)}
                onChange={() => onToggle(row.userId)}
              />
            ),
          },
          {
            key: 'reviewer',
            header: 'Reviewer',
            cell: (row: ProgressRow) => (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span>{row.name ?? row.email ?? 'Unknown'}</span>
                {row.name !== null && row.email !== null ? (
                  <span
                    style={{
                      color: 'var(--text-tertiary)',
                      font: 'var(--type-caption)',
                    }}
                  >
                    {row.email}
                  </span>
                ) : null}
              </div>
            ),
          },
          {
            key: 'assigned',
            header: 'Assigned',
            align: 'right',
            cell: (row: ProgressRow) => (
              <span style={{ fontFamily: 'var(--font-mono)' }}>
                {row.assigned}
              </span>
            ),
          },
          {
            key: 'done',
            header: 'Submitted',
            align: 'right',
            cell: (row: ProgressRow) => (
              <span style={{ fontFamily: 'var(--font-mono)' }}>
                {row.submitted} of {row.assigned}
                {row.assigned > 0
                  ? ` (${Math.round((row.submitted / row.assigned) * 100)}%)`
                  : ''}
              </span>
            ),
          },
          {
            key: 'conflicts',
            header: 'Conflicts',
            align: 'right',
            cell: (row: ProgressRow) =>
              row.conflicts > 0 ? (
                <Badge tone="attention">{row.conflicts}</Badge>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>—</span>
              ),
          },
        ]}
        rows={tableRows}
      />
    </Card>
  )
}

/** The per-round lever: spread unassigned proposals across the pool. */
function AutoDistribute({
  eventSlug,
  roundId,
}: {
  eventSlug: string
  roundId: Id<'reviewRounds'>
}) {
  const autoDistribute = useMutation(api.reviews.autoDistribute)
  const { pending, error, setError, run } = usePending()
  const [perProposal, setPerProposal] = useState('1')
  // A bulk assignment leaves a persistent result: "unplaced 2" has to still be
  // readable while the organizer works out who to add to the pool (W5).
  const [result, setResult] = useState<{
    status: 'success' | 'partial'
    title: string
    lines: Array<string>
  } | null>(null)

  const distribute = () => {
    const count = Number(perProposal.trim())
    if (!Number.isInteger(count) || count < 1) {
      setError('Reviews per proposal must be a whole number, at least 1.')
      return
    }
    void run(async () => {
      const outcome = await autoDistribute({
        eventSlug,
        roundId,
        perProposal: count,
      })
      setResult({
        status: outcome.unplaced === 0 ? 'success' : 'partial',
        title: `${outcome.assigned} assignment${outcome.assigned === 1 ? '' : 's'} created`,
        lines: [
          `${count} review${count === 1 ? '' : 's'} per proposal was requested.`,
          ...(outcome.unplaced === 0
            ? []
            : [
                `${outcome.unplaced} slot${outcome.unplaced === 1 ? '' : 's'} could not be filled — the round ran out of eligible reviewers.`,
              ]),
        ],
      })
    })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
      }}
    >
    <div
      style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-2)' }}
    >
      <Field
        label="Reviews / proposal"
        htmlFor={`dist-${roundId}`}
        error={error}
      >
        <Input
          id={`dist-${roundId}`}
          size="sm"
          type="number"
          value={perProposal}
          style={{ width: '5rem' }}
          onChange={(e) => setPerProposal(e.target.value)}
        />
      </Field>
      <Button
        size="sm"
        iconLeft="shuffle"
        disabled={pending}
        onClick={distribute}
      >
        {pending ? 'Distributing…' : 'Auto-distribute'}
      </Button>
    </div>
      {result === null ? null : (
        <ActionResult
          status={result.status}
          title={result.title}
          details={result.lines}
          onDismiss={() => setResult(null)}
        />
      )}
    </div>
  )
}
