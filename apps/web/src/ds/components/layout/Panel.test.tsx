import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Panel } from './Panel.jsx'

// The regression this file exists for: `open={defaultOpen}` on a native
// <details> looks uncontrolled but is not — React rewrites the property on
// every render, so a parent that re-renders (the control center's does, once a
// minute, because `now` ticks) silently reopens a section the reader collapsed.

afterEach(cleanup)

/** What a browser does when the reader collapses a section. */
function collapse(details: HTMLDetailsElement) {
  details.open = false
  fireEvent(details, new Event('toggle'))
}

describe('Panel', () => {
  it('opens by default and honours defaultOpen={false}', () => {
    const { container, unmount } = render(<Panel title="Open one">body</Panel>)
    expect(container.querySelector('details')?.open).toBe(true)
    unmount()

    const closed = render(
      <Panel title="Shut one" defaultOpen={false}>
        body
      </Panel>,
    )
    expect(closed.container.querySelector('details')?.open).toBe(false)
  })

  it('keeps the reader collapsed across a parent re-render', () => {
    const { container, rerender } = render(
      <Panel title="Attention" meta={<span>3 waiting</span>}>
        body
      </Panel>,
    )
    const details = container.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(true)

    collapse(details)
    expect(details.open).toBe(false)

    // The once-a-minute tick: same component, new props.
    rerender(
      <Panel title="Attention" meta={<span>4 waiting</span>}>
        body
      </Panel>,
    )
    expect(container.querySelector('details')?.open).toBe(false)
  })

  it('treats defaultOpen as an INITIAL value, never as a control', () => {
    // The discriminating case. React only writes a DOM property when the
    // rendered value changes — so `open={defaultOpen}` survives a re-render
    // with an unchanged prop, and yanks the section open the moment the prop
    // moves. That is the difference between "uncontrolled" and "uncontrolled
    // until something upstream changes its mind", and only the first one is
    // safe under a parent that re-renders on a clock.
    const { container, rerender } = render(
      <Panel title="Attention" defaultOpen={false}>
        body
      </Panel>,
    )
    expect(container.querySelector('details')?.open).toBe(false)

    rerender(
      <Panel title="Attention" defaultOpen>
        body
      </Panel>,
    )
    expect(container.querySelector('details')?.open).toBe(false)
  })
})
