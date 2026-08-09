import { useSyncExternalStore } from 'react'
import { Toast } from '~/ds'

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
      style={{
        position: 'fixed',
        right: 'var(--page-gutter)',
        bottom: 'var(--page-gutter)',
        zIndex: 'var(--z-toast)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
      }}
    >
      {list.map((t) => (
        <Toast
          key={t.id}
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
