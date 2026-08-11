import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DisplayNameGate } from './DisplayNameGate'

const state = vi.hoisted(() => ({
  profile: undefined as
    undefined | { displayName: string | null; needsDisplayName: boolean },
  setDisplayName: vi.fn(),
}))

vi.mock('convex/react', () => ({
  useQuery: () => state.profile,
  useMutation: () => state.setDisplayName,
}))

beforeEach(() => {
  state.profile = undefined
  state.setDisplayName.mockReset()
  state.setDisplayName.mockResolvedValue(null)
})

afterEach(cleanup)

describe('DisplayNameGate', () => {
  test('waits for the authenticated profile before mounting app content', () => {
    render(
      <DisplayNameGate>
        <p>Organizer workspace</p>
      </DisplayNameGate>,
    )

    expect(screen.getByText('Loading your profile…')).toBeTruthy()
    expect(screen.queryByText('Organizer workspace')).toBeNull()
  })

  test('mounts the app immediately when a human display name already exists', () => {
    state.profile = { displayName: 'Avery Chen', needsDisplayName: false }
    render(
      <DisplayNameGate>
        <p>Organizer workspace</p>
      </DisplayNameGate>,
    )

    expect(screen.getByText('Organizer workspace')).toBeTruthy()
    expect(screen.queryByText('Put a name to your work')).toBeNull()
  })

  test('collects a normalized name without showing or prefilling email, then continues reactively', async () => {
    state.profile = { displayName: null, needsDisplayName: true }
    const view = render(
      <DisplayNameGate>
        <p>Organizer workspace</p>
      </DisplayNameGate>,
    )

    const input = screen.getByRole<HTMLInputElement>('textbox', {
      name: /Display name/,
    })
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Avery Chen')
    expect(screen.queryByText(/@/)).toBeNull()
    expect(screen.getByText(/Your sign-in email stays private/i)).toBeTruthy()
    expect(screen.queryByText('Organizer workspace')).toBeNull()

    fireEvent.change(input, { target: { value: 'x'.repeat(201) } })
    expect(input.value).toHaveLength(200)
    fireEvent.change(input, { target: { value: '  Jordan   Alvarez  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    await waitFor(() => {
      expect(state.setDisplayName).toHaveBeenCalledWith({
        displayName: 'Jordan Alvarez',
      })
    })

    state.profile = {
      displayName: 'Jordan Alvarez',
      needsDisplayName: false,
    }
    view.rerender(
      <DisplayNameGate>
        <p>Organizer workspace</p>
      </DisplayNameGate>,
    )
    expect(screen.getByText('Organizer workspace')).toBeTruthy()
  })

  test('keeps the gate in place and surfaces a failed save', async () => {
    state.profile = { displayName: null, needsDisplayName: true }
    state.setDisplayName.mockRejectedValueOnce(
      new Error('Could not save profile.'),
    )
    render(
      <DisplayNameGate>
        <p>Organizer workspace</p>
      </DisplayNameGate>,
    )

    fireEvent.change(screen.getByRole('textbox', { name: /Display name/ }), {
      target: { value: 'Avery Chen' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))

    expect(await screen.findByText('Could not save profile.')).toBeTruthy()
    expect(screen.queryByText('Organizer workspace')).toBeNull()
  })
})
