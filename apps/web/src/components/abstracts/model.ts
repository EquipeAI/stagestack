import { allFields } from '@convex/shared/formDef'
import type { AnswerValue, FormDef, SystemKey } from '@convex/shared/formDef'
import type { Doc, Id } from '@convex/_generated/dataModel'

// Everything the abstracts table agrees on: the organizer's vocabulary for a
// proposal state, the table's own state shape (which is a URL search param set,
// so a view is a link), and the pure filter/sort/derive functions the table and
// the exporters both run over.

export type ProposalStatus = Doc<'proposals'>['status']
export type ProposalId = Id<'proposals'>

export type AbstractRow = {
  proposal: Doc<'proposals'>
  speakerCount: number
}

export type ReviewProgress = Record<
  string,
  { assigned: number; submitted: number; avgScore: number | null }
>

/**
 * What an ORGANIZER is told the state is — unlike the submitter-facing labels
 * in components/cfp/model.ts, the staged queues are named, because naming them
 * is the whole point of the staging step.
 */
export const ABSTRACT_STATUS_LABEL: Record<ProposalStatus, string> = {
  draft: 'Draft',
  pending: 'Submitted',
  acceptQueue: 'Accept queue',
  declineQueue: 'Decline queue',
  accepted: 'Accepted',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}

/**
 * The queue states are not in the design system's STATUS_TONES map (they are
 * StageStack-internal), so their tone is declared once, here, rather than
 * guessed per screen. Everything else resolves through StatusPill itself.
 */
export const ABSTRACT_STATUS_TONE: Partial<
  Record<ProposalStatus, 'success' | 'blocked'>
> = {
  acceptQueue: 'success',
  declineQueue: 'blocked',
}

/** Pipeline order — used for the chip row and for sorting by status. */
export const STATUS_ORDER: Array<ProposalStatus> = [
  'draft',
  'pending',
  'acceptQueue',
  'declineQueue',
  'accepted',
  'declined',
  'withdrawn',
]

const STATUS_RANK = new Map(STATUS_ORDER.map((s, i) => [s, i]))

export function isProposalStatus(value: string): value is ProposalStatus {
  return STATUS_RANK.has(value as ProposalStatus)
}

/** A staged decision is one waiting for a release — the only reversible half. */
export function isStaged(status: ProposalStatus) {
  return status === 'acceptQueue' || status === 'declineQueue'
}

// ── Columns ──────────────────────────────────────────────────────────────

export const COLUMNS = [
  { id: 'title', label: 'Title', fixed: true },
  { id: 'speakers', label: 'Speakers', fixed: false },
  { id: 'submitter', label: 'Submitter', fixed: false },
  { id: 'status', label: 'Status', fixed: false },
  { id: 'reviews', label: 'Reviews', fixed: false },
  { id: 'submittedAt', label: 'Submitted', fixed: false },
  { id: 'updatedAt', label: 'Updated', fixed: false },
] as const

export type ColumnId = (typeof COLUMNS)[number]['id']

export const ALL_COLUMN_IDS: Array<ColumnId> = COLUMNS.map((c) => c.id)

export type SortKey = ColumnId

// ── Table state ──────────────────────────────────────────────────────────

export type SortDir = 'asc' | 'desc'

export type TableState = {
  q: string
  statuses: Array<ProposalStatus>
  sort: SortKey
  dir: SortDir
  cols: Array<ColumnId>
}

/** The URL shape. Every key is optional so a default view has a clean URL. */
export type AbstractsSearch = {
  q?: string
  status?: string
  sort?: SortKey
  dir?: SortDir
  cols?: string
}

export const DEFAULT_SORT: SortKey = 'submittedAt'
export const DEFAULT_DIR: SortDir = 'desc'

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Route-level validateSearch: unknown params are dropped, never trusted. */
export function parseSearch(input: Record<string, unknown>): AbstractsSearch {
  const out: AbstractsSearch = {}
  const q = str(input.q)
  if (q !== undefined) out.q = q.slice(0, 200)
  const status = str(input.status)
  if (status !== undefined) {
    const list = status.split(',').filter(isProposalStatus)
    if (list.length > 0) out.status = list.join(',')
  }
  const sort = str(input.sort)
  if (sort !== undefined && ALL_COLUMN_IDS.includes(sort as ColumnId)) {
    out.sort = sort as SortKey
  }
  const dir = str(input.dir)
  if (dir === 'asc' || dir === 'desc') out.dir = dir
  const cols = str(input.cols)
  if (cols !== undefined) {
    const list = cols
      .split(',')
      .filter((c): c is ColumnId => ALL_COLUMN_IDS.includes(c as ColumnId))
    if (list.length > 0) out.cols = list.join(',')
  }
  return out
}

