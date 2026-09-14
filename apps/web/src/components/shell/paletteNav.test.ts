import { describe, expect, it } from 'vitest'
import { destinations, matchDestinations, score } from './paletteNav'

// The palette's jump list is only as good as its matching, and the one rule
// that outlives this cycle is the alias rule: a surface that gets renamed has
// to stay reachable by the name people already learned.

describe('score', () => {
  it('ranks a prefix above a later substring above a subsequence', () => {
    const prefix = score('Sessions', 'sess')
    const inside = score('Public page', 'page')
    const scattered = score('Speakers', 'spkr')
    expect(prefix).not.toBeNull()
    expect(inside).not.toBeNull()
    expect(scattered).not.toBeNull()
    expect(prefix!).toBeLessThan(inside!)
    expect(inside!).toBeLessThan(scattered!)
  })

  it('is case-insensitive and refuses what it cannot find', () => {
    expect(score('Agenda', 'AGE')).toBe(0)
    expect(score('Agenda', 'zzz')).toBeNull()
  })
})

describe('matchDestinations', () => {
  it('offers every destination the role can open when nothing is typed', () => {
    const all = matchDestinations('', 'organizer')
    expect(all.length).toBe(destinations('organizer').length)
    expect(all.some((d) => d.id === 'settings')).toBe(true)
  })

  it('hides organizer-only destinations from a reviewer', () => {
    const forReviewer = matchDestinations('', 'reviewer').map((d) => d.id)
    expect(forReviewer).toContain('reviews')
    expect(forReviewer).toContain('overview')
    expect(forReviewer).not.toContain('settings')
    expect(forReviewer).not.toContain('proposals')
    expect(forReviewer).not.toContain('speakers')
  })

  it('finds a renamed surface by its OLD label', () => {
    // W7 renamed these; the palette still answers to what they used to say.
    expect(matchDestinations('dashboard', 'organizer')[0].id).toBe('overview')
    expect(matchDestinations('speaker tasks', 'organizer')[0].id).toBe('tasks')
    expect(matchDestinations('publish', 'organizer')[0].id).toBe('publish')
  })

  it('lets the current label win a tie against an old one', () => {
    const ranked = matchDestinations('agenda', 'organizer')
    expect(ranked[0].id).toBe('agenda')
  })

  it('carries the lifecycle group each destination belongs to', () => {
    const sessions = matchDestinations('sessions', 'organizer')[0]
    expect(sessions.group).toBe('Prepare')
  })
})
