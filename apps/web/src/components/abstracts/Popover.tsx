import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type * as React from 'react'
import { Button } from '~/ds'

// A minimal menu surface: a trigger button plus one absolutely-positioned
// card. The design system ships no Menu/Popover, so this is the one place the
// behaviour is written — Escape closes and returns focus to the trigger, an
// outside pointer-down closes, and the panel itself takes focus on open so the
// keyboard never lands behind it.

export function usePopover() {
  const [open, setOpen] = useState(false)
  return { open, setOpen }
}

export function Popover({
  label,
  icon,
  iconRight,
  variant = 'secondary',
  size = 'sm',
  align = 'end',
  width = '20rem',
  disabled,
  children,
}: {
  label: React.ReactNode
  icon?: string
  iconRight?: string
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md'
  align?: 'start' | 'end'
  width?: string
  disabled?: boolean
  /** Rendered only while open — receives a `close` for its own actions. */
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const panelId = useId()

  const close = useCallback(() => {
    setOpen(false)
    const button = triggerRef.current?.querySelector('button')
    button?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const onPointerDown = (event: MouseEvent) => {
      if (hostRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  return (
    <div
      ref={hostRef}
      style={{ position: 'relative', display: 'inline-flex' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          close()
        }
      }}
    >
      <div ref={triggerRef} style={{ display: 'inline-flex' }}>
        <Button
          variant={variant}
          size={size}
          iconLeft={icon}
          iconRight={iconRight ?? 'chevron-down'}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          {label}
        </Button>
      </div>
      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-label={typeof label === 'string' ? label : undefined}
          tabIndex={-1}
          style={{
            position: 'absolute',
            top: `calc(100% + var(--space-2))`,
            [align === 'end' ? 'right' : 'left']: 0,
            zIndex: 'var(--z-dropdown)',
            width,
            maxWidth: 'calc(100vw - var(--page-gutter) * 2)',
            maxHeight: '70vh',
            overflowY: 'auto',
            background: 'var(--surface-card)',
            border: 'var(--space-px) solid var(--border-default)',
            borderRadius: 'var(--radius-card)',
            boxShadow: 'var(--shadow-lg)',
            padding: 'var(--space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
            textAlign: 'left',
          }}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  )
}

/** A full-width row inside a Popover — the menu-item shape used throughout. */
export function MenuItem({
  children,
  onClick,
  disabled,
  tone = 'default',
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-3)',
        width: '100%',
        minHeight: 'var(--row-height-sm)',
        padding: 'var(--space-1) var(--space-2)',
        borderRadius: 'var(--radius-control)',
        border: 'none',
        background: 'transparent',
        font: 'var(--type-body)',
        color: tone === 'danger' ? 'var(--text-danger)' : 'var(--text-primary)',
        textAlign: 'left',
        cursor: disabled === true ? 'not-allowed' : 'pointer',
        opacity: disabled === true ? 0.45 : 1,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--surface-hover)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </button>
  )
}

/** The uppercase eyebrow that separates groups inside a popover. */
export function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        font: 'var(--type-eyebrow)',
        textTransform: 'uppercase',
        letterSpacing: 'var(--tracking-caps)',
        color: 'var(--text-tertiary)',
        padding: 'var(--space-1) var(--space-2)',
      }}
    >
      {children}
    </span>
  )
}
