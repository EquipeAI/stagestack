import { useState } from 'react'
import type { ChannelDiff, DiffEntry } from './model'
import { Badge, Button } from '~/ds'

// "What will publishing change?" — the diff the backend computed, rendered.
//
// Stacked rows, never a table: three columns of one-line titles are unreadable
// at 375px, and the lists are the kind of thing an organizer scans on a phone
// on the way to a decision. The counts sentence is the model's, verbatim; the
// lists below it are the same numbers with names attached.

const GROUP_LABEL = {
  added: 'Added',
  changed: 'Changed',
  removed: 'Removed',
} as const

type Group = keyof typeof GROUP_LABEL

const TONE = {
  added: 'success',
  changed: 'info',
  removed: 'attention',
} as const

function EntryRow({ entry, group }: { entry: DiffEntry; group: Group }) {
  return (
    <li
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 'var(--space-2)',
        padding: 'var(--space-2) var(--space-0)',
        borderTop: 'var(--space-px) solid var(--border-subtle)',
      }}
    >
      <Badge tone={TONE[group]}>{GROUP_LABEL[group]}</Badge>
      <span style={{ flex: 1, minWidth: '10rem' }}>{entry.title}</span>
      {entry.changes.length === 0 ? null : (
        <span
          style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}
        >
          {entry.changes.join(', ')}
        </span>
      )}
    </li>
  )
}

export function DiffPreview({
  diff,
  label,
}: {
  diff: ChannelDiff
  /** Names the disclosure for a screen reader: "the lineup", "the schedule". */
  label: string
}) {
  const [open, setOpen] = useState(false)
  const groups: Array<[Group, Array<DiffEntry>]> = [
    ['added', diff.added],
    ['changed', diff.changed],
    ['removed', diff.removed],
  ]
  const total = diff.added.length + diff.changed.length + diff.removed.length

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
      }}
    >
      {/* The sentence the model composed. Nothing here recounts it. */}
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
        {diff.sentence}
      </p>
      {total === 0 ? null : (
        <div>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={open ? 'chevron-down' : 'chevron-right'}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? `Hide the ${label} changes` : `Show the ${label} changes`}
          </Button>
          {open ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {groups.flatMap(([group, entries]) =>
                entries.map((entry) => (
                  <EntryRow
                    key={`${group}:${entry.id}`}
                    entry={entry}
                    group={group}
                  />
                )),
              )}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  )
}
