import { useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { MenuItem, MenuLabel, Popover } from './Popover'
import {
  ABSTRACT_STATUS_LABEL,
  COLUMNS,
  STATUS_ORDER,
  displayTitle,
} from './model'
import {
  downloadFileBundle,
  exportCsv,
  exportReviewsCsv,
  exportReviewsXlsx,
  exportXlsx,
  reviewCompletion,
  slug,
} from './exporters'
import type { ConvexReactClient } from 'convex/react'
import type { ColumnId, ProposalStatus } from './model'
import type { ExportInput, ReviewExportRow } from './exporters'
import { ActionResult, Switch } from '~/ds'
import { visibleFilters } from '~/lib/filters'

// The two toolbar menus this table still owns: columns (a preference of this
// browser) and export (a client-side action over exactly the rows on screen).
// The views menu left in W2 — saved views are stored per user on the event now,
// so the picker is the shared `components/views/SavedViewsMenu`.

/**
 * Statuses whose ZERO is itself operational news (W12).
 *
 * "0 Submitted" means the queue is clear and "0 accept queue" means nothing is
 * staged waiting to be released — both are answers an organizer came to this
 * page for. "0 Withdrawn" and "0 Draft" are answers to nothing, so those chips
 * only appear once somebody is in them.
 */
const MEANINGFUL_ZERO: ReadonlySet<ProposalStatus> = new Set([
  'pending',
  'acceptQueue',
  'declineQueue',
])

/**
 * The status filter: every state that is worth offering, its count, and
 * whether it is on. A chip row rather than a Select because an organizer reads
 * the shape of the pipeline from the counts — 312 Submitted, 40 in the accept
 * queue — at a glance.
 */
export function StatusChips({
  counts,
  active,
  onToggle,
  onClear,
}: {
  counts: Record<string, number | undefined>
  active: ReadonlyArray<ProposalStatus>
  onToggle: (status: ProposalStatus) => void
  onClear: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 'var(--space-2)',
      }}
    >
      <Chip
        label="All"
        count={counts.all ?? 0}
        on={active.length === 0}
        onClick={onClear}
      />
      {visibleFilters(
        STATUS_ORDER.map((status) => ({
          id: status,
          label: ABSTRACT_STATUS_LABEL[status],
          count: counts[status] ?? 0,
          meaningfulZero: MEANINGFUL_ZERO.has(status),
        })),
        active,
      ).map((option) => (
        <Chip
          key={option.id}
          label={option.label}
          count={option.count}
          on={active.includes(option.id)}
          onClick={() => onToggle(option.id)}
        />
      ))}
    </div>
  )
}

function Chip({
  label,
  count,
  on,
  onClick,
}: {
  label: string
  count: number
  on: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        height: 'var(--row-height-sm)',
        padding: '0 var(--space-3)',
        borderRadius: 'var(--radius-pill)',
        border: `var(--space-px) solid ${on ? 'var(--border-strong)' : 'var(--border-default)'}`,
        background: on ? 'var(--surface-selected)' : 'var(--surface-card)',
        color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
        font: 'var(--type-body)',
        cursor: 'pointer',
      }}
    >
      {label}
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          color: 'var(--text-tertiary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {count}
      </span>
    </button>
  )
}

export function ColumnsMenu({
  cols,
  onChange,
}: {
  cols: Array<ColumnId>
  onChange: (cols: Array<ColumnId>) => void
}) {
  return (
    <Popover label="Columns" icon="columns-3" width="16rem">
      {() => (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          {COLUMNS.map((column) => (
            <Switch
              key={column.id}
              label={column.label}
              checked={column.fixed || cols.includes(column.id)}
              disabled={column.fixed}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...cols, column.id]
                    : cols.filter((c) => c !== column.id),
                )
              }
            />
          ))}
        </div>
      )}
    </Popover>
  )
}

