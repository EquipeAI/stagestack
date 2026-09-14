import type * as React from 'react'

// Shared bits of comms typography. Keys and addresses are mono because the
// design system fixes mono for anything a person has to copy or match
// character-for-character. (Merge tokens moved to TokenPalette, where they are
// buttons rather than labels.)

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
