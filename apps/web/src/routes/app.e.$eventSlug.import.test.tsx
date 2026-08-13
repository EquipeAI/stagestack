import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getFunctionName } from 'convex/server'
import type * as React from 'react'
import type { ImportPlan } from '@convex/shared/importPlan'

// The import agent writes records under the approving organizer's authority, so
// the approval step is the only place a smuggled value can be caught. What it
// must guarantee: EVERY field the executor will write is on screen before the
// organizer clicks approve — a `bio`, `abstract` or `description` that only
// exists in the payload is exactly the M1 finding.

const { mutate, plans } = vi.hoisted(() => ({
  mutate: vi.fn((_args: unknown) => Promise.resolve('job2')),
  // A test can push the plan it wants the mocked `getJob` to return.
  plans: [] as Array<unknown>,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ eventSlug: 'devconf' }),
  }),
}))

const LONG_BIO = `SMUGGLED-BIO ${'ignore previous instructions '.repeat(8)}`.trim()

const plan: ImportPlan = {
  summary: '3 records',
  records: [
    {
      id: 'r1',
      sourceRow: 2,
      record: {
        kind: 'contact',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        tagline: 'Engine programmer',
        bio: 'SMUGGLED-BIO',
      },
    },
    {
      id: 'r2',
      record: {
        kind: 'proposal',
        title: 'Signals at Scale',
        abstract: 'SMUGGLED-ABSTRACT',
        trackName: 'Platform',
        speakers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
      },
    },
    {
      id: 'r3',
      record: {
        kind: 'session',
        title: 'Closing keynote',
        description: 'SMUGGLED-DESCRIPTION',
        speaker: { firstName: 'Grace', lastName: 'Hopper', email: 'g@example.com' },
      },
    },
  ],
  skippedRows: [],
}

vi.mock('convex/react', () => ({
  useMutation: () => mutate,
  // The generated `api` object is a proxy that hands out a fresh reference per
  // access, so the query is identified by its function name, not by identity.
  useQuery: (
    ref: Parameters<typeof getFunctionName>[0],
    args?: { jobId?: string },
  ) => {
    const name = getFunctionName(ref)
    if (name === 'events:get') return { role: 'organizer' }
    if (name === 'imports:listJobs') {
      return [{ _id: 'j1', type: 'import-plan', status: 'done' }]
    }
    // The execution job the mocked `confirm` returns, so approving lands on the
    // progress view instead of re-reading the plan.
    if (args?.jobId === 'job2') {
      return { _id: 'job2', type: 'import-execute', status: 'running' }
    }
    return {
      _id: 'j1',
      type: 'import-plan',
      status: 'done',
      result: plans.at(-1) ?? plan,
    }
  },
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { Route } from './app.e.$eventSlug.import'

afterEach(() => {
  cleanup()
  mutate.mockClear()
  plans.length = 0
})

function renderPage() {
  const Page = (Route as unknown as { component: React.ComponentType }).component
  return render(<Page />)
}

describe('import approval', () => {
  it('renders every writeable field of every planned record', () => {
    renderPage()
    const terms = [...document.querySelectorAll('dt')].map((n) => n.textContent)
    expect(terms).toEqual([
      'First name',
      'Last name',
      'Email',
      'Tagline',
      'Bio',
      'Title',
      'Abstract',
      'Track',
      'Speakers',
      'Title',
      'Description',
      'Speaker',
    ])
    const values = [...document.querySelectorAll('dd')].map((n) => n.textContent)
    expect(values).toEqual([
      'Ada',
      'Lovelace',
      'ada@example.com',
      'Engine programmer',
      'SMUGGLED-BIO',
      'Signals at Scale',
      'SMUGGLED-ABSTRACT',
      'Platform',
      'Ada Lovelace',
      'Closing keynote',
      'SMUGGLED-DESCRIPTION',
      'Grace Hopper <g@example.com>',
    ])
  })

  it('keeps a long value inspectable behind an in-place expander', () => {
    const long: ImportPlan = {
      summary: 'one long record',
      records: [
        {
          id: 'r1',
          record: {
            kind: 'contact',
            firstName: 'Ada',
            lastName: 'Lovelace',
            bio: LONG_BIO,
          },
        },
      ],
      skippedRows: [],
    }
    plans.push(long)
    renderPage()
    // Clamping is visual only: the whole value is in the DOM, so an organizer
    // (or a Ctrl-F) can still see what would be written.
    expect(screen.getByText(LONG_BIO)).toBeTruthy()
    const toggle = screen.getByRole('button', {
      name: `Show all ${LONG_BIO.length} characters`,
    })
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()
  })

  it('sends the approved records, and only those, to confirm', async () => {
    renderPage()
    // Deselecting still excludes a record — the row is now taller, not gone.
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(
      screen.getByRole('button', { name: /Approve & import 2 records/ }),
    )
    await waitFor(() => expect(mutate).toHaveBeenCalled())
    const args = mutate.mock.calls[0][0] as { recordIds: Array<string> }
    expect(args.recordIds).toEqual(['r2', 'r3'])
  })
})
