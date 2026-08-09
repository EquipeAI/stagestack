import { useEffect, useState } from 'react'

/**
 * Wall clock that ticks every `intervalMs`, so UI derived from "now" (window
 * states, overdue flags) keeps up while the tab stays open. Callers pick the
 * resolution their deadline deserves.
 */
export function useNow(intervalMs: number): number {
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
