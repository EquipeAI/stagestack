import { useCallback, useState } from 'react'
import { errorMessage } from './errors'
import { announce } from './announce'

export type PendingOptions = {
  /**
   * How this action talks to the app's live region (lib/announce.ts).
   *
   * - omitted — failures are announced assertively. This is the default
   *   because the usual rendering of `error` is an inline red `<span>`, which
   *   is silent, next to a button whose label has just gone back to normal.
   * - `false` — say nothing. Pass this when the surface already announces the
   *   same failure itself: an `ActionResult` (role=status), a `Field` error
   *   (role=alert), or any hand-rolled role=alert. Two regions saying the same
   *   sentence is worse than one.
   * - a string — the action's name. Pending, done and failed are all
   *   announced, prefixed with it. For long work with no visible outcome.
   */
  announce?: false | string
}

/**
 * One pending flag + one surfaced error message per action. Every mutation in
 * the app runs through this so the button always reports its own state and the
 * backend's message is never swallowed.
 *
 * It is also the app's ONE mechanism for announcing pending→done transitions,
 * which is why the opt-out above lives here rather than as a live region grown
 * on each surface.
 */
export function usePending(options?: PendingOptions) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const speak = options?.announce

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setPending(true)
      setError(null)
      if (typeof speak === 'string') announce(`${speak}…`)
      try {
        await fn()
        if (typeof speak === 'string') announce(`${speak}: done.`)
        return true
      } catch (err) {
        const message = errorMessage(err)
        setError(message)
        if (speak !== false) {
          announce(
            typeof speak === 'string' ? `${speak} failed. ${message}` : message,
            'assertive',
          )
        }
        return false
      } finally {
        setPending(false)
      }
    },
    [speak],
  )

  return { pending, error, setError, run }
}
