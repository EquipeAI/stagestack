import { createFileRoute } from '@tanstack/react-router'
import { convexQuery } from '@convex-dev/react-query'
import { useSuspenseQuery } from '@tanstack/react-query'
import { api } from '@convex/_generated/api'
import type { PublicEmbed } from '@convex/model/embeds'
import { Icon } from '~/ds'
import { PoweredBy } from '~/components/public/ProgramView'
import { AgendaGrid } from '~/components/public/widgets/AgendaGrid'
import { Itinerary } from '~/components/public/widgets/Itinerary'
import { SessionsCatalog } from '~/components/public/widgets/SessionsCatalog'
import { SpeakerGallery } from '~/components/public/widgets/SpeakerGallery'
import { SpeakersDirectory } from '~/components/public/widgets/SpeakersDirectory'

// /embed/w/<id> — one configured widget for embedding on an external site.
// The anonymous `embeds.resolve` read serves only already-published data with
// the embed's own filters (track, hidden fields) applied server-side, so this
// route can never show more than the public page would. No site chrome — just
// the widget plus a tiny credit. Unknown or disabled ids render a neutral
// card instead of an error.

export const Route = createFileRoute('/embed/w/$embedId')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      convexQuery(api.embeds.resolve, { embedId: params.embedId }),
    )
    return null
  },
  head: () => ({ meta: [{ name: 'robots', content: 'noindex' }] }),
  component: EmbedWidgetPage,
})

function WidgetBody({ embed }: { embed: PublicEmbed }) {
  const accent = embed.config.brandColor
  switch (embed.widget) {
    case 'sessions':
      return <SessionsCatalog program={embed.program} accent={accent} />
    case 'speakers':
      return <SpeakersDirectory program={embed.program} accent={accent} />
    case 'agenda':
      return <AgendaGrid program={embed.program} accent={accent} />
    case 'itinerary':
      return <Itinerary program={embed.program} accent={accent} />
    case 'gallery':
      return <SpeakerGallery program={embed.program} accent={accent} />
  }
}

function NotAvailable() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-10) var(--space-6)',
        background: 'var(--surface-card)',
        border: 'var(--space-px) solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        color: 'var(--text-tertiary)',
      }}
    >
      <Icon name="eye-off" size={24} />
      <p
        style={{
          font: 'var(--type-body)',
          color: 'var(--text-secondary)',
          margin: 'var(--space-0)',
        }}
      >
        This embed is not available.
      </p>
    </div>
  )
}

function EmbedWidgetPage() {
  const { embedId } = Route.useParams()
  const { data } = useSuspenseQuery(
    convexQuery(api.embeds.resolve, { embedId }),
  )
  // `resolve` is validated as v.any() on the wire; the model layer guarantees
  // this shape (or null for unknown/disabled ids).
  const embed: PublicEmbed | null = data

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
        {embed === null ? <NotAvailable /> : <WidgetBody embed={embed} />}
      </div>
      <div
        style={{ flex: 'none', display: 'flex', justifyContent: 'flex-end' }}
      >
        <PoweredBy />
      </div>
    </div>
  )
}
