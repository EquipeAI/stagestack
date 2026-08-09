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
          // The bar grows by the top inset so its content clears the notch /
          // status bar, while its background still paints edge to edge under
          // it (viewport-fit=cover). Left/right insets matter in landscape.
          height: 'calc(var(--topbar-height) + var(--safe-top))',
          flex: 'none',
          position: 'sticky',
          top: 0,
          zIndex: 'var(--z-sticky)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)',
          // Longhands throughout: a `padding` shorthand listed after
          // `paddingTop` would silently reset the safe-area inset to 0.
          paddingTop: 'var(--safe-top)',
          paddingBottom: 0,
          paddingLeft: 'calc(var(--page-gutter) + var(--safe-left))',
          paddingRight: 'calc(var(--page-gutter) + var(--safe-right))',
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
