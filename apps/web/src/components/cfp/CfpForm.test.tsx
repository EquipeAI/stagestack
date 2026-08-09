import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { fieldDomId } from './model'
import type { FormDef } from '@convex/shared/formDef'
import type { Id } from '@convex/_generated/dataModel'

// A submitter who cannot see the red text has to be told another way: every
// validation message is a live region, and the control it belongs to points at
// it with aria-describedby and says it is invalid. Without that, the wizard
// refuses to advance for reasons a screen reader never announces.

vi.mock('convex/react', () => ({
  useMutation: () => vi.fn(() => Promise.resolve(undefined)),
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { CfpForm } from './CfpForm'

const PROPOSAL_ID = 'p1' as Id<'proposals'>

const form: FormDef = {
  sections: [
    {
      id: 'sec',
      title: 'About your talk',
      fields: [
        { id: 'title', kind: 'text', label: 'Talk title', required: true },
        {
          id: 'abstract',
          kind: 'textarea',
          label: 'Abstract',
          required: true,
          help: 'A short summary.',
        },
        {
          id: 'track',
          kind: 'dropdown',
          label: 'Track',
          required: true,
          options: ['Platform', 'Product'],
        },
        {
          id: 'tags',
          kind: 'multiselect',
          label: 'Tags',
          required: true,
          options: ['AI', 'Ops'],
        },
        {
          id: 'level',
          kind: 'radio',
          label: 'Experience level',
          required: true,
          options: ['First time', 'Veteran'],
        },
      ],
    },
  ],
}

function renderForm(flagged: Array<string>) {
  return render(
    <CfpForm
      form={form}
      answers={{}}
      onChange={() => {}}
      proposalId={PROPOSAL_ID}
      flagged={new Set(flagged)}
    />,
  )
}

afterEach(cleanup)

describe('CfpForm validation accessibility', () => {
  it('announces each error and links it to its control', () => {
    renderForm(['title'])

    const alerts = screen.getAllByRole('alert')
    expect(alerts.map((el) => el.textContent.trim())).toEqual([
      'This question is required.',
    ])

    const input = screen.getByLabelText(/Talk title/)
    expect(input.getAttribute('aria-describedby')).toBe(alerts[0].id)
    expect(alerts[0].id).not.toBe('')
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('marks every control kind invalid, not just the text inputs', () => {
    renderForm(['title', 'abstract', 'track', 'tags'])

    expect(
      screen.getByLabelText(/Abstract/).getAttribute('aria-invalid'),
    ).toBe('true')
    expect(screen.getByLabelText(/Track/).getAttribute('aria-invalid')).toBe(
      'true',
    )
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box.getAttribute('aria-invalid')).toBe('true')
    }
    // The checkbox group carries the description, so the wrapper is a group.
    const group = screen.getByRole('group')
    expect(group.getAttribute('aria-describedby')).not.toBeNull()
  })

  it('announces a radio group error on the group, not on one radio', () => {
    renderForm(['level'])

    const group = screen.getByRole('radiogroup')
    const alert = screen.getByRole('alert')
    expect(alert.textContent.trim()).toBe('This question is required.')
    expect(group.getAttribute('aria-describedby')).toBe(alert.id)
    expect(alert.id).not.toBe('')
    expect(group.getAttribute('aria-invalid')).toBe('true')
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.getAttribute('aria-invalid')).toBeNull()
    }
  })

  it('leaves a valid radio group unmarked', () => {
    renderForm([])

    expect(
      screen.getByRole('radiogroup').getAttribute('aria-invalid'),
    ).toBeNull()
  })

  it('names a grouped control by its field label', () => {
    renderForm([])

    // A <label for> cannot name a group, so the group points back at the label.
    const group = screen.getByRole('radiogroup', { name: /Experience level/ })
    const labelId = group.getAttribute('aria-labelledby')
    expect(document.getElementById(labelId ?? '')?.tagName).toBe('LABEL')
    expect(screen.getByRole('group', { name: /Tags/ })).toBeDefined()
  })

  it('gives grouped controls the id the review-step error jump looks up', () => {
    renderForm(['level', 'tags'])

    for (const fieldId of ['level', 'tags']) {
      const target = document.getElementById(fieldDomId(fieldId))
      expect(target).not.toBeNull()
      // The jump scrolls to and focuses this element, so it must take focus.
      target?.focus()
      expect(document.activeElement).toBe(target)
    }
  })

  it('describes a control by its hint while it is valid, with no alert', () => {
    renderForm([])

    const textarea = screen.getByLabelText(/Abstract/)
    const hintId = textarea.getAttribute('aria-describedby')
    expect(hintId).not.toBeNull()
    expect(document.getElementById(hintId ?? '')?.textContent).toBe(
      'A short summary.',
    )
    expect(textarea.getAttribute('aria-invalid')).toBeNull()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
  })
})