/** URL params + the organizer's stored column preference → the live state. */
export function stateFromSearch(
  search: AbstractsSearch,
  storedCols: Array<ColumnId> | null,
): TableState {
  const cols =
    search.cols !== undefined
      ? (search.cols.split(',') as Array<ColumnId>)
      : (storedCols ?? ALL_COLUMN_IDS)
  return {
    q: search.q ?? '',
    statuses:
      search.status === undefined
        ? []
        : (search.status.split(',') as Array<ProposalStatus>),
    sort: search.sort ?? DEFAULT_SORT,
    dir: search.dir ?? DEFAULT_DIR,
    // 'title' is not optional — it is how a row is identified.
    cols: ALL_COLUMN_IDS.filter((c) => c === 'title' || cols.includes(c)),
  }
}

/** The inverse. Defaults are omitted so "All" is just /proposals. */
export function searchFromState(state: TableState): AbstractsSearch {
  const out: AbstractsSearch = {}
  if (state.q.trim() !== '') out.q = state.q.trim()
  if (state.statuses.length > 0) out.status = state.statuses.join(',')
  if (state.sort !== DEFAULT_SORT) out.sort = state.sort
  if (state.dir !== DEFAULT_DIR) out.dir = state.dir
  if (state.cols.length !== ALL_COLUMN_IDS.length) out.cols = state.cols.join(',')
  return out
}

// ── Built-in views ───────────────────────────────────────────────────────

export type ViewDef = { name: string; search: AbstractsSearch }

export const BUILT_IN_VIEWS: Array<ViewDef> = [
  { name: 'All', search: {} },
  { name: 'Inbox', search: { status: 'pending' } },
  { name: 'Queues', search: { status: 'acceptQueue,declineQueue' } },
  { name: 'Released', search: { status: 'accepted,declined' } },
  { name: 'Withdrawn', search: { status: 'withdrawn' } },
]

/** Two views are the same view when they filter and sort the same way. */
export function sameView(a: AbstractsSearch, b: AbstractsSearch) {
  return (
    (a.q ?? '') === (b.q ?? '') &&
    (a.status ?? '') === (b.status ?? '') &&
    (a.sort ?? DEFAULT_SORT) === (b.sort ?? DEFAULT_SORT) &&
    (a.dir ?? DEFAULT_DIR) === (b.dir ?? DEFAULT_DIR) &&
    (a.cols ?? '') === (b.cols ?? '')
  )
}

// ── Answers ──────────────────────────────────────────────────────────────

export type SystemFieldIds = Record<SystemKey, string>

/**
 * System answers are keyed by the FIELD id, which only happens to equal the
 * system key on the default form. Resolve it from the definition instead of
 * assuming, or a renamed field silently blanks the Submitter column.
 */
export function systemFieldIds(def: FormDef | null): SystemFieldIds {
  const fallback: SystemFieldIds = {
    talkTitle: 'talkTitle',
    abstract: 'abstract',
    firstName: 'firstName',
    lastName: 'lastName',
    email: 'email',
  }
  if (def === null) return fallback
  for (const field of allFields(def)) {
    if (field.systemKey !== undefined) fallback[field.systemKey] = field.id
  }
  return fallback
}

