import { useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
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

type FileRow = FunctionReturnType<typeof api.tasks.filesLibraryV2>[number]

type Grouping = 'session' | 'speaker' | 'flat'
type ZipState = 'idle' | 'generating' | 'ready' | 'error'

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
  const files = useQuery(api.tasks.filesLibraryV2, { eventSlug })
  const convex = useConvex()
  // null means the initial "all latest files" selection. An explicit empty
  // Set means the organizer really deselected everything; it must never be
  // reinterpreted as "export all" by the backend's empty-array shorthand.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null)
  const [grouping, setGrouping] = useState<Grouping>('session')
  const [zipState, setZipState] = useState<ZipState>('idle')
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

  const selectedIds = selected ?? new Set(files.map((row) => row.fileId))
  const allSelected = selectedIds.size === files.length
  const toggleAll = () => {
    setSelected(
      allSelected ? new Set() : new Set(files.map((row) => row.fileId)),
    )
  }
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev ?? selectedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const downloadZip = () => {
    setZipState('generating')
    void (async () => {
      try {
        const bundle = await convex.query(api.tasks.exportBundleV2, {
          eventSlug,
          fileIds: [...selectedIds],
        })
        const { added, skipped } = await buildZip(bundle, grouping, eventSlug)
        if (added === 0) {
          setZipState('error')
          pushToast(
            'Nothing to download',
            'None of the selected files could be fetched.',
            'triangle-alert',
          )
        } else {
          setZipState('ready')
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
        setZipState('error')
        pushToast(
          'Export failed',
          'The file bundle could not be read. Try again.',
          'triangle-alert',
        )
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
            {
              ' · Complete view · 120 files · 64 headshots/sessions · 16 additional task contacts max'
            }
            {selectedIds.size > 0 ? ` · ${selectedIds.size} selected` : ''}
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
              disabled={zipState === 'generating' || selectedIds.size === 0}
              onClick={downloadZip}
            >
              {zipState === 'generating'
                ? 'Generating ZIP…'
                : `Download ZIP (${selectedIds.size})`}
            </Button>
            <span
              role="status"
              aria-live="polite"
              style={{
                font: 'var(--type-caption)',
                color:
                  zipState === 'ready'
                    ? 'var(--status-success-fg)'
                    : zipState === 'error'
                      ? 'var(--status-blocked-fg)'
                      : 'var(--text-tertiary)',
              }}
            >
              {zipState === 'generating'
                ? 'Generating selected latest versions…'
                : zipState === 'ready'
                  ? 'Ready — download started.'
                  : zipState === 'error'
                    ? 'ZIP was not downloaded.'
                    : 'Selected rows export their latest version.'}
            </span>
          </div>
        }
      />

      <Card padded={false}>
        <DataTable
          rowKey="fileId"
          selectedIds={[...selectedIds]}
          rows={files}
          columns={[
            {
              key: 'select',
              width: '2.5rem',
              header: <Checkbox checked={allSelected} onChange={toggleAll} />,
              cell: (row: FileRow) => (
                <Checkbox
                  checked={selectedIds.has(row.fileId)}
                  onChange={() => {
                    toggleOne(row.fileId)
                  }}
                />
              ),
            },
            {
              key: 'filename',
              header: 'File',
              cell: (row: FileRow) => (
                <span
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 'var(--space-1)',
                  }}
                >
                  {row.url === null ? (
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      {row.filename} (unavailable)
                    </span>
                  ) : (
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                      download={row.filename}
                      style={{ color: 'var(--text-link)' }}
                    >
                      {row.filename}
                    </a>
                  )}
                  {row.sourceFilename === null ? null : (
                    <span
                      style={{
                        font: 'var(--type-caption)',
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      Source: {row.sourceFilename}
                    </span>
                  )}
                </span>
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
              key: 'uploadedByName',
              header: 'Uploader',
              cell: (row: FileRow) => row.uploadedByName ?? 'Unknown',
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
                  {row.uploadedAt === null
                    ? 'Unknown'
                    : formatDateTime(row.uploadedAt, timezone)}
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
                  {row.version === null || row.versionCount === null
                    ? 'History unavailable'
                    : `v${row.version} · ${countLabel(
                        row.versionCount,
                        'version',
                        'versions',
                      )}`}
                </span>
              ),
            },
            {
              key: 'comments',
              header: 'Comments',
              cell: (row: FileRow) =>
                row.instanceId === null ? (
                  <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                ) : (
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

      {threadFor === null || threadFor.instanceId === null ? null : (
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

export type BundleFile = FunctionReturnType<
  typeof api.tasks.exportBundleV2
>[number]

export function folderFor(file: BundleFile, grouping: Grouping): string {
  switch (grouping) {
    case 'session':
      return slug(file.sessionTitle)
    case 'speaker':
      return slug(file.speakerName ?? 'unassigned')
    case 'flat':
      return ''
  }
}

/** Historical upload names may predate backend path validation. ZIP entries
 * always use a basename so no selected file can escape its grouping folder. */
export function safeZipFilename(filename: string): string {
  const leaf = filename.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)
  const withoutControls = [...(leaf ?? '')]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f ? '_' : character
    })
    .join('')
  const cleaned = withoutControls.trim().replace(/[. ]+$/g, '')
  return cleaned === '' || cleaned === '.' || cleaned === '..'
    ? 'file'
    : cleaned
}

/** Fetches in small batches (same rationale as the abstracts bundle) and
 * never lets one dead URL abort the export. */
export function planZipPaths(
  bundle: ReadonlyArray<BundleFile>,
  grouping: Grouping,
): Array<{ file: BundleFile; path: string }> {
  const used = new Set<string>()
  const collisionKey = (path: string) => path.normalize('NFKC').toLowerCase()
  const uniquePath = (folder: string, filename: string): string => {
    const base = folder === '' ? filename : `${folder}/${filename}`
    const baseKey = collisionKey(base)
    if (!used.has(baseKey)) {
      used.add(baseKey)
      return base
    }
    const dot = filename.lastIndexOf('.')
    const stem = dot <= 0 ? filename : filename.slice(0, dot)
    const ext = dot <= 0 ? '' : filename.slice(dot)
    for (let n = 2; ; n += 1) {
      const next =
        folder === '' ? `${stem}-${n}${ext}` : `${folder}/${stem}-${n}${ext}`
      const nextKey = collisionKey(next)
      if (!used.has(nextKey)) {
        used.add(nextKey)
        return next
      }
    }
  }
  return bundle.map((file) => ({
    file,
    path: uniquePath(folderFor(file, grouping), safeZipFilename(file.filename)),
  }))
}

export async function buildZip(
  bundle: ReadonlyArray<BundleFile>,
  grouping: Grouping,
  eventSlug: string,
): Promise<{ added: number; skipped: number }> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  let added = 0
  let skipped = 0
  const batchSize = 6

  const planned = planZipPaths(bundle, grouping)
  for (let i = 0; i < planned.length; i += batchSize) {
    const batch = planned.slice(i, i + batchSize)
    await Promise.all(
      batch.map(async ({ file, path }) => {
        if (file.url === null) {
          skipped += 1
          return
        }
        try {
          const response = await fetch(file.url)
          if (!response.ok) throw new Error(String(response.status))
          const blob = await response.blob()
          zip.file(path, blob)
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
