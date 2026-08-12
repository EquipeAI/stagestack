import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FilesPanel } from './FilesPanel'

const convex = vi.hoisted(() => ({
  files: [] as Array<Record<string, unknown>>,
  query: vi.fn(),
}))

vi.mock('convex/react', () => ({
  useQuery: () => convex.files,
  useConvex: () => ({ query: convex.query }),
  useMutation: () => vi.fn(),
}))

beforeEach(() => {
  convex.query.mockReset()
  convex.files = []
})

afterEach(cleanup)

describe('FilesPanel headshot provenance', () => {
  test('shows the current WebP download separately from its original source filename and audit metadata', () => {
    const uploadedAt = Date.parse('2026-08-11T15:30:00Z')
    convex.files = [
      {
        fileId: 'headshot:ticket-1',
        kind: 'headshot',
        instanceId: null,
        requirementTitle: 'Speaker headshot',
        sessionId: null,
        sessionTitle: 'Speaker profile',
        speakerName: 'Priya Raman',
        sourceFilename: 'headshot.png',
        filename: 'headshot.webp',
        version: 1,
        versionCount: 1,
        uploadedByName: 'Priya Raman',
        uploadedByNote: null,
        uploadedAt,
        url: 'https://files.example.test/headshot',
        commentCount: 0,
      },
    ]

    render(<FilesPanel eventSlug="summit" timezone="UTC" />)

    const link = screen.getByRole('link', { name: 'headshot.webp' })
    expect(link.getAttribute('href')).toBe(
      'https://files.example.test/headshot',
    )
    expect(link.getAttribute('download')).toBe('headshot.webp')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.getByText('Source: headshot.png')).toBeTruthy()
    expect(screen.getAllByText('Priya Raman')).toHaveLength(2)
    expect(screen.getByText('11 Aug 2026, 15:30 UTC')).toBeTruthy()
    expect(
      screen.getByText(
        /Complete view · 120 files · 64 headshots\/sessions · 16 additional task contacts max/,
      ),
    ).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: 'Download ZIP (1)' })
        .hasAttribute('disabled'),
    ).toBe(false)
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
  })

  test('keeps copied or legacy current headshots downloadable while labeling unknown provenance honestly', () => {
    convex.files = [
      {
        fileId: 'headshot:event-contact-1',
        kind: 'headshot',
        instanceId: null,
        requirementTitle: 'Speaker headshot',
        sessionId: null,
        sessionTitle: 'Speaker profile',
        speakerName: 'Priya Raman',
        sourceFilename: null,
        filename: 'headshot.webp',
        version: null,
        versionCount: null,
        uploadedByName: null,
        uploadedByNote: 'The uploader was not recorded for this file.',
        uploadedAt: null,
        url: 'https://files.example.test/legacy-headshot',
        commentCount: 0,
      },
    ]

    render(<FilesPanel eventSlug="summit" timezone="UTC" />)

    const link = screen.getByRole('link', { name: 'headshot.webp' })
    expect(link.getAttribute('href')).toBe(
      'https://files.example.test/legacy-headshot',
    )
    expect(link.getAttribute('download')).toBe('headshot.webp')
    // W5: the uploader column says plainly that nobody was recorded, in the
    // backend's own words — it no longer shares the date column's "Unknown".
    expect(
      screen.getByText('The uploader was not recorded for this file.'),
    ).toBeTruthy()
    expect(screen.getAllByText('Unknown')).toHaveLength(1)
    expect(screen.getByText('History unavailable')).toBeTruthy()
    expect(screen.queryByText(/^Source:/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
  })
})
