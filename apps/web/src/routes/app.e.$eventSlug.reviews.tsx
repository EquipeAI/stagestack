import { useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Id } from '@convex/_generated/dataModel'
import { Card, EmptyState, PageHeader, Tabs } from '~/ds'
import { ReviewQueue } from '~/components/reviews/ReviewQueue'
import { ReviewPanel } from '~/components/reviews/ReviewPanel'
import { ProposalReadout } from '~/components/reviews/ProposalReadout'
import { RoundsPanel } from '~/components/reviews/RoundsPanel'
import { ProgressPanel } from '~/components/reviews/ProgressPanel'
import {
  isUnfinished,
  reviewPanelKey,
  submittedCount,
} from '~/components/reviews/model'

// The single screen a reviewer works from: the queue on the left, the proposal
// in the middle, the review panel on the right. Nothing here navigates away —
// submitting advances to the next unfinished proposal in place.
//
// Organizers get two more views over the same URL: the evaluation plan
// (rounds, scorecards, pools) and the per-reviewer progress board. Reviewers
// see only their queue — no tabs.

export const Route = createFileRoute('/app/e/$eventSlug/reviews')({
  component: Reviews,
})

function Reviews() {
  const { eventSlug } = Route.useParams()
  const event = useQuery(api.events.get, { eventSlug })
  const [tab, setTab] = useState('queue')
  const isOrganizer = event !== undefined && event.role === 'organizer'

  const view =
    isOrganizer && tab === 'plan' ? (
      <RoundsPanel eventSlug={eventSlug} timezone={event.event.timezone} />
    ) : isOrganizer && tab === 'progress' ? (
      <ProgressPanel eventSlug={eventSlug} />
    ) : (
      <QueueView
        eventSlug={eventSlug}
        archived={event?.event.archivedAt !== undefined}
      />
    )

  if (!isOrganizer) return view

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <Tabs
        variant="underline"
        tabs={[
          { id: 'queue', label: 'My queue' },
          { id: 'plan', label: 'Evaluation plan' },
          { id: 'progress', label: 'Progress' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {view}
    </div>
  )
}

function QueueView({
  eventSlug,
  archived,
}: {
  eventSlug: string
  archived: boolean
}) {
  const assignments = useQuery(api.reviews.myAssignments, { eventSlug })

  const [selectedId, setSelectedId] = useState<Id<'reviews'> | null>(null)
  // The first unfinished review is opened once, on arrival. After that the
  // selection is the reviewer's (or the one "Submit & Next" moved to).
  const picked = useRef(false)

  useEffect(() => {
    if (assignments === undefined || picked.current) return
    picked.current = true
    const first = assignments.find(isUnfinished)
    setSelectedId(first === undefined ? null : first.reviewId)
  }, [assignments])

  if (assignments === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading your queue…</p>
  }

  if (assignments.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="star"
          title="No proposals assigned to you yet"
          description="Proposals an organizer assigns to you appear here, unfinished ones first."
        />
      </Card>
    )
  }

  const actionableAssignments = assignments.filter(
    (row) => row.status !== 'conflict',
  )
  const conflictCount = assignments.length - actionableAssignments.length
  const current =
    actionableAssignments.find((row) => row.reviewId === selectedId) ?? null
  const unfinished = actionableAssignments.filter(isUnfinished)
  const done = submittedCount(actionableAssignments)

  const advance = ({ revised }: { revised: boolean }) => {
    if (revised) return
    const next = unfinished.find((row) => row.reviewId !== selectedId)
    setSelectedId(next === undefined ? null : next.reviewId)
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <PageHeader
        title="Reviews"
        description={`${done} of ${actionableAssignments.length} submitted · ${unfinished.length} still waiting on you${conflictCount === 0 ? '' : ` · ${conflictCount} conflict${conflictCount === 1 ? '' : 's'} excluded`}`}
      />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          gap: 'var(--space-5)',
        }}
      >
        <div style={{ flex: '1 1 13rem', minWidth: 0, maxWidth: '100%' }}>
          <div
            style={{
              position: 'sticky',
              top: 'var(--topbar-height)',
            }}
          >
            <ReviewQueue
              assignments={assignments}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
        </div>

        <div style={{ flex: '5 1 24rem', minWidth: 0 }}>
          {current === null ? (
            <Card>
              <EmptyState
                icon="circle-check"
                title={`All caught up — ${done} review${done === 1 ? '' : 's'} submitted`}
                description="Nothing is waiting on you. Pick any proposal from the queue to revise the review you left."
              />
            </Card>
          ) : (
            <ProposalReadout assignment={current} />
          )}
        </div>

        <div style={{ flex: '3 1 19rem', minWidth: 0 }}>
          {current === null ? null : (
            <div style={{ position: 'sticky', top: 'var(--topbar-height)' }}>
              <ReviewPanel
                key={reviewPanelKey(current)}
                eventSlug={eventSlug}
                assignment={current}
                archived={archived}
                isLastUnfinished={
                  unfinished.length <= 1 &&
                  unfinished[0]?.reviewId === current.reviewId
                }
                onCommitted={advance}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
