import type * as React from 'react'

// A segmented control: one click (or one keystroke) per decision. Built from
// plain buttons because the design system's RadioGroup is a stacked list —
// too tall and too slow for the single-screen review flow. Selection uses the
// system's selected treatment: amber tint plus an amber edge.

export type SegmentedOption = {
  value: string
  label: string
  /** Second line, e.g. the shortcut key or what the value means. */
  hint?: string
}

export function Segmented({
  name,
  options,
  value,
  onChange,
  disabled = false,
}: {
  /** Used for the group's accessible name and for option ids. */
  name: string
  options: ReadonlyArray<SegmentedOption>
  value: string | null
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div
      role="group"
      aria-label={name}
      style={{
        display: 'flex',
        gap: 'var(--space-2)',
        alignItems: 'stretch',
      }}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => {
              onChange(option.value)
            }}
            style={segmentStyle(selected, disabled)}
          >
            <span
              style={{
                font: 'var(--type-label)',
                fontWeight: selected
                  ? 'var(--weight-semibold)'
                  : 'var(--weight-medium)',
              }}
            >
              {option.label}
            </span>
            {option.hint === undefined ? null : (
              <span
                style={{
                  font: 'var(--type-caption)',
                  color: 'var(--text-tertiary)',
                }}
              >
                {option.hint}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function segmentStyle(
  selected: boolean,
  disabled: boolean,
): React.CSSProperties {
  return {
    flex: '1 1 0',
    minWidth: 'var(--space-10)',
    minHeight: 'var(--row-height-lg)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-half)',
    padding: 'var(--pad-control-y) var(--space-2)',
    borderRadius: 'var(--radius-control)',
    border: `var(--space-px) solid ${
      selected ? 'var(--border-brand)' : 'var(--border-default)'
    }`,
    background: selected ? 'var(--surface-selected)' : 'var(--surface-card)',
    color: 'var(--text-primary)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    transition: 'var(--transition-control)',
  }
}
