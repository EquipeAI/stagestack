// The session roster's URL vocabulary (W8).
//
// The parser itself moved to `convex/shared/viewParams.ts` in W2, so a saved
// view's stored params are validated by the SAME function the route validates
// with. This module is the route's door to it, plus the one predicate that
// only the client needs.

import type { ContentFilter } from '@convex/shared/viewParams'

export {
  CONTENT_FILTERS,
  parseSessionsSearch,
} from '@convex/shared/viewParams'
export type {
  ContentFilter,
  SessionsSearch,
} from '@convex/shared/viewParams'

/** Legacy rows carry no contentStatus; they were always served, so absence
 * reads as approved — the same fallback the backend uses. */
export function matchesContent(
  contentStatus: string | undefined,
  filter: ContentFilter | undefined,
): boolean {
  if (filter === undefined) return true
  return (contentStatus ?? 'approved') === filter
}
