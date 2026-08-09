import { Link } from '@tanstack/react-router'
import type * as React from 'react'
import type { Doc } from '@convex/_generated/dataModel'
import { Badge, Card, StatusPill } from '~/ds'
import { formatDateRange } from '~/lib/datetime'

export function EventCard({ event }: { event: Doc<'events'> }) {
  return (
    <Link
      to="/app/e/$eventSlug"
      params={{ eventSlug: event.slug }}
      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
    >
      <Card
        variant="interactive"
        title={event.name}
        subtitle={formatDateRange(event.startsAt, event.endsAt, event.timezone)}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          <StatusPill status={event.cfpPublished ? 'Published' : 'Unpublished'} />
          {event.archivedAt !== undefined ? (
            <Badge tone="neutral">Archived</Badge>
          ) : null}
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-tertiary)',
            }}
          >
            {event.timezone}
          </span>
        </div>
      </Card>
    </Link>
  )
}

export function EventGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 18rem), 1fr))',
        gap: 'var(--space-4)',
      }}
    >
      {children}
    </div>
  )
}
