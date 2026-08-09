import { Link, createFileRoute } from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { useSuspenseQuery } from '@tanstack/react-query'
import { api } from '@convex/_generated/api'
import type * as React from 'react'
import { EmptyState, Logo } from '~/ds'
import { PoweredBy, ProgramView } from '~/components/public/ProgramView'

// The public event page: /e/<slug>. Unauthenticated and SSR-first — it is the
// shareable URL judges (and attendees) open, so the program is fetched in the
// loader so the HTML and its link-preview <meta> are populated server-side.
// The served blob is already privacy-filtered by the backend; this route adds
// zero authorization and touches no private data.

export const Route = createFileRoute('/e/$slug')({
  loader: async ({ context, params }) => {
    const program = (await context.queryClient.ensureQueryData(
      convexQuery(api.publish.publicProgram, { slug: params.slug }),
    ))
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
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:type', content: 'website' },
        { property: 'og:title', content: event.name },
        { property: 'og:description', content: description },
        { property: 'og:url', content: `https://stagestack.dev/e/${params.slug}` },
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
                  When the organizer publishes it, the lineup and schedule appear
                  here at{' '}
                  <span style={{ font: 'var(--type-mono)', color: 'var(--text-secondary)' }}>
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
        <ProgramView program={program} />
      </ProgramBody>
    </PublicShell>
  )
}
