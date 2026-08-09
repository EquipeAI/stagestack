import { useEffect, useRef, useState } from 'react'

/**
 * A clock that ticks. Overdue state is derived from `now` on the server
 * (convex/model/readiness.ts takes it as an argument on purpose), so the
 * dashboard has to keep feeding it a current value or "overdue" quietly goes
 * stale. One minute is the resolution a due date deserves.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now())
    }, intervalMs)
    return () => {
      window.clearInterval(id)
    }
  }, [intervalMs])
  return now
}

/**
 * Hold the last delivered value while a query re-subscribes.
 *
 * Ticking `now` changes the query args every minute, and Convex answers new
 * args with `undefined` until the first result lands. Without this the whole
 * dashboard would blink to "Loading…" once a minute. Live updates *within* one
 * tick are untouched — this only bridges the re-subscribe gap.
 */
export function useLastLoaded<T>(value: T | undefined): T | undefined {
  const last = useRef<T | undefined>(undefined)
  if (value !== undefined) last.current = value
  return value ?? last.current
}
