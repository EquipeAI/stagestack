// The reviews route's URL vocabulary (W8).
//
// It exists so a count on the control center can land on the Progress tab
// rather than on "Reviews, now find the tab" — a deep link that does not
// pre-filter is a link to a page, not to work.

export const REVIEW_TABS = ['queue', 'plan', 'progress'] as const
export type ReviewTab = (typeof REVIEW_TABS)[number]

export type ReviewsSearch = { tab?: ReviewTab }

/** Route-level validateSearch: an unknown tab is dropped, never trusted. */
export function parseReviewsSearch(
  input: Record<string, unknown>,
): ReviewsSearch {
  const tab = input.tab
  return typeof tab === 'string' &&
    (REVIEW_TABS as ReadonlyArray<string>).includes(tab)
    ? { tab: tab as ReviewTab }
    : {}
}
