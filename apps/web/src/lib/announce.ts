import { useSyncExternalStore } from 'react'

/**
 * One live region for the whole app.
 *
 * Async work in StageStack reports itself three ways today — a toast, an
 * inline `ActionResult`, or a button that flips to "Saving…" — and only the
 * first two are announced. This is the one mechanism for the third: any
 * pending→done transition that has no visible outcome component still gets a
 * sentence spoken, and no surface has to grow its own live region to say it.
 *
 * `polite` waits for a pause (outcomes, progress). `assertive` interrupts and
 * is reserved for failures, which the user has to know about before they act
 * again.
 */
export type Politeness = 'polite' | 'assertive'

type State = { polite: string; assertive: string }

const EMPTY: State = { polite: '', assertive: '' }
let state: State = EMPTY
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

/**
 * Speak `message`. Repeating the same sentence re-announces it: two failed
 * attempts with the same error are two events, and a region whose text did not
 * change is silent, so the text is cleared first.
 */
export function announce(message: string, politeness: Politeness = 'polite') {
  const text = message.trim()
  if (text === '') return
  state = { ...state, [politeness]: '' }
  emit()
  const publish = () => {
    state = { ...state, [politeness]: text }
    emit()
  }
  if (typeof window === 'undefined') publish()
  else window.setTimeout(publish, 50)
}

/** Test seam: drop anything queued so one test cannot hear another's message. */
export function resetAnnouncements() {
  state = EMPTY
  emit()
}

export function useAnnouncements(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    // Server render is always silent: the region has to exist in the markup
    // before anything is said into it, and nothing has been said yet.
    () => EMPTY,
  )
}
