import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { varsForContext } from '@convex/shared/templateVars'
import { TokenPalette, insertAtCursor } from './TokenPalette'

// The palette is the promise the composer makes about personalisation, so the
// two things tested here are the two that would break that promise: offering a
// token the send site does not pass, and stealing the caret.

afterEach(cleanup)

function matchMedia(narrow: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: narrow,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  })
}

describe('insertAtCursor', () => {
  test('inserts at the caret, keeps focus and leaves the caret after it', () => {
    const field = document.createElement('textarea')
    document.body.append(field)
    field.value = '<p>Hi ,</p>'
    field.setSelectionRange(6, 6)

    const onChange = vi.fn()
    insertAtCursor(field, '{{speaker.firstName}}', onChange)

    expect(onChange).toHaveBeenCalledWith('<p>Hi {{speaker.firstName}},</p>')
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(6 + '{{speaker.firstName}}'.length)
    expect(field.selectionEnd).toBe(field.selectionStart)
    field.remove()
  })

  test('replaces the selection rather than appending beside it', () => {
    const field = document.createElement('input')
    document.body.append(field)
    field.value = 'Hello NAME'
    field.setSelectionRange(6, 10)

    const onChange = vi.fn()
    insertAtCursor(field, '{{speaker.fullName}}', onChange)
    expect(onChange).toHaveBeenCalledWith('Hello {{speaker.fullName}}')
    field.remove()
  })

  test('a missing field is a no-op, not a crash', () => {
    const onChange = vi.fn()
    insertAtCursor(null, '{{link}}', onChange)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('TokenPalette', () => {
  test('offers exactly the tokens that context resolves, as named buttons', () => {
    matchMedia(false)
    render(
      <TokenPalette
        contextKey="decision.accepted"
        targetLabel="body"
        onInsert={() => {}}
      />,
    )

    for (const path of varsForContext('decision.accepted')) {
      expect(screen.getByText(`{{${path}}}`)).toBeTruthy()
    }
    // A decision send passes no speaker, so the palette must not offer one.
    expect(screen.queryByText('{{speaker.firstName}}')).toBeNull()
  })

  test('each token button has an accessible name saying what it inserts', () => {
    matchMedia(false)
    render(
      <TokenPalette
        contextKey="portal.invite"
        targetLabel="body"
        onInsert={() => {}}
      />,
    )
    const button = screen.getByRole('button', {
      name: 'Insert speaker first name token',
    })
    expect(button.textContent).toBe('{{speaker.firstName}}')
  })

  test('clicking a token reports its path', () => {
    matchMedia(false)
    const onInsert = vi.fn()
    render(
      <TokenPalette
        contextKey="portal.invite"
        targetLabel="body"
        onInsert={onInsert}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Insert event name token' }),
    )
    expect(onInsert).toHaveBeenCalledWith('event.name')
  })

  test('on a phone the tokens live in a sheet behind one button', () => {
    matchMedia(true)
    const onInsert = vi.fn()
    render(
      <TokenPalette
        contextKey="portal.invite"
        targetLabel="body"
        onInsert={onInsert}
      />,
    )

    // Nothing is listed until the sheet is opened…
    expect(screen.queryByText('{{event.name}}')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Insert a token' }))

    // …and choosing one closes the sheet and inserts.
    fireEvent.click(
      screen.getByRole('button', { name: 'Insert event name token' }),
    )
    expect(onInsert).toHaveBeenCalledWith('event.name')
    expect(screen.queryByText('{{event.name}}')).toBeNull()
  })
})
