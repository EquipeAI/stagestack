import { allFields } from '@convex/shared/formDef'
import {
  ABSTRACT_STATUS_LABEL,
  answerText,
  displayTitle,
  reviewCell,
  submitterOf,
} from './model'
import type { FormDef } from '@convex/shared/formDef'
import type {
  AbstractRow,
  ColumnId,
  ReviewProgress,
  SystemFieldIds,
  TableState,
} from './model'
import { formatDateTime } from '~/lib/datetime'

// Export is client-side on purpose: the table is already bounded (≤500 rows)
// and in memory, so CSV and XLSX are instant and cost the backend nothing.
// `xlsx` and `jszip` are dynamically imported so they never enter the bundle
// an organizer downloads just to look at the table. `xlsx` resolves to the
// vendor tarball pinned in package.json — SheetJS left the npm registry after
// 0.18.5, the version the prototype-pollution and ReDoS advisories name.

export type ExportInput = {
  rows: ReadonlyArray<AbstractRow>
  state: TableState
  ids: SystemFieldIds
  def: FormDef | null
  progress: ReviewProgress | undefined
  timezone: string
}

const COLUMN_HEADER: Record<ColumnId, string> = {
  title: 'Title',
  speakers: 'Speakers',
  submitter: 'Submitter',
  status: 'Status',
  reviews: 'Reviews',
  submittedAt: 'Submitted',
  updatedAt: 'Updated',
}

function columnValue(
  column: ColumnId,
  row: AbstractRow,
  input: ExportInput,
): string {
  const { proposal } = row
  switch (column) {
    case 'title':
      return displayTitle(proposal)
    case 'speakers':
      return String(row.speakerCount)
    case 'submitter': {
      const { name, email } = submitterOf(proposal, input.ids)
      return [name, email].filter((v) => v !== '').join(' · ')
    }
    case 'status':
      return ABSTRACT_STATUS_LABEL[proposal.status]
    case 'reviews':
      return reviewCell(input.progress, proposal._id)
    case 'submittedAt':
      return proposal.submittedAt === undefined
        ? ''
        : formatDateTime(proposal.submittedAt, input.timezone)
    case 'updatedAt':
      return formatDateTime(proposal.updatedAt, input.timezone)
  }
}

// Excel, Sheets and LibreOffice evaluate a cell whose text starts with `=`,
// `+`, `-` or `@` (optionally behind a tab or CR, which those parsers skip), so
// a CFP answer of `=HYPERLINK("http://evil","click")` would run on the
// organizer's machine when they open the export. Every proposal answer in the
// sheet is submitter-controlled, so the whole sheet is neutralized.
const FORMULA_TRIGGER = /^[\t\r]*[=+\-@]/
// Plain numbers are exempt: `-4`, `+1.5` and `1e3` are values, not formulas,
// and quoting them would turn real numbers into text in the XLSX and break
// sums an organizer builds on the export. Anything else that starts with a
// trigger — including dates or phone numbers rendered as strings — is prefixed
// with a single quote, the "this cell is text" marker every spreadsheet honours.
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/

/** Make one already-stringified cell safe to open in a spreadsheet. */
export function sheetSafe(value: string): string {
  return FORMULA_TRIGGER.test(value) && !PLAIN_NUMBER.test(value)
    ? `'${value}`
    : value
}

/**
 * The sheet an organizer expects: the columns they can see, then EVERY answer
 * flattened under its form label — the export is the escape hatch out of the
 * product, so it never hides a field the table happens not to show.
 */
export function buildSheet(input: ExportInput): Array<Array<string>> {
  const fields = input.def === null ? [] : allFields(input.def)
  const answerKeys: Array<{ key: string; label: string }> = fields.map((f) => ({
    key: f.id,
    label: f.label.trim() === '' ? f.id : f.label,
  }))
  const known = new Set(answerKeys.map((a) => a.key))
  // Answers whose field was deleted from the form still belong in the export.
  for (const row of input.rows) {
    for (const key of Object.keys(row.proposal.answers)) {
      if (known.has(key)) continue
      known.add(key)
      answerKeys.push({ key, label: key })
    }
  }

  const header = [
    ...input.state.cols.map((c) => COLUMN_HEADER[c]),
    ...answerKeys.map((a) => a.label),
  ]
  const body = input.rows.map((row) => [
    ...input.state.cols.map((c) => columnValue(c, row, input)),
    ...answerKeys.map((a) => answerText(row.proposal.answers[a.key])),
  ])
  // Neutralized here, at the one place both writers read from, so the CSV and
  // the XLSX file get the same protection — the XLSX path never passes through
  // `csvCell`.
  return [header, ...body].map((line) => line.map(sheetSafe))
}

