import { Link } from '@tanstack/react-router'
import { channelBlockers } from './model'
import type { ChannelId, PublicationRow } from './model'
import { Button, Callout } from '~/ds'
import { repairTarget } from '~/components/workspace/repair'

// "What is holding this channel back" (W10), straight from W4.
//
// Every sentence here was composed in convex/model/readiness.ts and is printed
// VERBATIM, next to the repair the same producer named. This file decides
// nothing about publication: it filters rows by the model's own `blocks` field
// and hands each reason to the shared repair mapping.

export function ChannelBlockers({
  eventSlug,
  channel,
  rows,
}: {
  eventSlug: string
  channel: ChannelId
  rows: Array<PublicationRow>
}) {
  const blocked = channelBlockers(rows, channel)
  const label = channel === 'lineup' ? 'the lineup' : 'the schedule'

  if (blocked.length === 0) {
    return (
      <Callout tone="success" title={`Nothing is holding ${label} back`}>
        Every planned session clears the gates for this channel. Publishing is
        the only step left.
      </Callout>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
      }}
    >
      <span
        style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}
      >
        {blocked.length === 1
          ? `1 session is not in ${label}`
          : `${blocked.length} sessions are not in ${label}`}
      </span>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {blocked.map((row) => (
          <li
            key={row.sessionId}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
              padding: 'var(--space-3) var(--space-0)',
              borderTop: 'var(--space-px) solid var(--border-subtle)',
            }}
          >
            <span
              style={{
                font: 'var(--type-label)',
                color: 'var(--text-primary)',
              }}
            >
              {row.title}
            </span>
            {row.reasons.map((reason) => {
              const target = repairTarget(eventSlug, reason.repair)
              return (
                <span
                  key={reason.code}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: '12rem',
                      font: 'var(--type-caption)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {reason.sentence}
                  </span>
                  <Link
                    to={target.to}
                    params={target.params}
                    search={target.search}
                    style={{ textDecoration: 'none' }}
                  >
                    <Button size="sm" variant="ghost">
                      {target.label}
                    </Button>
                  </Link>
                </span>
              )
            })}
          </li>
        ))}
      </ul>
    </div>
  )
}
