import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MenuButton } from './MenuButton.jsx'

// W12 moves every row action past the second into an overflow menu, and the
// W6 audit named menus as the last piece of open ground in the keyboard
// story. So this menu has to be operable without a mouse: arrows to move,
// Home/End to jump, Escape to leave, and focus back on the trigger every time
// it closes — otherwise the keyboard lands at the top of the document and the
// organizer has to tab back through the whole table.

function renderMenu(onSelect = vi.fn()) {
  render(
    <MenuButton
      label="More actions for Convex in anger"
      items={[
        { id: 'workspace', label: 'Open the workspace', onSelect },
        { id: 'content', label: 'Review the content', onSelect },
        { id: 'proposal', label: 'Open the source proposal', onSelect },
      ]}
    />,
  )
  return screen.getByRole('button', { name: 'More actions for Convex in anger' })
}

afterEach(() => {
  cleanup()
})

describe('MenuButton', () => {
  it('announces itself as a menu trigger and its open state', () => {
    const trigger = renderMenu()
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)
  })

  it('puts focus on the first item so the first arrow press is not wasted', () => {
    fireEvent.click(renderMenu())
    expect(document.activeElement?.textContent).toBe('Open the workspace')
  })

  it('moves with the arrows and wraps at both ends', () => {
    const trigger = renderMenu()
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Review the content')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Open the source proposal')
    // Past the end is the beginning, not a dead stop.
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Open the workspace')
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement?.textContent).toBe('Open the source proposal')
  })

  it('jumps to the ends with Home and End', () => {
    fireEvent.click(renderMenu())
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement?.textContent).toBe('Open the source proposal')
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement?.textContent).toBe('Open the workspace')
  })

  it('closes on Escape and gives focus back to the trigger', () => {
    const trigger = renderMenu()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on choosing, returns focus, and runs the action', () => {
    const onSelect = vi.fn()
    const trigger = renderMenu(onSelect)
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('Review the content'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('is a single tab stop with roving focus — the ACTIVE item carries it', () => {
    const trigger = renderMenu()
    fireEvent.click(trigger)
    const tabIndexes = () =>
      screen.getAllByRole('menuitem').map((i) => i.getAttribute('tabindex'))

    // Exactly one item is tabbable, and it is the focused one — otherwise Tab
    // walks through the menu instead of leaving it.
    expect(tabIndexes()).toEqual(['0', '-1', '-1'])

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(tabIndexes()).toEqual(['-1', '0', '-1'])
    expect(document.activeElement?.textContent).toBe('Review the content')

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' })
    expect(tabIndexes()).toEqual(['-1', '-1', '0'])
  })

  it('closes when Tab takes focus out of the panel', async () => {
    const trigger = renderMenu()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    // The browser moves focus; the menu closes once it has landed outside.
    ;(document.activeElement as HTMLElement).blur()
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })

  it('closes on Shift+Tab back onto the trigger', async () => {
    // The trigger lives inside the menu's own container, so a containment
    // check against the host would have kept the menu open behind a focus
    // ring that had already left it.
    const trigger = renderMenu()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab', shiftKey: true })
    trigger.focus()
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('opens downward from the trigger with the down arrow', () => {
    const trigger = renderMenu()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('skips disabled items when arrowing', () => {
    render(
      <MenuButton
        label="Row actions"
        items={[
          { id: 'a', label: 'First', onSelect: vi.fn() },
          { id: 'b', label: 'Blocked', onSelect: vi.fn(), disabled: true },
          { id: 'c', label: 'Third', onSelect: vi.fn() },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Row actions' }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Third')
  })
})
