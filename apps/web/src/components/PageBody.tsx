import type * as React from 'react'

/** Page gutter + section rhythm, applied once so screens stay on the grid. */
export function PageBody({
  children,
  narrow = false,
}: {
  children: React.ReactNode
  narrow?: boolean
}) {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: narrow ? 'var(--content-max-prose)' : 'var(--content-max)',
        margin: '0 auto',
        padding: 'var(--pad-section) var(--page-gutter)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-8)',
      }}
    >
      {children}
    </div>
  )
}
