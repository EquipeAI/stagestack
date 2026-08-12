import { describe, expect, it } from 'vitest'
import { isEditable, reviewPanelKey, submittedCount } from './model'
import type { Assignment } from './model'

function assignment(status: Assignment['status']): Assignment {
  return { status } as Assignment
}

describe('review completion state', () => {
  it('counts only submitted and locked reviews as completed', () => {
    expect(
      submittedCount([
        assignment('assigned'),
        assignment('draft'),
        assignment('conflict'),
        assignment('submitted'),
        assignment('locked'),
      ]),
    ).toBe(2)
  })

  it('makes conflicts and locked evidence non-editable', () => {
    expect(isEditable(assignment('conflict'))).toBe(false)
    expect(isEditable(assignment('locked'))).toBe(false)
    expect(isEditable(assignment('draft'))).toBe(true)
  })

  it('keys local review state by assignment and proposal content revision', () => {
    expect(
      reviewPanelKey({
        reviewId: 'review-1',
        contentVersion: 3,
      } as Assignment),
    ).toBe('review-1:3')
  })
})
