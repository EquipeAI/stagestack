import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReviewQueue } from './ReviewQueue'
import type { Assignment } from './model'
import type { Id } from '@convex/_generated/dataModel'

afterEach(cleanup)

function assignment(
  reviewId: string,
  title: string,
  status: Assignment['status'],
): Assignment {
  return {
    reviewId: reviewId as Id<'reviews'>,
    status,
    proposal: { title },
  } as Assignment
}

describe('ReviewQueue conflicts', () => {
  it('removes conflicts from actionable rows and completion denominator', () => {
    const onSelect = vi.fn()
    render(
      <ReviewQueue
        assignments={[
          assignment('r-conflict', 'Conflicted proposal', 'conflict'),
          assignment('r-open', 'Actionable proposal', 'assigned'),
          assignment('r-done', 'Finished proposal', 'submitted'),
        ]}
        selectedId={null}
        onSelect={onSelect}
      />,
    )

    expect(screen.queryByText('Conflicted proposal')).toBeNull()
    expect(
      screen.getByText('1 conflict excluded from the actionable queue.'),
    ).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Actionable proposal/ }))
    expect(onSelect).toHaveBeenCalledWith('r-open')
  })
})
