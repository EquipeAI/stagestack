import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { PoolEditor } from './PoolEditor'
import { RoundLaunchFlow } from './RoundLaunchFlow'
import { criterionSummary } from './launchFlow'
import type { Round } from './launchFlow'
import { Badge, Button, Callout, Card, Dialog, Field, IconButton } from '~/ds'
import { formatDateTime } from '~/lib/datetime'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'

// The organizer's evaluation plan: every review round, its window, its
// scorecard and its reviewer pool.
//
// Setting a round up is not a form — it is a guided flow that ends in a
// launch whose consequences are stated in sentences (W11). The flow is state
// in THIS route rather than a route of its own: it is a bounded task that
// belongs to the plan tab, its draft is not resumable across a reload, and
// keeping it here means the plan list is one Back away rather than one
// navigation. `?tab=plan&flow=…` lands on it.

export function RoundsPanel({
  eventSlug,
  timezone,
  flow,
  onOpenFlow,
  onOpenProgress,
  registerLeaveGuard,
}: {
  eventSlug: string
  timezone: string
  /** URL-landable flow state: 'new', a roundId, or undefined. */
  flow?: string
  onOpenFlow: (flow: string | undefined) => void
  onOpenProgress: () => void
  /** Passed straight to the flow: the route owns the tab, so it has to ask
   * before unmounting a flow with unsaved work or a draft round. */
  registerLeaveGuard?: (
    guard: ((proceed: () => void) => boolean) | null,
  ) => void
}) {
  const rounds = useQuery(api.reviews.listRounds, { eventSlug })
  // Invitation expiry is time-derived, so team reads take the clock as an
  // argument (see settings/team screens). One snapshot is enough here.
  const [now] = useState(() => Date.now())
  const team = useQuery(api.team.listForEvent, { eventSlug, now })

  if (rounds === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading rounds…</p>
  }

  const members = (team?.members ?? []).filter(
    (member) => member.role === 'organizer' || member.role === 'reviewer',
  )

  if (flow !== undefined) {
    const editing =
      flow === 'new'
        ? null
        : (rounds.find((round) => round.roundId === flow) ?? null)
    // A flow id that no longer names a round falls back to the list rather
    // than silently starting a new round the organizer did not ask for.
    if (flow === 'new' || editing !== null) {
      return (
        <RoundLaunchFlow
          key={flow}
          eventSlug={eventSlug}
          timezone={timezone}
          round={editing}
          members={members}
          onClose={() => onOpenFlow(undefined)}
          onOpenProgress={onOpenProgress}
          registerLeaveGuard={registerLeaveGuard}
        />
      )
    }
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          iconLeft="plus"
          onClick={() => onOpenFlow('new')}
        >
          New round
        </Button>
      </div>

      {rounds.length === 0 ? (
        <Callout tone="info" title="No review rounds yet">
          A round bundles a scorecard, a reviewing window and a reviewer pool.
          Create one to start assigning proposals.
        </Callout>
      ) : (
        rounds.map((round) => (
          <RoundCard
            key={round.roundId}
            eventSlug={eventSlug}
            round={round}
            timezone={timezone}
            members={members}
            onEdit={() => onOpenFlow(round.roundId)}
          />
        ))
      )}
    </div>
  )
}

// ── One round ─────────────────────────────────────────────────────────────

function RoundCard({
  eventSlug,
  round,
  timezone,
  members,
  onEdit,
}: {
  eventSlug: string
  round: Round
  timezone: string
  members: Array<Parameters<typeof PoolEditor>[0]['members'][number]>
  onEdit: () => void
}) {
  const deleteRound = useMutation(api.reviews.deleteRound)
  const removal = usePending()
  const [confirming, setConfirming] = useState(false)

  const window =
    round.opensAt === undefined && round.closesAt === undefined
      ? 'Always open'
      : `${round.opensAt === undefined ? 'Open' : formatDateTime(round.opensAt, timezone)} → ${
          round.closesAt === undefined
            ? 'no close date'
            : formatDateTime(round.closesAt, timezone)
        }`

  return (
    <Card
      title={round.name}
      subtitle={window}
      actions={
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
        >
          {round.draft ? (
            <Badge tone="attention">Draft — not launched</Badge>
          ) : null}
          {round.anonymized ? <Badge tone="info">Blind review</Badge> : null}
          {round.reviewerCap !== undefined ? (
            <Badge tone="neutral">Cap {round.reviewerCap} / reviewer</Badge>
          ) : null}
          <Button size="sm" iconLeft="play" onClick={onEdit}>
            {round.draft ? 'Finish & launch' : 'Review & launch'}
          </Button>
          <IconButton
            icon="trash-2"
            label="Delete round"
            size="sm"
            disabled={removal.pending}
            onClick={() => setConfirming(true)}
          />
        </div>
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {removal.error !== null ? (
          <Callout tone="blocked">{removal.error}</Callout>
        ) : null}

        {round.draft ? (
          <Callout tone="attention" title="This round has not been launched">
            It assigns nothing, no reviewer can see it, and it counts toward no
            readiness number. Finish its flow to launch it, or delete it.
          </Callout>
        ) : null}

        <Field label="Scorecard">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {round.scorecard.map((field) => (
              <li
                key={field.id}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 'var(--space-2)',
                  minHeight: 'var(--row-height-sm)',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ font: 'var(--type-body)' }}>{field.label}</span>
                <span
                  style={{
                    color: 'var(--text-tertiary)',
                    font: 'var(--type-caption)',
                  }}
                >
                  {criterionSummary(field)}
                </span>
              </li>
            ))}
          </ul>
        </Field>

        <PoolEditor eventSlug={eventSlug} round={round} members={members} />
      </div>

      {confirming ? (
        <Dialog
          title={`Delete "${round.name}"?`}
          description="The round, its scorecard and its reviewer pool go away. Deleting cannot be undone."
          width={480}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={removal.pending}
                onClick={() => {
                  setConfirming(false)
                  void removal.run(async () => {
                    await deleteRound({ eventSlug, roundId: round.roundId })
                    pushToast('Round deleted', round.name)
                  })
                }}
              >
                Delete round
              </Button>
            </>
          }
        />
      ) : null}
    </Card>
  )
}
