import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '~/lib/errors'

export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error'

export type Autosave<T> = {
  status: SaveStatus
  error: string | null
  /** Queue a value; it saves `delay` ms after the last change. */
  schedule: (value: T) => void
  /**
   * Save the queued value now (explicit "Save draft", or leaving a step).
   * Waits for any save already in flight, then writes whatever is still
   * queued. **Rejects** if a write fails — a submit path has to be able to
   * stop. Call sites that only want the on-screen state use `.catch(() => {})`.
   */
  flush: () => Promise<void>
  /** Save this exact value now, even if nothing was queued. Rejects like `flush`. */
  saveNow: (value: T) => Promise<void>
}

/**
 * Debounced write-behind for one record. The wizard praises itself on never
 * losing a draft, so the queue survives a save that is already in flight and
 * a pending value is still written when the component unmounts.
 *
 * Two callers are never in the write at the same time: every drain is chained
 * behind the previous one, which is what makes `flush()` a promise you can
 * submit behind. A failed write leaves the value queued, so the next keystroke
 * (or the next explicit save) retries it instead of dropping the edit.
 */
export function useAutosave<T>(
  save: (value: T) => Promise<unknown>,
  delay = 800,
): Autosave<T> {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const saveRef = useRef(save)
  saveRef.current = save
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queued = useRef<{ value: T } | null>(null)
  /** The tail of the write chain. Sanitized, so it never rejects. */
  const chain = useRef<Promise<void> | null>(null)

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  // Writes whatever is queued, including anything queued while a write was in
  // flight. A rejection leaves the value queued on purpose.
  const drain = useCallback(async () => {
    while (queued.current !== null) {
      const pending = queued.current
      setStatus('saving')
      await saveRef.current(pending.value)
      // Only clear it if this is still the value that was written — a
      // keystroke during the await must survive.
      if (queued.current === pending) queued.current = null
    }
  }, [])

  // Every drain waits for the one before it, so "flush while saving" means
  // "wait for that save, then write what is still queued".
  const run = useCallback(() => {
    const next = (chain.current ?? Promise.resolve()).then(drain)
    chain.current = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }, [drain])

  const write = useCallback(
    async (explicit: boolean) => {
      clearTimer()
      try {
        await run()
        setError(null)
        setStatus((current) => (current === 'saving' ? 'saved' : current))
      } catch (err) {
        setStatus('error')
        setError(errorMessage(err))
        // A background autosave reports through the indicator; an explicit
        // save has a caller that may need to abandon what it was doing.
        if (explicit) throw err
      }
    },
    [clearTimer, run],
  )

  const flush = useCallback(() => write(true), [write])

  const schedule = useCallback(
    (value: T) => {
      queued.current = { value }
      setStatus('unsaved')
      setError(null)
      clearTimer()
      timer.current = setTimeout(() => {
        void write(false)
      }, delay)
    },
    [clearTimer, delay, write],
  )

  const saveNow = useCallback(
    async (value: T) => {
      queued.current = { value }
      await write(true)
    },
    [write],
  )

  useEffect(
    () => () => {
      // Unmounting mid-debounce must not drop the edit. Fire and forget: the
      // component is gone, so there is no state left to update.
      if (timer.current !== null) clearTimeout(timer.current)
      const pending = queued.current
      queued.current = null
      if (pending !== null) {
        const previous = chain.current ?? Promise.resolve()
        // Still ordered behind anything in flight, so the last edit wins.
        void previous.then(() => saveRef.current(pending.value)).catch(() => {})
      }
    },
    [],
  )

  return { status, error, schedule, flush, saveNow }
}

/** "Saved" / "Saving…" / "Unsaved changes" — the wording is the same everywhere. */
export function saveStatusLabel(status: SaveStatus): string | null {
  switch (status) {
    case 'saving':
      return 'Saving…'
    case 'saved':
      return 'Saved'
    case 'unsaved':
      return 'Unsaved changes'
    case 'error':
      return 'Not saved'
    case 'idle':
      return null
  }
}
