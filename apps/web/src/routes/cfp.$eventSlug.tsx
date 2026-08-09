import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { Show, UserButton } from '@clerk/tanstack-react-start'
import { Logo } from '~/ds'
import { ToastViewport } from '~/components/toast'

// The public submitter surface: /cfp/<eventSlug> and everything under it.
// Deliberately outside the /app layout — most people who land here have never
// seen StageStack and may not be signed in.

export const Route = createFileRoute('/cfp/$eventSlug')({
  component: CfpLayout,
})

function CfpLayout() {
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
          gap: 'var(--space-4)',
          padding: '0 var(--page-gutter)',
          background: 'var(--surface-card)',
          borderBottom: 'var(--space-px) solid var(--border-default)',
        }}
      >
        <Link to="/" style={{ display: 'flex', alignItems: 'center' }}>
          <Logo size={18} />
        </Link>
        <div style={{ flex: 1 }} />
        <Show when="signed-in">
          <UserButton />
        </Show>
      </header>
      <main
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <Outlet />
      </main>
      <ToastViewport />
    </div>
  )
}
