import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { Callout, Tabs } from '~/ds'
import { LogPanel } from '~/components/comms/LogPanel'
import { SendPanel } from '~/components/comms/SendPanel'
import { TemplatesPanel } from '~/components/comms/TemplatesPanel'
import { QueryBoundary } from '~/components/QueryBoundary'

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
