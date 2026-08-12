import { useSyncExternalStore } from 'react'
import { Toast } from '~/ds'
import { announce } from '~/lib/announce'

type ToastItem = {
  id: number
  title: string
  description?: string
  icon?: string
}

const EMPTY: Array<ToastItem> = []
let items: Array<ToastItem> = EMPTY
let seq = 0
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id)
  emit()
}

/** Toasts report what happened; they never praise. */
export function pushToast(title: string, description?: string, icon?: string) {
  seq += 1
  const id = seq
  items = [...items, { id, title, description, icon }]
  emit()
  // Spoken through the app's single live region rather than by the toast
  // itself. The viewport mounts and unmounts with the list, so a live region
  // living here would always be inserted WITH its message already inside —
  // which is not reliably announced — and a second region would double up on
  // the root one.
  announce(description === undefined ? title : `${title}. ${description}`)
  if (typeof window !== 'undefined') {
    window.setTimeout(() => dismiss(id), 5000)
  }
}

export function ToastViewport() {
  const list = useSyncExternalStore(
    subscribe,
    () => items,
    () => EMPTY,
  )
  if (list.length === 0) return null
  return (
    <div
      // Pinned to the right on desktop; on a phone it spans the width (see
      // .toast-viewport in feedback.css) because a 300px-min toast inset by a
      // gutter does not fit a 320px screen. The bottom offset clears the iOS
      // home indicator.
      className="toast-viewport"
      style={{
        position: 'fixed',
        right: 'calc(var(--page-gutter) + var(--safe-right))',
        bottom: 'calc(var(--page-gutter) + var(--safe-bottom))',
        left: 'auto',
        zIndex: 'var(--z-toast)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
      }}
      // A container, NOT a live region: pushToast already announced through
      // the root one, and a second would read every toast out twice.
      role="group"
      aria-label="Notifications"
    >
      {list.map((t) => (
        <Toast
          key={t.id}
          // Same reason. `Toast` declares role="status" for standalone use;
          // inside this viewport the announcement is already handled, so the
          // role is dropped rather than nested inside another announcement.
          role={undefined}
          title={t.title}
          description={t.description}
          icon={t.icon}
          actionLabel="Dismiss"
          onAction={() => dismiss(t.id)}
        />
      ))}
    </div>
  )
}
