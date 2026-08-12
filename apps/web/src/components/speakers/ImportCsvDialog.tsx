import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type * as React from 'react'
import {
  ActionResult,
  Button,
  Callout,
  DataTable,
  Dialog,
  Field,
  Select,
  Textarea,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { errorMessage } from '~/lib/errors'

// Deterministic CSV import (SPK-03). The file is parsed in the browser with
// the same pinned SheetJS build the proposals export uses (dynamically
// imported, so it never enters the base bundle), the organizer maps columns
// to speaker fields, and clean rows go to speakers.importRows — which dedupes
// by email server-side and reports created / merged / skipped.

const MAX_ROWS = 300

const TARGETS = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'jobTitle', label: 'Job title' },
  { key: 'company', label: 'Company' },
  { key: 'tagline', label: 'Tagline' },
  { key: 'bio', label: 'Bio' },
] as const

type TargetKey = (typeof TARGETS)[number]['key']
type Mapping = Partial<Record<TargetKey, number>>

// Best-guess auto-mapping: header names normalized to bare letters, so
// "First Name", "first_name" and "firstname" all land on First name.
const GUESSES: Record<TargetKey, Array<string>> = {
  firstName: ['firstname', 'first', 'givenname', 'name'],
  lastName: ['lastname', 'last', 'surname', 'familyname'],
  email: ['email', 'emailaddress', 'mail'],
  jobTitle: ['jobtitle', 'title', 'role', 'position'],
  company: ['company', 'organization', 'organisation', 'org', 'employer'],
  tagline: ['tagline', 'headline'],
  bio: ['bio', 'about', 'biography', 'description'],
}

function normalize(header: string): string {
  return header.toLowerCase().replaceAll(/[^a-z]/g, '')
}

function guessMapping(headers: Array<string>): Mapping {
  const mapping: Mapping = {}
  const taken = new Set<number>()
  for (const target of TARGETS) {
    for (const candidate of GUESSES[target.key]) {
      const index = headers.findIndex(
        (h, i) => !taken.has(i) && normalize(h) === candidate,
      )
      if (index !== -1) {
        mapping[target.key] = index
        taken.add(index)
        break
      }
    }
  }
  return mapping
}

type Parsed = { headers: Array<string>; rows: Array<Array<string>> }
type ImportResult = FunctionReturnType<typeof api.speakers.importRows>

