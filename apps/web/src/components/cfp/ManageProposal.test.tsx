import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type * as React from 'react'
import type { Doc, Id } from '@convex/_generated/dataModel'

const { mutation, navigate } = vi.hoisted(() => ({
  mutation: vi.fn(),
  navigate: vi.fn(() => Promise.resolve()),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Link: ({ children }: { children: React.ReactNode }) => children,
  useNavigate: () => navigate,
}))

vi.mock('@clerk/tanstack-react-start', () => ({
  Show: ({ children }: { children: React.ReactNode }) => children,
  SignInButton: ({ children }: { children: React.ReactNode }) => children,
  useUser: () => ({ user: null }),
}))

vi.mock('convex/react', () => ({
  useMutation: () => mutation,
  useQuery: () => undefined,
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import {
  ManageProposal,
  manageProposalKey,
} from '../../routes/cfp.$eventSlug.proposal.$proposalId'

type MyProposalView = FunctionReturnType<typeof api.cfp.getMyProposal>

const PROPOSAL_ID = 'proposal-1' as Id<'proposals'>
const EVENT_ID = 'event-1' as Id<'events'>
const USER_ID = 'user-1' as Id<'users'>

function speaker(
  id: string,
  order: number,
  firstName: string,
  lastName: string,
  role?: string,
): Doc<'proposalSpeakers'> {
  return {
    _id: id as Id<'proposalSpeakers'>,
    _creationTime: order + 1,
    proposalId: PROPOSAL_ID,
    eventId: EVENT_ID,
    order,
    firstName,
    lastName,
    isPrimary: order === 0,
    role,
  }
}

function proposalView(
  contentVersion: number,
  speakers: Array<Doc<'proposalSpeakers'>>,
): MyProposalView {
  const now = Date.now()
  return {
    proposal: {
      _id: PROPOSAL_ID,
      _creationTime: 1,
      eventId: EVENT_ID,
      submitterUserId: USER_ID,
      status: 'accepted',
      title: 'Taming 40-Minute CI',
      answers: {},
      formVersion: 1,
      contentVersion,
      submittedAt: now - 60_000,
      updatedAt: now,
      reopenedUntil: now + 60 * 60_000,
    },
    speakers,
    form: { sections: [] },
    formVersion: 1,
    event: {
      name: 'DevFlow Conf 2027',
      slug: 'devflow-conf',
      timezone: 'UTC',
      cfpPublished: true,
      cfpCloseAt: now + 60 * 60_000,
    },
    windowOpen: true,
  }
}

function addMarcus(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Add speaker' }))
  const firstNames = screen.getAllByLabelText<HTMLInputElement>(/First name/)
  const lastNames = screen.getAllByLabelText<HTMLInputElement>(/Last name/)
  fireEvent.change(firstNames[1], { target: { value: 'Marcus' } })
  fireEvent.change(lastNames[1], { target: { value: 'Okafor' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), {
    target: { value: 'Co-author' },
  })
}

function proposal(data: MyProposalView) {
  return (
    <ManageProposal
      key={manageProposalKey(data)}
      eventSlug="devflow-conf"
      data={data}
    />
  )
}

afterEach(() => {
  cleanup()
  mutation.mockReset()
  navigate.mockClear()
})

describe('accepted proposal mounted resubmits', () => {
  it('re-seeds server speaker ids before a second resubmit in the same view', async () => {
    let finishFirst: ((value: { successMessage: null }) => void) | undefined
    mutation
      .mockImplementationOnce(
        () =>
          new Promise<{ successMessage: null }>((resolve) => {
            finishFirst = resolve
          }),
      )
      .mockResolvedValue({ successMessage: null })

    const initial = proposalView(0, [
      speaker('speaker-priya', 0, 'Priya', 'Raman'),
    ])
    const view = render(proposal(initial))
    addMarcus()

    fireEvent.click(screen.getByRole('button', { name: 'Save & resubmit' }))
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy()
    // A successful remount cannot discard keystrokes made after the submitted
    // snapshot: the editor freezes while that snapshot is in flight.
    expect(
      screen.getAllByLabelText<HTMLInputElement>(/First name/)[1].disabled,
    ).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Add speaker' })
        .disabled,
    ).toBe(true)

    await act(() => {
      finishFirst?.({ successMessage: null })
      return Promise.resolve()
    })
    await waitFor(() => {
      expect(mutation).toHaveBeenCalledTimes(1)
    })
    expect(mutation.mock.calls[0]?.[0]).toMatchObject({
      proposalId: PROPOSAL_ID,
      expectedContentVersion: 0,
    })
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Refreshing…' })
        .disabled,
    ).toBe(true)

    const persisted = proposalView(1, [
      speaker('speaker-priya', 0, 'Priya', 'Raman'),
      speaker('speaker-marcus', 1, 'Marcus', 'Okafor', 'Co-author'),
    ])
    // The outer render stays mounted; the production revision key deliberately
    // replaces only the reconciled proposal editor beneath it.
    view.rerender(proposal(persisted))
    expect(
      screen
        .getAllByLabelText<HTMLInputElement>(/First name/)
        .map((input) => input.value),
    ).toEqual(['Priya', 'Marcus'])

    fireEvent.click(screen.getByRole('button', { name: 'Save & resubmit' }))
    await waitFor(() => {
      expect(mutation).toHaveBeenCalledTimes(2)
    })
    expect(mutation.mock.calls[1]?.[0]).toMatchObject({
      proposalId: PROPOSAL_ID,
      expectedContentVersion: 1,
      speakers: [
        expect.objectContaining({ proposalSpeakerId: 'speaker-priya' }),
        expect.objectContaining({
          proposalSpeakerId: 'speaker-marcus',
          firstName: 'Marcus',
          role: 'Co-author',
        }),
      ],
    })
  })

  it('keeps local edits and the visible error when resubmit fails', async () => {
    mutation.mockRejectedValueOnce(new Error('The resubmit was refused.'))
    const data = proposalView(0, [
      speaker('speaker-priya', 0, 'Priya', 'Raman'),
    ])
    render(proposal(data))
    addMarcus()

    fireEvent.click(screen.getByRole('button', { name: 'Save & resubmit' }))

    expect(
      await screen.findByText('This proposal was not submitted'),
    ).toBeTruthy()
    expect(screen.getByText('The resubmit was refused.')).toBeTruthy()
    expect(
      screen
        .getAllByLabelText<HTMLInputElement>(/First name/)
        .map((input) => input.value),
    ).toEqual(['Priya', 'Marcus'])
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Save & resubmit' })
        .disabled,
    ).toBe(false)
  })
})
