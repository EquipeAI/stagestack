import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgendaGrid } from './AgendaGrid'
import { SpeakerGallery } from './SpeakerGallery'
import { SpeakersDirectory } from './SpeakersDirectory'
import type { PublicProgram, PublicSpeaker } from '@convex/model/publish'

const legacySpeaker = {
  name: 'Ada Lovelace',
  company: 'Analytical Engines',
  bio: 'Computing pioneer.',
  headshotUrl: 'https://expired.test/ada.jpg',
} as PublicSpeaker

afterEach(cleanup)

function program(): PublicProgram {
  return {
    event: {
      name: 'Event',
      slug: 'event',
      timezone: 'America/New_York',
      startsAt: Date.parse('2026-06-03T13:00:00Z'),
      endsAt: Date.parse('2026-06-05T21:00:00Z'),
    },
    lineupPublished: true,
    agendaPublished: true,
    lineup: [
      {
        sessionId: 's1',
        title: 'Computing',
        speakers: [legacySpeaker],
        toBeAnnounced: false,
      },
    ],
    agenda: [
      {
        kind: 'item',
        itemId: 'doors',
        title: 'Doors open',
        startsAt: Date.parse('2026-06-03T13:00:00Z'),
        endsAt: Date.parse('2026-06-03T14:00:00Z'),
      },
    ],
  }
}

describe('AgendaGrid day tabs', () => {
  it('does not synthesize empty event days before the agenda is published', () => {
    const unpublished = { ...program(), agendaPublished: false, agenda: [] }
    render(<AgendaGrid program={unpublished} />)
    expect(
      screen.getByText('The agenda has not been published yet.'),
    ).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('switches the visible date and renders an explicit empty-day state', () => {
    render(<AgendaGrid program={program()} />)
    expect(screen.getByText('Doors open')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Thu 4 Jun' }))
    expect(
      screen.getByRole('heading', { name: 'Thursday, 4 Jun 2026' }),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'No agenda items are scheduled for Thursday, 4 Jun 2026.',
      ),
    ).toBeTruthy()
    expect(screen.queryByText('Doors open')).toBeNull()
  })

  it('falls back to speaker initials when an agenda-detail headshot fails', () => {
    const withSession = program()
    withSession.agenda = [
      {
        kind: 'session',
        sessionId: 's1',
        title: 'Computing',
        speakers: [legacySpeaker],
        toBeAnnounced: false,
        startsAt: Date.parse('2026-06-03T13:00:00Z'),
        endsAt: Date.parse('2026-06-03T14:00:00Z'),
      },
    ]
    const { container } = render(<AgendaGrid program={withSession} />)
    fireEvent.click(screen.getByRole('button', { name: /Computing/ }))
    const image = container.querySelector('img[src="https://expired.test/ada.jpg"]')
    expect(image).not.toBeNull()
    fireEvent.error(image as HTMLImageElement)
    expect(
      container.querySelector('img[src="https://expired.test/ada.jpg"]'),
    ).toBeNull()
    expect(screen.getByText('AL')).toBeTruthy()
  })
})

describe('legacy speaker widgets', () => {
  it('opens directory detail without a speakerId', () => {
    render(<SpeakersDirectory program={program()} />)
    fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace/ }))
    expect(screen.getByText('Computing pioneer.')).toBeTruthy()
  })

  it('falls back to initials when a gallery headshot fails and still opens detail', () => {
    render(<SpeakerGallery program={program()} />)
    const image = screen.getByRole('img', { name: 'Ada Lovelace' })
    fireEvent.error(image)
    expect(screen.queryByRole('img', { name: 'Ada Lovelace' })).toBeNull()
    expect(screen.getByText('AL')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace/ }))
    expect(screen.getByText('Computing pioneer.')).toBeTruthy()
  })
})
