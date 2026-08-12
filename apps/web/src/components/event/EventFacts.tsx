import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type * as React from 'react'
import {
  Button,
  Callout,
  Card,
  DescriptionList,
  Dialog,
  StatusPill,
} from '~/ds'
import { formatDateRange, formatDateTime } from '~/lib/datetime'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { CopyLinkRow } from '~/components/CopyLinkRow'
import { cfpUrl } from '~/components/cfp/ShareCallCard'

// The event's stable facts: what it is, when it is, where its CFP link points,
// and how to archive it. This was the whole of the event root until W7 gave
// the root to the control center (decision 5). It now has two homes, and they
// are the same component:
//
//   · Setup → Event details (`/details`) — for everyone, organizers included.
//   · The event root — for reviewers and speakers, who have no control center
//     to be shown and for whom the root has always been a real page.
//
// One component, so the two can never drift into two accounts of the same
// event.

export function EventFacts({ eventSlug }: { eventSlug: string }) {
  const data = useQuery(api.events.get, { eventSlug })

  if (data === undefined) {
    return (
      <p style={{ color: 'var(--text-tertiary)' }}>Loading event details…</p>
    )
  }

  const { event } = data
  const zone = event.timezone

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))',
        gap: 'var(--space-4)',
        alignItems: 'start',
      }}
    >
      <Card title="Event details" subtitle="Shown in the event timezone.">
        <DescriptionList
          items={[
            {
              term: 'Dates',
              value: formatDateRange(event.startsAt, event.endsAt, zone),
            },
            {
              term: 'Starts',
              value: <Mono>{formatDateTime(event.startsAt, zone)}</Mono>,
            },
            {
              term: 'Ends',
              value: <Mono>{formatDateTime(event.endsAt, zone)}</Mono>,
            },
            { term: 'Timezone', value: <Mono>{zone}</Mono> },
            { term: 'Type', value: event.type ?? '—' },
            { term: 'Location', value: event.location ?? '—' },
            {
              term: 'Website',
              value:
                event.website === undefined ? (
                  '—'
                ) : (
                  <a href={event.website} target="_blank" rel="noreferrer">
                    {event.website}
                  </a>
                ),
            },
            { term: 'Slug', value: <Mono>{event.slug}</Mono> },
            { term: 'Description', value: event.description ?? '—' },
          ]}
        />
      </Card>

      <Card
        title="Call for speakers"
        subtitle="The CFP window and its publication are independent controls."
        actions={
          <StatusPill status={event.cfpPublished ? 'Published' : 'Unpublished'} />
        }
      >
        <DescriptionList
          items={[
            {
              term: 'Opens',
              value:
                event.cfpOpenAt === undefined ? (
                  'Not set'
                ) : (
                  <Mono>{formatDateTime(event.cfpOpenAt, zone)}</Mono>
                ),
            },
            {
              term: 'Closes',
              value:
                event.cfpCloseAt === undefined ? (
                  'Not set'
                ) : (
                  <Mono>{formatDateTime(event.cfpCloseAt, zone)}</Mono>
                ),
            },
          ]}
        />
        <div style={{ marginTop: 'var(--space-4)' }}>
          <CopyLinkRow
            label="CFP link"
            value={cfpUrl(eventSlug)}
            toast="CFP link copied"
          />
        </div>
        <p
          style={{
            marginTop: 'var(--space-3)',
            color: 'var(--text-tertiary)',
            font: 'var(--type-caption)',
          }}
        >
          {event.cfpPublished ? (
            'This is the link to send to candidate speakers.'
          ) : (
            <>
              The link goes live once the form is published in{' '}
              <Link to="/app/e/$eventSlug/cfp" params={{ eventSlug }}>
                Call for speakers
              </Link>{' '}
              and "CFP published" is on in Settings.
            </>
          )}
        </p>
      </Card>

      <ArchiveCard
        eventSlug={eventSlug}
        eventName={event.name}
        archived={event.archivedAt !== undefined}
        canEdit={data.role === 'organizer'}
      />
    </div>
  )
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
      {children}
    </span>
  )
}

function ArchiveCard({
  eventSlug,
  eventName,
  archived,
  canEdit,
}: {
  eventSlug: string
  eventName: string
  archived: boolean
  canEdit: boolean
}) {
  const setArchived = useMutation(api.events.setArchived)
  const { pending, error, run } = usePending()
  const [confirming, setConfirming] = useState(false)

  const apply = () => {
    void run(async () => {
      await setArchived({ eventSlug, archived: !archived })
      pushToast(archived ? 'Event unarchived' : 'Event archived', eventName)
      setConfirming(false)
    })
  }

  return (
    <Card
      title="Archive"
      subtitle={
        archived
          ? 'This event is archived and hidden from active lists.'
          : 'Archiving hides the event from active lists. Nothing is deleted.'
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        <div>
          <Button
            variant={archived ? 'secondary' : 'danger'}
            disabled={!canEdit || pending}
            onClick={() => setConfirming(true)}
          >
            {archived ? 'Unarchive event' : 'Archive event'}
          </Button>
        </div>
        {!canEdit ? (
          <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
            Only event organizers can archive.
          </p>
        ) : null}
      </div>
      {confirming ? (
        <Dialog
          open
          title={archived ? 'Unarchive event?' : 'Archive event?'}
          description={
            archived
              ? `${eventName} returns to your active events.`
              : `${eventName} disappears from active lists for everyone on the team. Its data, CFP and team stay intact.`
          }
          onClose={pending ? undefined : () => setConfirming(false)}
          footer={
            <>
              <Button onClick={() => setConfirming(false)} disabled={pending}>
                Cancel
              </Button>
              <Button
                variant={archived ? 'primary' : 'danger'}
                onClick={apply}
                disabled={pending}
              >
                {pending
                  ? 'Working…'
                  : archived
                    ? 'Unarchive event'
                    : 'Archive event'}
              </Button>
            </>
          }
        />
      ) : null}
    </Card>
  )
}
