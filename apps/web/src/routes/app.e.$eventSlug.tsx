import { useCallback, useEffect, useState } from 'react'
import {
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Attention, NavItem, TabId } from '~/components/shell/nav'
import {
  Badge,
  Button,
  Callout,
  NavDrawer,
  PageHeader,
  SidebarNav,
} from '~/ds'
import { PageBody } from '~/components/PageBody'
import { errorCode, errorMessage } from '~/lib/errors'
import { formatDateRange } from '~/lib/datetime'
import { rememberLastEventSlug } from '~/lib/lastEvent'
import { AttentionCounts } from '~/components/shell/AttentionCounts'
import {
  EventHeaderProvider,
  useEventHeader,
} from '~/components/shell/EventHeader'
import {
  DECISIONS_SEARCH,
  NAV_GROUPS,
  TAB_PATHS,
  activeNavId,
  attentionSummary,
  countHint,
  formatCount,
  groupOf,
  itemOf,
} from '~/components/shell/nav'

// The event shell. It owns three things and delegates the rest:
//   · the navigation rail (desktop) and drawer (phone), both rendered from the
//     one lifecycle grouping in components/shell/nav.ts;
//   · one subscription to the cheap attention counts, feeding both;
//   · one route-aware header, so a deeper route contributes a crumb and a
//     title instead of stacking a second sticky header (W9 consumes this).

export const Route = createFileRoute('/app/e/$eventSlug')({
  component: EventLayout,
  errorComponent: EventError,
})

