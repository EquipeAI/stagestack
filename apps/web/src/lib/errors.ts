import { ConvexError } from 'convex/values'

type ErrorPayload = { code?: string; message?: string }

function payload(err: unknown): ErrorPayload | null {
  if (!(err instanceof ConvexError)) return null
  const data: unknown = err.data
  if (typeof data === 'string') return { message: data }
  if (data !== null && typeof data === 'object') return data
  return null
}

/** The message the backend meant a human to read, never a stack trace. */
export function errorMessage(err: unknown, fallback = 'Something went wrong.') {
  const data = payload(err)
  if (data?.message) return data.message
  if (err instanceof Error && err.message) {
    // Convex wraps server errors with a long "Uncaught …" preamble in dev.
    return import.meta.env.DEV ? err.message : fallback
  }
  return fallback
}

/** Backend error codes: forbidden, not_found, user_not_provisioned, … */
export function errorCode(err: unknown) {
  return payload(err)?.code ?? null
}
