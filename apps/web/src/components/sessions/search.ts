// The session roster's URL vocabulary (W8).
//
// Content approval is the one session-level gate that holds publication back
// without anyone being told, so "4 sessions have Draft content" needs to land
// on those four rather than on the whole roster.

export const CONTENT_FILTERS = ['draft', 'approved'] as const
export type ContentFilter = (typeof CONTENT_FILTERS)[number]

export type SessionsSearch = { content?: ContentFilter }

/** Route-level validateSearch: unknown params are dropped, never trusted. */
export function parseSessionsSearch(
  input: Record<string, unknown>,
): SessionsSearch {
  const content = input.content
  return typeof content === 'string' &&
    (CONTENT_FILTERS as ReadonlyArray<string>).includes(content)
    ? { content: content as ContentFilter }
    : {}
}

/** Legacy rows carry no contentStatus; they were always served, so absence
 * reads as approved — the same fallback the backend uses. */
export function matchesContent(
  contentStatus: string | undefined,
  filter: ContentFilter | undefined,
): boolean {
  if (filter === undefined) return true
  return (contentStatus ?? 'approved') === filter
}
