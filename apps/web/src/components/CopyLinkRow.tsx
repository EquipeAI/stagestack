import { Button } from '~/ds'
import { copyToClipboard } from '~/lib/clipboard'

// One row shape for every URL an organizer hands to somebody else — the public
// program links, the CFP link, the embed API. Mono, selectable, one copy
// button: the design system fixes mono for anything a person has to copy.

export function CopyLinkRow({
  label,
  value,
  toast,
}: {
  label: string
  value: string
  toast: string
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          font: 'var(--type-eyebrow)',
          letterSpacing: 'var(--tracking-caps)',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
          minWidth: 'var(--space-16)',
        }}
      >
        {label}
      </span>
      <code
        style={{
          font: 'var(--type-mono)',
          color: 'var(--text-secondary)',
          background: 'var(--surface-sunken)',
          padding: 'var(--space-1) var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}
      >
        {value || '—'}
      </code>
      <Button
        variant="secondary"
        size="sm"
        iconLeft="copy"
        onClick={() => void copyToClipboard(value, toast)}
        disabled={value === ''}
      >
        Copy
      </Button>
    </div>
  )
}
