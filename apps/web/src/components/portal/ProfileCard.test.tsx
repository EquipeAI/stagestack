import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ProfileCard } from './ProfileCard'
import type { PortalProfile } from './model'
import type { Id } from '@convex/_generated/dataModel'

vi.mock('@clerk/tanstack-react-start', () => ({
  useAuth: () => ({ getToken: vi.fn() }),
}))

vi.mock('convex/react', () => ({
  useMutation: () => vi.fn(() => Promise.resolve(null)),
}))

function profile(overrides: Partial<PortalProfile> = {}): PortalProfile {
  return {
    _id: 'event-contact-id',
    firstName: 'Dana',
    lastName: 'Keynote',
    bio: 'Server bio',
    headshotUrl: null,
    ...overrides,
  } as PortalProfile
}

describe('ProfileCard reactivity', () => {
  test('headshot attach/remove updates preserve an unsaved text draft', () => {
    const initial = profile()
    const view = render(
      <ProfileCard eventSlug="summit" profile={initial} readOnly={false} />,
    )
    const bio = screen.getByLabelText('Bio')
    fireEvent.change(bio, { target: { value: 'Unsaved draft bio' } })

    view.rerender(
      <ProfileCard
        eventSlug="summit"
        profile={profile({
          headshotId: 'new-storage-id' as Id<'_storage'>,
          headshotUrl: 'https://files.example.test/new',
        })}
        readOnly={false}
      />,
    )
    expect(screen.getByLabelText<HTMLTextAreaElement>('Bio').value).toBe(
      'Unsaved draft bio',
    )

    view.rerender(
      <ProfileCard
        eventSlug="summit"
        profile={profile({ headshotId: undefined, headshotUrl: null })}
        readOnly={false}
      />,
    )
    expect(screen.getByLabelText<HTMLTextAreaElement>('Bio').value).toBe(
      'Unsaved draft bio',
    )
  })
})
