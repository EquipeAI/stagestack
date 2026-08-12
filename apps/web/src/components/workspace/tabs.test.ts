import { describe, expect, it } from 'vitest'
import {
  SESSION_TABS,
  SPEAKER_TABS,
  activeWorkspaceTab,
  parseSessionWorkspaceSearch,
  parseSpeakerWorkspaceSearch,
} from './tabs'

// W9 — tab state lives in the URL.
//
// The contract, stated as tests: every tab survives a round trip through
// `validateSearch`, the default tab is written as an ABSENT param (so a record
// has one canonical URL), and anything else at all resolves to the first tab
// rather than to a blank page.

describe('the tab round trip', () => {
  it.each(SESSION_TABS.map((t) => t.id))(
    'a session tab survives validateSearch: %s',
    (id) => {
      const parsed = parseSessionWorkspaceSearch({ tab: id })
      expect(activeWorkspaceTab(SESSION_TABS, parsed)).toBe(id)
    },
  )

  it.each(SPEAKER_TABS.map((t) => t.id))(
    'a speaker tab survives validateSearch: %s',
    (id) => {
      const parsed = parseSpeakerWorkspaceSearch({ tab: id })
      expect(activeWorkspaceTab(SPEAKER_TABS, parsed)).toBe(id)
    },
  )

  it('is the link W4 blockers use: ?tab=content', () => {
    // The plan's literal example. If this ever stops resolving, every
    // publication blocker's repair link lands on the wrong tab.
    const parsed = parseSessionWorkspaceSearch({ tab: 'content' })
    expect(parsed).toEqual({ tab: 'content' })
    expect(activeWorkspaceTab(SESSION_TABS, parsed)).toBe('content')
  })
})

describe('the canonical URL of a record', () => {
  it('writes the default tab as no param at all', () => {
    // …/sessions/$id and …/sessions/$id?tab=overview are the same screen, so
    // they must be the same URL — otherwise Back visits it twice.
    expect(parseSessionWorkspaceSearch({ tab: 'overview' })).toEqual({})
    expect(parseSpeakerWorkspaceSearch({ tab: 'identity' })).toEqual({})
  })

  it('resolves a bare URL to the first tab', () => {
    expect(activeWorkspaceTab(SESSION_TABS, {})).toBe('overview')
    expect(activeWorkspaceTab(SPEAKER_TABS, {})).toBe('identity')
  })
})

describe('an untrusted param', () => {
  it('drops an unknown tab instead of erroring', () => {
    // A link from an older release must still open the record.
    expect(parseSessionWorkspaceSearch({ tab: 'virtual-links' })).toEqual({})
    expect(activeWorkspaceTab(SESSION_TABS, { tab: 'nope' as never })).toBe(
      'overview',
    )
  })

  it('drops a non-string tab', () => {
    expect(parseSessionWorkspaceSearch({ tab: 3 })).toEqual({})
    expect(parseSessionWorkspaceSearch({ tab: ['content'] })).toEqual({})
    expect(parseSessionWorkspaceSearch({})).toEqual({})
  })

  it('keeps no other key from the URL', () => {
    expect(
      parseSessionWorkspaceSearch({ tab: 'content', redirect: 'evil' }),
    ).toEqual({ tab: 'content' })
  })
})

describe('the tab vocabulary', () => {
  it('covers what the plan asked each workspace to hold', () => {
    expect(SPEAKER_TABS.map((t) => t.id)).toEqual([
      'identity',
      'sessions',
      'readiness',
      'tasks',
      'files',
      'comments',
      'comms',
    ])
    expect(SESSION_TABS.map((t) => t.id)).toEqual([
      'overview',
      'proposal',
      'speakers',
      'content',
      'tasks',
      'schedule',
      'publication',
      'history',
    ])
  })
})