function csvCell(value: string) {
  return /["\n,]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function toCsv(sheet: Array<Array<string>>) {
  return sheet.map((line) => line.map(csvCell).join(',')).join('\r\n')
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on the next tick so Safari has taken the download first.
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function exportCsv(input: ExportInput, filename: string) {
  // The BOM is what makes Excel read UTF-8 accented speaker names correctly.
  const blob = new Blob(['﻿', toCsv(buildSheet(input))], {
    type: 'text/csv;charset=utf-8',
  })
  downloadBlob(blob, `${filename}.csv`)
}

// ── Review export (ABS-13) ───────────────────────────────────────────────

export type ReviewExportRow = {
  title: string
  status: string
  assigned: number
  submitted: number
  avgScore: number | null
  acceptCount: number
  neutralCount: number
  declineCount: number
}

/** Two decimals only when the average is fractional — a clean 4 stays "4". */
export function scoreText(score: number | null): string {
  if (score === null) return ''
  return Number.isInteger(score) ? String(score) : score.toFixed(2)
}

const REVIEW_HEADER = [
  'Title',
  'Status',
  'Assigned',
  'Submitted',
  'Avg score',
  'Accept',
  'Neutral',
  'Decline',
]

/** One row per proposal: assignment progress plus the recommendation split. */
export function exportReviewsCsv(
  rows: ReadonlyArray<ReviewExportRow>,
  filename: string,
) {
  const sheet = [
    REVIEW_HEADER,
    ...rows.map((row) => [
      row.title,
      row.status,
      String(row.assigned),
      String(row.submitted),
      scoreText(row.avgScore),
      String(row.acceptCount),
      String(row.neutralCount),
      String(row.declineCount),
    ]),
  ].map((line) => line.map(sheetSafe))
  const blob = new Blob(['﻿', toCsv(sheet)], {
    type: 'text/csv;charset=utf-8',
  })
  downloadBlob(blob, `${filename}.csv`)
}

/** Split out from `exportXlsx` so the workbook can be round-tripped in a test
 * without a DOM download. */
export async function xlsxBytes(
  rows: Array<Array<string>>,
): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx')
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  sheet['!cols'] = rows[0].map((_, index) => ({
    wch: Math.min(
      60,
      Math.max(12, ...rows.map((line) => (line[index] ?? '').length + 2)),
    ),
  }))
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Proposals')
  return XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
}

export async function exportXlsx(input: ExportInput, filename: string) {
  const data = await xlsxBytes(buildSheet(input))
  downloadBlob(
    new Blob([data], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    `${filename}.xlsx`,
  )
}

export function slug(value: string) {
  const out = value
    .normalize('NFKD')
    .replaceAll(/[^\w\s-]/g, '')
    .trim()
    .replaceAll(/[\s_]+/g, '-')
    .toLowerCase()
    .slice(0, 60)
  return out === '' ? 'untitled' : out
}

const EXTENSION: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'text/plain': '.txt',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
}

export type FileAnswer = {
  proposalId: string
  proposalTitle: string
  fieldLabel: string
  storageId: string
  url: string | null
}

/**
 * One zip, one folder per proposal. Files are fetched in small batches so a
 * 500-proposal event does not open 500 sockets at once, and a single failed
 * download is reported rather than aborting the bundle.
 */
export async function downloadFileBundle(
  files: ReadonlyArray<FileAnswer>,
  filename: string,
): Promise<{ added: number; failed: number }> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  let added = 0
  let failed = 0
  const batchSize = 6

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize)
    await Promise.all(
      batch.map(async (file) => {
        if (file.url === null) {
          failed += 1
          return
        }
        try {
          const response = await fetch(file.url)
          if (!response.ok) throw new Error(String(response.status))
          const blob = await response.blob()
          const folder = `${slug(file.proposalTitle)}-${file.proposalId.slice(-6)}`
          const ext = EXTENSION[blob.type] ?? ''
          zip.file(
            `${folder}/${slug(file.fieldLabel)}-${file.storageId.slice(-8)}${ext}`,
            blob,
          )
          added += 1
        } catch {
          failed += 1
        }
      }),
    )
  }

  if (added > 0) {
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${filename}.zip`)
  }
  return { added, failed }
}
