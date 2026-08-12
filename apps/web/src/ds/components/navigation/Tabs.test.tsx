import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tabs } from './Tabs.jsx'

// The DS tab strip's keyboard contract (closed in W9; deferred by W6).
//
// `role="tablist"` announces "arrow keys move between tabs, Tab leaves the
// strip". These tests are that announcement, made checkable — they belong to
// the DS rather than to any one consumer, because every Tabs caller in the app
// inherits the behaviour.

const TABS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Bravo' },
  { id: 'c', label: 'Charlie' },
]

function Harness({ initial = 'a' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <button type="button">before</button>
      <Tabs aria-label="Sections" tabs={TABS} value={value} onChange={setValue} />
      <button type="button">after</button>
    </>
  )
}

const tab = (name: string) => screen.getByRole('tab', { name })

afterEach(cleanup)

describe('roving tabindex', () => {
  it('puts exactly one tab in the page tab order — the selected one', () => {
    render(<Harness />)
    expect(tab('Alpha').tabIndex).toBe(0)
    expect(tab('Bravo').tabIndex).toBe(-1)
    expect(tab('Charlie').tabIndex).toBe(-1)
  })

  it('moves the tab stop with the selection', () => {
    render(<Harness />)
    fireEvent.click(tab('Charlie'))
    expect(tab('Charlie').tabIndex).toBe(0)
    expect(tab('Alpha').tabIndex).toBe(-1)
  })

  it('keeps a tab stop even when the value names nothing', () => {
    // A stale URL or a still-loading parent must not leave a region with no
    // way in at all.
    render(<Tabs aria-label="Sections" tabs={TABS} value="gone" />)
    expect(tab('Alpha').tabIndex).toBe(0)
  })
})

describe('arrow-key movement', () => {
  it('moves right and left by one', () => {
    render(<Harness />)
    fireEvent.keyDown(tab('Alpha'), { key: 'ArrowRight' })
    expect(tab('Bravo').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('Bravo'))

    fireEvent.keyDown(tab('Bravo'), { key: 'ArrowLeft' })
    expect(tab('Alpha').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('Alpha'))
  })

  it('wraps at both ends', () => {
    render(<Harness />)
    fireEvent.keyDown(tab('Alpha'), { key: 'ArrowLeft' })
    expect(tab('Charlie').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('Charlie'), { key: 'ArrowRight' })
    expect(tab('Alpha').getAttribute('aria-selected')).toBe('true')
  })

  it('jumps to the ends with Home and End', () => {
    render(<Harness initial="b" />)
    fireEvent.keyDown(tab('Bravo'), { key: 'End' })
    expect(tab('Charlie').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('Charlie'), { key: 'Home' })
    expect(tab('Alpha').getAttribute('aria-selected')).toBe('true')
  })

  it('reports the moved-to tab through onChange, once', () => {
    const onChange = vi.fn()
    render(<Tabs aria-label="Sections" tabs={TABS} value="a" onChange={onChange} />)
    fireEvent.keyDown(tab('Alpha'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('leaves other keys to the browser', () => {
    const onChange = vi.fn()
    render(<Tabs aria-label="Sections" tabs={TABS} value="a" onChange={onChange} />)
    // Tab must NOT be swallowed — it is how the strip is exited, and the
    // roving tabindex is what makes one press enough.
    const event = fireEvent.keyDown(tab('Alpha'), { key: 'Tab' })
    expect(event).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(tab('Alpha'), { key: 'ArrowDown' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('survives an empty strip', () => {
    render(<Tabs aria-label="Sections" tabs={[]} value="a" />)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })
})
