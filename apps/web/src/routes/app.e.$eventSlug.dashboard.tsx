import { createFileRoute, redirect } from '@tanstack/react-router'

// `/app/e/$eventSlug/dashboard` no longer renders anything: the dashboard IS
// the event root now (W7, decision 5). The path stays, permanently, as a
// redirect — the plan's cross-cutting rule is that every published path keeps
// resolving, never 404s, and this one is the address every organizer bookmark,
// every eval discovery hint and every older screenshot points at.
//
// The redirect is in `beforeLoad`, so it happens before any component or query
// runs: nothing of the old page is ever rendered, and the address bar is
// corrected rather than left showing a URL that no longer describes the page.

export const Route = createFileRoute('/app/e/$eventSlug/dashboard')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/app/e/$eventSlug',
      params: { eventSlug: params.eventSlug },
      // Carry the whole address across: a bookmarked ?filter or #fragment
      // belongs to the destination, not to the retired path.
      search: true,
      hash: true,
      // Not a step in anyone's history: Back from the root should leave the
      // event, not bounce through the old address and forward again.
      replace: true,
    })
  },
})
