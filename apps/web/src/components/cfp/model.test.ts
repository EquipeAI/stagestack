import { describe, expect, it } from 'vitest'
import { conditionMet, visibleFields } from '@convex/shared/formDef'
import {
  cfpWindowState,
  fieldDomId,
  isBlankAnswer,
  missingAnswers,
  proposalEditAccess,
} from './model'
import type { FieldDef, FormDef } from '@convex/shared/formDef'
import type { Answers } from './model'

// The wizard's client-side submit gate: visibleIf evaluation decides which
// fields exist at all, missingAnswers decides what blocks Submit, and
// fieldDomId is the anchor the Review step's "jump to blocker" scrolls to
// (routes/cfp.$eventSlug.submit.tsx pairs getElementById(fieldDomId(id)) with
// the id CfpForm renders — both sides must call the same function).

function field(
  id: string,
  kind: FieldDef['kind'],
  over: Partial<FieldDef> = {},
): FieldDef {
  return { id, kind, label: id, required: false, ...over }
}

// One form exercising every conditional shape: a field-level `equals`, a
// section-level `includes` on a multiselect, and format validation fields.
const form: FormDef = {
  sections: [
    {
      id: 'basics',
      title: 'Basics',
      fields: [
        field('talkTitle', 'text', { required: true }),
        field('email', 'email', { required: true }),
        field('website', 'url'),
        field('format', 'radio', {
          required: true,
          options: ['Talk', 'Workshop'],
        }),
        field('workshopLength', 'text', {
          required: true,
          visibleIf: { fieldId: 'format', op: 'equals', value: 'Workshop' },
        }),
        field('topics', 'multiselect', { options: ['AI', 'Web', 'Infra'] }),
      ],
    },
    {
      id: 'ai-details',
      title: 'AI details',
      visibleIf: { fieldId: 'topics', op: 'includes', value: 'AI' },
      fields: [field('model', 'text', { required: true })],
    },
  ],
}

const complete: Answers = {
  talkTitle: 'Signals at Scale',
  email: 'ada@example.com',
  format: 'Talk',
}

describe('conditionMet', () => {
  it('equals matches the exact string answer only', () => {
    const cond = { fieldId: 'format', op: 'equals', value: 'Workshop' } as const
    expect(conditionMet(cond, { format: 'Workshop' })).toBe(true)
    expect(conditionMet(cond, { format: 'Talk' })).toBe(false)
    expect(conditionMet(cond, {})).toBe(false)
  })

  it('notEquals is met while the controlling field is still unanswered', () => {
    const cond = {
      fieldId: 'format',
      op: 'notEquals',
      value: 'Workshop',
    } as const
    expect(conditionMet(cond, {})).toBe(true)
    expect(conditionMet(cond, { format: 'Workshop' })).toBe(false)
  })

  it('includes requires an array answer — a string never matches', () => {
    const cond = { fieldId: 'topics', op: 'includes', value: 'AI' } as const
    expect(conditionMet(cond, { topics: ['AI', 'Web'] })).toBe(true)
    expect(conditionMet(cond, { topics: ['Web'] })).toBe(false)
    expect(conditionMet(cond, { topics: 'AI' })).toBe(false)
  })
})

describe('missingAnswers (submit blockers)', () => {
  it('passes a complete form whose conditional fields are hidden', () => {
    expect(missingAnswers(form, complete)).toEqual([])
  })

  it('never requires a hidden conditional field', () => {
    // workshopLength is required, but format=Talk keeps it invisible.
    const out = missingAnswers(form, complete)
    expect(out.map((m) => m.field.id)).not.toContain('workshopLength')
  })

  it('requires the conditional field once its condition is met', () => {
    const out = missingAnswers(form, { ...complete, format: 'Workshop' })
    expect(out.map((m) => m.field.id)).toEqual(['workshopLength'])
    expect(out[0].reason).toBe('This question is required.')
  })

  it('a section-level condition surfaces the whole section, and hides it again', () => {
    const withAi = missingAnswers(form, { ...complete, topics: ['AI'] })
    expect(withAi.map((m) => m.field.id)).toEqual(['model'])
    const withoutAi = missingAnswers(form, { ...complete, topics: ['Web'] })
    expect(withoutAi).toEqual([])
  })

  it('treats "", [], and null as blank for a required field', () => {
    for (const blank of ['', '   ', null, []] as const) {
      const out = missingAnswers(form, {
        ...complete,
        talkTitle: blank as never,
      })
      expect(out.map((m) => m.field.id)).toContain('talkTitle')
    }
    expect(isBlankAnswer(undefined)).toBe(true)
    expect(isBlankAnswer('x')).toBe(false)
  })

  it('flags malformed email and url answers, but only when non-blank', () => {
    const out = missingAnswers(form, {
      ...complete,
      email: 'not-an-email',
      website: 'javascript:alert(1)',
    })
    expect(out).toEqual([
      expect.objectContaining({ reason: 'Enter a valid email address.' }),
      expect.objectContaining({
        reason: 'Enter a full URL, starting with https://',
      }),
    ])
    // Optional url left blank is not a blocker.
    expect(missingAnswers(form, { ...complete, website: '' })).toEqual([])
  })

  it('lists blockers in form order so the Review step jumps top-down', () => {
    const out = missingAnswers(form, { format: 'Workshop', topics: ['AI'] })
    // format itself is answered ('Workshop') — it must not be listed.
    expect(out.map((m) => m.field.id)).toEqual([
      'talkTitle',
      'email',
      'workshopLength',
      'model',
    ])
  })

  it('only sees fields visibleFields sees — the two gates cannot disagree', () => {
    const answers = { ...complete, format: 'Workshop', topics: ['AI'] }
    const visible = new Set(visibleFields(form, answers).map((f) => f.id))
    for (const m of missingAnswers(form, answers)) {
      expect(visible.has(m.field.id)).toBe(true)
    }
  })
})

