import {
  ABSTRACT_STATUS_LABEL,
  ABSTRACT_STATUS_TONE,
  COLUMNS,
  displayTitle,
  reviewCell,
  submitterOf,
} from './model'
import type * as React from 'react'
import type {
  AbstractRow,
  ColumnId,
  ProposalId,
  ReviewProgress,
  SortKey,
  SystemFieldIds,
  TableState,
} from './model'
import { DataTable, Icon, StatusPill } from '~/ds'
import { formatDateTime } from '~/lib/datetime'

// The table itself. Selection, sorting and the detail hand-off live in the
// route; this renders. Rows arrive already filtered and sorted so a keystroke
// re-renders exactly one component.

const COLUMN_LABEL: Record<ColumnId, string> = Object.fromEntries(
  COLUMNS.map((c) => [c.id, c.label]),
) as Record<ColumnId, string>

const WIDTHS: Record<ColumnId, string | undefined> = {
  title: undefined,
  speakers: '6.5rem',
  submitter: '14rem',
  status: '9.5rem',
  reviews: '9rem',
  submittedAt: '12rem',
  updatedAt: '12rem',
}

const ALIGN: Partial<Record<ColumnId, 'left' | 'right'>> = { speakers: 'right' }

export function AbstractsTable({
  rows,
  state,
  ids,
  progress,
  timezone,
  selected,
  failures,
  onSort,
  onToggle,
  onToggleAll,
  onOpen,
}: {
  rows: ReadonlyArray<AbstractRow>
  state: TableState
  ids: SystemFieldIds
  progress: ReviewProgress | undefined
  timezone: string
  selected: ReadonlySet<string>
  /** proposalId → why its last bulk action did not apply. */
  failures: ReadonlyMap<string, string>
  onSort: (key: SortKey) => void
  onToggle: (id: ProposalId, shiftKey: boolean) => void
  onToggleAll: () => void
  onOpen: (id: ProposalId) => void
}) {
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.proposal._id))

  const columns = [
    {
      key: 'select',
      width: '2.75rem',
      header: (
        <CheckCell
          checked={allSelected}
          label={allSelected ? 'Clear selection' : 'Select every visible proposal'}
          onToggle={onToggleAll}
        />
      ),
      cell: (row: AbstractRow) => (
        <CheckCell
          checked={selected.has(row.proposal._id)}
          label={`Select ${displayTitle(row.proposal)}`}
          onToggle={(shiftKey) => onToggle(row.proposal._id, shiftKey)}
        />
      ),
    },
    ...state.cols.map((id) => ({
      key: id,
      width: WIDTHS[id],
      align: ALIGN[id] ?? 'left',
      header: (
        <SortHeader
          label={COLUMN_LABEL[id]}
          active={state.sort === id}
          dir={state.dir}
          align={ALIGN[id] ?? 'left'}
          onClick={() => onSort(id)}
        />
      ),
      cell: (row: AbstractRow) =>
        renderCell(id, row, { ids, progress, timezone, failures, onOpen }),
    })),
  ]

  return (
    <DataTable
      rowKey="_id"
      rows={rows.map((r) => ({ ...r, _id: r.proposal._id }))}
      selectedIds={[...selected]}
      onRowClick={(row: AbstractRow) => onOpen(row.proposal._id)}
      columns={columns}
    />
  )
}

function renderCell(
  id: ColumnId,
  row: AbstractRow,
  ctx: {
    ids: SystemFieldIds
    progress: ReviewProgress | undefined
    timezone: string
    failures: ReadonlyMap<string, string>
    onOpen: (id: ProposalId) => void
  },
): React.ReactNode {
  const { proposal } = row
  switch (id) {
    case 'title': {
      const failure = ctx.failures.get(proposal._id)
      return (
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* A real button, so the detail panel is reachable by keyboard —
              the row's own click handler is a mouse convenience on top. */}
          <button
            type="button"
            className="ss-table__primary"
            onClick={(e) => {
              e.stopPropagation()
              ctx.onOpen(proposal._id)
            }}
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              background: 'transparent',
              border: 'none',
              padding: 0,
              font: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
              color:
                proposal.title.trim() === ''
                  ? 'var(--text-tertiary)'
                  : 'var(--text-primary)',
            }}
          >
            {displayTitle(proposal)}
          </button>
          {failure !== undefined ? (
            <span className="ss-table__sub" style={{ color: 'var(--text-danger)' }}>
              {failure}
            </span>
          ) : null}
        </span>
      )
    }
    case 'speakers':
      return <span className="ss-table__num">{row.speakerCount}</span>
    case 'submitter': {
      const { name, email } = submitterOf(proposal, ctx.ids)
      return (
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={ellipsis}>{name === '' ? '—' : name}</span>
          {email !== '' ? (
            <span className="ss-table__sub" style={ellipsis}>
              {email}
            </span>
          ) : null}
        </span>
      )
    }
    case 'status':
      return (
        <StatusPill
          status={ABSTRACT_STATUS_LABEL[proposal.status]}
          tone={ABSTRACT_STATUS_TONE[proposal.status]}
        />
      )
    case 'reviews':
      return (
        <span className="ss-table__num">{reviewCell(ctx.progress, proposal._id)}</span>
      )
    case 'submittedAt':
      return (
        <span className="ss-table__num">
          {proposal.submittedAt === undefined
            ? '—'
            : formatDateTime(proposal.submittedAt, ctx.timezone)}
        </span>
      )
    case 'updatedAt':
      return (
        <span className="ss-table__num">
          {formatDateTime(proposal.updatedAt, ctx.timezone)}
        </span>
      )
  }
}

/**
 * A native checkbox rather than the design system's `Checkbox`: the cell has to
 * stop the click from reaching the row, and `Checkbox` declares no click
 * handler. Sizing and the amber focus ring come from the same tokens.
 */
function CheckCell({
  checked,
  label,
  onToggle,
}: {
  checked: boolean
  label: string
  onToggle: (shiftKey: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onToggle((e.nativeEvent as MouseEvent).shiftKey === true)}
      style={{
        width: 'var(--space-4)',
        height: 'var(--space-4)',
        accentColor: 'var(--gray-900)',
        cursor: 'pointer',
        display: 'block',
      }}
    />
  )
}

function SortHeader({
  label,
  active,
  dir,
  align,
  onClick,
}: {
  label: string
  active: boolean
  dir: 'asc' | 'desc'
  align: 'left' | 'right'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        active
          ? `${label}, sorted ${dir === 'asc' ? 'ascending' : 'descending'}. Reverse the order`
          : `Sort by ${label}`
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        width: '100%',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        background: 'transparent',
        border: 'none',
        padding: 0,
        font: 'inherit',
        letterSpacing: 'inherit',
        textTransform: 'inherit',
        color: active ? 'var(--text-primary)' : 'inherit',
        cursor: 'pointer',
      }}
    >
      {label}
      <span
        style={{
          display: 'inline-flex',
          opacity: active ? 1 : 0,
          transform: active && dir === 'asc' ? 'rotate(180deg)' : undefined,
        }}
      >
        <Icon name="chevron-down" size={14} />
      </span>
    </button>
  )
}

const ellipsis: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
