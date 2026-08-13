import { describe, expect, it } from 'vitest'
import {
  MODULE_ACCESS,
  PROPOSAL_COLUMN_IDS,
  PROPOSAL_STATUSES,
  VIEW_MODULES,
  checkViewParams,
  presetsFor,
} from '@convex/shared/viewParams'
import { activeView, isUnnarrowed, paramsFromSearch } from './model'
import type { ViewModule } from '@convex/shared/viewParams'
import {
  COLUMNS,
  STATUS_ORDER,
  parseSearch as parseProposalsSearch,
} from '~/components/abstracts/model'
import { parseAgendaSearch } from '~/components/agenda/search'
import { parseReviewsSearch } from '~/components/reviews/search'
import { parseSessionsSearch } from '~/components/sessions/search'
import { parseSpeakersSearch } from '~/components/speakers/search'
import { parseTasksSearch } from '~/components/tasks/search'
import { NAV_GROUPS } from '~/components/shell/nav'

// The saved-view contract (W2), read from the client end.
//
// Same shape of proof as `components/dashboard/links.test.ts`: a stored view
// only works if the params it holds are params the destination route's own
// `validateSearch` KEEPS. A dropped param lands the organizer on a page that
// looks filtered and is not — and a stored one can outlive the vocabulary it
// was written against, which a URL cannot.

/** The real parser each module route validates its search with. */
const PARSERS: Record<ViewModule, (input: Record<string, unknown>) => object> = {
  proposals: parseProposalsSearch,
  sessions: parseSessionsSearch,
  speakers: parseSpeakersSearch,
  tasks: parseTasksSearch,
  reviews: parseReviewsSearch,
  agenda: parseAgendaSearch,
}

describe('preset views', () => {
  it.each(VIEW_MODULES)(
    '%s: every preset survives the destination route validateSearch',
    (module) => {
      for (const preset of presetsFor(module)) {
        expect(PARSERS[module](preset.params)).toMatchObject(preset.params)
        // And the backend agrees a view could store it.
        expect(checkViewParams(module, preset.params).dropped).toEqual([])
      }
    },
  )

  it('Decisions is a proposals preset, defined once', () => {
    const decisions = presetsFor('proposals').find((p) => p.id === 'decisions')
    expect(decisions?.name).toBe('Decisions')
    expect(decisions?.params).toEqual({ status: 'acceptQueue,declineQueue' })
    expect(parseProposalsSearch(decisions?.params ?? {})).toEqual(
      decisions?.params,
    )
  })

  it('no two presets on a module are the same view under two names', () => {
    for (const module of VIEW_MODULES) {
      const spellings = presetsFor(module).map((preset) =>
        JSON.stringify(preset.params),
      )
      expect(new Set(spellings).size).toBe(spellings.length)
    }
  })
})

describe('stored params validation', () => {
  it('names the param a route would drop rather than storing it', () => {
    expect(checkViewParams('proposals', { wormholes: 'yes' }).dropped).toEqual([
      'wormholes',
    ])
    // A known key with a value the route refuses is the same failure.
    expect(checkViewParams('proposals', { status: 'notAStatus' }).dropped).toEqual(
      ['status'],
    )
    expect(checkViewParams('tasks', { tab: 'nope' }).dropped).toEqual(['tab'])
    expect(checkViewParams('speakers', { state: 'nope' }).dropped).toEqual([
      'state',
    ])
  })

  it('keeps a params set the route keeps, unchanged', () => {
    const params = { status: 'pending', sort: 'title', dir: 'asc' }
    const checked = checkViewParams('proposals', params)
    expect(checked.dropped).toEqual([])
    expect(checked.params).toEqual(params)
  })
})

describe('the picker’s state', () => {
  it('reads the params a route search object carries', () => {
    expect(
      paramsFromSearch({ status: 'pending', q: '', tab: undefined, n: 3 }),
    ).toEqual({ status: 'pending' })
  })

  it('names the current view, preferring the name the organizer chose', () => {
    const saved = [
      {
        viewId: 'v1',
        name: 'My decisions',
        params: { status: 'acceptQueue,declineQueue' },
        isDefault: true,
      },
    ]
    expect(
      activeView('proposals', { status: 'acceptQueue,declineQueue' }, saved),
    ).toEqual({ kind: 'saved', id: 'v1', name: 'My decisions', isDefault: true })
    expect(activeView('proposals', { status: 'pending' }, saved)).toMatchObject({
      kind: 'preset',
      name: 'Inbox',
    })
    expect(activeView('proposals', { q: 'ada' }, saved)).toMatchObject({
      kind: 'custom',
    })
  })

  it('applies a default only on a URL that narrows nothing', () => {
    expect(isUnnarrowed('proposals', {})).toBe(true)
    expect(isUnnarrowed('proposals', { status: 'pending' })).toBe(false)
    // The agenda always names a view, so its baseline is not the empty object.
    expect(isUnnarrowed('agenda', { view: 'room' })).toBe(true)
    expect(isUnnarrowed('agenda', {})).toBe(false)
    expect(isUnnarrowed('agenda', { view: 'list' })).toBe(false)
  })
})

describe('the proposals table and the shared parser share one vocabulary', () => {
  it('every column the table sorts by is a sort key a view can store', () => {
    expect([...PROPOSAL_COLUMN_IDS]).toEqual(COLUMNS.map((column) => column.id))
  })

  it('every status the table filters by is a status a view can store', () => {
    expect([...PROPOSAL_STATUSES].sort()).toEqual([...STATUS_ORDER].sort())
  })
})

describe('role gating agrees with the rail', () => {
  it.each(VIEW_MODULES)('%s is gated exactly as its nav entry is', (module) => {
    const item = NAV_GROUPS.flatMap((group) => group.items).find(
      (entry) => entry.id === module,
    )
    expect(item, `no nav entry for ${module}`).toBeDefined()
    expect(MODULE_ACCESS[module]).toBe(
      item?.requires === 'organizer' ? 'organizer' : 'member',
    )
  })
})
