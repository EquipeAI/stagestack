import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Id } from '@convex/_generated/dataModel'
import type { SpeakingItem } from './model'

// The confirm dialog is a privacy contract: before a speaker agrees, it must
// preview EXACTLY the fields the organizers may publish (name, tagline, bio,
// headshot, links, session) — and nothing private that rides the same portal
// payload, like the backstage URL. Declining previews nothing.

// The card wires three api.portal mutations; the dialog test only needs them
// to exist and to record what the dialog submits.
const { mutate } = vi.hoisted(() => ({
  mutate: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('convex/react', () => ({
  useMutation: () => mutate,
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { SpeakingCard } from './SpeakingCard'

const BACKSTAGE_URL = 'https://stagestack.dev/backstage/secret-token'

function item(over: Partial<SpeakingItem> = {}): SpeakingItem {
  return {
    participantId: 'p1' as Id<'sessionParticipants'>,
    sessionId: 's1' as Id<'sessions'>,
    sessionTitle: 'Signals at Scale',
    sessionDescription: 'A talk about signals.',
    format: 'Talk',
    state: 'awaiting',
    eventContact: {
      _id: 'ec1' as Id<'eventContacts'>,
      firstName: 'Ada',
      lastName: 'Lovelace',
      tagline: 'Engine programmer',
      bio: 'Wrote the first program.',
      headshotUrl: null,
      links: { website: 'https://ada.dev', github: 'https://github.com/ada' },
    },
    backstageUrl: BACKSTAGE_URL,
    ...over,
  }
}

function renderCard(speaking: SpeakingItem) {
  return render(
    <SpeakingCard
      eventSlug="devconf"
      item={speaking}
      readOnly={false}
      timezone="UTC"
    />,
  )
}

function openDialog(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
  return screen.getByRole('dialog')
}

afterEach(() => {
  cleanup()
  mutate.mockClear()
})

describe('SpeakingCard confirm dialog', () => {
  it('previews exactly the publishable fields, and only those', () => {
    renderCard(item())
    const dialog = openDialog('Confirm you will speak')

    expect(
      within(dialog).getByText(
        'The organizers of this event may publish these fields for "Signals at Scale".',
      ),
    ).toBeTruthy()

    const terms = [...dialog.querySelectorAll('dt')].map((dt) => dt.textContent)
    expect(terms).toEqual(['Name', 'Tagline', 'Bio', 'Headshot', 'Links', 'Session'])

    const values = [...dialog.querySelectorAll('dd')].map((dd) => dd.textContent)
    expect(values).toEqual([
      'Ada Lovelace',
      'Engine programmer',
      'Wrote the first program.',
      'None — initials are used',
      'https://ada.dev · https://github.com/ada',
      'Signals at Scale',
    ])

    // The portal payload also carries the backstage URL — it must never
    // appear in what the speaker is told can be published.
    expect(dialog.textContent).not.toContain(BACKSTAGE_URL)
    expect(dialog.textContent).not.toContain('backstage')
  })

  it('states the fallbacks: provided headshot, and dashes for absent fields', () => {
    renderCard(
      item({
        eventContact: {
          _id: 'ec1' as Id<'eventContacts'>,
          firstName: 'Ada',
          lastName: 'Lovelace',
          headshotUrl: 'https://cdn.example/headshot.png',
        },
      }),
    )
    const dialog = openDialog('Confirm you will speak')
    const values = [...dialog.querySelectorAll('dd')].map((dd) => dd.textContent)
    expect(values).toEqual([
      'Ada Lovelace',
      '—',
      '—',
      'Provided',
      '—',
      'Signals at Scale',
    ])
  })

  it('submits exactly what was previewed when the speaker confirms', async () => {
    renderCard(item())
    const dialog = openDialog('Confirm you will speak')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Confirm you will speak' }),
    )
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        eventSlug: 'devconf',
        participantId: 'p1',
        to: 'confirmed',
      })
    })
  })

  it('previews no profile fields at all when declining', () => {
    renderCard(item())
    const dialog = openDialog('Decline')

    expect(within(dialog).getByText('Decline this session?')).toBeTruthy()
    expect(dialog.querySelectorAll('dt')).toHaveLength(0)
    expect(dialog.textContent).not.toContain('Ada Lovelace')
    expect(
      within(dialog).getByText(
        'Nothing is published for you on this session while it is Declined.',
      ),
    ).toBeTruthy()
  })
})
