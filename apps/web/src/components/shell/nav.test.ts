import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DECISIONS_SEARCH,
  LEGACY_TAB_PATHS,
  NAV_GROUPS,
  TAB_PATHS,
  activeNavId,
  activeTabId,
  attentionSummary,
  countHint,
  formatCount,
  groupOf,
  isDecisionsView,
} from './nav'
import type { Attention } from './nav'
import {
  BUILT_IN_VIEWS,
  isStaged,
  parseSearch,
  stateFromSearch,
} from '~/components/abstracts/model'

// W7's two load-bearing invariants, as tests:
//   · the active entry is resolved by longest PREFIX, so W9's routed
//     workspaces (/sessions/$id) highlight Sessions rather than the root;
//   · every path the shell published before this workstream still resolves —
//     the plan's rule is "redirect, never 404".

const SLUG = 'devconf'
// vitest runs from apps/web (vitest.config.ts lives there).
const ROUTES = `${process.cwd()}/src/routes/`

describe('activeTabId', () => {
  it('matches a tab path exactly', () => {
    expect(activeTabId(`/app/e/${SLUG}/sessions`, SLUG)).toBe('sessions')
    expect(activeTabId(`/app/e/${SLUG}/publish`, SLUG)).toBe('publish')
  })

  it('matches the root exactly, and only exactly', () => {
    expect(activeTabId(`/app/e/${SLUG}`, SLUG)).toBe('overview')
    // A trailing slash is the same address.
    expect(activeTabId(`/app/e/${SLUG}/`, SLUG)).toBe('overview')
  })

  it('matches a deeper path to its owning tab', () => {
    // The case that made this change necessary: exact equality answered
    // "overview" here, which highlighted the control center from inside a
    // session workspace and would have scrolled the phone nav to the wrong
    // entry.
    expect(activeTabId(`/app/e/${SLUG}/sessions/abc123`, SLUG)).toBe('sessions')
    expect(activeTabId(`/app/e/${SLUG}/speakers/xyz/tasks`, SLUG)).toBe(
      'speakers',
    )
  })

  it('does not let one tab claim another whose name it prefixes', () => {
    // `/team` must not be claimed by anything, and a path that merely STARTS
    // with a tab's characters is not inside it.
    expect(activeTabId(`/app/e/${SLUG}/teamwork`, SLUG)).toBe('overview')
  })

  it('falls back to the root for an unknown path', () => {
    expect(activeTabId(`/app/e/${SLUG}/nowhere`, SLUG)).toBe('overview')
    expect(activeTabId('/app/home', SLUG)).toBe('overview')
  })

  it('resolves against the slug it is given', () => {
    expect(activeTabId('/app/e/other/sessions', SLUG)).toBe('overview')
    expect(activeTabId('/app/e/other/sessions', 'other')).toBe('sessions')
  })
})

describe('activeNavId', () => {
  it('reads plain proposals as Proposals', () => {
    expect(activeNavId(`/app/e/${SLUG}/proposals`, SLUG, {})).toBe('proposals')
    expect(activeNavId(`/app/e/${SLUG}/proposals`, SLUG, { status: 'pending' })).toBe(
      'proposals',
    )
  })

  it('reads the staged queues as Decisions', () => {
    expect(
      activeNavId(`/app/e/${SLUG}/proposals`, SLUG, DECISIONS_SEARCH),
    ).toBe('decisions')
    // Order is not part of the identity.
    expect(
      activeNavId(`/app/e/${SLUG}/proposals`, SLUG, {
        status: 'declineQueue,acceptQueue',
      }),
    ).toBe('decisions')
  })

  it('does not read a partial queue filter as Decisions', () => {
    expect(
      activeNavId(`/app/e/${SLUG}/proposals`, SLUG, { status: 'acceptQueue' }),
    ).toBe('proposals')
    expect(
      activeNavId(`/app/e/${SLUG}/proposals`, SLUG, {
        status: 'acceptQueue,declineQueue,pending',
      }),
    ).toBe('proposals')
  })

  it('ignores the filter away from proposals', () => {
    expect(
      activeNavId(`/app/e/${SLUG}/sessions`, SLUG, DECISIONS_SEARCH),
    ).toBe('sessions')
  })
})

