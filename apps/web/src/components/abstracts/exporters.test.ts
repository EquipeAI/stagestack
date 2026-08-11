import { describe, expect, it } from 'vitest'
import {
  buildReviewSheet,
  buildSheet,
  reviewCompletion,
  sheetSafe,
  toCsv,
  xlsxBytes,
} from './exporters'
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

// A CFP answer is written by an anonymous submitter, and the export is opened
// in Excel/Sheets by an organizer — a cell starting with =, +, - or @ is code
// there, so it must arrive as text on BOTH export paths.
describe('formula injection', () => {
  const attack = () =>
    proposal({
      answers: {
        talkTitle: 'Signals at Scale',
        firstName: '=HYPERLINK("http://evil","click")',
        lastName: '@SUM(A1:A9)',
        email: '+1 555 0100',
        topics: ['-2+3'],
      },
    })

  it('prefixes formula-looking cells and leaves ordinary ones alone', () => {
    const sheet = buildSheet(input([{ proposal: attack(), speakerCount: 1 }]))
    expect(sheet[1].slice(3)).toEqual([
      'Signals at Scale',
      '\'=HYPERLINK("http://evil","click")',
      "'@SUM(A1:A9)",
      "'+1 555 0100",
      "'-2+3",
    ])
  })

  it('leaves plain numbers unquoted so they stay numbers', () => {
    expect(sheetSafe('-4')).toBe('-4')
    expect(sheetSafe('+1.5')).toBe('+1.5')
    expect(sheetSafe('1e3')).toBe('1e3')
    expect(sheetSafe('Ada Lovelace')).toBe('Ada Lovelace')
    expect(sheetSafe('=1+1')).toBe("'=1+1")
    // Excel skips leading whitespace before deciding a cell is a formula.
    expect(sheetSafe('\t=1+1')).toBe("'\t=1+1")
  })

  it('neutralizes the same cells in the CSV text', () => {
    const csv = toCsv(
      buildSheet(input([{ proposal: attack(), speakerCount: 1 }])),
    )
    expect(csv).not.toContain(',=HYPERLINK')
    expect(csv).toContain('"\'=HYPERLINK(""http://evil"",""click"")"')
  })

  it('neutralizes the same cells in the workbook', async () => {
    const rows = buildSheet(input([{ proposal: attack(), speakerCount: 1 }]))
    const bytes = await xlsxBytes(rows)
    const XLSX = await import('xlsx')
    const book = XLSX.read(new Uint8Array(bytes), { type: 'array' })
    const cells = XLSX.utils.sheet_to_json<Array<string>>(
      book.Sheets.Proposals,
      { header: 1, raw: false },
    )
    // No cell in the workbook may be a live formula, and the payload must be
    // present as inert text.
    for (const cell of Object.values(book.Sheets.Proposals)) {
      expect((cell as { f?: string }).f).toBeUndefined()
    }
    expect(cells[1]).toContain('\'=HYPERLINK("http://evil","click")')
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

describe('review results sheet', () => {
  it('excludes conflicts from the actionable completion denominator', () => {
    expect(
      reviewCompletion(1, [
        { status: 'submitted' },
        { status: 'assigned' },
        { status: 'conflict' },
      ]),
    ).toEqual({
      assigned: 2,
      conflicts: 1,
      label: '1 of 2 submitted · 1 conflict',
    })
  })

  it('includes proposal/review status, recommendation, aggregate and per-criterion scores', () => {
    const sheet = buildReviewSheet([
      {
        title: 'Signals at Scale',
        status: 'Submitted',
        assigned: 2,
        submitted: 1,
        avgScore: 4.25,
        reviewStatus: '1 of 2 submitted',
        recommendationSummary: 'Accept 1',
        acceptCount: 1,
        neutralCount: 0,
        declineCount: 0,
        criteria: {
          'round-1:originality': {
            label: 'Originality (Round one)',
            value: 5,
          },
          'round-1:clarity': {
            label: 'Clarity (Round one)',
            value: 4,
          },
        },
      },
    ])
    expect(sheet[0]).toEqual([
      'Title',
      'Proposal status',
      'Assigned',
      'Submitted',
      'Aggregate score',
      'Review status',
      'Recommendation summary',
      'Accept',
      'Neutral',
      'Decline',
      'Originality (Round one)',
      'Clarity (Round one)',
    ])
    expect(sheet[1]).toContain('Accept 1')
    expect(sheet[1]).toContain(4.25)
    expect(sheet[1]).toContain(5)
  })

  it('keeps duplicate criterion labels in distinct columns', () => {
    const base = {
      title: 'Signals at Scale',
      status: 'Submitted',
      assigned: 1,
      submitted: 1,
      avgScore: 4,
      reviewStatus: '1 of 1 submitted',
      recommendationSummary: 'Accept 1',
      acceptCount: 1,
      neutralCount: 0,
      declineCount: 0,
    }
    const sheet = buildReviewSheet([
      {
        ...base,
        criteria: {
          'round-a:quality': { label: 'Quality (Final)', value: 5 },
          'round-b:quality': { label: 'Quality (Final)', value: 3 },
        },
      },
    ])
    expect(sheet[0].slice(-2)).toEqual([
      'Quality (Final)',
      'Quality (Final) [2]',
    ])
    expect(sheet[1].slice(-2)).toEqual([5, 3])
  })

  it('writes review results to a named XLSX sheet', async () => {
    const rows = [
      ['Title', 'Review status'],
      ['Talk', 4.25],
    ]
    const bytes = await xlsxBytes(rows, 'Review results')
    const XLSX = await import('xlsx')
    const book = XLSX.read(new Uint8Array(bytes), { type: 'array' })
    expect(book.SheetNames).toEqual(['Review results'])
    expect(book.Sheets['Review results'].B2.t).toBe('n')
  })
})
