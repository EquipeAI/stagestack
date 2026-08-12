import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { didNotReach, messageKindLabel } from './model'
import { ContactSelect, useEventContacts } from './ContactSelect'
import { DeliveryLifecycle, DeliveryPill } from './DeliveryLifecycle'
import { MonoText } from './primitives'
import type * as React from 'react'
import type { Id } from '@convex/_generated/dataModel'
import { Card, EmptyState, Field, Tag } from '~/ds'
import { formatDateTime } from '~/lib/datetime'

// "What was sent to this person, and when." The log is per contact on purpose:
// an organizer opens it because one speaker says they never heard from us.

export function LogPanel({
  eventSlug,
  timezone,
}: {
  eventSlug: string
  timezone: string
}) {
  const contacts = useEventContacts(eventSlug)
  const [contactId, setContactId] = useState<Id<'eventContacts'> | ''>('')

  if (contacts === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading speakers…</p>
  }

  if (contacts.length === 0) {
    return (
      <Card title="Comms log">
        <EmptyState
          icon="mail"
          title="No speakers yet"
          description="The log is kept per person. Once sessions have participants, everything StageStack has sent them appears here."
        />
      </Card>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <Card
        title="Comms log"
        subtitle="Everything StageStack has sent one speaker for this event, newest first."
      >
        <Field
          label="Speaker"
          htmlFor="log-contact"
          hint="Covers both their own address and anything sent on their behalf."
        >
          <ContactSelect
            id="log-contact"
            contacts={contacts}
            value={contactId}
            placeholder="Choose a speaker to see their log…"
            onChange={(value) => {
              setContactId(value as Id<'eventContacts'>)
            }}
          />
        </Field>
      </Card>

      {contactId === '' ? null : (
        <ContactLog
          key={contactId}
          eventSlug={eventSlug}
          eventContactId={contactId}
          timezone={timezone}
        />
      )}
    </div>
  )
}

function ContactLog({
  eventSlug,
  eventContactId,
  timezone,
}: {
  eventSlug: string
  eventContactId: Id<'eventContacts'>
  timezone: string
}) {
  const messages = useQuery(api.comms.contactLog, { eventSlug, eventContactId })
  // The template list is the authority on what a kind is called — including
  // keys added after this screen was written, and the organizer's own custom
  // ones. `messageKindLabel` is the fallback for a kind no template owns.
  const templates = useQuery(api.templates.list, { eventSlug })

  const nameFor = (kind: string) =>
    templates?.find((row) => row.key === kind)?.name ?? messageKindLabel(kind)

  if (messages === undefined) {
    return (
      <Card title="Messages">
        <p style={{ color: 'var(--text-tertiary)' }}>Loading the log…</p>
      </Card>
    )
  }

  if (messages.length === 0) {
    return (
      <Card title="Messages">
        <EmptyState
          icon="inbox"
          title="Nothing sent yet"
          description="Every lifecycle email, reminder and one-off message StageStack sends this speaker is recorded here the moment it goes out."
        />
      </Card>
    )
  }

  // "N sent" would overclaim: a `failed` row never left the building and a
  // bounce came back. A `complained` row is NOT in this count — it reached the
  // recipient, who then reported it as spam.
  const failedCount = messages.filter((message) =>
    didNotReach(message.deliveryStatus),
  ).length

  return (
    <Card
      title="Messages"
      subtitle={
        failedCount === 0
          ? `${messages.length} recorded`
          : `${messages.length} recorded · ${failedCount} did not reach the recipient`
      }
      padded={false}
    >
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {messages.map((message) => {
          return (
            <li key={message.messageId} style={row}>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    flexWrap: 'wrap',
                  }}
                >
                  <Tag>{nameFor(message.kind)}</Tag>
                  <DeliveryPill status={message.deliveryStatus} />
                </span>
                <span style={{ font: 'var(--type-label)', overflowWrap: 'anywhere' }}>
                  {message.subject}
                </span>
                <MonoText>{message.toEmail}</MonoText>
                <DeliveryLifecycle
                  status={message.deliveryStatus}
                  timezone={timezone}
                  updatedAt={message.deliveryUpdatedAt}
                />
              </div>
              <span style={sentAt}>
                {formatDateTime(message.sentAt, timezone)}
              </span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--space-4)',
  padding: 'var(--space-3) var(--space-5)',
  borderTop: 'var(--space-px) solid var(--border-subtle)',
}

const sentAt: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--text-tertiary)',
  whiteSpace: 'nowrap',
}
