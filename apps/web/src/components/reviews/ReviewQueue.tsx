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
  const actionableAssignments = assignments.filter(
    (row) => row.status !== 'conflict',
  )
  const conflictCount = assignments.length - actionableAssignments.length
  const done = submittedCount(actionableAssignments)

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
          {done}/{actionableAssignments.length}
        </span>
      </div>
      {conflictCount > 0 ? (
        <span
          role="status"
          style={{
            padding: 'var(--space-2)',
            borderRadius: 'var(--radius-control)',
            background: 'var(--status-attention-bg)',
            color: 'var(--status-attention-fg)',
            font: 'var(--type-caption)',
          }}
        >
          {conflictCount} conflict{conflictCount === 1 ? '' : 's'} excluded from
          the actionable queue.
        </span>
      ) : null}
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
        {actionableAssignments.map((assignment) => (
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
  const conflict = assignment.status === 'conflict'
  return (
    <button
      type="button"
      disabled={conflict}
      onClick={conflict ? undefined : onSelect}
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
        background: conflict
          ? 'var(--status-attention-bg)'
          : selected
            ? 'var(--surface-selected)'
            : 'transparent',
        color: conflict
          ? 'var(--status-attention-fg)'
          : unfinished
            ? 'var(--text-primary)'
            : 'var(--text-secondary)',
        cursor: conflict ? 'not-allowed' : 'pointer',
        opacity: 1,
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

/**
 * Done reads as a check; everything else as its state's dot.
 *
 * Two accessibility rules shape this. `aria-label` on a role-less `<span>` is
 * prohibited and most screen readers drop it, so each mark declares
 * `role="img"` — and the inner `Icon` is `aria-hidden`, which would otherwise
 * leave an empty element. And draft vs awaiting-review used to differ only by
 * the dot's colour: a draft is now a ring and an untouched assignment a filled
 * dot, so the difference survives without colour (WCAG 1.4.1).
 */
function StatusMark({ assignment }: { assignment: Assignment }) {
  if (assignment.status === 'conflict') {
    return (
      <span
        role="img"
        aria-label={REVIEW_STATUS_LABEL[assignment.status]}
        style={{ color: 'var(--status-attention-fg)', display: 'flex' }}
      >
        <Icon name="triangle-alert" size={14} />
      </span>
    )
  }
  if (!isUnfinished(assignment)) {
    return (
      <span
        role="img"
        aria-label={REVIEW_STATUS_LABEL[assignment.status]}
        style={{ color: 'var(--status-success-fg)', display: 'flex' }}
      >
        <Icon name="check" size={14} />
      </span>
    )
  }
  const draft = assignment.status === 'draft'
  return (
    <span
      role="img"
      aria-label={REVIEW_STATUS_LABEL[assignment.status]}
      style={{
        flex: 'none',
        width: 'var(--space-2)',
        height: 'var(--space-2)',
        borderRadius: 'var(--radius-full)',
        background: draft ? 'transparent' : 'var(--status-info-dot)',
        boxShadow: draft
          ? 'inset 0 0 0 var(--space-px) var(--status-attention-dot)'
          : undefined,
      }}
    />
  )
}
