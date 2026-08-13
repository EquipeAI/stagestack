import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { Show, UserButton } from '@clerk/tanstack-react-start'
import { Logo } from '~/ds'
import { AuthGate } from '~/components/AuthGate'
import { EventSwitcher } from '~/components/EventSwitcher'
import { GlobalSearch } from '~/components/shell/GlobalSearch'
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
          // Above --z-sticky: the bar hosts the event switcher, and its panel
          // is trapped in this element's stacking context — at --z-sticky the
          // nav rail (same layer, later in the DOM) painted over the menu.
          zIndex: 'var(--z-dropdown)',
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
        <Show when="signed-in">
          <span
            aria-hidden="true"
            style={{ color: 'var(--text-tertiary)', flex: 'none' }}
          >
            /
          </span>
          <EventSwitcher />
        </Show>
        <div style={{ flex: 1 }} />
        {/* Visible, not only ⌘K: the shortcut is for the people who already
            know it, and the button is for everyone else. */}
        <Show when="signed-in">
          <GlobalSearch />
        </Show>
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
