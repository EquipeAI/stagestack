// Which event this browser was last inside. /app opens it directly instead of
// the organization list — an organizer lives in one event for weeks at a time.
// Storage is best-effort: it is a convenience, never a source of truth, and it
// is validated against the user's real events before anything navigates there.

const KEY = 'stagestack.last-event'

export function readLastEventSlug(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(KEY)
    return value === null || value === '' ? null : value
  } catch {
    // Private modes and blocked third-party storage throw on access.
    return null
  }
}

export function rememberLastEventSlug(slug: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, slug)
  } catch {
    // Nothing to do — the next /app visit just falls back to the newest event.
  }
}
