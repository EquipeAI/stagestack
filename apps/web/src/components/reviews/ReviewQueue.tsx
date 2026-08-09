import { REVIEW_STATUS_LABEL, isUnfinished, submittedCount } from './model'
import type { Id } from '@convex/_generated/dataModel'
import type { Assignment } from './model'
import { Icon } from '~/ds'

// The queue rail: everything assigned to this reviewer, unfinished first (the
// backend orders it), one click to jump. It is the only navigation the review
// flow needs — no list page, no back and forth.

export function ReviewQueue({
  assignments,
  selectedId,
  onSelect,
}: {
  assignments: ReadonlyArray<Assignment>
  selectedId: Id<'reviews'> | null
  onSelect: (reviewId: Id<'reviews'>) => void
}) {
  const done = submittedCount(assignments)

  return (
    <nav
      aria-label="Your review queue"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          padding: 'var(--space-0) var(--space-2)',
        }}
      >
        <span
          style={{ font: 'var(--type-eyebrow)', color: 'var(--text-tertiary)' }}
        >
          Queue
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text-tertiary)',
          }}
        >
          {done}/{assignments.length}
        </span>
      </div>
      <ul
        style={{
          listStyle: 'none',
          margin: 'var(--space-0)',
          padding: 'var(--space-0)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-px)',
        }}
      >
        {assignments.map((assignment) => (
          <li key={assignment.reviewId}>
            <QueueItem
              assignment={assignment}
              selected={assignment.reviewId === selectedId}
              onSelect={() => {
                onSelect(assignment.reviewId)
              }}
            />
          </li>
        ))}
      </ul>
    </nav>
  )
}

function QueueItem({
  assignment,
  selected,
  onSelect,
}: {
  assignment: Assignment
  selected: boolean
  onSelect: () => void
}) {
  const unfinished = isUnfinished(assignment)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      title={`${assignment.proposal.title} — ${REVIEW_STATUS_LABEL[assignment.status]}`}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        textAlign: 'left',
        minHeight: 'var(--row-height-md)',
        padding: 'var(--space-2) var(--space-2)',
        borderRadius: 'var(--radius-control)',
        border: 'var(--space-px) solid transparent',
        borderLeft: `var(--space-half) solid ${
          selected ? 'var(--border-brand)' : 'transparent'
        }`,
        background: selected ? 'var(--surface-selected)' : 'transparent',
        color: unfinished ? 'var(--text-primary)' : 'var(--text-secondary)',
        cursor: 'pointer',
        transition: 'var(--transition-control)',
      }}
    >
      <StatusMark assignment={assignment} />
      <span
        style={{
          font: 'var(--type-body)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {assignment.proposal.title}
      </span>
    </button>
  )
}

/** Done reads as a check; everything else as its state's dot. */
function StatusMark({ assignment }: { assignment: Assignment }) {
  if (!isUnfinished(assignment)) {
    return (
      <span
        aria-label={REVIEW_STATUS_LABEL[assignment.status]}
        style={{ color: 'var(--status-success-fg)', display: 'flex' }}
      >
        <Icon name="check" size={14} />
      </span>
    )
  }
  return (
    <span
      aria-label={REVIEW_STATUS_LABEL[assignment.status]}
      style={{
        flex: 'none',
        width: 'var(--space-2)',
        height: 'var(--space-2)',
        borderRadius: 'var(--radius-full)',
        background:
          assignment.status === 'draft'
            ? 'var(--status-attention-dot)'
            : 'var(--status-info-dot)',
      }}
    />
  )
}
