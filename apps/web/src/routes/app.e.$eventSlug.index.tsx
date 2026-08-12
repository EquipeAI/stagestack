import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { ControlCenter } from '~/components/dashboard/ControlCenter'
import { EventFacts } from '~/components/event/EventFacts'

// The event root, after the Dashboard/Overview merge (W7, decision 5).
//
// It is role-conditional, not a redirect and not a route swap. The root was
// already a real page that reviewers and speakers could open, while the
// dashboard was `requires: 'organizer'` — so handing the root to the control
// center without a role branch would have given every non-organizer an
// organizer-only refusal as the first thing they see inside an event.
//
//   organizer → the control center (what `/dashboard` used to render)
//   anyone else → the event facts (what this route used to render)
//
// Both surfaces are also reachable by name from the rail: Setup → Overview is
// this route, Setup → Event details is the facts on their own path.

export const Route = createFileRoute('/app/e/$eventSlug/')({
  component: EventRoot,
})

function EventRoot() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })

  // Render nothing role-specific until the role is known, so a reviewer never
  // sees the organizer surface flash — the same rule the rail follows.
  if (data === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading event…</p>
  }

  return data.role === 'organizer' ? (
    <ControlCenter eventSlug={eventSlug} />
  ) : (
    <EventFacts eventSlug={eventSlug} />
  )
}
