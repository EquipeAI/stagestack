import { useState } from 'react'
import { useConvex, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { MenuItem, MenuLabel, Popover } from './Popover'
import {
  ABSTRACT_STATUS_LABEL,
  BUILT_IN_VIEWS,
  COLUMNS,
  STATUS_ORDER,
  displayTitle,
  sameView,
} from './model'
import {
  downloadFileBundle,
  exportCsv,
  exportReviewsCsv,
  exportXlsx,
  slug,
} from './exporters'
import type { ConvexReactClient } from 'convex/react'
import type {
  AbstractsSearch,
  ColumnId,
  ProposalStatus,
  ViewDef,
} from './model'
import type { ExportInput, ReviewExportRow } from './exporters'
import { Button, Field, Icon, IconButton, Input, Switch } from '~/ds'
import { pushToast } from '~/components/toast'

// The three toolbar menus. Views and columns are preferences (URL + local
// storage); export is a client-side action over exactly the rows on screen.

export function ViewsMenu({
  search,
  saved,
  onApply,
  onSave,
  onDelete,
}: {
  search: AbstractsSearch
  saved: ReadonlyArray<ViewDef>
  onApply: (search: AbstractsSearch) => void
  onSave: (name: string) => void
  onDelete: (name: string) => void
}) {
  const active =
    [...BUILT_IN_VIEWS, ...saved].find((v) => sameView(v.search, search))?.name ?? null

  return (
    <Popover
      label={active === null ? 'Custom view' : active}
      icon="list-filter"
      align="start"
      width="19rem"
    >
      {(close) => (
        <>
          <MenuLabel>Built in</MenuLabel>
          {BUILT_IN_VIEWS.map((view) => (
            <MenuItem
              key={view.name}
              onClick={() => {
                onApply(view.search)
                close()
              }}
            >
              {view.name}
              {view.name === active ? <Icon name="check" size={14} /> : null}
            </MenuItem>
          ))}
          {saved.length > 0 ? (
            <>
              <MenuLabel>Saved</MenuLabel>
              {saved.map((view) => (
                <div
                  key={view.name}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <MenuItem
                      onClick={() => {
                        onApply(view.search)
                        close()
                      }}
                    >
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {view.name}
                      </span>
                      {view.name === active ? <Icon name="check" size={14} /> : null}
                    </MenuItem>
                  </span>
                  <IconButton
                    icon="trash-2"
                    label={`Delete the ${view.name} view`}
                    size="sm"
                    onClick={() => onDelete(view.name)}
                  />
                </div>
              ))}
            </>
          ) : null}
          <SaveViewForm onSave={onSave} />
        </>
      )}
    </Popover>
  )
}

function SaveViewForm({ onSave }: { onSave: (name: string) => void }) {
  const [name, setName] = useState('')
  const submit = () => {
    if (name.trim() === '') return
    onSave(name.trim())
    setName('')
  }
  return (
    <div
      style={{
        paddingTop: 'var(--space-2)',
        borderTop: 'var(--space-px) solid var(--border-subtle)',
      }}
    >
      <Field
        label="Save this view"
        htmlFor="save-view-name"
        hint="Search, filters, sort and columns, kept in this browser."
      >
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Input
            id="save-view-name"
            size="sm"
            value={name}
            placeholder="Wave 1 shortlist"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          <Button size="sm" onClick={submit} disabled={name.trim() === ''}>
            Save
          </Button>
        </div>
      </Field>
    </div>
  )
}

/**
 * The status filter: every state, its count, and whether it is on. A chip row
 * rather than a Select because an organizer reads the shape of the pipeline
 * from the counts — 312 Submitted, 40 in the accept queue — at a glance.
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
      <Chip label="All" count={counts.all ?? 0} on={active.length === 0} onClick={onClear} />
      {STATUS_ORDER.map((status) => (
        <Chip
          key={status}
          label={ABSTRACT_STATUS_LABEL[status]}
          count={counts[status] ?? 0}
          on={active.includes(status)}
          onClick={() => onToggle(status)}
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
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
  const base = `${slug(eventName)}-proposals`

  return (
    <Popover label="Export" icon="download" width="20rem" disabled={busy}>
      {(close) => (
        <>
          <MenuLabel>
            {visibleCount} {visibleCount === 1 ? 'proposal' : 'proposals'} in this view
          </MenuLabel>
          <MenuItem
            onClick={() => {
              exportCsv(buildInput(), base)
              pushToast('CSV exported', `${visibleCount} rows, visible columns + every answer.`)
              close()
            }}
          >
            Export CSV
          </MenuItem>
          <MenuItem
            onClick={() => {
              setBusy(true)
              void exportXlsx(buildInput(), base)
                .then(() => {
                  pushToast('XLSX exported', `${visibleCount} rows, one sheet.`)
                })
                .catch(() => pushToast('Export failed', 'The workbook could not be built.'))
                .finally(() => {
                  setBusy(false)
                  close()
                })
            }}
          >
            Export XLSX
          </MenuItem>
          <ReviewsCsvItem
            eventSlug={eventSlug}
            base={base}
            buildInput={buildInput}
            onDone={close}
          />
          <MenuLabel>Attachments</MenuLabel>
          <FileBundleItem eventSlug={eventSlug} base={base} onDone={close} />
        </>
      )}
    </Popover>
  )
}

/**
 * One review row per proposal on screen. Assignment progress is already in
 * memory (the table subscribes to it); the recommendation split lives in the
 * per-proposal summary, fetched here in small batches at click time — and only
 * for proposals that actually have assignments.
 */
async function buildReviewRows(
  convex: ConvexReactClient,
  eventSlug: string,
  input: ExportInput,
): Promise<Array<ReviewExportRow>> {
  const out: Array<ReviewExportRow> = []
  const batchSize = 8
  for (let i = 0; i < input.rows.length; i += batchSize) {
    const batch = input.rows.slice(i, i + batchSize)
    out.push(
      ...(await Promise.all(
        batch.map(async (row) => {
          const p = input.progress?.[row.proposal._id]
          const base = {
            title: displayTitle(row.proposal),
            status: ABSTRACT_STATUS_LABEL[row.proposal.status],
            assigned: p?.assigned ?? 0,
            submitted: p?.submitted ?? 0,
            avgScore: p?.avgScore ?? null,
          }
          if (p === undefined || p.assigned === 0) {
            return { ...base, acceptCount: 0, neutralCount: 0, declineCount: 0 }
          }
          const summary = await convex.query(api.reviews.summary, {
            eventSlug,
            proposalId: row.proposal._id,
          })
          return {
            ...base,
            avgScore: summary.aggregate.avgScore,
            acceptCount: summary.aggregate.recommendations.accept,
            neutralCount: summary.aggregate.recommendations.neutral,
            declineCount: summary.aggregate.recommendations.decline,
          }
        }),
      )),
    )
  }
  return out
}

/** The reviews sheet (ABS-13): one row per visible proposal. */
function ReviewsCsvItem({
  eventSlug,
  base,
  buildInput,
  onDone,
}: {
  eventSlug: string
  base: string
  buildInput: () => ExportInput
  onDone: () => void
}) {
  const convex = useConvex()
  const [busy, setBusy] = useState(false)

  return (
    <MenuItem
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void buildReviewRows(convex, eventSlug, buildInput())
          .then((rows) => {
            exportReviewsCsv(rows, `${base}-reviews`)
            pushToast(
              'Reviews exported',
              `${rows.length} ${rows.length === 1 ? 'proposal' : 'proposals'}, progress and recommendations.`,
            )
          })
          .catch(() => pushToast('Export failed', 'The review summaries could not be read.'))
          .finally(() => {
            setBusy(false)
            onDone()
          })
      }}
    >
      {busy ? 'Reading reviews…' : 'Reviews (CSV)'}
    </MenuItem>
  )
}

/** Mounted only inside the open menu — the file-answer query (and its storage
 * URLs) is never subscribed by a table nobody is exporting from. */
function FileBundleItem({
  eventSlug,
  base,
  onDone,
}: {
  eventSlug: string
  base: string
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
          pushToast('No files to download', 'No proposal has a file answer yet.')
          onDone()
          return
        }
        setBusy(true)
        void downloadFileBundle(files, `${base}-files`)
          .then(({ added, failed }) => {
            pushToast(
              `${added} ${added === 1 ? 'file' : 'files'} bundled`,
              failed === 0 ? undefined : `${failed} could not be fetched.`,
            )
          })
          .catch(() => pushToast('Bundle failed', 'The zip could not be built.'))
          .finally(() => {
            setBusy(false)
            onDone()
          })
      }}
    >
      {label}
    </MenuItem>
  )
}
