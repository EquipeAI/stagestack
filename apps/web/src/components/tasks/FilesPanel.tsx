import { useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import {
  Button,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  Select,
  Toolbar,
} from '~/ds'
import { TaskCommentThread } from '~/components/tasks/TaskCommentThread'
import { downloadBlob, slug } from '~/components/abstracts/exporters'
import { formatDateTime } from '~/lib/datetime'
import { countLabel } from '~/components/tasks/model'
import { pushToast } from '~/components/toast'

// The files library (CNT-13/CNT-14): every current deliverable across the
// event in one table, with a bulk ZIP for the AV desk. The export is
// client-side on purpose — the list is bounded and already in memory, and
// jszip is dynamically imported so it never enters the everyday bundle
// (same pattern as the abstracts exporters).

type FileRow = FunctionReturnType<typeof api.tasks.filesLibrary>[number]

type Grouping = 'session' | 'speaker' | 'flat'

const GROUPING_OPTIONS: Array<{ value: Grouping; label: string }> = [
  { value: 'session', label: 'Group by session' },
  { value: 'speaker', label: 'Group by speaker' },
  { value: 'flat', label: 'No folders' },
]

export function FilesPanel({
  eventSlug,
  timezone,
}: {
  eventSlug: string
  timezone: string
}) {
  const files = useQuery(api.tasks.filesLibrary, { eventSlug })
  const convex = useConvex()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [grouping, setGrouping] = useState<Grouping>('session')
  const [zipping, setZipping] = useState(false)
  const [threadFor, setThreadFor] = useState<FileRow | null>(null)

  if (files === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading files…</p>
  }

  if (files.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="file-text"
          title="No files yet"
          description="Every file a speaker uploads for a task lands here — slides, releases, headshots. Nothing has been submitted so far."
        />
      </Card>
    )
  }

  const allSelected = selected.size === files.length
  const toggleAll = () => {
    setSelected(
      allSelected ? new Set() : new Set(files.map((row) => row.instanceId)),
    )
  }
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const downloadZip = () => {
    setZipping(true)
    void (async () => {
      try {
        const instanceIds = [...selected] as Array<Id<'taskInstances'>>
        const bundle = await convex.query(api.tasks.exportBundle, {
          eventSlug,
          instanceIds,
        })
        const { added, skipped } = await buildZip(bundle, grouping, eventSlug)
        if (added === 0) {
          pushToast(
            'Nothing to download',
            'None of the selected files could be fetched.',
            'triangle-alert',
          )
        } else {
          pushToast(
            'ZIP downloaded',
            `${countLabel(added, 'file', 'files')} in ${eventSlug}-deliverables.zip.`,
            'download',
          )
          if (skipped > 0) {
            pushToast(
              'Some files were skipped',
              `${countLabel(skipped, 'file was', 'files were')} unavailable and left out of the ZIP.`,
              'triangle-alert',
            )
          }
        }
      } catch {
        pushToast(
          'Export failed',
          'The file bundle could not be read. Try again.',
          'triangle-alert',
        )
      } finally {
        setZipping(false)
      }
    })()
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      <Toolbar
        left={
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--text-tertiary)',
            }}
          >
            {countLabel(files.length, 'file', 'files')}
            {selected.size > 0 ? ` · ${selected.size} selected` : ''}
          </span>
        }
        right={
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              flexWrap: 'wrap',
            }}
          >
            <Select
              size="sm"
              value={grouping}
              options={GROUPING_OPTIONS}
              onChange={(e) => {
                setGrouping(e.target.value as Grouping)
              }}
            />
            <Button
              iconLeft="download"
              disabled={zipping}
              onClick={downloadZip}
            >
              {zipping
                ? 'Zipping…'
                : selected.size === 0
                  ? 'Download ZIP (all)'
                  : `Download ZIP (${selected.size})`}
            </Button>
          </div>
        }
      />

      <Card padded={false}>
        <DataTable
          rowKey="instanceId"
          selectedIds={[...selected]}
          rows={files}
          columns={[
            {
              key: 'select',
              width: '2.5rem',
              header: <Checkbox checked={allSelected} onChange={toggleAll} />,
              cell: (row: FileRow) => (
                <Checkbox
                  checked={selected.has(row.instanceId)}
                  onChange={() => {
                    toggleOne(row.instanceId)
                  }}
                />
              ),
            },
            {
              key: 'filename',
              header: 'File',
              cell: (row: FileRow) =>
                row.url === null ? (
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    {row.filename} (unavailable)
                  </span>
                ) : (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--text-link)' }}
                  >
                    {row.filename}
                  </a>
                ),
            },
            {
              key: 'requirementTitle',
              header: 'Requirement',
              cell: (row: FileRow) => (
                <span style={{ color: 'var(--text-secondary)' }}>
                  {row.requirementTitle}
                </span>
              ),
            },
            {
              key: 'sessionTitle',
              header: 'Session',
              cell: (row: FileRow) => (
                <span style={{ color: 'var(--text-secondary)' }}>
                  {row.sessionTitle}
                </span>
              ),
            },
            {
              key: 'speakerName',
              header: 'Speaker',
              cell: (row: FileRow) => row.speakerName ?? 'Session task',
            },
            {
              key: 'uploadedAt',
              header: 'Uploaded',
              cell: (row: FileRow) => (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-xs)',
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--text-tertiary)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatDateTime(row.uploadedAt, timezone)}
                </span>
              ),
            },
            {
              key: 'version',
              header: 'Versions',
              cell: (row: FileRow) => (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-xs)',
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--text-tertiary)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  v{row.version} ·{' '}
                  {countLabel(row.versionCount, 'version', 'versions')}
                </span>
              ),
            },
            {
              key: 'comments',
              header: 'Comments',
              cell: (row: FileRow) => (
                <Button
                  size="sm"
                  variant="ghost"
                  iconLeft="mail"
                  onClick={() => {
                    setThreadFor(row)
                  }}
                >
                  {row.commentCount === 0
                    ? 'Comment'
                    : String(row.commentCount)}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {threadFor === null ? null : (
        <Dialog
          open
          width={560}
          title={threadFor.filename}
          description={`Comments on "${threadFor.requirementTitle}" for ${threadFor.speakerName ?? threadFor.sessionTitle}. The speaker sees this thread in their portal.`}
          onClose={() => {
            setThreadFor(null)
          }}
          footer={
            <Button
              variant="primary"
              onClick={() => {
                setThreadFor(null)
              }}
            >
              Close
            </Button>
          }
        >
          <TaskCommentThread
            eventSlug={eventSlug}
            instanceId={threadFor.instanceId}
            source="organizer"
            timezone={timezone}
          />
        </Dialog>
      )}
    </div>
  )
}