describe('the Decisions deep link', () => {
  it('uses the proposals route vocabulary, unextended', () => {
    // The status values are the schema's own staged states, and the proposals
    // route's parseSearch already accepts them (its "Queues" built-in view is
    // the same string). Nothing was added to validateSearch for this entry.
    expect(DECISIONS_SEARCH.status).toBe('acceptQueue,declineQueue')
    expect(isDecisionsView(DECISIONS_SEARCH)).toBe(true)
  })

  it('survives the proposals route validateSearch unchanged', () => {
    // The deep link is only a deep link if the destination accepts it: a
    // status the route drops would land the organizer on an unfiltered table.
    expect(parseSearch({ ...DECISIONS_SEARCH })).toEqual({
      status: 'acceptQueue,declineQueue',
    })
  })

  it('produces exactly the staged-decision filter state', () => {
    const state = stateFromSearch(parseSearch({ ...DECISIONS_SEARCH }), null)
    expect(state.statuses).toEqual(['acceptQueue', 'declineQueue'])
    // Every selected status is a staged (releasable) one, and nothing else is.
    expect(state.statuses.every(isStaged)).toBe(true)
    expect(state.q).toBe('')
  })

  it('is the view the proposals table already called Queues', () => {
    const queues = BUILT_IN_VIEWS.find((v) => v.name === 'Queues')
    expect(queues?.search.status).toBe(DECISIONS_SEARCH.status)
  })
})

describe('route resolution', () => {
  const file = (path: string) => {
    const rest = path.replace('/app/e/$eventSlug', '')
    const name = rest === '' ? 'index' : rest.slice(1).replaceAll('/', '.')
    return `app.e.$eventSlug.${name}.tsx`
  }

  it.each(Object.entries(LEGACY_TAB_PATHS))(
    'every pre-W7 path still resolves: %s',
    (_id, path) => {
      expect(existsSync(`${ROUTES}${file(path)}`)).toBe(true)
    },
  )

  it.each(Object.entries(TAB_PATHS))(
    'every current path resolves: %s',
    (_id, path) => {
      expect(existsSync(`${ROUTES}${file(path)}`)).toBe(true)
    },
  )

  it('/dashboard resolves as a redirect to the root, not as a page', () => {
    const source = readFileSync(
      `${ROUTES}app.e.$eventSlug.dashboard.tsx`,
      'utf8',
    )
    expect(source).toContain('redirect')
    expect(source).toContain("to: '/app/e/$eventSlug'")
    // It must not still render the old dashboard.
    expect(source).not.toContain('component:')
  })

  it('drops dashboard as an entry while keeping its path resolvable', () => {
    expect('dashboard' in TAB_PATHS).toBe(false)
    const ids = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))
    expect(ids).not.toContain('dashboard')
  })
})

describe('the lifecycle grouping', () => {
  it('places every entry in its lifecycle step', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      'Setup',
      'Collect',
      'Select',
      'Prepare',
      'Schedule',
      'Publish',
    ])
    expect(groupOf('cfp')).toBe('Collect')
    expect(groupOf('decisions')).toBe('Select')
    expect(groupOf('agenda')).toBe('Schedule')
    expect(groupOf('publish')).toBe('Publish')
  })

  it('keeps every renamed label findable by its old wording', () => {
    const byId = new Map(
      NAV_GROUPS.flatMap((g) => g.items).map((i) => [i.id, i]),
    )
    expect(byId.get('tasks')?.alias).toBe('Speaker tasks')
    expect(byId.get('publish')?.alias).toBe('Publish')
    // The merged root answers to the name of the page it absorbed.
    expect(byId.get('overview')?.alias).toBe('Dashboard')
  })

  it('routes every entry to a real target', () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (item.id === 'decisions') continue
        expect(Object.keys(TAB_PATHS)).toContain(item.id)
      }
    }
  })
})

describe('the count convention', () => {
  it('shows nothing for an empty queue', () => {
    expect(formatCount(0, false)).toBeUndefined()
    expect(formatCount(undefined, false)).toBeUndefined()
    expect(countHint(0, false)).toBeUndefined()
  })

  it('shows an exact number when the read was complete', () => {
    expect(formatCount(12, false)).toBe('12')
    expect(countHint(12, false)).toBe('12 needing attention')
  })

  it('shows a floor, not a total, when the read was capped', () => {
    expect(formatCount(500, true)).toBe('500+')
    expect(countHint(500, true)).toBe('at least 500 needing attention')
  })

  it('summarises the whole event for the phone menu button', () => {
    const attention: Attention = {
      counts: {
        proposals: 2,
        decisions: 0,
        reviews: 1,
        sessions: 0,
        speakers: 0,
        agenda: 0,
        tasks: 0,
        publish: 0,
      },
      capped: false,
    }
    expect(attentionSummary(attention)).toBe(
      'Event menu · 3 items need attention',
    )
    expect(
      attentionSummary({ ...attention, capped: true }),
    ).toBe('Event menu · at least 3 items need attention')
    expect(
      attentionSummary({
        counts: {
          proposals: 0,
          decisions: 0,
          reviews: 0,
          sessions: 0,
          speakers: 0,
          agenda: 0,
          tasks: 0,
          publish: 0,
        },
        capped: false,
      }),
    ).toBe('Event menu · nothing needs attention')
    // No counts (reviewer, or the query failed) says nothing about the event.
    expect(attentionSummary(null)).toBe('Event menu')
  })
})
