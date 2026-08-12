import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { CLEARED_NOTE } from '@convex/shared/sessionContent'
import { RestoreDiff, SnapshotRow } from './ContentHistoryDialog'

afterEach(cleanup)

// W3: the restore preview and the grouped history row. The sentences are the
// shared producer's; these tests are about what the organizer actually SEES
// before any write happens.

const current = {
  title: 'Reactive backends',
  description: 'A live demo.',
  format: 'Talk',
}

describe('restore diff preview', () => {
  test('a changed field shows current and restored values as separate stacked lines', () => {
    render(
      <RestoreDiff
        current={current}
        snapshot={{ ...current, title: 'Older title' }}
      />,
    )
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('Now: Reactive backends')
    expect(rows[0].textContent).toContain('After restore: Older title')
  })

  test('a field the snapshot never had says CLEARED, and says why, before any write', () => {
    render(
      <RestoreDiff current={current} snapshot={{ title: current.title }} />,
    )
    const format = screen
      .getAllByRole('listitem')
      .find((row) => row.textContent.startsWith('Format'))
    expect(format?.textContent).toContain('Cleared')
    expect(format?.textContent).toContain('After restore: (cleared)')
    // The sharp edge is stated, not discovered.
    expect(format?.textContent).toContain(CLEARED_NOTE)
    expect(screen.getByText(/2 fields will be cleared/)).toBeTruthy()
  })

  test('an unchanged field is listed as unchanged rather than hidden', () => {
    render(
      <RestoreDiff
        current={current}
        snapshot={{ ...current, title: 'Older title' }}
      />,
    )
    const description = screen
      .getAllByRole('listitem')
      .find((row) => row.textContent.startsWith('Description'))
    expect(description?.textContent).toContain('unchanged')
    expect(description?.textContent).not.toContain('After restore')
  })

  test('it is a stacked list at every width, never a two-column table', () => {
    const { container } = render(
      <RestoreDiff current={current} snapshot={{ title: 'Older title' }} />,
    )
    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('ul')?.style.flexDirection).toBe('column')
    for (const row of container.querySelectorAll('li')) {
      expect(row.style.flexDirection).toBe('column')
    }
  })

  test('restoring an identical snapshot says so instead of promising a change', () => {
    render(<RestoreDiff current={current} snapshot={current} />)
    expect(screen.getByText(/matches the current content/)).toBeTruthy()
  })
})

const snapshot = {
  key: 'rev1',
  revisionId: 'rev1' as never,
  label: 'Before edit on 11 Aug at 13:42 PDT',
  editedAt: 1,
  editorName: 'Jordan Alvarez',
  editorEmail: 'jordan@example.com',
  content: current,
  origin: 'edit' as const,
  originLabel: null,
}

describe('snapshot list rows', () => {
  test('an ordinary edit renders its model-composed label verbatim', () => {
    render(
      <SnapshotRow
        snapshot={snapshot}
        archived={false}
        disabled={false}
        onRestore={() => {}}
      />,
    )
    expect(screen.getByText('Before edit on 11 Aug at 13:42 PDT')).toBeTruthy()
    expect(screen.queryByText('Restore')).toBeNull()
    expect(screen.getByText('Restore this snapshot')).toBeTruthy()
  })

  test('a restore reads as one grouped event, not as another anonymous edit', () => {
    render(
      <SnapshotRow
        snapshot={{
          ...snapshot,
          label: 'Before the restore on 11 Aug at 13:45 PDT',
          origin: 'restore',
          originLabel: 'Restored the snapshot from 11 Aug at 13:42 PDT',
        }}
        archived={false}
        disabled={false}
        onRestore={() => {}}
      />,
    )
    expect(screen.getByText('Restore')).toBeTruthy()
    expect(
      screen.getByText('Restored the snapshot from 11 Aug at 13:42 PDT'),
    ).toBeTruthy()
  })

  test('Current cannot be restored onto itself, and an archived event restores nothing', () => {
    const { rerender } = render(
      <SnapshotRow
        snapshot={{
          ...snapshot,
          revisionId: null,
          label: 'Current',
          origin: 'current',
          editorName: null,
        }}
        archived={false}
        disabled={false}
        onRestore={() => {}}
      />,
    )
    expect(screen.queryByText('Restore this snapshot')).toBeNull()
    rerender(
      <SnapshotRow
        snapshot={snapshot}
        archived
        disabled={false}
        onRestore={() => {}}
      />,
    )
    expect(screen.queryByText('Restore this snapshot')).toBeNull()
  })
})