// ── ZIP assembly ─────────────────────────────────────────────────────────

type BundleFile = FunctionReturnType<typeof api.tasks.exportBundle>[number]

function folderFor(file: BundleFile, grouping: Grouping): string {
  switch (grouping) {
    case 'session':
      return slug(file.sessionTitle)
    case 'speaker':
      return slug(file.speakerName ?? 'unassigned')
    case 'flat':
      return ''
  }
}

/** Fetches in small batches (same rationale as the abstracts bundle) and
 * never lets one dead URL abort the export. */
async function buildZip(
  bundle: ReadonlyArray<BundleFile>,
  grouping: Grouping,
  eventSlug: string,
): Promise<{ added: number; skipped: number }> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const used = new Set<string>()
  let added = 0
  let skipped = 0
  const batchSize = 6

  const uniquePath = (folder: string, filename: string): string => {
    const base = folder === '' ? filename : `${folder}/${filename}`
    if (!used.has(base)) {
      used.add(base)
      return base
    }
    const dot = filename.lastIndexOf('.')
    const stem = dot <= 0 ? filename : filename.slice(0, dot)
    const ext = dot <= 0 ? '' : filename.slice(dot)
    for (let n = 2; ; n += 1) {
      const next =
        folder === '' ? `${stem}-${n}${ext}` : `${folder}/${stem}-${n}${ext}`
      if (!used.has(next)) {
        used.add(next)
        return next
      }
    }
  }

  for (let i = 0; i < bundle.length; i += batchSize) {
    const batch = bundle.slice(i, i + batchSize)
    await Promise.all(
      batch.map(async (file) => {
        if (file.url === null) {
          skipped += 1
          return
        }
        try {
          const response = await fetch(file.url)
          if (!response.ok) throw new Error(String(response.status))
          const blob = await response.blob()
          zip.file(uniquePath(folderFor(file, grouping), file.filename), blob)
          added += 1
        } catch {
          skipped += 1
        }
      }),
    )
  }

  if (added > 0) {
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${eventSlug}-deliverables.zip`)
  }
  return { added, skipped }
}