export function ImportCsvDialog({
  eventSlug,
  archived,
  onClose,
}: {
  eventSlug: string
  archived: boolean
  onClose: () => void
}) {
  const importRows = useMutation(api.speakers.importRows)
  const { pending, error, setError, run } = usePending()

  const [filename, setFilename] = useState<string | null>(null)
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [mapping, setMapping] = useState<Mapping>({})
  const [parsing, setParsing] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [pastedCsv, setPastedCsv] = useState('')

  const setGrid = (grid: Array<Array<unknown>>, source: string) => {
    if (grid.length < 2) {
      throw new Error(
        'That CSV has no data rows — the first row must be column headers.',
      )
    }
    const [head, ...body] = grid
    const headers = head.map((cell) => String(cell).trim())
    const rows = body.map((line) => line.map((cell) => String(cell).trim()))
    setFilename(source)
    setParsed({ headers, rows })
    setMapping(guessMapping(headers))
  }

  const parse = async (file: File) => {
    setParsing(true)
    setError(null)
    setResult(null)
    try {
      // Same pinned SheetJS build as the proposals export — its CSV parser
      // handles quoting, BOMs and embedded newlines correctly.
      const XLSX = await import('xlsx')
      const book = XLSX.read(await file.arrayBuffer(), { raw: true })
      const sheet = book.Sheets[book.SheetNames[0]]
      const grid = XLSX.utils.sheet_to_json<Array<unknown>>(sheet, {
        header: 1,
        blankrows: false,
        defval: '',
      })
      setGrid(grid, file.name)
    } catch (err) {
      setError(errorMessage(err, 'That file could not be read as a CSV.'))
      setFilename(null)
      setParsed(null)
    } finally {
      setParsing(false)
    }
  }

  const parsePaste = async () => {
    setParsing(true)
    setError(null)
    setResult(null)
    try {
      const XLSX = await import('xlsx')
      const book = XLSX.read(pastedCsv, { type: 'string', raw: true })
      const sheet = book.Sheets[book.SheetNames[0]]
      const grid = XLSX.utils.sheet_to_json<Array<unknown>>(sheet, {
        header: 1,
        blankrows: false,
        defval: '',
      })
      setGrid(grid, 'Pasted CSV')
    } catch (err) {
      setError(errorMessage(err, 'That text could not be read as CSV.'))
      setFilename(null)
      setParsed(null)
    } finally {
      setParsing(false)
    }
  }

  const cell = (line: Array<string>, key: TargetKey): string => {
    const index = mapping[key]
    return index === undefined ? '' : (line[index] ?? '')
  }

  const mappedRows = (parsed?.rows ?? []).map((line) => ({
    firstName: cell(line, 'firstName'),
    lastName: cell(line, 'lastName'),
    email: cell(line, 'email') === '' ? undefined : cell(line, 'email'),
    jobTitle:
      cell(line, 'jobTitle') === '' ? undefined : cell(line, 'jobTitle'),
    company: cell(line, 'company') === '' ? undefined : cell(line, 'company'),
    tagline: cell(line, 'tagline') === '' ? undefined : cell(line, 'tagline'),
    bio: cell(line, 'bio') === '' ? undefined : cell(line, 'bio'),
  }))

  const nameMapped =
    mapping.firstName !== undefined || mapping.lastName !== undefined
  const overflow = mappedRows.length > MAX_ROWS

  const send = () => {
    if (!nameMapped) {
      return setError('Map at least a first-name or last-name column.')
    }
    void run(async () => {
      const outcome = await importRows({
        eventSlug,
        rows: mappedRows,
      })
      setResult(outcome)
    })
  }

  const preview = mappedRows.slice(0, 3).map((row, index) => ({
    id: String(index),
    ...row,
  }))

  return (
    <Dialog
      open
      width={720}
      title="Import speakers from CSV"
      description="First row must be column headers. Rows are matched to existing speakers by email — a match fills blank fields and never overwrites."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {result === null ? 'Cancel' : 'Close'}
          </Button>
          <Button
            variant="primary"
            iconLeft="upload"
            onClick={send}
            disabled={
              archived ||
              pending ||
              parsing ||
              parsed === null ||
              overflow ||
              result !== null
            }
          >
            {pending
              ? 'Importing…'
              : `Import ${mappedRows.length} row${
                  mappedRows.length === 1 ? '' : 's'
                }`}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}

        <Field
          label="CSV file"
          hint={
            filename === null
              ? 'Only the mapped columns are imported.'
              : `${filename} — ${mappedRows.length} data row${mappedRows.length === 1 ? '' : 's'}.`
          }
        >
          <div>
            {parsing || pending ? (
              <Button size="sm" iconLeft="file-text" disabled>
                {parsing ? 'Reading…' : 'Choose a file'}
              </Button>
            ) : (
              <Button as="label" size="sm" iconLeft="file-text">
                <input
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (file !== undefined) void parse(file)
                  }}
                />
                {filename === null ? 'Choose a file' : 'Choose another file'}
              </Button>
            )}
          </div>
        </Field>

        <Field
          label="Or paste CSV"
          htmlFor="speaker-csv-paste"
          hint="Useful in browser automation and when a CSV file is not available. It uses the same mapping, preview and import rules."
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
            }}
          >
            <Textarea
              id="speaker-csv-paste"
              rows={5}
              value={pastedCsv}
              disabled={parsing || pending}
              placeholder={
                'firstName,lastName,email\nAda,Lovelace,ada@example.com'
              }
              onChange={(event) => {
                setPastedCsv(event.target.value)
              }}
            />
            <div>
              <Button
                size="sm"
                iconLeft="clipboard"
                disabled={parsing || pending || pastedCsv.trim() === ''}
                onClick={() => void parsePaste()}
              >
                Preview pasted CSV
              </Button>
            </div>
          </div>
        </Field>

        {overflow ? (
          <Callout
            tone="attention"
            title={`This import is over the ${MAX_ROWS}-row limit`}
          >
            Nothing will be truncated. Split these {mappedRows.length} rows into
            files of at most {MAX_ROWS} rows and import each file.
          </Callout>
        ) : null}

        {parsed !== null && result === null ? (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(12rem, 1fr))',
                gap: 'var(--space-3)',
              }}
            >
              {TARGETS.map((target) => (
                <Field
                  key={target.key}
                  label={target.label}
                  htmlFor={`map-${target.key}`}
                >
                  <Select
                    id={`map-${target.key}`}
                    value={
                      mapping[target.key] === undefined
                        ? ''
                        : String(mapping[target.key])
                    }
                    options={[
                      { value: '', label: '— not imported —' },
                      ...parsed.headers.map((header, index) => ({
                        value: String(index),
                        label: header === '' ? `Column ${index + 1}` : header,
                      })),
                    ]}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                      const value = e.target.value
                      setMapping((current) => {
                        const next = { ...current }
                        if (value === '') delete next[target.key]
                        else next[target.key] = Number(value)
                        return next
                      })
                    }}
                  />
                </Field>
              ))}
            </div>

            <Field
              label="Preview"
              hint="The first 3 rows, as they will import."
            >
              <DataTable
                aria-label="Import preview"
                rowKey="id"
                columns={TARGETS.map((target) => ({
                  key: target.key,
                  header: target.label,
                  cell: (row: (typeof preview)[number]) => {
                    const value = row[target.key]
                    return value === undefined || value === '' ? (
                      <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                    ) : (
                      <span
                        style={{
                          display: 'inline-block',
                          maxWidth: '14rem',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          verticalAlign: 'bottom',
                        }}
                      >
                        {value}
                      </span>
                    )
                  },
                }))}
                rows={preview}
              />
            </Field>
          </>
        ) : null}

        {result !== null ? (
          <ActionResult
            status={result.skipped.length === 0 ? 'success' : 'partial'}
            title={`Created ${result.created} · merged ${result.merged} · skipped ${result.skipped.length}`}
            details={[
              `${mappedRows.length} mapped row${mappedRows.length === 1 ? '' : 's'} submitted.`,
              'Merged rows matched an existing speaker by email and only filled blank fields.',
              ...result.skipped.map(
                (skip) => `Row ${skip.row} skipped: ${skip.reason}`,
              ),
            ]}
          />
        ) : null}
      </div>
    </Dialog>
  )
}