describe('fieldDomId (jump-to-blocker anchor)', () => {
  it('is stable and unique per field id', () => {
    expect(fieldDomId('abc')).toBe('cfp-field-abc')
    expect(fieldDomId('abc')).toBe(fieldDomId('abc'))
    expect(fieldDomId('a')).not.toBe(fieldDomId('b'))
  })
})

describe('cfpWindowState', () => {
  const openAt = 1_000
  const closeAt = 2_000

  it('walks before → open → closed across the window bounds', () => {
    expect(cfpWindowState({ openAt, closeAt, now: 999 })).toBe('before')
    expect(cfpWindowState({ openAt, closeAt, now: 1_000 })).toBe('open')
    expect(cfpWindowState({ openAt, closeAt, now: 2_000 })).toBe('open')
    expect(cfpWindowState({ openAt, closeAt, now: 2_001 })).toBe('closed')
  })

  it('is open when no bounds are configured', () => {
    expect(cfpWindowState({ now: 5 })).toBe('open')
    expect(cfpWindowState({ openAt: null, closeAt: null, now: 5 })).toBe('open')
  })

  it('an unexpired reopen overrides a closed window; an expired one does not', () => {
    expect(
      cfpWindowState({ openAt, closeAt, reopenedUntil: 3_000, now: 2_500 }),
    ).toBe('open')
    expect(
      cfpWindowState({ openAt, closeAt, reopenedUntil: 2_400, now: 2_500 }),
    ).toBe('closed')
    // A reopen also overrides "before".
    expect(
      cfpWindowState({ openAt, closeAt, reopenedUntil: 900, now: 500 }),
    ).toBe('open')
  })
})

describe('proposalEditAccess', () => {
  it('keeps undecided proposals eligible for the ordinary CFP window', () => {
    for (const status of [
      'draft',
      'pending',
      'acceptQueue',
      'declineQueue',
    ] as const) {
      expect(proposalEditAccess({ status, now: 2_000 })).toBe('eligible')
    }
  })

  it('requires a live proposal-specific grant for a released acceptance', () => {
    expect(proposalEditAccess({ status: 'accepted', now: 2_000 })).toBe(
      'locked',
    )
    expect(
      proposalEditAccess({
        status: 'accepted',
        reopenedUntil: 2_500,
        now: 2_000,
      }),
    ).toBe('eligible')
    expect(
      proposalEditAccess({
        status: 'accepted',
        reopenedUntil: 1_500,
        now: 2_000,
      }),
    ).toBe('expired-grant')
  })

  it('keeps declined and withdrawn proposals correction-only', () => {
    expect(proposalEditAccess({ status: 'declined', now: 2_000 })).toBe(
      'locked',
    )
    expect(proposalEditAccess({ status: 'withdrawn', now: 2_000 })).toBe(
      'locked',
    )
  })

  it('locks every proposal when its event is archived', () => {
    expect(
      proposalEditAccess({
        status: 'accepted',
        reopenedUntil: 3_000,
        archivedAt: 1_900,
        now: 2_000,
      }),
    ).toBe('locked')
    expect(
      proposalEditAccess({ status: 'draft', archivedAt: 1_900, now: 2_000 }),
    ).toBe('locked')
  })
})
