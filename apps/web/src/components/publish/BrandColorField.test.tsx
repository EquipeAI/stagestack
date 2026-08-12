import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { BrandColorField } from './BrandColorField'

// W5: the embed brand colour. The rule is stated, an illegal value is refused
// with the backend's own sentence, a legal-but-invisible value only WARNS, and
// the preview shows the accent on both a light and a dark host page.

afterEach(cleanup)

describe('BrandColorField', () => {
  test('refuses a CSS colour name with the same rule the backend enforces', () => {
    render(<BrandColorField value="rebeccapurple" onChange={vi.fn()} />)
    expect(
      screen.getByText('The brand color must be a hex value like #7c5cff.'),
    ).toBeTruthy()
  })

  test('warns about low contrast without refusing the value', () => {
    render(<BrandColorField value="#DDDDDD" onChange={vi.fn()} />)
    expect(
      screen.queryByText('The brand color must be a hex value like #7c5cff.'),
    ).toBeNull()
    const warning = screen.getByRole('status')
    expect(warning.textContent).toContain('below the 3:1')
    // The measured ratio is shown beside the accent, not just asserted at.
    expect(screen.getAllByText(/#DDDDDD · [\d.]+:1/).length).toBeGreaterThan(0)
  })

  test('a legible colour previews on both host surfaces with no warning', () => {
    render(<BrandColorField value="#6B4EFF" onChange={vi.fn()} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Light host page')).toBeTruthy()
    expect(screen.getByText('Dark host page')).toBeTruthy()
    expect(screen.getAllByText('Main stage')).toHaveLength(2)
  })

  test('the picker and the text field edit the same value', () => {
    const onChange = vi.fn()
    render(<BrandColorField value="#6B4EFF" onChange={onChange} />)
    const picker = screen.getByLabelText('Pick a brand color')
    expect(picker.getAttribute('value')).toBe('#6B4EFF')
    fireEvent.change(picker, { target: { value: '#123456' } })
    expect(onChange).toHaveBeenCalledWith('#123456')
  })
})
