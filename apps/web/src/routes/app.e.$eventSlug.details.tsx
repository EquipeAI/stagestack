import { createFileRoute } from '@tanstack/react-router'
import { EventFacts } from '~/components/event/EventFacts'
import { useEventHeaderSlot } from '~/components/shell/EventHeader'

// Setup → Event details. The stable facts that used to be the event root,
// given their own path when the root became the control center (W7).
//
// Also the first consumer of the route-aware header: it contributes a fourth
// breadcrumb level and its own title, which is the mechanism W9's workspaces
// will use rather than stacking a second sticky header of their own.

export const Route = createFileRoute('/app/e/$eventSlug/details')({
  component: DetailsRoute,
})

function DetailsRoute() {
  const { eventSlug } = Route.useParams()
  useEventHeaderSlot({
    title: 'Event details',
    description: 'What this event is, and where its public links point.',
    crumbs: [{ label: 'Event details' }],
  })
  return <EventFacts eventSlug={eventSlug} />
}
