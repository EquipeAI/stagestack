import { createFileRoute } from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { useSuspenseQuery } from '@tanstack/react-query'
import { api } from '@convex/_generated/api'
import {
  AgendaSection,
  LineupSection,
  PoweredBy,
} from '~/components/public/ProgramView'

// A minimal, iframe-friendly view of ONE published section, for embedding on an
// external site. No app nav, no hero — just the lineup or the agenda plus a
// tiny credit. `?section=lineup|agenda` (default lineup). Reuses the exact same
// public components so an embed can never show anything the page wouldn't.

type EmbedSearch = { section: 'lineup' | 'agenda' }

export const Route = createFileRoute('/embed/$slug')({
  validateSearch: (search: Record<string, unknown>): EmbedSearch => ({
    section: search.section === 'agenda' ? 'agenda' : 'lineup',
  }),
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      convexQuery(api.publish.publicProgram, { slug: params.slug }),
    )
    return null
  },
  head: () => ({ meta: [{ name: 'robots', content: 'noindex' }] }),
  component: EmbedPage,
})

function EmbedPage() {
  const { slug } = Route.useParams()
  const { section } = Route.useSearch()
  const { data } = useSuspenseQuery(
    convexQuery(api.publish.publicProgram, { slug }),
  )
  const program = data

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
        padding: 'var(--space-6)',
        background: 'transparent',
      }}
    >
      <div style={{ flex: 1, minHeight: 0 }}>
        {program === null ? (
          <p style={{ font: 'var(--type-body)', color: 'var(--text-tertiary)' }}>
            This program isn't published yet.
          </p>
        ) : section === 'agenda' ? (
          <AgendaSection
            agenda={program.agenda}
            timezone={program.event.timezone}
          />
        ) : (
          <LineupSection lineup={program.lineup} />
        )}
      </div>
      <div style={{ flex: 'none', display: 'flex', justifyContent: 'flex-end' }}>
        <PoweredBy compact />
      </div>
    </div>
  )
}
