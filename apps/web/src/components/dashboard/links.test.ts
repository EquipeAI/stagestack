import { describe, expect, it } from 'vitest'
import { linkTarget } from './links'
import { parseSearch as parseProposalsSearch } from '~/components/abstracts/model'
import { parseAgendaSearch } from '~/components/agenda/search'
import { parseReviewsSearch } from '~/components/reviews/search'
import { parseSessionsSearch } from '~/components/sessions/search'
import { parseSpeakersSearch } from '~/components/speakers/search'
import { parseTasksSearch } from '~/components/tasks/search'
import { TAB_PATHS } from '~/components/shell/nav'

// The deep-link contract (W8).
//
// A count on the control center must land on ALREADY-FILTERED work. That is
// only true if the search params the backend emits are params the destination
// route's own `validateSearch` keeps — a param it silently drops lands the
// organizer on an unfiltered page that looks identical to a working link.
//
// So every row below is run through the REAL parser of its destination, and
// asserted to survive unchanged. If a route's vocabulary changes, this fails
// here rather than in the browser.

/**
 * The links `convex/model/controlCenter.ts` emits, spelled exactly as the
 * convex test asserts them (see convex/controlCenter.test.ts). The two lists
 * are the same contract read from opposite ends.
 */
const LINKS = [
  {
    row: 'CFP submissions waiting',
    link: { tab: 'proposals', search: { status: 'pending' } },
    parse: parseProposalsSearch,
  },
  {
    row: 'Decisions staged, not released',
    link: {
      tab: 'proposals',
      search: { status: 'acceptQueue,declineQueue' },
    },
    parse: parseProposalsSearch,
  },
  {
    row: 'Reviews outstanding',
    link: { tab: 'reviews', search: { tab: 'progress' } },
    parse: parseReviewsSearch,
  },
  {
    row: 'Speakers unconfirmed',
    link: { tab: 'speakers', search: { state: 'awaiting' } },
    parse: parseSpeakersSearch,
  },
  {
    row: 'Speaker tasks outstanding',
    link: { tab: 'tasks', search: { tab: 'instances', status: 'outstanding' } },
    parse: parseTasksSearch,
  },
  {
    row: 'Content still in Draft',
    link: { tab: 'sessions', search: { content: 'draft' } },
    parse: parseSessionsSearch,
  },
  {
    row: 'Sessions unscheduled',
    link: { tab: 'agenda', search: { view: 'list' } },
    parse: parseAgendaSearch,
  },
  {
    row: 'Schedule conflicts',
    link: { tab: 'agenda', search: { view: 'room' } },
    parse: parseAgendaSearch,
  },
  {
    row: 'Publication channels',
    link: { tab: 'publish' },
    parse: null,
  },
] as const

describe('control center deep links', () => {
  it.each(LINKS)('$row lands on a route that resolves', ({ link }) => {
    const target = linkTarget(link, 'devconf')
    expect(target.to).toBe(TAB_PATHS[link.tab])
    expect(target.params).toEqual({ eventSlug: 'devconf' })
  })

  it.each(LINKS.filter((entry) => entry.parse !== null))(
    '$row lands PRE-FILTERED — its search survives the destination validateSearch',
    ({ link, parse }) => {
      const target = linkTarget(link, 'devconf')
      // The destination's own parser, not a copy of its rules.
      const parsed = parse(target.search)
      expect(parsed).toMatchObject(target.search)
    },
  )

  it('never sends a search param the destination would drop', () => {
    // The failure mode this whole file exists for, proven to be detectable.
    expect(parseProposalsSearch({ status: 'notAStatus' })).toEqual({})
    expect(parseReviewsSearch({ tab: 'nope' })).toEqual({})
    expect(parseSpeakersSearch({ state: 'nope' })).toEqual({})
    expect(parseTasksSearch({ tab: 'nope', status: 'nope' })).toEqual({})
    expect(parseSessionsSearch({ content: 'nope' })).toEqual({})
  })

  it('falls back to the event root for a destination this build cannot name', () => {
    // A backend that learns a new tab before the client does costs a precise
    // landing, never the panel.
    const target = linkTarget({ tab: 'wormholes' }, 'devconf')
    expect(target.to).toBe(TAB_PATHS.overview)
    expect(target.search).toEqual({})
  })
})
