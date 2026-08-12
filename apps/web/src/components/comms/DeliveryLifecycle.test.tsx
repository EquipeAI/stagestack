import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryLifecycle, DeliveryPill } from './DeliveryLifecycle'
import { DELIVERY_STATUS, didNotReach } from './model'
import type { DeliveryStatus } from './model'

afterEach(cleanup)

// The statuses the Resend webhook actually writes (convex/emails.ts
// DELIVERY_STATUS_BY_EVENT) plus the `queued` row model/comms.ts starts at.
const WEBHOOK_STATUSES: Array<DeliveryStatus> = [
  'queued',
  'sent',
  'delivered',
  'delivery_delayed',
  'bounced',
  'complained',
  'failed',
]

describe('delivery lifecycle', () => {
  test('every status the webhook writes has a label, and only queued says Queued', () => {
    for (const status of WEBHOOK_STATUSES) {
      expect(DELIVERY_STATUS[status]).toBeDefined()
    }
    // The review's actual complaint: mail Gmail had already received rendered
    // as "Queued". A provider-accepted row must never claim that again.
    expect(DELIVERY_STATUS.sent.label).toBe('Sent — delivery unconfirmed')
    for (const status of WEBHOOK_STATUSES) {
      if (status === 'queued') continue
      expect(DELIVERY_STATUS[status].label).not.toBe('Queued')
    }
    expect(DELIVERY_STATUS.delivered.label).toBe('Delivered')
    expect(DELIVERY_STATUS.delivery_delayed.label).toContain('Delayed')
    expect(DELIVERY_STATUS.bounced.failed).toBe(true)
    expect(DELIVERY_STATUS.complained.failed).toBe(true)
    expect(DELIVERY_STATUS.failed.failed).toBe(true)
    expect(DELIVERY_STATUS.sent.failed).toBe(false)
  })

  test('complained means delivered THEN reported as spam, so it never counts as "did not reach"', () => {
    expect(DELIVERY_STATUS.complained.reached).toBe(true)
    expect(DELIVERY_STATUS.complained.label).toBe(
      'Delivered, then marked as spam',
    )
    expect(DELIVERY_STATUS.complained.detail).toContain('received it')
    // The comms log subtitle counts exactly this predicate.
    expect(didNotReach('complained')).toBe(false)
    expect(didNotReach('delivered')).toBe(false)
    expect(didNotReach('bounced')).toBe(true)
    expect(didNotReach('failed')).toBe(true)
    // Unknown is not failure: neither of these has been given up on.
    expect(didNotReach('sent')).toBe(false)
    expect(didNotReach('delivery_delayed')).toBe(false)
    expect(didNotReach('queued')).toBe(false)
  })

  test("the final step carries the provider's own timestamp, in event time", () => {
    const providerAt = Date.parse('2026-08-11T12:32:00Z')
    render(
      <DeliveryLifecycle
        status="delivered"
        timezone="Europe/Berlin"
        updatedAt={providerAt}
      />,
    )
    const steps = screen.getAllByRole('listitem')
    // 14:32 in Berlin, not 12:32 UTC, and the zone is on the string.
    expect(steps[2].textContent).toContain('14:32')
    expect(steps[2].textContent).toContain('11 Aug 2026')
  })

  test('no provider event means no claimed timestamp', () => {
    render(<DeliveryLifecycle status="sent" timezone="UTC" />)
    expect(screen.getAllByRole('listitem')[1].textContent).not.toContain('·')
  })

  test('a provider-accepted send shows acceptance reached and delivery not reached', () => {
    render(<DeliveryLifecycle status="sent" timezone="UTC" />)
    const steps = screen.getAllByRole('listitem')
    expect(steps).toHaveLength(3)
    expect(steps[0].textContent).toContain('Queued — done')
    expect(steps[1].textContent).toContain('Provider accepted — current')
    expect(steps[2].textContent).toContain('Delivered — not reached')
  })

  test('the last step is named by the outcome that actually happened', () => {
    render(<DeliveryLifecycle status="bounced" timezone="UTC" />)
    const steps = screen.getAllByRole('listitem')
    expect(steps[2].textContent).toContain('Bounced')
    expect(steps[2].textContent).toContain('failed')
    expect(steps[2].textContent).not.toContain('Delivered —')
  })

  test('it is a vertical list at every width, never a horizontal stepper', () => {
    const { container } = render(
      <DeliveryLifecycle status="delivered" timezone="UTC" />,
    )
    const list = container.querySelector('ol')
    expect(list?.style.flexDirection).toBe('column')
  })

  test('the pill states the delivery label rather than the raw status', () => {
    render(<DeliveryPill status="delivery_delayed" />)
    expect(
      screen.getByText(DELIVERY_STATUS.delivery_delayed.label),
    ).toBeTruthy()
  })
})
