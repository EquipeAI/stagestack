import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { UploadVersionList } from './UploadVersionList'

afterEach(cleanup)

describe('UploadVersionList', () => {
  test('marks only the newest version current while keeping older links and timestamps accessible', () => {
    const uploadedV1 = Date.parse('2026-08-10T14:00:00Z')
    const uploadedV2 = Date.parse('2026-08-11T15:30:00Z')
    render(
      <UploadVersionList
        timezone="UTC"
        uploads={[
          {
            uploadId: 'v2',
            filename: 'slides-v2.pdf',
            version: 2,
            uploadedAt: uploadedV2,
            url: 'https://files.example.test/v2',
          },
          {
            uploadId: 'v1',
            filename: 'slides-v1.pdf',
            version: 1,
            uploadedAt: uploadedV1,
            url: 'https://files.example.test/v1',
            approvedAt: uploadedV1 + 1_000,
          },
        ]}
      />,
    )

    expect(screen.getAllByText('Current')).toHaveLength(1)
    expect(screen.getByText('Current').closest('li')?.textContent).toContain(
      'v2',
    )
    expect(
      screen.getByRole('link', { name: 'slides-v2.pdf' }).getAttribute('href'),
    ).toBe('https://files.example.test/v2')
    expect(
      screen.getByRole('link', { name: 'slides-v1.pdf' }).getAttribute('href'),
    ).toBe('https://files.example.test/v1')
    expect(
      screen.getByText('10 Aug 2026, 14:00 UTC').getAttribute('datetime'),
    ).toBe(new Date(uploadedV1).toISOString())
    expect(
      screen.getByText('11 Aug 2026, 15:30 UTC').getAttribute('datetime'),
    ).toBe(new Date(uploadedV2).toISOString())
    expect(screen.getByText('Approved').closest('li')?.textContent).toContain(
      'v1',
    )
  })
})
