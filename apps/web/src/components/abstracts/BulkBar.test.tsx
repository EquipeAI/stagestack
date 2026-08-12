import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { planBulk } from '@convex/shared/bulkDecisions'
import type { ProposalStatus } from '@convex/shared/bulkDecisions'

// The bulk bar arms two actions with two DIFFERENT eligibility rules: the
// queue moves accept STAGEABLE_STATUSES, "Release decisions" accepts only
// RELEASABLE_STATUSES. A single "N eligible" is therefore a claim about
// whichever button the organizer did not press — these pin that the bar names
// both, and that the release confirmation states the RELEASE plan.

vi.mock('convex/react', () => ({
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
  useConvex: () => ({ query: vi.fn() }),
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted
import { BulkBar } from './BulkBar'

function row(id: string, status: ProposalStatus) {
  return {
    proposal: {
      _id: id,
      _creationTime: 1,
      eventId: 'e1',
      submitterUserId: 'u1',
      status,
      title: `Proposal ${id}`,
      answers: {},
      formVersion: 1,
      updatedAt: 1,
    },
    speakerCount: 1,
  }
}

/** Two staged for release, two more that can only be re-staged, and two that
 * neither action can touch. */
const SELECTION = [
  row('p1', 'pending'),
  row('p2', 'pending'),
  row('p3', 'acceptQueue'),
  row('p4', 'acceptQueue'),
  row('p5', 'accepted'),
  row('p6', 'withdrawn'),
]

function renderBar() {
  return render(
    <BulkBar
      eventSlug="devconf"
      selection={SELECTION as never}
      onFailures={vi.fn()}
      onResult={vi.fn()}
      onClear={vi.fn()}
    />,
  )
}

afterEach(() => {
  cleanup()
})

describe('BulkBar eligibility', () => {
  it('names BOTH rules, because the two actions do not share one', () => {
    renderBar()
    const bar = screen.getByRole('region', { name: 'Proposal bulk actions' })
    // 6 ticked · 4 can be re-staged · only the 2 already staged can be released.
    expect(bar.textContent).toContain(
      '6 proposals selected · 4 stageable · 2 releasable',
    )
  })

  it('agrees with the shared producer both mutations enforce', () => {
    const statuses = SELECTION.map((r) => r.proposal.status)
    const stage = planBulk(statuses, { kind: 'stage', to: 'acceptQueue' })
    const release = planBulk(statuses, { kind: 'release' })
    // The numbers on screen are not re-derived here — they are these.
    expect(stage.eligible).toBe(4)
    expect(release.eligible).toBe(2)
    renderBar()
    const bar = screen.getByRole('region', { name: 'Proposal bulk actions' })
    expect(bar.textContent).toContain(`${stage.eligible} stageable`)
    expect(bar.textContent).toContain(`${release.eligible} releasable`)
  })

  it('states no ambient exclusions — they belong to an action, not to the bar', () => {
    renderBar()
    expect(document.querySelector('.ss-batchbar__excluded')).toBeNull()
  })

  it('the release confirmation states the RELEASE arithmetic, not the staging one', () => {
    renderBar()
    fireEvent.click(screen.getByText('Release decisions'))

    const dialog = screen.getByRole('dialog')
    // Release's own eligibility — two, not the four the queue buttons accept.
    expect(dialog.textContent).toContain('6 proposals selected · 2 eligible.')
    expect(dialog.textContent).not.toContain('4 eligible')
    // What each eligible row will actually cause.
    expect(dialog.textContent).toContain(
      '2 in the accept queue — each becomes a session and its speakers are emailed an invitation.',
    )
    // And why the rest are not in it, in the producer's words.
    expect(dialog.textContent).toContain('not staged for a decision yet')
    expect(dialog.textContent).toContain(
      'already released — correct it individually instead',
    )
  })

  it('offers no release at all when nothing in the selection is staged', () => {
    render(
      <BulkBar
        eventSlug="devconf"
        selection={[row('p1', 'pending')] as never}
        onFailures={vi.fn()}
        onResult={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    const bar = screen.getByRole('region', { name: 'Proposal bulk actions' })
    expect(bar.textContent).toContain('1 proposal selected · 1 stageable · 0 releasable')
    expect(screen.getByText('Release decisions').closest('button')?.disabled).toBe(
      true,
    )
  })
})
