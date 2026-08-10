import { useEffect } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Doc } from '@convex/_generated/dataModel'
import { AppHome } from '~/components/AppHome'
import { PageBody } from '~/components/PageBody'
import { readLastEventSlug } from '~/lib/lastEvent'

// /app opens the event this browser was last inside — an organizer works one
// event for weeks, and the organization list was a toll gate on the way there.
// The switcher in the topbar changes event or organization; My StageStack, the
// cross-organization home, keeps its own address at /app/home.
//
// The choice needs the user's events, which only the client can query, so the
// redirect happens after the first render rather than in beforeLoad. Someone
// with no events yet gets the home page in place — it holds the onboarding.

export const Route = createFileRoute('/app/')({
  component: AppEntry,
})

/** Last visited if it still exists, else the newest event this user can open. */
export function pickLandingEvent(
  events: Array<Doc<'events'>>,
  lastSlug: string | null,
): Doc<'events'> | null {
  const live = events.filter((event) => event.archivedAt === undefined)
  const pool = live.length > 0 ? live : events
  if (pool.length === 0) return null
  const remembered = pool.find((event) => event.slug === lastSlug)
  if (remembered !== undefined) return remembered
  return pool.reduce((newest, event) =>
    event._creationTime > newest._creationTime ? event : newest,
  )
}

function AppEntry() {
  const home = useQuery(api.orgs.myHome, {})
  const navigate = useNavigate()
  const events = home?.flatMap((entry) => entry.events)

  // The remembered slug is read inside the effect, never during render: it is
  // browser-only state, and reading it while rendering would make the server
  // and client markup disagree. Render only needs to know whether there is
  // somewhere to go.
  const hasEvent =
    events !== undefined && pickLandingEvent(events, null) !== null

  useEffect(() => {
    if (events === undefined) return
    const landing = pickLandingEvent(events, readLastEventSlug())
    if (landing === null) return
    void navigate({
      to: '/app/e/$eventSlug',
      params: { eventSlug: landing.slug },
      replace: true,
    })
    // Convex hands back a fresh array on every update; the slugs are what
    // matter, so re-running on a same-content array is only a repeat of an
    // already-satisfied navigation.
  }, [events, navigate])

  if (home === undefined) {
    return (
      <PageBody>
        <p style={{ color: 'var(--text-tertiary)' }}>Loading your StageStack…</p>
      </PageBody>
    )
  }
  if (hasEvent) {
    return (
      <PageBody>
        <p style={{ color: 'var(--text-tertiary)' }}>Opening your event…</p>
      </PageBody>
    )
  }
  return <AppHome />
}
