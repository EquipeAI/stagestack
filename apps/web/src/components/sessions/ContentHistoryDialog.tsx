import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import {
  CLEARED_VALUE_LABEL,
  EMPTY_VALUE_LABEL,
  diffContent,
  diffHeadline,
} from '@convex/shared/sessionContent'
import type {
  ContentDiffEntry,
  SessionContentFields,
} from '@convex/shared/sessionContent'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import { ActionResult, Badge, Button, Callout, Dialog } from '~/ds'
import { usePending } from '~/lib/usePending'

// W3 — "Snapshots, not inverse edits".
//
// The organizer picks a STATE to go back to (Current, then one entry per
// edit), previews exactly what restoring would do to each content field
// BEFORE anything is written, and can undo the restore from a persistent
// result rather than by hunting for a second manual restore.
//
// Every sentence about a snapshot (its label, the restore grouping line, the
// result message) is composed in `convex/model/sessions.ts` or in the shared
// pure module `@convex/shared/sessionContent` and rendered verbatim here.

type Snapshot = FunctionReturnType<
  typeof api.sessions.listSnapshots
>['entries'][number]

const column = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
} as const

function clip(value: string): string {
  if (value === '') return EMPTY_VALUE_LABEL
  return value.length > 120 ? `${value.slice(0, 120)}…` : value
}

// ── The restore diff (pure, stacked, mobile-first) ───────────────────────

/**
 * What restoring a snapshot would do, one field per row, stacked before/after
 * — never a two-column table, so it reads the same at 375px as at 1440px.
 * Pure: it takes the two content states and nothing else, and the diff itself
 * comes from the one shared producer.
 */
export function RestoreDiff({
  current,
  snapshot,
}: {
  current: SessionContentFields
  snapshot: SessionContentFields
}) {
  const entries = diffContent(current, snapshot)
  return (
    <div style={column}>
      <p style={{ margin: 0, font: 'var(--type-body)' }}>
        {diffHeadline(entries)}
      </p>
      <ul
        style={{
          listStyle: 'none',
          margin: 'var(--space-0)',
          padding: 'var(--space-0)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        {entries.map((entry) => (
          <DiffRow key={entry.field} entry={entry} />
        ))}
      </ul>
    </div>
  )
}

function DiffRow({ entry }: { entry: ContentDiffEntry }) {
  const unchanged = entry.status === 'unchanged'
  return (
    <li
      style={{
        ...column,
        gap: 'var(--space-1)',
        paddingLeft: 'var(--space-3)',
        borderLeft: `var(--space-half) solid ${
          entry.status === 'cleared'
            ? 'var(--status-attention-dot)'
            : entry.status === 'changed'
              ? 'var(--status-info-dot)'
              : 'var(--border-subtle)'
        }`,
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          fontWeight: 'var(--weight-medium)',
        }}
      >
        {entry.label}
        {entry.status === 'cleared' ? (
          <Badge tone="attention">Cleared</Badge>
        ) : null}
      </span>
      {unchanged ? (
        <span style={{ color: 'var(--text-tertiary)' }}>unchanged</span>
      ) : (
        <>
          <span style={{ color: 'var(--text-tertiary)' }}>
            Now: {clip(entry.from)}
          </span>
          <span>
            After restore:{' '}
            {entry.status === 'cleared' ? CLEARED_VALUE_LABEL : clip(entry.to)}
          </span>
        </>
      )}
      {entry.note === null ? null : (
        <span
          style={{
            font: 'var(--type-caption)',
            color: 'var(--text-secondary)',
          }}
        >
          {entry.note}
        </span>
      )}
    </li>
  )
}

// ── One row of the snapshot list ─────────────────────────────────────────

export function SnapshotRow({
  snapshot,
  archived,
  disabled,
  onRestore,
}: {
  snapshot: Snapshot
  archived: boolean
  disabled: boolean
  onRestore: (snapshot: Snapshot) => void
}) {
  const restore = snapshot.origin === 'restore'
  return (
    <li
      style={{
        ...column,
        paddingBottom: 'var(--space-3)',
        paddingLeft: restore ? 'var(--space-3)' : undefined,
        borderLeft: restore
          ? 'var(--space-half) solid var(--status-info-dot)'
          : undefined,
        borderBottom: 'var(--space-px) solid var(--border-subtle)',
      }}
    >
      <span
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--space-2)',
        }}
      >
        <strong>{snapshot.label}</strong>
        {restore ? <Badge tone="info">Restore</Badge> : null}
        {snapshot.editorName === null ? null : (
          <span
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-tertiary)',
            }}
          >
            {snapshot.editorName}
          </span>
        )}
      </span>

      {snapshot.originLabel === null ? null : (
        <span
          style={{
            font: 'var(--type-caption)',
            color: 'var(--text-secondary)',
          }}
        >
          {snapshot.originLabel}
        </span>
      )}

      <div style={{ ...column, gap: 'var(--space-1)' }}>
        <span>{clip(snapshot.content.title)}</span>
        <span
          style={{
            font: 'var(--type-caption)',
            color: 'var(--text-tertiary)',
          }}
        >
          Format: {clip(snapshot.content.format ?? '')}
        </span>
        <span
          style={{
            font: 'var(--type-caption)',
            color: 'var(--text-tertiary)',
          }}
        >
          Description: {clip(snapshot.content.description ?? '')}
        </span>
      </div>

      {archived || snapshot.revisionId === null ? null : (
        <div>
          <Button
            size="sm"
            variant="ghost"
            iconLeft="refresh-cw"
            disabled={disabled}
            onClick={() => {
              onRestore(snapshot)
            }}
          >
            Restore this snapshot
          </Button>
        </div>
      )}
    </li>
  )
}

