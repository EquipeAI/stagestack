import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ActionResult } from '~/ds'

// W5: the persistent-result pattern. What matters is that the outcome and its
// arithmetic stay on screen, that a retry appears only when retrying is
// meaningful, and that the result can be dismissed — the three things a toast
// cannot do.

afterEach(cleanup)

describe('ActionResult', () => {
  test('renders the outcome and every arithmetic line, and announces itself', () => {
    render(
      <ActionResult
        status="partial"
        title="8 proposals released"
        details={[
          '10 proposals selected · 9 eligible.',
          '1 proposal is withdrawn — left alone.',
          '',
        ]}
      />,
    )

    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(screen.getByText('8 proposals released')).toBeTruthy()
    expect(
      screen.getByText('10 proposals selected · 9 eligible.'),
    ).toBeTruthy()
    // Falsy lines are dropped rather than rendered as empty bullets.
    expect(region.querySelectorAll('li')).toHaveLength(2)
  })

  test('offers a retry only when one is given, and reports it while pending', () => {
    const onRetry = vi.fn()
    const { rerender } = render(
      <ActionResult status="failed" title="Export failed" onRetry={onRetry} />,
    )
    fireEvent.click(screen.getByText('Try again'))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(
      <ActionResult
        status="failed"
        title="Export failed"
        onRetry={onRetry}
        retryPending
      />,
    )
    expect(screen.getByText('Retrying…')).toBeTruthy()
  })

  test('a successful result carries no retry and can be dismissed', () => {
    const onDismiss = vi.fn()
    render(
      <ActionResult
        status="success"
        title="CSV downloaded"
        onDismiss={onDismiss}
      />,
    )
    expect(screen.queryByText('Try again')).toBeNull()
    fireEvent.click(screen.getByText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  test('tone follows the status so a failure never reads as a success', () => {
    const { container, rerender } = render(
      <ActionResult status="success" title="Done" />,
    )
    expect(
      container.querySelector('.ss-callout--success'),
    ).not.toBeNull()
    rerender(<ActionResult status="partial" title="Some of it" />)
    expect(container.querySelector('.ss-callout--attention')).not.toBeNull()
    rerender(<ActionResult status="failed" title="None of it" />)
    expect(container.querySelector('.ss-callout--blocked')).not.toBeNull()
  })
})
