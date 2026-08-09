import { useCallback, useState } from 'react'
import { errorMessage } from './errors'

/**
 * One pending flag + one surfaced error message per action. Every mutation in
 * the app runs through this so the button always reports its own state and the
 * backend's message is never swallowed.
 */
export function usePending() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setPending(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    } finally {
      setPending(false)
    }
  }, [])

  return { pending, error, setError, run }
}