// ── The dialog ───────────────────────────────────────────────────────────

type RestoreResult = {
  message: string
  undoRevisionId: Id<'sessionRevisions'> | null
}

export function ContentHistoryDialog({
  eventSlug,
  sessionId,
  sessionTitle,
  archived,
  onClose,
}: {
  eventSlug: string
  sessionId: Id<'sessions'>
  sessionTitle: string
  archived: boolean
  onClose: () => void
}) {
  const snapshots = useQuery(api.sessions.listSnapshots, {
    eventSlug,
    sessionId,
  })
  const restoreRevision = useMutation(api.sessions.restoreRevision)
  const { pending, error, run } = usePending()
  const [previewing, setPreviewing] = useState<Snapshot | null>(null)
  const [result, setResult] = useState<RestoreResult | null>(null)

  // Live subscription: `current` (and therefore the open preview's diff)
  // re-renders if someone edits concurrently. The residual race — an edit
  // landing between the last render and the mutation — is recoverable by
  // design: the restore records the pre-restore state as its own revision,
  // so Undo always exists.
  const current = snapshots?.entries[0]?.content ?? null

  const restore = (revisionId: Id<'sessionRevisions'>) => {
    void run(async () => {
      const outcome = await restoreRevision({ eventSlug, revisionId })
      setResult(outcome)
      setPreviewing(null)
    })
  }

  return (
    <Dialog
      open
      width={640}
      title={previewing === null ? 'Content history' : 'Restore this snapshot'}
      description={
        previewing === null
          ? `Every state "${sessionTitle}"'s content has been in, newest first. Only title, description and format are versioned — schedule, track and tags are not.`
          : 'Nothing is written yet. This is exactly what restoring would change.'
      }
      onClose={pending ? undefined : onClose}
      footer={
        previewing === null ? (
          <Button variant="primary" disabled={pending} onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button
              disabled={pending}
              onClick={() => {
                setPreviewing(null)
              }}
            >
              Back
            </Button>
            <Button
              variant="primary"
              disabled={pending || previewing.revisionId === null}
              onClick={() => {
                if (previewing.revisionId !== null)
                  restore(previewing.revisionId)
              }}
            >
              {pending ? 'Restoring…' : 'Restore this snapshot'}
            </Button>
          </>
        )
      }
    >
      <div style={{ ...column, gap: 'var(--space-4)' }}>
        {error === null ? null : <Callout tone="blocked">{error}</Callout>}

        {result === null ? null : (
          // The shared persistent-result pattern (W5) — same component the
          // exports, bulk actions, publishes and imports report through.
          <ActionResult
            status="success"
            title="Snapshot restored"
            details={[result.message]}
            onDismiss={() => setResult(null)}
            actions={
              result.undoRevisionId === null ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  iconLeft="refresh-cw"
                  disabled={pending || archived}
                  onClick={() => {
                    if (result.undoRevisionId !== null)
                      restore(result.undoRevisionId)
                  }}
                >
                  Undo the restore
                </Button>
              )
            }
          />
        )}

        {previewing !== null && current !== null ? (
          <>
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              {previewing.label}
            </p>
            <RestoreDiff current={current} snapshot={previewing.content} />
          </>
        ) : snapshots === undefined ? (
          <p style={{ color: 'var(--text-tertiary)' }}>Loading history…</p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 'var(--space-0)',
              padding: 'var(--space-0)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
            }}
          >
            {snapshots.entries.map((snapshot) => (
              <SnapshotRow
                key={snapshot.key}
                snapshot={snapshot}
                archived={archived}
                disabled={pending}
                onRestore={setPreviewing}
              />
            ))}
          </ul>
        )}

        {snapshots !== undefined && snapshots.truncated ? (
          <p style={{ color: 'var(--text-tertiary)' }}>
            Long history — only the most recent {snapshots.entries.length - 1}{' '}
            edits are shown here. Older snapshots are retained but not listed.
          </p>
        ) : null}

        {snapshots !== undefined && snapshots.entries.length === 1 ? (
          <p style={{ color: 'var(--text-tertiary)' }}>
            No edits yet — Current is still the content as it was first created.
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
