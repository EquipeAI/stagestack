import { Link, createFileRoute } from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { useSuspenseQuery } from '@tanstack/react-query'
import { api } from '@convex/_generated/api'
import type * as React from 'react'
import type { PublicProgram } from '@convex/model/publish'
import { EmptyState, Logo, Tabs } from '~/ds'
import { EventHero, PoweredBy } from '~/components/public/ProgramView'
import { AgendaGrid } from '~/components/public/widgets/AgendaGrid'
import { Itinerary } from '~/components/public/widgets/Itinerary'
import { SessionsCatalog } from '~/components/public/widgets/SessionsCatalog'
import { SpeakerGallery } from '~/components/public/widgets/SpeakerGallery'
import { SpeakersDirectory } from '~/components/public/widgets/SpeakersDirectory'
import { siteOrigin } from '~/lib/origin'

// The public event page: /e/<slug>. Unauthenticated and SSR-first — it is the
// shareable URL judges (and attendees) open, so the program is fetched in the
// loader so the HTML and its link-preview <meta> are populated server-side.
// The served blob is already privacy-filtered by the backend; this route adds
// zero authorization and touches no private data.
//
// The body is the five public widgets behind a section nav; the active section
// lives in `?view=` so /e/<slug>?view=speakers is a shareable deep link. The
// widgets are client-interactive but render full initial HTML from the
// server-loaded program, so SSR keeps working.

const VIEWS = [
  'sessions',
  'speakers',
  'agenda',
  'itinerary',
  'gallery',
] as const
type ViewId = (typeof VIEWS)[number]

type PublicSearch = { view?: ViewId }

function parseSearch(input: Record<string, unknown>): PublicSearch {
  const raw = input.view
  return typeof raw === 'string' &&
    (VIEWS as ReadonlyArray<string>).includes(raw) &&
    raw !== 'sessions'
    ? { view: raw as ViewId }
    : {}
}

export const Route = createFileRoute('/e/$slug')({
  validateSearch: parseSearch,
  loader: async ({ context, params }) => {
    const program = await context.queryClient.ensureQueryData(
      convexQuery(api.publish.publicProgram, { slug: params.slug }),
    )
    return { program }
  },
  head: ({ loaderData, params }) => {
    const program = loaderData?.program ?? null
    if (program === null) {
      return { meta: [{ title: `Event — StageStack` }] }
    }
    const { event } = program
    const description =
      event.description !== undefined
        ? event.description.slice(0, 200)
        : `The program for ${event.name}.`
    const title = `${event.name} — StageStack`
    // og:url has to be the origin this page was actually served from — a
    // self-hosted install or a preview deployment must not advertise the
    // production host. siteOrigin() is the one helper that knows: this `head`
    // runs during SSR, where it reads the request's (forwarded) host.
    const url = `${siteOrigin()}/e/${params.slug}`
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:type', content: 'website' },
        { property: 'og:title', content: event.name },
        { property: 'og:description', content: description },
        { property: 'og:url', content: url },
        ...(event.logoUrl !== undefined
          ? [{ property: 'og:image', content: event.logoUrl }]
          : []),
        { name: 'twitter:card', content: 'summary' },
        { name: 'twitter:title', content: event.name },
        { name: 'twitter:description', content: description },
      ],
    }
  },
  component: PublicEventPage,
})

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-canvas)',
      }}
    >
      <header
        style={{
          height: 'var(--topbar-height)',
          flex: 'none',
          position: 'sticky',
          top: 0,
          zIndex: 'var(--z-sticky)',
          display: 'flex',
          alignItems: 'center',
          padding: 'var(--space-0) var(--page-gutter)',
          background: 'var(--surface-card)',
          borderBottom: 'var(--space-px) solid var(--border-default)',
        }}
      >
        <Link to="/" style={{ display: 'flex', alignItems: 'center' }}>
          <Logo size={18} />
        </Link>
      </header>
      <main style={{ flex: 1, minHeight: 0 }}>{children}</main>
      <footer
        style={{
          flex: 'none',
          padding: 'var(--space-6) var(--page-gutter)',
          borderTop: 'var(--space-px) solid var(--border-default)',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <PoweredBy />
      </footer>
    </div>
  )
}

function ProgramBody({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: 'var(--content-max)',
        margin: '0 auto',
        padding: 'var(--space-12) var(--page-gutter)',
      }}
    >
      {children}
    </div>
  )
}

function PublicEventPage() {
  const { slug } = Route.useParams()
  const { data: program } = useSuspenseQuery(
    convexQuery(api.publish.publicProgram, { slug }),
  )

  if (program === null) {
    return (
      <PublicShell>
        <ProgramBody>
          <div style={{ padding: 'var(--space-16) var(--space-0)' }}>
            <EmptyState
              icon="globe"
              title="This event's program isn't published yet"
              description={
                <span>
                  When the organizer publishes it, the lineup and schedule
                  appear here at{' '}
                  <span
                    style={{
                      font: 'var(--type-mono)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    /e/{slug}
                  </span>
                  .
                </span>
              }
            />
          </div>
        </ProgramBody>
      </PublicShell>
    )
  }

  return (
    <PublicShell>
      <ProgramBody>
        <ProgramWidgets program={program} />
      </ProgramBody>
    </PublicShell>
  )
}

// ── widget nav ────────────────────────────────────────────────────────────
function ProgramWidgets({ program }: { program: PublicProgram }) {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  // Agenda-shaped views only exist once the agenda is actually published and
  // has entries — a lineup-only event shows Sessions / Speakers / Gallery.
  const hasAgenda = program.agendaPublished && program.agenda.length > 0
  const tabs = [
    { id: 'sessions', label: 'Sessions', icon: 'presentation' },
    { id: 'speakers', label: 'Speakers', icon: 'users' },
    ...(hasAgenda
      ? [
          { id: 'agenda', label: 'Agenda', icon: 'calendar-days' },
          { id: 'itinerary', label: 'Itinerary', icon: 'list-checks' },
        ]
      : []),
    { id: 'gallery', label: 'Gallery', icon: 'layout-grid' },
  ]

  const requested = search.view ?? 'sessions'
  const view: ViewId = tabs.some((t) => t.id === requested)
    ? requested
    : 'sessions'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-8)',
      }}
    >
      <EventHero event={program.event} />
      <div
        style={{
          position: 'sticky',
          top: 'var(--topbar-height)',
          zIndex: 'var(--z-sticky)',
          background: 'var(--surface-canvas)',
          margin: 'var(--space-0) calc(-1 * var(--space-2))',
          padding: 'var(--space-2) var(--space-2) var(--space-0)',
        }}
      >
        <Tabs
          tabs={tabs}
          value={view}
          onChange={(id) =>
            void navigate({
              search: id === 'sessions' ? {} : { view: id as ViewId },
              replace: true,
              resetScroll: false,
            })
          }
        />
      </div>
      {view === 'sessions' ? <SessionsCatalog program={program} /> : null}
      {view === 'speakers' ? <SpeakersDirectory program={program} /> : null}
      {view === 'agenda' ? <AgendaGrid program={program} /> : null}
      {view === 'itinerary' ? <Itinerary program={program} /> : null}
      {view === 'gallery' ? <SpeakerGallery program={program} /> : null}
    </div>
  )
}
