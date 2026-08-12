import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Switch } from '~/ds'

// W6: a switch with no accessible name is announced as "switch, on" and the
// setting it controls is invisible to a screen reader. The .d.ts makes that a
// type error; these tests cover the runtime backstop and the three namings.

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Switch accessible name', () => {
  test('a visible label names the control', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Switch label="Require organizer review" />)

    expect(screen.getByRole('switch', { name: 'Require organizer review' })).toBeTruthy()
    expect(error).not.toHaveBeenCalled()
  })

  test('aria-label names a switch whose title is rendered elsewhere', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Switch aria-label="Embed enabled: Track feed" />)

    expect(screen.getByRole('switch', { name: 'Embed enabled: Track feed' })).toBeTruthy()
    expect(error).not.toHaveBeenCalled()
  })

  test('aria-labelledby points at the name already on screen', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <>
        <span id="row-title">Public page</span>
        <Switch aria-labelledby="row-title" />
      </>,
    )

    expect(screen.getByRole('switch', { name: 'Public page' })).toBeTruthy()
    expect(error).not.toHaveBeenCalled()
  })

  test('aria-label wins over the visible state word, and keeps it inside the name', () => {
    render(<Switch label="Active" aria-label="Active — Headshot" />)

    // WCAG 2.5.3 Label in Name: the visible word is contained in the
    // accessible name, so voice control still reaches it by what it reads.
    const control = screen.getByRole('switch', { name: 'Active — Headshot' })
    expect(control).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
  })

  test('an unnamed switch reports in development and still renders', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The type contract forbids this; the cast is what a JS call site or a
    // label that is only empty at runtime would produce.
    const Unnamed = Switch as (props: Record<string, unknown>) => React.ReactElement
    render(<Unnamed checked={false} readOnly />)

    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('no accessible name')
    // Reporting, never removing: a control that vanished would be worse.
    expect(screen.getByRole('switch')).toBeTruthy()
  })

  test('a label that is blank at runtime counts as unnamed', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Switch label="   " />)

    expect(error).toHaveBeenCalledTimes(1)
  })
})