function EventLayout() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })
  const navigate = useNavigate()
  const pathname = useLocation({ select: (l) => l.pathname })
  // Only the one param the rail reads. Selecting the whole search object would
  // re-render the shell on every table sort and keystroke.
  //
  // `strict: false` rather than a cast (S4): this shell has no search schema of
  // its own — `status` belongs to the proposals child route, whose parser is
  // `parseProposalsSearch` in convex/shared/viewParams.ts. Non-strict useSearch
  // types the result from the router's registered routes, so `status` is
  // `string | undefined` because that route says so, and the day the parser
  // drops or renames the param this line stops compiling instead of silently
  // reading undefined.
  const status = useSearch({ strict: false, select: (s) => s.status })

  // /app opens whatever event you were last in. Only record it once the event
  // actually loaded, so a stale or forbidden slug in the URL is not the thing
  // this browser returns to.
  const loaded = data !== undefined
  useEffect(() => {
    if (loaded) rememberLastEventSlug(eventSlug)
  }, [loaded, eventSlug])

  const [attention, setAttention] = useState<Attention | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Close on ANY route change, not only ones that came through go():
  // browser Back/Forward and programmatic navigation must not leave the
  // drawer floating over a page it no longer describes.
  useEffect(() => {
    setDrawerOpen(false)
  }, [pathname])

  // A stable callback: the probe reports through an effect, and an inline
  // function here would make that effect fire on every render.
  const onAttention = useCallback((value: Attention | null) => {
    setAttention(value)
  }, [])

  const activeId = activeNavId(pathname, eventSlug, { status })

  const groups = NAV_GROUPS.map((group) => ({
    label: group.label,
    // Role-gated entries stay hidden until the role is known, so a reviewer
    // never sees an organizer tab flash on load.
    items: group.items
      .filter(
        (item) => item.requires === undefined || data?.role === item.requires,
      )
      .map((item) => decorate(item, attention)),
  })).filter((group) => group.items.length > 0)

  const go = (id: string) => {
    setDrawerOpen(false)
    // Decisions is a saved view of Proposals, not a route: one navigation, to
    // the proposals path, carrying the staged-queue filter its own
    // validateSearch already accepts.
    if (id === 'decisions') {
      void navigate({
        to: TAB_PATHS.proposals,
        params: { eventSlug },
        search: DECISIONS_SEARCH,
      })
      return
    }
    const to = id in TAB_PATHS ? TAB_PATHS[id as TabId] : TAB_PATHS.overview
    void navigate({ to, params: { eventSlug } })
  }

  const eventName = data === undefined ? 'Loading…' : data.event.name

  return (
    // Classes, not inline styles: the shell flips from "rail beside content"
    // to "menu button above content" at 860px, and a media query cannot reach
    // a style attribute. See .app-shell in styles/app.css.
    <div className="app-shell">
      <AttentionCounts
        eventSlug={eventSlug}
        enabled={data?.role === 'organizer'}
        onData={onAttention}
      />

      <div className="app-shell__nav">
        <SidebarNav
          header={
            <span
              style={{
                font: 'var(--type-label)',
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {eventName}
            </span>
          }
          groups={groups}
          activeId={activeId}
          onSelect={go}
        />
      </div>

      <div className="app-shell__main">
        {/* Below 860px this bar replaces the rail entirely — see the note on
            .app-shell__nav. It answers "where am I" without opening anything,
            and the button's accessible name carries the attention total so the
            drawer is worth opening (or not). */}
        <div className="app-shell__bar">
          <Button
            iconLeft="menu"
            size="sm"
            aria-label={attentionSummary(attention)}
            aria-expanded={drawerOpen}
            // Set only while the drawer exists — it unmounts when closed, and
            // aria-controls must not point at nothing.
            aria-controls={drawerOpen ? 'event-nav-drawer' : undefined}
            onClick={() => {
              setDrawerOpen(true)
            }}
          >
            Menu
          </Button>
          <span className="app-shell__where">
            {groupOf(activeId) ?? 'Setup'} ·{' '}
            <strong>{itemOf(activeId)?.label ?? 'Overview'}</strong>
          </span>
        </div>

        <NavDrawer
          open={drawerOpen}
          id="event-nav-drawer"
          title={eventName}
          groups={groups}
          activeId={activeId}
          onSelect={go}
          onClose={() => {
            setDrawerOpen(false)
          }}
        />

        <PageBody>
          {data === undefined ? (
            <p style={{ color: 'var(--text-tertiary)' }}>Loading event…</p>
          ) : (
            <EventHeaderProvider>
              <EventChrome
                eventSlug={eventSlug}
                event={data.event}
                org={data.org}
                role={data.role}
              />
            </EventHeaderProvider>
          )}
        </PageBody>
      </div>
    </div>
  )
}

/** A count is a badge only when it is worth being one — see `formatCount`. */
function decorate(item: NavItem, attention: Attention | null) {
  const value =
    item.attention === undefined || attention === null
      ? undefined
      : attention.counts[item.attention]
  const capped = attention?.capped === true
  return {
    id: item.id,
    label: item.label,
    icon: item.icon,
    alias: item.alias,
    count: formatCount(value, capped),
    countHint: countHint(value, capped),
  }
}

type EventData = {
  eventSlug: string
  event: {
    name: string
    startsAt: number
    endsAt: number
    timezone: string
    archivedAt?: number
  }
  org: { name: string; slug: string }
  role: string
}

/**
 * The header and the outlet, inside the header provider — so a child route's
 * `useEventHeaderSlot` is read by the same render that draws the header.
 */
function EventChrome({ eventSlug, event, org, role }: EventData) {
  const slot = useEventHeader()
  const deeper = slot !== null

  return (
    <>
      <PageHeader
        title={slot?.title ?? event.name}
        breadcrumbs={[
          { label: 'My StageStack', href: '/app/home' },
          { label: org.name, href: `/app/org/${org.slug}` },
          // The event stops being the last crumb once a route contributes its
          // own, so it becomes the link back up to the event home.
          deeper
            ? { label: event.name, href: `/app/e/${eventSlug}` }
            : { label: event.name },
          ...(slot?.crumbs ?? []),
        ]}
        description={
          slot?.description ??
          formatDateRange(event.startsAt, event.endsAt, event.timezone)
        }
        actions={slot?.actions}
        meta={
          <span style={{ marginLeft: 'var(--space-3)' }}>
            <Badge tone={role === 'organizer' ? 'info' : 'neutral'}>
              {role === 'organizer' ? 'Organizer' : 'Reviewer'}
            </Badge>
          </span>
        }
      />
      {event.archivedAt !== undefined ? (
        <Callout tone="attention" title="This event is archived">
          Archived events are read-only in spirit — nothing is deleted, and you
          can unarchive it from Event details.
        </Callout>
      ) : null}
      <Outlet />
    </>
  )
}

function EventError({ error }: { error: Error }) {
  const code = errorCode(error)
  return (
    <PageBody narrow>
      <Callout
        tone="blocked"
        title={
          code === 'not_found' ? 'No such event' : 'You cannot open this event'
        }
      >
        {errorMessage(error)}
      </Callout>
    </PageBody>
  )
}
