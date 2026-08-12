import { describe, expect, it } from 'vitest'
import { visibleFilters } from './filters'

// W12: "hide zero-count filters unless the zero is operationally meaningful".
// The rule is a property of the FILTER, not of the data, so it lives in the
// definition and is applied here — which is what keeps "an empty Blocked is
// worth showing, an empty Withdrawn is noise" from being re-decided per route.

describe('visibleFilters', () => {
  it('hides an empty filter that says nothing', () => {
    const shown = visibleFilters([
      { id: 'submitted', label: 'Submitted', count: 12 },
      { id: 'withdrawn', label: 'Withdrawn', count: 0 },
    ])
    expect(shown.map((o) => o.id)).toEqual(['submitted'])
  })

  it('keeps an empty filter whose zero is the answer', () => {
    const shown = visibleFilters([
      { id: 'blocked', label: 'Blocked', count: 0, meaningfulZero: true },
      { id: 'withdrawn', label: 'Withdrawn', count: 0 },
    ])
    expect(shown.map((o) => o.id)).toEqual(['blocked'])
  })

  it('never hides the filter that is currently in force', () => {
    // Otherwise narrowing to a status that then empties would remove the only
    // control that could undo it, stranding the organizer inside the view.
    const shown = visibleFilters(
      [
        { id: 'submitted', label: 'Submitted', count: 3 },
        { id: 'withdrawn', label: 'Withdrawn', count: 0 },
      ],
      ['withdrawn'],
    )
    expect(shown.map((o) => o.id)).toEqual(['submitted', 'withdrawn'])
  })

  it('keeps every filter that has anyone in it', () => {
    const shown = visibleFilters([
      { id: 'a', label: 'A', count: 1 },
      { id: 'b', label: 'B', count: 9 },
    ])
    expect(shown).toHaveLength(2)
  })
})