/** W5: an export's outcome is a persistent result, not a toast — "did the
 * download actually happen, and with how many rows?" is a question asked after
 * the five seconds a toast lives.
 *
 * W12 adds the `pending` half: a zip of 40 attachments or a review-results
 * sheet takes long enough that a menu closing over silence reads as nothing
 * having happened. The pending result is the same component, announced the
 * same way, replaced in place by the outcome. */
export type ExportOutcome = {
  status: 'pending' | 'success' | 'partial' | 'failed'
  title: string
  lines: Array<string>
  retry?: () => void
}

export function ExportMenu({
  eventSlug,
  eventName,
  buildInput,
  visibleCount,
}: {
  eventSlug: string
  eventName: string
  /** Called at click time so the export always matches what is on screen. */
  buildInput: () => ExportInput
  visibleCount: number
}) {
  const [busy, setBusy] = useState(false)
  const [exportResult, setExportResult] = useState<ExportOutcome | null>(null)
  const base = `${slug(eventName)}-proposals`
  const rowLabel = (count: number) =>
    `${count} proposal ${count === 1 ? 'row' : 'rows'}`

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
    >
      <Popover label="Export" icon="download" width="21rem" disabled={busy}>
        {(close) => (
          <>
            <MenuLabel>
              Exactly {visibleCount} loaded{' '}
              {visibleCount === 1 ? 'proposal' : 'proposals'} in this view
            </MenuLabel>
            <MenuItem
              onClick={() => {
                setExportResult(null)
                const runCsv = () => {
                  try {
                    exportCsv(buildInput(), base)
                    setExportResult({
                      status: 'success',
                      title: 'CSV downloaded',
                      lines: [
                        `${rowLabel(visibleCount)} — the rows loaded in this view.`,
                        'Visible columns plus every answer.',
                      ],
                    })
                  } catch {
                    setExportResult({
                      status: 'failed',
                      title: 'CSV export failed',
                      lines: ['The file could not be built. Nothing downloaded.'],
                      retry: runCsv,
                    })
                  }
                }
                runCsv()
                close()
              }}
            >
              Export CSV
            </MenuItem>
            <MenuItem
              onClick={() => {
                const runXlsx = () => {
                  setExportResult({
                    status: 'pending',
                    title: 'Building the XLSX…',
                    lines: [`${rowLabel(visibleCount)} — the rows loaded in this view.`],
                  })
                  setBusy(true)
                  void exportXlsx(buildInput(), base)
                    .then(() => {
                      setExportResult({
                        status: 'success',
                        title: 'XLSX downloaded',
                        lines: [
                          `${rowLabel(visibleCount)} — the rows loaded in this view.`,
                          'One sheet.',
                        ],
                      })
                    })
                    .catch(() =>
                      setExportResult({
                        status: 'failed',
                        title: 'XLSX export failed',
                        lines: [
                          'The workbook could not be built. Nothing downloaded.',
                        ],
                        retry: runXlsx,
                      }),
                    )
                    .finally(() => {
                      setBusy(false)
                    })
                }
                runXlsx()
                close()
              }}
            >
              Export XLSX
            </MenuItem>
            <ReviewsCsvItem
              eventSlug={eventSlug}
              base={base}
              buildInput={buildInput}
              onResult={setExportResult}
              onDone={close}
            />
            <MenuLabel>Attachments</MenuLabel>
            <FileBundleItem
              eventSlug={eventSlug}
              base={base}
              onResult={setExportResult}
              onDone={close}
            />
          </>
        )}
      </Popover>
      {exportResult === null ? null : (
        <span style={{ flex: '1 1 20rem', minWidth: 0 }}>
          <ActionResult
            status={exportResult.status}
            title={exportResult.title}
            details={exportResult.lines}
            onRetry={exportResult.retry}
            onDismiss={
              exportResult.status === 'pending'
                ? undefined
                : () => setExportResult(null)
            }
          />
        </span>
      )}
    </div>
  )
}

