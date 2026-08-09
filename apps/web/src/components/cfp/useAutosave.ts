import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '~/lib/errors'

export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error'

export type Autosave<T> = {
  status: SaveStatus
  error: string | null
  /** Queue a value; it saves `delay` ms after the last change. */
  schedule: (value: T) => void
  /** Save the queued value now (explicit "Save draft", or leaving a step). */
  flush: () => Promise<void>
  /** Save this exact value now, even if nothing was queued. */
  saveNow: (value: T) => Promise<void>
}

/**
 * Debounced write-behind for one record. The wizard praises itself on never
 * losing a draft, so the queue survives a save that is already in flight and
 * a pending value is still written when the component unmounts.
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
  const inFlight = useRef(false)

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const flush = useCallback(async () => {
    clearTimer()
    if (inFlight.current) return
    inFlight.current = true
    try {
      let failed = false
      while (queued.current !== null) {
        const { value } = queued.current
        queued.current = null
        setStatus('saving')
        try {
          await saveRef.current(value)
        } catch (err) {
          setStatus('error')
          setError(errorMessage(err))
          failed = true
          break
        }
      }
      if (!failed) {
        setError(null)
        setStatus((current) => (current === 'saving' ? 'saved' : current))
      }
    } finally {
      inFlight.current = false
    }
  }, [clearTimer])

  const schedule = useCallback(
    (value: T) => {
      queued.current = { value }
      setStatus('unsaved')
      setError(null)
      clearTimer()
      timer.current = setTimeout(() => {
        void flush()
      }, delay)
    },
    [clearTimer, delay, flush],
  )

  const saveNow = useCallback(
    async (value: T) => {
      queued.current = { value }
      await flush()
    },
    [flush],
  )

  useEffect(
    () => () => {
      // Unmounting mid-debounce must not drop the edit. Fire and forget: the
      // component is gone, so there is no state left to update.
      if (timer.current !== null) clearTimeout(timer.current)
      const pending = queued.current
      queued.current = null
      if (pending !== null) void saveRef.current(pending.value)
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