export function answerText(value: AnswerValue | undefined): string {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

export type Submitter = { name: string; email: string }

export function submitterOf(
  proposal: Doc<'proposals'>,
  ids: SystemFieldIds,
): Submitter {
  const name = [
    answerText(proposal.answers[ids.firstName]),
    answerText(proposal.answers[ids.lastName]),
  ]
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .join(' ')
  return { name, email: answerText(proposal.answers[ids.email]).trim() }
}

export function displayTitle(proposal: Doc<'proposals'>) {
  return proposal.title.trim() === '' ? 'Untitled proposal' : proposal.title
}

// ── Filter & sort ────────────────────────────────────────────────────────

/**
 * One lowercased haystack per proposal — title, submitter, and every text
 * answer — built once per row and reused across keystrokes. 500 rows × a few
 * hundred characters is nothing; rebuilding it per keystroke would not be.
 */
export function searchIndex(
  rows: ReadonlyArray<AbstractRow>,
  ids: SystemFieldIds,
): Map<string, string> {
  const index = new Map<string, string>()
  for (const row of rows) {
    const parts = [row.proposal.title]
    for (const value of Object.values(row.proposal.answers)) {
      parts.push(answerText(value))
    }
    const { name, email } = submitterOf(row.proposal, ids)
    parts.push(name, email)
    index.set(row.proposal._id, parts.join('   ').toLowerCase())
  }
  return index
}

export function filterRows(
  rows: ReadonlyArray<AbstractRow>,
  state: TableState,
  index: Map<string, string>,
): Array<AbstractRow> {
  const needle = state.q.trim().toLowerCase()
  const statuses = new Set(state.statuses)
  return rows.filter((row) => {
    if (statuses.size > 0 && !statuses.has(row.proposal.status)) return false
    if (needle === '') return true
    return (index.get(row.proposal._id) ?? '').includes(needle)
  })
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base' })

export function sortRows(
  rows: Array<AbstractRow>,
  state: TableState,
  ids: SystemFieldIds,
  progress: ReviewProgress | undefined,
): Array<AbstractRow> {
  const factor = state.dir === 'asc' ? 1 : -1
  const value = (row: AbstractRow): number | string => {
    switch (state.sort) {
      case 'title':
        return displayTitle(row.proposal).toLowerCase()
      case 'speakers':
        return row.speakerCount
      case 'submitter':
        return submitterOf(row.proposal, ids).name.toLowerCase()
      case 'status':
        return STATUS_RANK.get(row.proposal.status) ?? 0
      case 'reviews': {
        const p = progress?.[row.proposal._id]
        // Unreviewed sorts below every scored proposal, in both directions.
        return p === undefined ? -1 : (p.avgScore ?? p.submitted / 100)
      }
      case 'submittedAt':
        return row.proposal.submittedAt ?? 0
      case 'updatedAt':
        return row.proposal.updatedAt
    }
  }
  return [...rows].sort((a, b) => {
    const left = value(a)
    const right = value(b)
    const cmp =
      typeof left === 'string' && typeof right === 'string'
        ? collator.compare(left, right)
        : Number(left) - Number(right)
    // Stable tiebreak so equal rows never shuffle between renders.
    return cmp !== 0 ? cmp * factor : collator.compare(a.proposal._id, b.proposal._id)
  })
}

export function reviewCell(
  progress: ReviewProgress | undefined,
  id: string,
): string {
  const p = progress?.[id]
  if (p === undefined || p.assigned === 0) return '—'
  const score = p.avgScore === null ? '' : ` · avg ${p.avgScore.toFixed(1)}`
  return `${p.submitted}/${p.assigned}${score}`
}

// ── Bulk results ─────────────────────────────────────────────────────────

export type BulkResult = { proposalId: ProposalId; ok: boolean; error?: string }

/**
 * What one call to sessions.setStatus / sessions.release accepts. The cap is
 * the backend's (convex/model/sessions.ts, MAX_BULK) — a selection larger than
 * this is the caller's to split, which is what `bulkChunks` is for.
 */
export const BULK_LIMIT = 100

/** Splits a selection into calls the backend will accept, in order. */
export function bulkChunks<T>(
  ids: ReadonlyArray<T>,
  size = BULK_LIMIT,
): Array<Array<T>> {
  const out: Array<Array<T>> = []
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size))
  }
  return out
}

/** Stable backend codes → the sentence an organizer can act on. */
export function bulkErrorMessage(code: string | undefined) {
  switch (code) {
    case 'not_found':
      return 'No longer on this event.'
    case 'invalid_status':
      return 'Its state changed while you were looking at it.'
    default:
      return 'Could not be changed.'
  }
}

// ── Stored preferences ───────────────────────────────────────────────────

const VIEWS_KEY = 'stagestack.abstracts.views'
const COLUMNS_KEY = 'stagestack.abstracts.columns'

function read<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as T)
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // A full or blocked storage costs the organizer a preference, not a table.
  }
}

export function loadSavedViews(eventSlug: string): Array<ViewDef> {
  const stored = read<unknown>(`${VIEWS_KEY}.${eventSlug}`)
  if (!Array.isArray(stored)) return []
  const out: Array<ViewDef> = []
  for (const entry of stored as Array<Record<string, unknown>>) {
    const name = entry.name
    const search = entry.search
    if (typeof name !== 'string' || name === '') continue
    if (typeof search !== 'object' || search === null) continue
    // Re-validated on read: stored JSON is as untrusted as a URL.
    out.push({ name, search: parseSearch(search as Record<string, unknown>) })
  }
  return out
}

export function storeSavedViews(eventSlug: string, views: Array<ViewDef>) {
  write(`${VIEWS_KEY}.${eventSlug}`, views)
}

export function loadStoredColumns(eventSlug: string): Array<ColumnId> | null {
  const stored = read<Array<string>>(`${COLUMNS_KEY}.${eventSlug}`)
  if (stored === null || !Array.isArray(stored)) return null
  const list = stored.filter((c): c is ColumnId =>
    ALL_COLUMN_IDS.includes(c as ColumnId),
  )
  return list.length === 0 ? null : list
}

export function storeColumns(eventSlug: string, cols: Array<ColumnId>) {
  write(`${COLUMNS_KEY}.${eventSlug}`, cols)
}
