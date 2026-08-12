import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { dayKey, dayLabel, slotClock } from './model'
import type { Board } from './model'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import { Badge, Button, Callout, Dialog, EmptyState } from '~/ds'
import { usePending } from '~/lib/usePending'

// Propose before writing (W2). "Suggest schedule" is a QUERY: this dialog
// shows exactly what would happen — session, day, time, room and why — and
// Apply sends that same plan back to one mutation, which re-plans against
// current state and refuses if the board moved. Nothing here re-derives a
// placement or re-words a reason; both come from convex/model/agenda.ts.
//
// It is a list on purpose: at 375px this, not the grid, is how scheduling
// gets reviewed.

export type Plan = FunctionReturnType<typeof api.agenda.suggestSchedule>

export type AppliedRun = {
  runId: Id<'auditLog'>
  placed: number
}

export function SuggestDialog({
  eventSlug,
  board,
  onClose,
  onApplied,
}: {
  eventSlug: string
  board: Board
  onClose: () => void
  onApplied: (run: AppliedRun) => void
}) {
  const plan = useQuery(api.agenda.suggestSchedule, { eventSlug })
  const apply = useMutation(api.agenda.applySchedule)
  const { pending, error, setError, run } = usePending()
  const zone = board.event.timezone
  const roomName = new Map(board.rooms.map((r) => [r.roomId as string, r.name]))

  const placements = plan?.placements ?? []

  const onApply = () => {
    if (plan === undefined) return
    setError(null)
    void run(async () => {
      const result = await apply({
        eventSlug,
        fingerprint: plan.fingerprint,
        placements: plan.placements.map((p) => ({
          sessionId: p.sessionId,
          startsAt: p.startsAt,
          endsAt: p.endsAt,
          roomId: p.roomId,
        })),
      })
      onApplied({ runId: result.runId, placed: result.placed.length })
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={720}
      title="Suggested schedule"
      description="Nothing is written until you apply. Review each placement, then apply the whole plan or discard it."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Discard
          </Button>
          <Button
            variant="primary"
            disabled={pending || plan === undefined || placements.length === 0}
            onClick={onApply}
          >
            {pending
              ? 'Applying…'
              : placements.length === 0
                ? 'Nothing to apply'
                : `Apply ${placements.length} placement${placements.length === 1 ? '' : 's'}`}
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

        {plan === undefined ? (
          <p style={{ color: 'var(--text-tertiary)' }}>Working out a plan…</p>
        ) : (
          <PlanReview plan={plan} zone={zone} roomName={roomName} />
        )}
      </div>
    </Dialog>
  )
}

/**
 * The review list itself — pure, so it renders the same at 375px in a bottom
 * sheet as it does in a desktop dialog, and so it can be tested without a
 * Convex client. Every sentence it shows (`why`, an unplaced `message`) comes
 * from the backend and is printed verbatim.
 */
export function PlanReview({
  plan,
  zone,
  roomName,
}: {
  plan: Plan
  zone: string
  roomName: ReadonlyMap<string, string>
}) {
  const placements = plan.placements
  const unplaced = plan.unplaced
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      {placements.length === 0 && unplaced.length === 0 ? (
        <EmptyState
          icon="calendar-days"
          title="Everything is already placed"
          description="There are no unscheduled sessions to suggest slots for."
        />
      ) : (
        <>
          {placements.length > 0 ? (
            <section
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
              }}
            >
              <h3
                style={{
                  font: 'var(--type-label)',
                  color: 'var(--text-primary)',
                  margin: 'var(--space-0)',
                }}
              >
                {placements.length} to place
              </h3>
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-2)',
                }}
              >
                {placements.map((placement) => (
                  <li
                    key={placement.sessionId}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-1)',
                      padding: 'var(--space-3)',
                      borderRadius: 'var(--radius-md)',
                      border: 'var(--space-px) solid var(--border-subtle)',
                      background: 'var(--surface-card)',
                    }}
                  >
                    <span
                      style={{
                        font: 'var(--type-label)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {placement.title}
                    </span>
                    <span
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--text-xs)',
                        fontVariantNumeric: 'tabular-nums',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <span>
                        {dayLabel(dayKey(placement.startsAt, zone), zone)}
                      </span>
                      <span>
                        {slotClock(placement.startsAt, placement.endsAt, zone)}
                      </span>
                      <Badge tone="neutral" size="sm">
                        {placement.roomId === undefined
                          ? 'No room'
                          : (roomName.get(placement.roomId) ?? 'Unknown room')}
                      </Badge>
                      <Badge tone="neutral" size="sm">
                        {placement.durationMinutes} min
                      </Badge>
                    </span>
                    <span
                      style={{
                        font: 'var(--type-caption)',
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      {placement.why}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {unplaced.length > 0 ? (
            <section
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
              }}
            >
              <h3
                style={{
                  font: 'var(--type-label)',
                  color: 'var(--text-primary)',
                  margin: 'var(--space-0)',
                }}
              >
                {unplaced.length} without a slot
              </h3>
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-2)',
                }}
              >
                {unplaced.map((entry) => (
                  <li key={entry.sessionId}>
                    <Callout tone="attention" title={entry.title}>
                      {entry.message}
                    </Callout>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
