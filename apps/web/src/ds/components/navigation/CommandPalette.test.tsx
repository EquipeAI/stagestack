import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CommandPalette } from '~/ds'

// The palette primitive, independent of what fills it. The combobox contract
// is the thing worth pinning: focus never leaves the field, the highlight is
// named by aria-activedescendant, and the highlight follows the results
// rather than pointing at a row that stopped existing.

afterEach(cleanup)

const GROUPS = [
  {
    id: 'go',
    label: 'Go to',
    items: [
      { id: 'a', label: 'Sessions', hint: 'Prepare' },
      { id: 'b', label: 'Speakers', hint: 'Prepare' },
    ],
  },
  {
    id: 'events',
    label: 'Events',
    items: [{ id: 'c', label: 'Acme Summit' }],
  },
]

function Harness({
  groups = GROUPS,
  onSelect = () => {},
}: {
  groups?: typeof GROUPS
  onSelect?: (id: string) => void
}) {
  const [value, setValue] = useState('')
  return (
    <CommandPalette
      open
      title="Search"
      label="Search everything"
      value={value}
      onValueChange={setValue}
      status="3 results in 2 groups."
      groups={groups}
      onSelect={onSelect}
      onClose={() => {}}
    />
  )
}

describe('CommandPalette', () => {
  test('is a dialog holding a labelled combobox over a listbox', () => {
    render(<Harness />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    const field = screen.getByRole('combobox', { name: 'Search everything' })
    const list = screen.getByRole('listbox')
    expect(field.getAttribute('aria-controls')).toBe(list.getAttribute('id'))
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByRole('group', { name: 'Events' })).toBeTruthy()
  })

  test('describes the field with the status sentence', () => {
    render(<Harness />)
    const field = screen.getByRole('combobox')
    const describedBy = field.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      '3 results in 2 groups.',
    )
  })

  test('arrows wrap around and keep the keyboard in the field', () => {
    render(<Harness />)
    const field = screen.getByRole('combobox')
    field.focus()
    const ids = screen.getAllByRole('option').map((row) => row.id)

    expect(field.getAttribute('aria-activedescendant')).toBe(ids[0])
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    expect(field.getAttribute('aria-activedescendant')).toBe(ids[2])
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(field.getAttribute('aria-activedescendant')).toBe(ids[0])
    expect(document.activeElement).toBe(field)
  })

  test('Enter opens the highlighted row; a click opens the row clicked', () => {
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const field = screen.getByRole('combobox')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('b')

    fireEvent.click(screen.getByRole('option', { name: 'Acme Summit' }))
    expect(onSelect).toHaveBeenLastCalledWith('c')
  })

  test('the highlight never survives the row it pointed at', () => {
    const { rerender } = render(<Harness />)
    const field = screen.getByRole('combobox')
    fireEvent.keyDown(field, { key: 'End' })
    expect(
      screen.getByRole('option', { name: 'Acme Summit' }).getAttribute('aria-selected'),
    ).toBe('true')

    rerender(<Harness groups={[GROUPS[0]]} />)
    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(2)
    expect(rows[0].getAttribute('aria-selected')).toBe('true')
  })

  test('says so when there is nothing to show', () => {
    render(<Harness groups={[]} />)
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText('No matches.')).toBeTruthy()
  })
})
