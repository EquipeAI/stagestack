import { createFileRoute } from '@tanstack/react-router'
import { AppHome } from '~/components/AppHome'

// The cross-organization home. /app redirects into your last event, so this is
// the stable address for "show me everything I'm part of" — the switcher and
// every breadcrumb point here.

export const Route = createFileRoute('/app/home')({
  component: AppHome,
})