/**
 * One review row per proposal on screen. Assignment progress is already in
 * per-proposal summary, fetched here in small batches at click time. The export
 * never trusts the table's concurrently loading progress subscription, because
 * clicking before that query resolves must not label every proposal unassigned.
 */
async function buildReviewRows(
  convex: ConvexReactClient,
  eventSlug: string,
  input: ExportInput,
): Promise<Array<ReviewExportRow>> {
  if (input.progress === undefined) {
    throw new Error('Review progress is still loading.')
  }
  const out: Array<ReviewExportRow> = []
  const batchSize = 8
  for (let i = 0; i < input.rows.length; i += batchSize) {
    const batch = input.rows.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async (row) => {
        const p = input.progress?.[row.proposal._id]
        const base = {
          title: displayTitle(row.proposal),
          status: ABSTRACT_STATUS_LABEL[row.proposal.status],
          assigned: p?.assigned ?? 0,
          submitted: p?.submitted ?? 0,
          avgScore: p?.avgScore ?? null,
        }
        if (p === undefined) {
          return {
            ...base,
            reviewStatus: 'Not assigned',
            recommendationSummary: 'No submitted recommendations',
            acceptCount: 0,
            neutralCount: 0,
            declineCount: 0,
            criteria: {},
          }
        }
        const summary = await convex.query(api.reviews.summary, {
          eventSlug,
          proposalId: row.proposal._id,
        })
        const criterionTotals = new Map<
          string,
          { label: string; total: number; count: number }
        >()
        for (const review of summary.reviews) {
          if (review.status !== 'submitted' && review.status !== 'locked') {
            continue
          }
          for (const field of review.scorecard) {
            if (field.kind !== 'numeric') continue
            const value = review.answers?.[field.id]
            if (typeof value !== 'number') continue
            const key = `${review.roundId ?? 'legacy'}:${field.id}`
            const total = criterionTotals.get(key) ?? {
              label: `${field.label} (${review.roundName})`,
              total: 0,
              count: 0,
            }
            total.total += value
            total.count += 1
            criterionTotals.set(key, total)
          }
        }
        const criteria: Record<
          string,
          { label: string; value: number }
        > = {}
        for (const [key, total] of criterionTotals) {
          criteria[key] = {
            label: total.label,
            value: Number((total.total / total.count).toFixed(2)),
          }
        }
        const { recommendations } = summary.aggregate
        const completion = reviewCompletion(
          summary.aggregate.submittedCount,
          summary.reviews,
        )
        const recommendationSummary = [
          recommendations.accept > 0 ? `Accept ${recommendations.accept}` : '',
          recommendations.neutral > 0
            ? `Neutral ${recommendations.neutral}`
            : '',
          recommendations.decline > 0
            ? `Decline ${recommendations.decline}`
            : '',
        ]
          .filter(Boolean)
          .join(' · ')
        return {
          ...base,
          assigned: completion.assigned,
          submitted: summary.aggregate.submittedCount,
          avgScore: summary.aggregate.avgScore,
          reviewStatus:
            summary.reviews.length === 0 ? 'Not assigned' : completion.label,
          recommendationSummary:
            recommendationSummary === ''
              ? 'No submitted recommendations'
              : recommendationSummary,
          acceptCount: recommendations.accept,
          neutralCount: recommendations.neutral,
          declineCount: recommendations.decline,
          criteria,
        }
      }),
    )
    out.push(...results)
  }
  return out
}

