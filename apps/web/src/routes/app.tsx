import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { UserButton } from '@clerk/tanstack-react-start'
import { Logo } from '~/ds'
import { AuthGate } from '~/components/AuthGate'
import { ToastViewport } from '~/components/toast'

export const Route = createFileRoute('/app')({
  // The whole /app/** subtree is behind AuthGate, so a crawler only ever gets
  // the sign-in shell — noindex at the subtree root instead of on every child.
  head: () => ({ meta: [{ name: 'robots', content: 'noindex' }] }),
  component: AppLayout,
})

function AppLayout() {
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
        <Link to="/app" style={{ display: 'flex', alignItems: 'center' }}>
          <Logo size={18} />
        </Link>
        <div style={{ flex: 1 }} />
        <UserButton />
      </header>
      <main style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <AuthGate>
          <Outlet />
        </AuthGate>
      </main>
      <ToastViewport />
    </div>
  )
}
