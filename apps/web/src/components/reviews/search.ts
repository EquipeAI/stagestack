// The reviews route's URL vocabulary (W8).
//
// It exists so a count on the control center can land on the Progress tab
// rather than on "Reviews, now find the tab" — a deep link that does not
// pre-filter is a link to a page, not to work.

export const REVIEW_TABS = ['queue', 'plan', 'progress'] as const
export type ReviewTab = (typeof REVIEW_TABS)[number]

export type ReviewsSearch = { tab?: ReviewTab; flow?: string }

/** Route-level validateSearch: an unknown tab is dropped, never trusted.
 * `flow` lands on the round launch flow — 'new', or a round id. The panel
 * resolves the id against the round list, so a stale one falls back to the
 * plan rather than opening something that no longer exists. */
export function parseReviewsSearch(
  input: Record<string, unknown>,
): ReviewsSearch {
  const tab = input.tab
  const flow = input.flow
  const out: ReviewsSearch = {}
  if (
    typeof tab === 'string' &&
    (REVIEW_TABS as ReadonlyArray<string>).includes(tab)
  ) {
    out.tab = tab as ReviewTab
  }
  if (typeof flow === 'string' && flow !== '' && flow.length <= 64) {
    out.flow = flow
  }
  return out
}
