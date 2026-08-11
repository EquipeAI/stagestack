import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { Callout, Tabs } from '~/ds'
import { LogPanel } from '~/components/comms/LogPanel'
import { SendPanel } from '~/components/comms/SendPanel'
import { TemplatesPanel } from '~/components/comms/TemplatesPanel'
import { QueryBoundary } from '~/components/QueryBoundary'
import { formatDateTime } from '~/lib/datetime'

export const Route = createFileRoute('/app/e/$eventSlug/comms')({
  component: CommsRoute,
})

// Communications (M5). Three questions in one place: what does StageStack say
// on our behalf, who can we reach right now, and what has this person already
// been sent.

function CommsRoute() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })
  const [tab, setTab] = useState('templates')

  if (data === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading communications…</p>
  }

  if (data.role !== 'organizer') {
    return (
      <Callout tone="blocked" title="Communications are organizer-only">
        You have reviewer access to this event. What StageStack sends speakers
        is operational data, so it is not shown to reviewers.
      </Callout>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <DeliveryHealthBanner eventSlug={eventSlug} timezone={data.event.timezone} />
      <Tabs
        variant="underline"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'templates', label: 'Templates', icon: 'file-text' },
          { id: 'send', label: 'Send', icon: 'mail' },
          { id: 'log', label: 'Log', icon: 'inbox' },
        ]}
      />
      <QueryBoundary resetKey={tab} title="This could not be loaded">
        {tab === 'templates' ? (
          <TemplatesPanel eventSlug={eventSlug} eventName={data.event.name} />
        ) : tab === 'send' ? (
          <SendPanel eventSlug={eventSlug} eventName={data.event.name} />
        ) : (
          <LogPanel eventSlug={eventSlug} timezone={data.event.timezone} />
        )}
      </QueryBoundary>
    </div>
  )
}

// A refused send still commits whatever triggered it (a submission, an invite),
// so the sender-side screens all said "sent" while nothing left the building —
// the Aug 2026 eval flagged exactly this (CFP-08). Failures here are almost
// always deployment mail config (Resend API key, RESEND_TEST_MODE), so the
// banner names that cause instead of asking the organizer to guess.
function DeliveryHealthBanner({
  eventSlug,
  timezone,
}: {
  eventSlug: string
  timezone: string
}) {
  const health = useQuery(api.comms.deliveryHealth, { eventSlug })
  if (health === undefined || health.failed === 0) return null
  const scope =
    health.failed === health.scanned
      ? `All ${health.scanned} of this event's most recent emails`
      : `${health.failed} of this event's last ${health.scanned} emails`
  return (
    <Callout tone="blocked" title="Emails are failing to send">
      {scope} were refused by the mail service and never reached anyone
      {health.lastFailedAt === null
        ? '.'
        : ` — most recently ${formatDateTime(health.lastFailedAt, timezone)}.`}{' '}
      This usually means the deployment's mail settings are wrong: a missing or
      invalid Resend API key, or test mode refusing real recipients. Each
      failed message is recorded in the Log tab; fixing the configuration does
      not re-send them.
    </Callout>
  )
}
