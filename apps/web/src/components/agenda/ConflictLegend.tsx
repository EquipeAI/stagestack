import { Badge } from '~/ds'

// Two levels, said plainly (design system: warnings distinguish "blocks" from
// "warns"). A blocker stops a release; a warning never does.

export function ConflictLegend() {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 'var(--space-4)',
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-canvas)',
        border: 'var(--space-px) solid var(--border-default)',
      }}
    >
      <span
        style={{
          font: 'var(--type-eyebrow)',
          letterSpacing: 'var(--tracking-caps)',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
        }}
      >
        Conflicts
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <Badge tone="blocked" dot>
          Blocker
        </Badge>
        <span style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>
          Speaker double-booked or room clash — a release is refused.
        </span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <Badge tone="attention" dot>
          Warning
        </Badge>
        <span style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>
          Same track overlaps — allowed, but worth a look.
        </span>
      </span>
    </div>
  )
}
