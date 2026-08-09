import { describe, expect, it } from 'vitest'
import { buildSheet, toCsv, xlsxBytes } from './exporters'
import type { FormDef } from '@convex/shared/formDef'
import type { Doc } from '@convex/_generated/dataModel'
import type { ExportInput } from './exporters'
import type { AbstractRow } from './model'

// The XLSX writer is the only place StageStack depends on SheetJS in the
// browser, and SheetJS ships off-registry (package.json pins the cdn.sheetjs.com
// tarball). A round-trip through the real library is what proves the pinned
// build still resolves and still writes a workbook Excel can open.

const form: FormDef = {
  sections: [
    {
      id: 'basics',
      title: 'Basics',
      fields: [
        { id: 'talkTitle', kind: 'text', label: 'Talk title', required: true },
        { id: 'firstName', kind: 'text', label: 'First name', required: true },
        { id: 'lastName', kind: 'text', label: 'Last name', required: true },
        { id: 'email', kind: 'email', label: 'Email', required: true },
        { id: 'topics', kind: 'multiselect', label: 'Topics', required: false },
      ],
    },
  ],
}

function proposal(over: Partial<Doc<'proposals'>> = {}): Doc<'proposals'> {
  return {
    _id: 'p1' as Doc<'proposals'>['_id'],
    _creationTime: 0,
    title: 'Signals at Scale',
    status: 'pending',
    updatedAt: Date.UTC(2026, 2, 4, 12, 0),
    submittedAt: Date.UTC(2026, 2, 3, 9, 30),
    answers: {
      talkTitle: 'Signals at Scale',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      topics: ['AI', 'Infra'],
    },
    ...over,
  } as Doc<'proposals'>
}

function input(rows: Array<AbstractRow>): ExportInput {
  return {
    rows,
    state: {
      q: '',
      statuses: [],
      sort: 'submittedAt',
      dir: 'desc',
      cols: ['title', 'submitter', 'status'],
    },
    ids: {
      talkTitle: 'talkTitle',
      abstract: 'abstract',
      firstName: 'firstName',
      lastName: 'lastName',
      email: 'email',
    },
    def: form,
    progress: undefined,
    timezone: 'UTC',
  }
}

describe('buildSheet', () => {
  it('puts the visible columns first, then every form answer', () => {
    const sheet = buildSheet(input([{ proposal: proposal(), speakerCount: 1 }]))
    expect(sheet[0]).toEqual([
      'Title',
      'Submitter',
      'Status',
      'Talk title',
      'First name',
      'Last name',
      'Email',
      'Topics',
    ])
    expect(sheet[1]).toEqual([
      'Signals at Scale',
      'Ada Lovelace · ada@example.com',
      'Submitted',
      'Signals at Scale',
      'Ada',
      'Lovelace',
      'ada@example.com',
      'AI, Infra',
    ])
  })

  it('keeps answers whose field was deleted from the form', () => {
    const orphan = proposal({
      answers: { talkTitle: 'Orphan', legacyNote: 'kept' },
    })
    const sheet = buildSheet(input([{ proposal: orphan, speakerCount: 0 }]))
    expect(sheet[0].at(-1)).toBe('legacyNote')
    expect(sheet[1].at(-1)).toBe('kept')
  })
})

describe('toCsv', () => {
  it('quotes cells containing commas, quotes or newlines', () => {
    expect(toCsv([['a,b', 'say "hi"', 'one\ntwo', 'plain']])).toBe(
      '"a,b","say ""hi""","one\ntwo",plain',
    )
  })
})

describe('xlsxBytes', () => {
  it('writes a workbook the reader parses back cell for cell', async () => {
    const rows = buildSheet(input([{ proposal: proposal(), speakerCount: 1 }]))
    const bytes = await xlsxBytes(rows)
    const XLSX = await import('xlsx')
    const book = XLSX.read(new Uint8Array(bytes), { type: 'array' })
    expect(book.SheetNames).toEqual(['Proposals'])
    const back = XLSX.utils.sheet_to_json(book.Sheets.Proposals, {
      header: 1,
      raw: false,
    })
    expect(back).toEqual(rows)
  })
})
