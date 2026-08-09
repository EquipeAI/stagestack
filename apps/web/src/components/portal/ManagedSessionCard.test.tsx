import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Id } from '@convex/_generated/dataModel'
import type { ManagingItem } from './model'

// The card renders values that arrive from a live Convex subscription, so an
// organizer editing the same session pushes new props mid-typing. Unsaved text
// belongs to the manager: it must survive that, and the manager must be told
// the server moved rather than have it applied silently.

const { mutate } = vi.hoisted(() => ({
  mutate: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('convex/react', () => ({
  useMutation: () => mutate,
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { ManagedSessionCard } from './ManagedSessionCard'

function item(over: Partial<ManagingItem> = {}): ManagingItem {
  return {
    sessionId: 's1' as Id<'sessions'>,
    title: 'Signals at Scale',
    description: 'A talk about signals.',
    format: 'Talk',
    source: 'cfp',
    status: 'planned',
    participants: [],
    ...over,
  }
}

function renderCard(managing: ManagingItem) {
  return render(
    <ManagedSessionCard eventSlug="devconf" item={managing} readOnly={false} />,
  )
}

function startEditing() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit session content' }))
}

function titleInput() {
  return screen.getByLabelText<HTMLInputElement>(/Session title/)
}

afterEach(() => {
  cleanup()
  mutate.mockClear()
})

describe('ManagedSessionCard editing vs the live query', () => {
  it('keeps unsaved typing when the server values change underneath', () => {
    const { rerender } = renderCard(item())
    startEditing()
    fireEvent.change(titleInput(), { target: { value: 'My unsaved title' } })

    rerender(
      <ManagedSessionCard
        eventSlug="devconf"
        item={item({ title: 'Organizer renamed it', description: 'Theirs.' })}
        readOnly={false}
      />,
    )

    expect(titleInput().value).toBe('My unsaved title')
    expect(
      screen.getByLabelText<HTMLTextAreaElement>(/Description/).value,
    ).toBe('A talk about signals.')
    expect(screen.getByText('This session changed somewhere else')).toBeTruthy()
  })

  it('takes the server values when the card is not being edited', () => {
    const { rerender } = renderCard(item())
    rerender(
      <ManagedSessionCard
        eventSlug="devconf"
        item={item({ title: 'Organizer renamed it' })}
        readOnly={false}
      />,
    )
    startEditing()
    expect(titleInput().value).toBe('Organizer renamed it')
    expect(screen.queryByText('This session changed somewhere else')).toBeNull()
  })

  it('discarding adopts the newer server values', () => {
    const { rerender } = renderCard(item())
    startEditing()
    fireEvent.change(titleInput(), { target: { value: 'My unsaved title' } })
    rerender(
      <ManagedSessionCard
        eventSlug="devconf"
        item={item({ title: 'Organizer renamed it' })}
        readOnly={false}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Discard my edits' }))

    expect(titleInput().value).toBe('Organizer renamed it')
    expect(screen.queryByText('This session changed somewhere else')).toBeNull()
  })

  it('saves the manager\'s own text, not the value that arrived meanwhile', async () => {
    const { rerender } = renderCard(item())
    startEditing()
    fireEvent.change(titleInput(), { target: { value: 'My unsaved title' } })
    rerender(
      <ManagedSessionCard
        eventSlug="devconf"
        item={item({ title: 'Organizer renamed it' })}
        readOnly={false}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save session' }))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        eventSlug: 'devconf',
        sessionId: 's1',
        patch: {
          title: 'My unsaved title',
          description: 'A talk about signals.',
          format: 'Talk',
        },
      })
    })
  })
})
