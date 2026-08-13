import { NAV_GROUPS } from './nav'
import type { NavId } from './nav'

// The palette's "go to" half (W1). Pure functions over the SAME nav data the
// rail and the drawer render — a destination the palette knows about is a
// destination the rail shows, by construction.
//
// The alias carried by each nav entry is its PREVIOUS label (W7). It is
// matched here exactly like the current one, so a surface that was renamed
// stays findable by the name a person — or a harness — learned first.

export type Destination = {
  id: NavId
  label: string
  icon: string
  /** The old label, matched but not displayed. */
  alias?: string
  /** Lifecycle group, shown as the row's trailing hint. */
  group: string
}

/** Every event destination this role can actually open, in rail order. */
export function destinations(role: string | undefined): Array<Destination> {
  const out: Array<Destination> = []
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.requires !== undefined && item.requires !== role) continue
      out.push({
        id: item.id,
        label: item.label,
        icon: item.icon,
        alias: item.alias,
        group: group.label,
      })
    }
  }
  return out
}

/**
 * How well `term` names `text`, lower being better, null for no match.
 *
 * Three tiers, in the order a person expects: what you typed starts the name,
 * what you typed is somewhere in the name, or the letters you typed appear in
 * that order ("spkr" → Speakers). The subsequence tier is what makes this a
 * jump rather than a filter — it is deliberately last, so an exact word never
 * loses to a scattered one.
 */
export function score(text: string, term: string): number | null {
  const haystack = text.toLowerCase()
  const needle = term.toLowerCase().trim()
  if (needle === '') return 0
  const at = haystack.indexOf(needle)
  if (at === 0) return 0
  if (at > 0) return 1 + at / 100
  let cursor = 0
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor)
    if (found < 0) return null
    cursor = found + 1
  }
  return 10
}

/**
 * The destinations that answer `term`, best first.
 *
 * An alias hit scores just behind the same tier of a label hit: the current
 * name wins a tie, the old name still gets you there.
 */
export function matchDestinations(
  term: string,
  role: string | undefined,
): Array<Destination> {
  const trimmed = term.trim()
  const all = destinations(role)
  if (trimmed === '') return all
  const ranked: Array<{ destination: Destination; rank: number }> = []
  for (const destination of all) {
    const byLabel = score(destination.label, trimmed)
    const byAlias =
      destination.alias === undefined
        ? null
        : score(destination.alias, trimmed)
    const alias = byAlias === null ? null : byAlias + 0.5
    const rank =
      byLabel === null
        ? alias
        : alias === null
          ? byLabel
          : Math.min(byLabel, alias)
    if (rank !== null) ranked.push({ destination, rank })
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank || a.destination.label.localeCompare(b.destination.label),
  )
  return ranked.map((row) => row.destination)
}
