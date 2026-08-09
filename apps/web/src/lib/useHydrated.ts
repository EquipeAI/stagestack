import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}

/**
 * False during SSR and the hydration render, true afterwards. Gate controls
 * whose only behavior is a client-side handler — an SSR'd button that looks
 * enabled but has no listener yet silently swallows clicks.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
}
