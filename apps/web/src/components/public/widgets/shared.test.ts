import { describe, expect, it } from 'vitest'
import { groupDays } from './AgendaGrid'
import { publicSpeakerKey, speakerEntries } from './shared'
import type { PublicProgram, PublicSpeaker } from '@convex/model/publish'

const zone = 'America/New_York'

function program(): PublicProgram {
  return {
    event: {
      name: 'Event',
      slug: 'event',
      timezone: zone,
      startsAt: Date.parse('2026-06-03T13:00:00Z'),
      endsAt: Date.parse('2026-06-05T21:00:00Z'),
    },
    lineupPublished: true,
    agendaPublished: true,
    lineup: [],
    agenda: [
      {
        kind: 'item',
        itemId: 'item-1',
        title: 'Doors',
        startsAt: Date.parse('2026-06-03T13:00:00Z'),
        endsAt: Date.parse('2026-06-03T14:00:00Z'),
      },
    ],
  }
}

describe('public agenda days', () => {
  it('builds every event calendar day, including empty days', () => {
    const p = program()
    const days = groupDays(p.agenda, zone, p.event)
    expect(days.map((day) => day.key)).toEqual([
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
    ])
    expect(days.map((day) => day.entries.length)).toEqual([1, 0, 0])
  })

  it('handles reversed same-day bounds as one safe day', () => {
    const startsAt = Date.parse('2026-06-03T20:00:00Z')
    const days = groupDays([], zone, { startsAt, endsAt: startsAt - 1000 })
    expect(days).toHaveLength(1)
  })
})

describe('legacy public speakers', () => {
  it('uses one stable key and merges sessions when speakerId is missing', () => {
    const speaker = { name: 'Ada Lovelace' } as PublicSpeaker
    expect(publicSpeakerKey(speaker)).toBe('legacy:ada lovelace')
    const p = program()
    p.lineup = [
      {
        sessionId: 's1',
        title: 'One',
        speakers: [speaker],
        toBeAnnounced: false,
      },
      {
        sessionId: 's2',
        title: 'Two',
        speakers: [speaker],
        toBeAnnounced: false,
      },
    ]
    const entries = speakerEntries(p)
    expect(entries).toHaveLength(1)
    expect(entries[0].key).toBe('legacy:ada lovelace')
    expect(entries[0].sessions).toHaveLength(2)
  })
})
