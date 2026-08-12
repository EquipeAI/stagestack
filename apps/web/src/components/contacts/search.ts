// The organization page's URL vocabulary (W12).
//
// The contact directory is one of the five operational tables, and it was the
// only one whose search, tag and company filters lived in component state:
// a filtered directory could not be linked, reloaded or backed out of, and a
// saved segment applied filters the URL never learned about. This makes them
// addressable on the same terms as the other four.

export const ORG_TABS = ['events', 'contacts', 'team'] as const
export type OrgTab = (typeof ORG_TABS)[number]

export type OrgSearch = {
  tab?: OrgTab
  q?: string
  tag?: string
  company?: string
}

/** Route-level validateSearch: unknown params are dropped, never trusted.
 * Tag and company are free text (they are org-authored values), so they are
 * only bounded, never enumerated — an unknown one narrows to nothing, which is
 * exactly what the directory should then show. */
export function parseOrgSearch(input: Record<string, unknown>): OrgSearch {
  const out: OrgSearch = {}
  const tab = input.tab
  if (typeof tab === 'string' && (ORG_TABS as ReadonlyArray<string>).includes(tab)) {
    out.tab = tab as OrgTab
  }
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value.slice(0, 200) : undefined
  const q = text(input.q)
  if (q !== undefined) out.q = q
  const tag = text(input.tag)
  if (tag !== undefined) out.tag = tag
  const company = text(input.company)
  if (company !== undefined) out.company = company
  return out
}
