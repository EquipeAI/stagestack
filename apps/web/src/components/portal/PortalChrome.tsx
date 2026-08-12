import { Link } from '@tanstack/react-router'
import { Show, UserButton } from '@clerk/tanstack-react-start'
import type * as React from 'react'
import { Callout, Logo, Tooltip } from '~/ds'
import { ToastViewport } from '~/components/toast'

// Shell and shared furniture for /portal/<eventSlug>. The portal sits outside
// the /app layout on purpose: most people who open it have one job here and
// have never seen the organizer app.

export function PortalShell({ children }: { children: React.ReactNode }) {
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
          padding: 'var(--space-0) var(--page-gutter)',
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
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </main>
      <ToastViewport />
    </div>
  )
}

/** A titled band of cards. Single column at every width — the portal is read
 * on a phone between talks as often as at a desk. */
export function PortalSection({
  title,
  description,
  meta,
  children,
}: {
  title: string
  description?: React.ReactNode
  meta?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <h2
          style={{
            font: 'var(--type-heading)',
            color: 'var(--text-primary)',
            margin: 'var(--space-0)',
          }}
        >
          {title}
        </h2>
        {meta === undefined ? null : (
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--text-tertiary)',
            }}
          >
            {meta}
          </span>
        )}
      </div>
      {description === undefined ? null : (
        <p
          style={{
            font: 'var(--type-body)',
            color: 'var(--text-secondary)',
            margin: 'var(--space-0)',
          }}
        >
          {description}
        </p>
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {children}
      </div>
    </section>
  )
}

/**
 * The organizer's read-only view of someone else's portal. Amber is the
 * system's attention colour and this banner never scrolls away: a preview must
 * never be mistaken for the real thing.
 */
export function PreviewBanner({
  contactName,
  eventSlug,
}: {
  contactName: string
  eventSlug: string
}) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 'var(--topbar-height)',
        zIndex: 'var(--z-sticky)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        flexWrap: 'wrap',
        padding: 'var(--space-3) var(--page-gutter)',
        background: 'var(--status-brand-bg)',
        color: 'var(--status-brand-fg)',
        borderBottom: 'var(--space-px) solid var(--border-brand)',
        font: 'var(--type-body)',
      }}
    >
      <span>
        Previewing the portal as <strong>{contactName}</strong> — actions are
        disabled.
      </span>
      <Link
        to="/app/e/$eventSlug/sessions"
        params={{ eventSlug }}
        style={{ marginLeft: 'auto', color: 'inherit' }}
      >
        Exit preview
      </Link>
    </div>
  )
}

/** Wraps a disabled control so hovering says why it cannot be used. */
export function PreviewLock({ children }: { children: React.ReactNode }) {
  return <Tooltip label="Disabled in preview">{children}</Tooltip>
}

/** The message the backend wrote, shown where the action was attempted. */
export function ActionError({ error }: { error: string | null }) {
  if (error === null) return null
  // Mounted only on failure, so `alert` (assertive) is right: the user has to
  // hear why the action did not take before trying it again.
  return (
    <Callout tone="blocked" role="alert">
      {error}
    </Callout>
  )
}

/** Two-up on a desktop, stacked on a phone. */
export function FieldRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
        gap: 'var(--space-4)',
      }}
    >
      {children}
    </div>
  )
}

/** A row of buttons that wraps instead of overflowing at 375px. */
export function ButtonRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      {children}
    </div>
  )
}
