import { DELIVERY_STAGES, DELIVERY_STAGE_LABEL, DELIVERY_STATUS } from './model'
import type * as React from 'react'
import type { DeliveryStatus } from './model'
import { StatusPill } from '~/ds'
import { formatDateTime } from '~/lib/datetime'

// One rendering of "where did this email get to", used by the comms log and by
// the CRM contact's outreach history so the two cannot word it differently.
//
// It is a LABELLED VERTICAL LIST at every width, never a horizontal stepper: a
// three-step stepper at 375px either truncates its labels or scrolls sideways,
// and this is exactly the information the review found the product lying about.

export function DeliveryPill({ status }: { status: DeliveryStatus }) {
  const delivery = DELIVERY_STATUS[status]
  return <StatusPill status={delivery.label} tone={delivery.tone} />
}

type StepState = 'done' | 'current' | 'pending' | 'failed'

export function DeliveryLifecycle({
  status,
  timezone,
  updatedAt,
}: {
  status: DeliveryStatus
  /** Event timezone — provider timestamps are shown in event time, labelled,
   * like every other time in an organizer surface. */
  timezone: string
  /** The provider's own timestamp for the event that produced `status`. */
  updatedAt?: number
}) {
  const delivery = DELIVERY_STATUS[status]
  const reached = DELIVERY_STAGES.indexOf(delivery.stage)

  return (
    <ol style={listStyle} aria-label="Delivery lifecycle">
      {DELIVERY_STAGES.map((stage, index) => {
        const isLast = index === reached
        const state: StepState =
          index > reached
            ? 'pending'
            : isLast && delivery.failed
              ? 'failed'
              : isLast
                ? 'current'
                : 'done'
        // The final step is named by the outcome that actually happened —
        // "Bounced", not a hopeful "Delivered" the row never earned.
        const label =
          isLast && stage === 'closed'
            ? delivery.label
            : DELIVERY_STAGE_LABEL[stage]
        return (
          <li key={stage} style={itemStyle}>
            <span aria-hidden="true" style={markStyle(state)} />
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={labelStyle(state)}>
                {label}
                <span style={stateNoteStyle}>{` — ${STATE_NOTE[state]}`}</span>
                {/* The provider's own timestamp for this step, not ours. */}
                {isLast && updatedAt !== undefined ? (
                  <span style={stateNoteStyle}>
                    {` · ${formatDateTime(updatedAt, timezone)}`}
                  </span>
                ) : null}
              </span>
              {isLast ? (
                <span style={detailStyle}>{delivery.detail}</span>
              ) : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Text, not colour alone — every step says its own state. */
const STATE_NOTE: Record<StepState, string> = {
  done: 'done',
  current: 'current',
  pending: 'not reached',
  failed: 'failed',
}

const listStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
}

const itemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--space-2)',
}

function markStyle(state: StepState): React.CSSProperties {
  return {
    marginTop: '0.4em',
    width: '0.5rem',
    height: '0.5rem',
    flex: '0 0 auto',
    borderRadius: '50%',
    background:
      state === 'pending'
        ? 'var(--border-subtle)'
        : state === 'failed'
          ? 'var(--text-danger)'
          : 'var(--text-secondary)',
  }
}

function labelStyle(state: StepState): React.CSSProperties {
  return {
    fontSize: 'var(--text-xs)',
    color:
      state === 'pending'
        ? 'var(--text-tertiary)'
        : state === 'failed'
          ? 'var(--text-danger)'
          : 'var(--text-secondary)',
  }
}

const stateNoteStyle: React.CSSProperties = {
  color: 'var(--text-tertiary)',
}

const detailStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--text-tertiary)',
}
