import { useCallback, useEffect, useState } from 'react'
import { useConvexAuth, useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { errorMessage } from './errors'

export type Provisioning = {
  isLoading: boolean
  isAuthenticated: boolean
  /** True once `users.ensure` has resolved — authed queries are safe now. */
  provisioned: boolean
  error: string | null
  retry: () => void
}

/**
 * Every authed Convex function throws `user_not_provisioned` until
 * `users.ensure` has run, so anything reading authed data waits on this.
 *
 * The stored error is cleared before every attempt and whenever the auth
 * state changes: a single transient failure must never strand the caller.
 */
export function useProvisioning(): Provisioning {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const ensure = useMutation(api.users.ensure)
  const [provisioned, setProvisioned] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setError(null)
    if (!isAuthenticated) {
      setProvisioned(false)
      return
    }
    let cancelled = false
    ensure({})
      .then(() => {
        if (!cancelled) setProvisioned(true)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, ensure, attempt])

  const retry = useCallback(() => {
    setAttempt((n) => n + 1)
  }, [])

  return { isLoading, isAuthenticated, provisioned, error, retry }
}