/** The review results sheet (ABS-13): exactly one row per loaded proposal. */
function ReviewsCsvItem({
  eventSlug,
  base,
  buildInput,
  onResult,
  onDone,
}: {
  eventSlug: string
  base: string
  buildInput: () => ExportInput
  onResult: (result: ExportOutcome | null) => void
  onDone: () => void
}) {
  const convex = useConvex()
  const [busy, setBusy] = useState(false)
  const progressReady = buildInput().progress !== undefined

  const runExport = (format: 'csv' | 'xlsx') => {
    // Each proposal's review summary is a separate read, so this one runs for
    // seconds on a real CFP. Say so while it does.
    onResult({
      status: 'pending',
      title: 'Reading review results…',
      lines: [
        'One row per loaded proposal. The download starts when every summary is in.',
      ],
    })
    setBusy(true)
    void buildReviewRows(convex, eventSlug, buildInput())
      .then(async (rows) => {
        if (format === 'csv') exportReviewsCsv(rows, `${base}-reviews`)
        else await exportReviewsXlsx(rows, `${base}-reviews`)
        onResult({
          status: 'success',
          title: `Review results ${format.toUpperCase()} downloaded`,
          lines: [
            `${rows.length} review result ${rows.length === 1 ? 'row' : 'rows'} — one per loaded proposal.`,
            'Status, recommendations, aggregate and criterion scores.',
          ],
        })
      })
      .catch(() =>
        onResult({
          status: 'failed',
          title: 'Review results export failed',
          lines: [
            'The review summaries could not be read. Nothing downloaded.',
          ],
          retry: () => runExport(format),
        }),
      )
      .finally(() => {
        setBusy(false)
        onDone()
      })
  }

  return (
    <>
      <MenuLabel>Review results · loaded proposals only</MenuLabel>
      <MenuItem
        disabled={busy || !progressReady}
        onClick={() => runExport('csv')}
      >
        {busy
          ? 'Reading review results…'
          : progressReady
            ? 'Review results (CSV)'
            : 'Loading review progress…'}
      </MenuItem>
      <MenuItem
        disabled={busy || !progressReady}
        onClick={() => runExport('xlsx')}
      >
        {busy ? 'Reading review results…' : 'Review results (XLSX)'}
      </MenuItem>
    </>
  )
}

/** Mounted only inside the open menu — the file-answer query (and its storage
 * URLs) is never subscribed by a table nobody is exporting from. */
function FileBundleItem({
  eventSlug,
  base,
  onResult,
  onDone,
}: {
  eventSlug: string
  base: string
  onResult: (result: ExportOutcome | null) => void
  onDone: () => void
}) {
  const files = useQuery(api.cfp.listFileAnswers, { eventSlug })
  const [busy, setBusy] = useState(false)

  const label =
    files === undefined
      ? 'Reading attachments…'
      : busy
        ? 'Zipping…'
        : `Download files (${files.length})`

  return (
    <MenuItem
      disabled={files === undefined || busy}
      onClick={() => {
        if (files === undefined) return
        if (files.length === 0) {
          onResult({
            status: 'success',
            title: 'Nothing to download',
            lines: ['No proposal has a file answer yet, so no zip was built.'],
          })
          onDone()
          return
        }
        const runBundle = () => {
          onResult({
            status: 'pending',
            title: `Zipping ${files.length} ${files.length === 1 ? 'file' : 'files'}…`,
            lines: ['Each attachment is fetched, then written into one zip.'],
          })
          setBusy(true)
          void downloadFileBundle(files, `${base}-files`)
            .then(({ added, failed }) => {
              onResult({
                status: failed === 0 ? 'success' : 'partial',
                title: `${added} ${added === 1 ? 'file' : 'files'} downloaded in the zip`,
                lines: [
                  `${files.length} attached ${files.length === 1 ? 'file was' : 'files were'} requested.`,
                  ...(failed === 0
                    ? []
                    : [
                        `${failed} could not be fetched and ${failed === 1 ? 'is' : 'are'} missing from the zip.`,
                      ]),
                ],
                retry: failed === 0 ? undefined : runBundle,
              })
            })
            .catch(() =>
              onResult({
                status: 'failed',
                title: 'Bundle failed',
                lines: ['The zip could not be built. Nothing downloaded.'],
                retry: runBundle,
              }),
            )
            .finally(() => {
              setBusy(false)
            })
        }
        runBundle()
        onDone()
      }}
    >
      {label}
    </MenuItem>
  )
}
