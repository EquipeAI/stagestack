import type * as React from 'react'

// Shared bits of comms typography. Keys, template variables and addresses are
// mono because the design system fixes mono for anything a person has to copy
// or match character-for-character.

export function MonoText({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        color: 'var(--text-tertiary)',
        overflowWrap: 'anywhere',
      }}
    >
      {children}
    </span>
  )
}

export function VariableChip({ path }: { path: string }) {
  return (
    <code
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        color: 'var(--text-secondary)',
        background: 'var(--surface-sunken)',
        border: 'var(--space-px) solid var(--border-subtle)',
        borderRadius: 'var(--radius-xs)',
        padding: 'var(--space-half) var(--space-2)',
        whiteSpace: 'nowrap',
      }}
    >
      {`{{${path}}}`}
    </code>
  )
}
