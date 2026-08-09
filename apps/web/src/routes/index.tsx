import { createFileRoute } from '@tanstack/react-router'
import { Landing } from '~/components/marketing/Landing'
import { siteOrigin } from '~/lib/origin'

// The stagestack.dev homepage — public, SSR-first, no data dependencies.

const TITLE = 'StageStack — Speaker & content management for events'
const DESCRIPTION =
  'Open source event content, speaker and abstract management: call for speakers, review, speaker operations, agenda — and the published program that comes out the other end. Not another registration platform.'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: 'description', content: DESCRIPTION },
      { property: 'og:type', content: 'website' },
      { property: 'og:title', content: TITLE },
      { property: 'og:description', content: DESCRIPTION },
      // Crawlers read this out of the SSR'd HTML, so it has to name the host
      // they actually fetched — a self-host must not point shares at the
      // hosted product. siteOrigin() derives it from the request.
      { property: 'og:url', content: siteOrigin() },
      { name: 'twitter:card', content: 'summary' },
      { name: 'twitter:title', content: TITLE },
      { name: 'twitter:description', content: DESCRIPTION },
    ],
  }),
  component: Landing,
})
