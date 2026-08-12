import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { usePending } from './usePending'
import { resetAnnouncements } from './announce'
import type { PendingOptions } from './usePending'
import { LiveRegion } from '~/components/LiveRegion'

// W6. `usePending` is the app's one mechanism for announcing pending→done.
// The interesting cases are the two ends of it: a failure that would otherwise
// be silent must be spoken, and a failure the surface already speaks must not
// be spoken a second time.

let lastRun: ((fn: () => Promise<unknown>) => Promise<boolean>) | null = null

function Harness({ options }: { options?: PendingOptions }) {
  const { run } = usePending(options)
  lastRun = run
  return <LiveRegion />
}

async function runFailing() {
  await act(async () => {
    await lastRun?.(() => Promise.reject(new Error('That slot is taken.')))
    vi.runAllTimers()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  resetAnnouncements()
  lastRun = null
  vi.useRealTimers()
})

describe('usePending announcements', () => {
  test('a failure with no visible outcome component is announced, once', async () => {
    render(<Harness />)
    await runFailing()

    expect(screen.getByRole('alert').textContent).toBe('That slot is taken.')
    // Assertive only: the polite region must not repeat it.
    expect(screen.getByRole('status').textContent).toBe('')
  })

  test('announce:false says nothing — the surface already renders role=alert', async () => {
    render(<Harness options={{ announce: false }} />)
    await runFailing()

    expect(screen.getByRole('alert').textContent).toBe('')
    expect(screen.getByRole('status').textContent).toBe('')
  })

  test('a named action announces pending, then done', async () => {
    render(<Harness options={{ announce: 'Publishing the lineup' }} />)

    await act(async () => {
      await lastRun?.(() => Promise.resolve())
      vi.runAllTimers()
    })

    expect(screen.getByRole('status').textContent).toBe(
      'Publishing the lineup: done.',
    )
  })

  test('a named action puts its name in front of the failure', async () => {
    render(<Harness options={{ announce: 'Publishing the lineup' }} />)
    await runFailing()

    expect(screen.getByRole('alert').textContent).toBe(
      'Publishing the lineup failed. That slot is taken.',
    )
  })

  test('the error is still returned to the caller either way', async () => {
    render(<Harness options={{ announce: false }} />)

    let ok: boolean | undefined
    await act(async () => {
      ok = await lastRun?.(() => Promise.reject(new Error('nope')))
    })

    // Silencing the announcement must not silence the inline message.
    expect(ok).toBe(false)
  })
})
