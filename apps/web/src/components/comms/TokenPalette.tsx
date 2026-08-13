import { useCallback, useState, useSyncExternalStore } from 'react'
import {
  TEMPLATE_VAR_CATALOG,
  tokenFor,
  varsForContext,
} from '@convex/shared/templateVars'
import type * as React from 'react'
import { Button, Dialog } from '~/ds'

// The merge-token palette (W3).
//
// Two things this must not do. It must not offer a token the template's send
// site does not pass — the list comes from `varsForContext`, the same map the
// server renders against, so the palette cannot promise a personalisation the
// send never makes. And it must not take the organizer's place in the text:
// inserting puts the token at the caret and hands focus straight back, caret
// after the token, so typing continues where it left off.

/** Below this the DS Dialog is a bottom sheet, so the palette becomes one. */
const SHEET_BREAKPOINT = 640

/** `matchMedia` is absent under SSR and in some test environments, where its
 * absence reads as "not narrow" rather than throwing. */
function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

function useNarrow(maxWidth: number): boolean {
  const query = `(max-width: ${maxWidth}px)`
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!hasMatchMedia()) return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', notify)
      return () => {
        list.removeEventListener('change', notify)
      }
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => (hasMatchMedia() ? window.matchMedia(query).matches : false),
    () => false,
  )
}

export type TokenTarget = HTMLInputElement | HTMLTextAreaElement | null

/**
 * Insert `token` at the caret of `field`, then return focus with the caret
 * after what was inserted.
 *
 * `setRangeText` writes into the DOM node FIRST, which is what makes the caret
 * survive: setting React state and then calling `setSelectionRange` puts the
 * caret into the old, shorter value and the browser clamps it to the end. With
 * the element already carrying the new text, React's re-render is a no-op on
 * the value and leaves the selection where it was put.
 */
export function insertAtCursor(
  field: TokenTarget,
  token: string,
  onChange: (value: string) => void,
): void {
  if (field === null) return
  const start = field.selectionStart ?? field.value.length
  const end = field.selectionEnd ?? start
  field.focus()
  field.setRangeText(token, start, end, 'end')
  onChange(field.value)
}

/**
 * The field the palette writes into, by id.
 *
 * By id rather than by ref because the DS form controls are vendored and their
 * published types take no `ref` — reaching for the element the editor already
 * labels with `htmlFor` is honest, and does not fork the design system.
 */
export function fieldById(id: string): TokenTarget {
  if (typeof document === 'undefined') return null
  const element = document.getElementById(id)
  return element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
    ? element
    : null
}

function TokenButtons({
  paths,
  disabled,
  onInsert,
}: {
  paths: ReadonlyArray<string>
  disabled?: boolean
  onInsert: (path: string) => void
}) {
  return (
    <div style={buttonWrap}>
      {paths.map((path) => (
        <button
          key={path}
          type="button"
          disabled={disabled}
          // The visible text is the token; the accessible name says what
          // pressing it does, which the token alone never does.
          aria-label={`Insert ${TEMPLATE_VAR_CATALOG[path].label} token`}
          style={tokenButton}
          onClick={() => {
            onInsert(path)
          }}
        >
          {tokenFor(path)}
        </button>
      ))}
    </div>
  )
}

/**
 * `contextKey` is the template key (or `manual.oneoff`), and it decides the
 * list — a decision email offers no speaker name because a decision send
 * passes none.
 */
export function TokenPalette({
  contextKey,
  targetLabel,
  disabled,
  onInsert,
}: {
  contextKey: string
  /** Which field the tokens land in, said out loud. */
  targetLabel: string
  disabled?: boolean
  onInsert: (path: string) => void
}) {
  const narrow = useNarrow(SHEET_BREAKPOINT)
  const [sheetOpen, setSheetOpen] = useState(false)
  const paths = varsForContext(contextKey)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <span style={{ font: 'var(--type-label)', color: 'var(--text-secondary)' }}>
        Tokens
      </span>

      {narrow ? (
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => {
            setSheetOpen(true)
          }}
        >
          Insert a token
        </Button>
      ) : (
        <TokenButtons paths={paths} disabled={disabled} onInsert={onInsert} />
      )}

      <p style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
        Inserted into the {targetLabel} at the cursor. Only these have values in
        this message — anything else renders as nothing. Values are escaped
        before they are substituted, so a speaker called{' '}
        <code style={{ fontFamily: 'var(--font-mono)' }}>&lt;script&gt;</code> is
        text, never markup.
      </p>

      {narrow && sheetOpen ? (
        <Dialog
          open
          width={480}
          title="Insert a token"
          description={`Choose one and it lands in the ${targetLabel} at the cursor.`}
          onClose={() => {
            setSheetOpen(false)
          }}
          footer={
            <Button
              onClick={() => {
                setSheetOpen(false)
              }}
            >
              Close
            </Button>
          }
        >
          <TokenButtons
            paths={paths}
            disabled={disabled}
            onInsert={(path) => {
              setSheetOpen(false)
              onInsert(path)
            }}
          />
        </Dialog>
      ) : null}
    </div>
  )
}

const buttonWrap: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-2)',
}

const tokenButton: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  color: 'var(--text-secondary)',
  background: 'var(--surface-sunken)',
  border: 'var(--space-px) solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  padding: 'var(--space-half) var(--space-2)',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}
