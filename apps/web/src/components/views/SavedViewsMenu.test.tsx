import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getFunctionName } from 'convex/server'

// The view picker (W2). What is worth breaking the build over:
//   • the picker is a real menu, reachable and operable without a pointer, and
//     it SAYS which view is current — a toolbar reading "Inbox" tells a screen
//     reader nothing about what that word is;
//   • the model's sentences are printed verbatim — the list summary in the
//     menu, the write outcome in the toast;
//   • the personal default applies on a bare URL and NEVER over a link that
//     carries its own filters, because that link is how a view is shared.

type ListResult = {
  module: string
  moduleLabel: string
  views: Array<{
    viewId: string
    name: string
    params: Record<string, string>
    isDefault: boolean
    updatedAt: number
  }>
  defaultViewId: string | null
  summary: string
}

const { state, mutations, toasts } = vi.hoisted(() => ({
  state: { list: undefined as ListResult | undefined },
  mutations: { calls: [] as Array<{ name: string; args: unknown }> },
  toasts: [] as Array<string>,
}))

vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(ref) === 'savedViews:list' ? state.list : undefined,
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref)
    return (args: unknown) => {
      mutations.calls.push({ name, args })
      return Promise.resolve({ viewId: 'v1', message: `did ${name}` })
    }
  },
}))

vi.mock('~/components/toast', () => ({
  pushToast: (title: string) => {
    toasts.push(title)
  },
}))

// eslint-disable-next-line import/first -- vi.mock is hoisted above this
import { SavedViewsMenu } from './SavedViewsMenu'

function listResult(overrides: Partial<ListResult> = {}): ListResult {
  return {
    module: 'proposals',
    moduleLabel: 'Proposals',
    views: [
      {
        viewId: 'v1',
        name: 'Wave 1',
        params: { status: 'pending', sort: 'title' },
        isDefault: false,
        updatedAt: 1,
      },
    ],
    defaultViewId: null,
    summary: '1 saved view on Proposals. None of them opens by default.',
    ...overrides,
  }
}

function mount(
  params: Record<string, string>,
  onApply = vi.fn(),
) {
  render(
    <SavedViewsMenu
      eventSlug="devconf"
      module="proposals"
      params={params}
      onApply={onApply}
    />,
  )
  return onApply
}

afterEach(() => {
  cleanup()
  state.list = undefined
  mutations.calls.length = 0
  toasts.length = 0
})

describe('SavedViewsMenu', () => {
  it('names the current view in its accessible name, not only its text', () => {
    state.list = listResult()
    mount({ status: 'acceptQueue,declineQueue' })
    expect(
      screen.getByRole('button', {
        name: 'Saved views. Current view: Decisions.',
      }),
    ).toBeTruthy()
  })

  it('prints the model’s summary sentence verbatim inside the menu', () => {
    state.list = listResult()
    mount({})
    fireEvent.click(screen.getByRole('button'))
    expect(
      screen.getByText('1 saved view on Proposals. None of them opens by default.'),
    ).toBeTruthy()
  })

  it('offers presets and saved views, and applies the params of the one picked', () => {
    state.list = listResult()
    const onApply = mount({})
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Wave 1/ }))
    expect(onApply).toHaveBeenCalledWith({ status: 'pending', sort: 'title' })

    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Decisions/ }))
    expect(onApply).toHaveBeenLastCalledWith({
      status: 'acceptQueue,declineQueue',
    })
  })

  it('offers rename, default and delete only for a view that is saved', () => {
    state.list = listResult()
    mount({ q: 'ada' })
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('menuitem', { name: 'Rename…' })).toBeNull()
    cleanup()

    mount({ status: 'pending', sort: 'title' })
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('menuitem', { name: 'Rename…' })).toBeTruthy()
    expect(
      screen.getByRole('menuitem', { name: 'Set as my default for this table' }),
    ).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete “Wave 1”' })).toBeTruthy()
  })

  it('saves the params on screen under a name, and reports the model’s sentence', async () => {
    state.list = listResult()
    mount({ status: 'withdrawn' })
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save this view…' }))
    fireEvent.change(screen.getByLabelText('View name'), {
      target: { value: 'Cold cases' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }))
    await waitFor(() => expect(mutations.calls).toHaveLength(1))
    expect(mutations.calls[0]).toEqual({
      name: 'savedViews:create',
      args: {
        eventSlug: 'devconf',
        module: 'proposals',
        name: 'Cold cases',
        params: { status: 'withdrawn' },
      },
    })
    expect(toasts).toEqual(['did savedViews:create'])
  })

  it('applies my default on a bare URL', async () => {
    state.list = listResult({ defaultViewId: 'v1' })
    state.list.views[0].isDefault = true
    const onApply = mount({})
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({ status: 'pending', sort: 'title' }),
    )
  })

  it('NEVER applies my default over a link that carries its own filters', async () => {
    // A shared view is its URL. A default that overrode it would mean the
    // recipient of a link saw a different table than the sender.
    state.list = listResult({ defaultViewId: 'v1' })
    state.list.views[0].isDefault = true
    const onApply = mount({ status: 'withdrawn' })
    await Promise.resolve()
    expect(onApply).not.toHaveBeenCalled()
  })
})
