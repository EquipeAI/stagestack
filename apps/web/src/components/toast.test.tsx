import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LiveRegion } from './LiveRegion'
import { ToastViewport, pushToast } from './toast'
import { announce, resetAnnouncements } from '~/lib/announce'

// W6. The app has exactly ONE pair of live regions, mounted at the document
// root. Everything that has to be spoken goes through them. These tests are as
// much about what does NOT announce — a second region saying the same sentence
// is worse than the silence it was meant to fix.

/** The whole app: the root regions plus a shell that shows toasts. */
function App() {
  return (
    <>
      <LiveRegion />
      <ToastViewport />
    </>
  )
}

function liveRegions(): Array<HTMLElement> {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-live]'))
}

/** How many live regions currently carry `text`. Must never exceed one. */
function announcedBy(text: string): number {
  return liveRegions().filter((r) => r.textContent.includes(text)).length
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  // Toasts live in module state and expire on a timer; drain it so one test's
  // confirmation is not still on screen during the next one.
  act(() => {
    vi.runAllTimers()
  })
  cleanup()
  resetAnnouncements()
  vi.useRealTimers()
})

describe('the app has one pair of live regions', () => {
  test('both are present before anything is said', () => {
    render(<App />)

    const regions = liveRegions()
    expect(regions).toHaveLength(2)
    expect(regions.map((r) => r.getAttribute('aria-live')).sort()).toEqual([
      'assertive',
      'polite',
    ])
  })

  test('showing a toast adds no further live region', () => {
    render(<App />)

    act(() => {
      pushToast('Embed enabled')
      vi.runAllTimers()
    })

    expect(liveRegions()).toHaveLength(2)
  })
})

describe('toasts', () => {
  test('are announced exactly once, through the shared region', () => {
    render(<App />)

    act(() => {
      pushToast('Requirement reactivated', 'New acceptances get this task again.')
      vi.advanceTimersByTime(100)
    })

    expect(
      announcedBy('Requirement reactivated. New acceptances get this task again.'),
    ).toBe(1)
  })

  test('the toast element itself is not a second live region', () => {
    render(<App />)

    act(() => {
      pushToast('Embed disabled')
      vi.advanceTimersByTime(100)
    })

    const viewport = screen.getByRole('group', { name: 'Notifications' })
    const visible = within(viewport).getByText('Embed disabled')
    expect(visible.closest('[aria-live]')).toBeNull()
    expect(visible.closest('[role="status"]')).toBeNull()
    // Still a reachable, named container — the Dismiss button lives in it.
    expect(within(viewport).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  test('the viewport disappears when the last toast does', () => {
    render(<App />)

    act(() => {
      pushToast('Embed disabled')
      vi.advanceTimersByTime(100)
    })
    expect(screen.queryByRole('group', { name: 'Notifications' })).not.toBeNull()

    act(() => {
      vi.runAllTimers()
    })
    expect(screen.queryByRole('group', { name: 'Notifications' })).toBeNull()
    // The regions outlive it: they are the root's, not the viewport's.
    expect(liveRegions()).toHaveLength(2)
  })
})

describe('announce', () => {
  test('a polite message reaches the polite region, and only that one', () => {
    render(<App />)

    act(() => {
      announce('Suggesting a schedule…')
      vi.runAllTimers()
    })

    expect(announcedBy('Suggesting a schedule…')).toBe(1)
    expect(screen.getByRole('status').textContent).toBe('Suggesting a schedule…')
  })

  test('a failure interrupts, and lands in the assertive region only', () => {
    render(<App />)

    act(() => {
      announce('That session is already released.', 'assertive')
      vi.runAllTimers()
    })

    const alert = screen.getByRole('alert')
    expect(alert.getAttribute('aria-live')).toBe('assertive')
    expect(alert.textContent).toBe('That session is already released.')
    expect(announcedBy('That session is already released.')).toBe(1)
    expect(screen.getByRole('status').textContent).toBe('')
  })

  test('the same sentence twice is announced twice', () => {
    render(<App />)

    act(() => {
      announce('Saved.')
      vi.runAllTimers()
    })
    const region = screen.getByRole('status')
    expect(region.textContent).toBe('Saved.')

    act(() => {
      announce('Saved.')
    })
    // Cleared first: a region whose text did not change says nothing, and two
    // attempts with the same outcome are two events.
    expect(region.textContent).toBe('')

    act(() => {
      vi.runAllTimers()
    })
    expect(region.textContent).toBe('Saved.')
  })

  test('an empty message is not an announcement', () => {
    render(<App />)

    act(() => {
      announce('   ')
      vi.runAllTimers()
    })

    expect(screen.getByRole('status').textContent).toBe('')
    expect(screen.getByRole('alert').textContent).toBe('')
  })
})
