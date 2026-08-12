import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { planBulk } from '@convex/shared/bulkDecisions'
import { planOutreach } from '@convex/shared/bulkOutreach'
import { BatchBar } from './BatchBar.jsx'
import { Button } from '../core/Button.jsx'

// W12 promotes the proposals bulk bar into the design system. What matters is
// not that it moved but that the numbers it prints are the PRODUCER's: these
// feed it the same plan objects convex/shared/* hand the mutation, so a bar
// that says "3 eligible" cannot belong to a call that moves five.

afterEach(() => {
  cleanup()
})

describe('BatchBar', () => {
  it('states the selection and eligibility from a bulkDecisions plan', () => {
    // Two stageable, one already released, one withdrawn.
    const plan = planBulk(
      ['pending', 'acceptQueue', 'accepted', 'withdrawn'],
      { kind: 'stage', to: 'acceptQueue' },
    )
    render(
      <BatchBar
        noun="proposal"
        count={plan.selected}
        eligible={plan.eligible}
        exclusions={plan.excluded}
      />,
    )

    expect(screen.getByText('4 proposals selected · 2 eligible')).toBeTruthy()
    // The exclusions are the producer's words, printed unchanged.
    const excluded = document.querySelector('.ss-batchbar__excluded')
    expect(excluded?.textContent).toContain(
      'already released — correct it individually instead',
    )
    expect(excluded?.textContent).toContain('withdrawn')
  })

  it('states the CRM audience from a bulkOutreach plan, including its refusal', () => {
    const plan = planOutreach([{ email: 'a@example.com' }])
    render(
      <BatchBar
        noun="contact"
        count={plan.selected}
        eligible={plan.eligible}
        exclusions={plan.excluded}
        summary={plan.blocked ?? undefined}
      />,
    )
    expect(screen.getByText('1 contact selected · 1 eligible')).toBeTruthy()
    // The bar disables itself against the backend's own sentence rather than
    // a copy of the rule.
    expect(
      screen.getByText('Select between 2 and 25 contacts.'),
    ).toBeTruthy()
  })

  it('says nothing about exclusions when there are none', () => {
    const plan = planOutreach([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ])
    render(
      <BatchBar count={plan.selected} eligible={plan.eligible} exclusions={plan.excluded} />,
    )
    expect(document.querySelector('.ss-batchbar__excluded')).toBeNull()
  })

  it('is a labelled region with actions and a way out of the selection', () => {
    const clear = vi.fn()
    const send = vi.fn()
    render(
      <BatchBar
        label="Contact bulk actions"
        noun="contact"
        count={3}
        onClear={clear}
        actions={<Button size="sm" onClick={send}>Email selected</Button>}
      />,
    )
    expect(screen.getByRole('region', { name: 'Contact bulk actions' })).toBeTruthy()
    fireEvent.click(screen.getByText('Email selected'))
    expect(send).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Clear'))
    expect(clear).toHaveBeenCalled()
  })

  it('leaves the last table row reachable under the pinned bar', () => {
    render(<BatchBar count={1} />)
    expect(document.querySelector('.ss-batchbar__spacer')).toBeTruthy()
  })
})
