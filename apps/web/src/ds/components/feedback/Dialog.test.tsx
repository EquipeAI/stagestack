import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Button, Dialog } from '~/ds'

// W6: a modal that does not hold focus leaves a keyboard user tabbing the page
// behind the scrim, and one that does not give focus back drops them at the top
// of the document. Both are assertable in jsdom.

afterEach(cleanup)

function Harness({ title = 'Place session' }: { title?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Elsewhere</button>
      <Dialog
        open={open}
        title={title}
        onClose={() => setOpen(false)}
        footer={<Button onClick={() => setOpen(false)}>Save</Button>}
      >
        <input aria-label="Start time" />
      </Dialog>
    </>
  )
}

describe('Dialog focus management', () => {
  test('focus moves into the dialog on open and back to the opener on close', () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    // First focusable in DOM order is the header close button.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close' }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  test('Tab from the last focusable wraps to the first, and Shift+Tab back', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    const close = screen.getByRole('button', { name: 'Close' })
    const save = screen.getByRole('button', { name: 'Save' })
    const dialog = screen.getByRole('dialog')

    save.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    close.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(save)
  })

  test('Escape closes and returns focus', () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  test('the surface is labelled by its own title and is itself focusable', () => {
    render(<Harness title="Restore snapshot" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    const dialog = screen.getByRole('dialog', { name: 'Restore snapshot' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // Needed so a dialog with no focusable content can still receive focus
    // rather than leaving it on the page behind the scrim.
    expect(dialog.getAttribute('tabindex')).toBe('-1')
  })

  test('a dialog with nothing focusable takes focus itself and keeps Tab inside', () => {
    render(
      <Dialog open title="Working">
        <p>Preparing the export.</p>
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)

    const prevented = fireEvent.keyDown(dialog, { key: 'Tab' })
    // fireEvent returns false when the handler called preventDefault.
    expect(prevented).toBe(false)
    expect(document.activeElement).toBe(dialog)
  })

  test('hidden controls are never Tab stops, even when nothing has geometry', () => {
    // jsdom reports zero geometry for everything, which is the same signal a
    // browser gives before layout. The trap falls back to checks that need no
    // measurement — it must not fall back to "everything in the DOM".
    render(
      <Dialog open title="Place session" onClose={() => {}}>
        <input aria-label="Start time" />
        <div style={{ display: 'none' }}>
          <button type="button">In a collapsed section</button>
        </div>
        <div aria-hidden="true">
          <button type="button">Decorative</button>
        </div>
        <button type="button" hidden>
          Hidden attribute
        </button>
        <button type="button" disabled>
          Not yet available
        </button>
        <button type="button">Save</button>
      </Dialog>,
    )

    const dialog = screen.getByRole('dialog')
    const save = screen.getByRole('button', { name: 'Save' })
    const close = screen.getByRole('button', { name: 'Close' })

    // Save is the last real focusable, so Tab from it wraps to the first.
    save.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    // And Shift+Tab from the first lands back on Save, not on anything hidden.
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(save)
  })

  test('a bottom sheet is the same dialog and behaves the same', () => {
    // Below 640px `.ss-dialog` is styled as a bottom sheet in feedback.css;
    // the element, its roles and its focus handling are unchanged, so the
    // contract asserted above holds in sheet mode too.
    const onClose = vi.fn()
    render(
      <Dialog open title="Place session" onClose={onClose}>
        <input aria-label="Room" />
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('ss-dialog')
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close' }),
    )

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
