import type { FunctionReturnType } from 'convex/server'
import type { api } from '@convex/_generated/api'

// The round launch flow's model (W11): the steps, the criterion drafts the
// scorecard editor holds, and the client-side pre-validation.
//
// The pre-validation deliberately MIRRORS convex/model/reviews.ts
// (`assertRoundInput`, `assertScorecard`) rather than replacing it: the
// backend stays the enforcer, and this only exists so Next fails on the step
// that owns the problem instead of at the end of a seven-step flow.

export type Round = FunctionReturnType<typeof api.reviews.listRounds>[number]
export type ScorecardField = Round['scorecard'][number]

// ── Steps ─────────────────────────────────────────────────────────────────

export const LAUNCH_STEPS = [
  {
    id: 'basics',
    label: 'Basics',
    question: 'What is this round, and when is it open?',
  },
  {
    id: 'scorecard',
    label: 'Scorecard',
    question: 'What are reviewers asked?',
  },
  {
    id: 'reviewers',
    label: 'Reviewers',
    question: 'Who reviews in this round?',
  },
  {
    id: 'proposals',
    label: 'Proposals',
    question: 'Which proposals enter this round?',
  },
  {
    id: 'policy',
    label: 'Assignment',
    question: 'How is the work spread?',
  },
  {
    id: 'preview',
    label: 'Preview',
    question: 'What will a reviewer see?',
  },
  {
    id: 'summary',
    label: 'Launch',
    question: 'What happens when you launch?',
  },
] as const

export type LaunchStep = (typeof LAUNCH_STEPS)[number]
export type LaunchStepId = LaunchStep['id']

/** The step whose Next persists the round — everything after it needs a
 * round row to hang a pool, a preview and a plan on. */
export const PERSIST_AFTER: LaunchStepId = 'scorecard'

// ── Criterion drafts ──────────────────────────────────────────────────────
// The editor holds every numeric field as a string, so a half-typed value
// never fights the input; conversion (and complaint) happens on Next.

export type CriterionDraft = {
  id: string
  label: string
  kind: 'numeric' | 'dropdown' | 'text'
  required: boolean
  min: string
  max: string
  weight: string
  options: string
}

export function criterionId(label: string) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const suffix = Math.random().toString(36).slice(2, 7)
  return slug === '' ? suffix : `${slug}-${suffix}`
}

export function draftFromField(field: ScorecardField): CriterionDraft {
  return {
    id: field.id,
    label: field.label,
    kind: field.kind,
    required: field.required === true,
    min: field.min === undefined ? '1' : String(field.min),
    max: field.max === undefined ? '5' : String(field.max),
    weight: field.weight === undefined ? '1' : String(field.weight),
    options: (field.options ?? []).join(', '),
  }
}

export function blankDraft(): CriterionDraft {
  return {
    id: '',
    label: '',
    kind: 'numeric',
    required: false,
    min: '1',
    max: '5',
    weight: '1',
    options: '',
  }
}

/** The scorecard a brand-new round starts from. */
export function defaultDrafts(): Array<CriterionDraft> {
  return [
    { ...blankDraft(), id: 'score', label: 'Score', required: true },
    {
      ...blankDraft(),
      id: 'recommendation',
      label: 'Recommendation',
      kind: 'dropdown',
      required: true,
      options: 'Accept, Maybe, Reject',
    },
    { ...blankDraft(), id: 'comments', label: 'Comments', kind: 'text' },
  ]
}

/** Draft → stored field, or the complaint that stops the step. */
export function fieldFromDraft(
  draft: CriterionDraft,
): { field: ScorecardField } | { problem: string } {
  const label = draft.label.trim()
  if (label === '') return { problem: 'Every criterion needs a label.' }
  const field: ScorecardField = {
    id: draft.id === '' ? criterionId(label) : draft.id,
    label,
    kind: draft.kind,
    required: draft.required ? true : undefined,
  }
  if (draft.kind === 'numeric') {
    const min = Number(draft.min.trim())
    const max = Number(draft.max.trim())
    const weight = Number(draft.weight.trim())
    if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min) {
      return {
        problem: `"${label}" needs whole-number bounds with max above min.`,
      }
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      return { problem: `"${label}" needs a weight above zero.` }
    }
    field.min = min
    field.max = max
    field.weight = weight
  }
  if (draft.kind === 'dropdown') {
    const options = draft.options
      .split(',')
      .map((option) => option.trim())
      .filter((option) => option !== '')
    if (options.length < 2) {
      return { problem: `"${label}" needs at least two dropdown options.` }
    }
    field.options = options
  }
  return { field }
}

export function scorecardFromDrafts(
  criteria: ReadonlyArray<CriterionDraft>,
): { scorecard: Array<ScorecardField> } | { problem: string } {
  if (criteria.length === 0) {
    return { problem: 'The scorecard needs at least one criterion.' }
  }
  const scorecard: Array<ScorecardField> = []
  const seen = new Set<string>()
  for (const draft of criteria) {
    const converted = fieldFromDraft(draft)
    if ('problem' in converted) return converted
    if (seen.has(converted.field.id)) {
      return { problem: 'Criterion ids must be unique.' }
    }
    seen.add(converted.field.id)
    scorecard.push(converted.field)
  }
  return { scorecard }
}

/** One compact line per criterion, e.g. "Score · 1–5 · ×2 · required". */
export function criterionSummary(field: ScorecardField) {
  const parts: Array<string> = []
  if (field.kind === 'numeric') {
    parts.push(`${field.min ?? 1}–${field.max ?? 5}`)
    const weight = field.weight ?? 1
    if (weight !== 1) parts.push(`×${weight}`)
  }
  if (field.kind === 'dropdown') parts.push((field.options ?? []).join(' / '))
  if (field.kind === 'text') parts.push('text')
  if (field.required === true) parts.push('required')
  return parts.join(' · ')
}

// ── Per-step validation ───────────────────────────────────────────────────

export type RoundDraft = {
  name: string
  opensAt: string
  closesAt: string
  anonymized: boolean
  reviewerCap: string
  criteria: Array<CriterionDraft>
}

export type StepFacts = {
  /** Parsed from the draft's datetime inputs by the caller (it owns the
   * event timezone). `null` = empty, `'unreadable'` = typed but unparseable. */
  opens: number | null | 'unreadable'
  closes: number | null | 'unreadable'
  poolSize: number
  selectedCount: number
  perProposal: string
}

export function emptyDraft(): RoundDraft {
  return {
    name: '',
    opensAt: '',
    closesAt: '',
    anonymized: false,
    reviewerCap: '',
    criteria: defaultDrafts(),
  }
}

/** What stops Next on this step, or null when it may proceed. */
export function stepProblem(
  step: LaunchStepId,
  draft: RoundDraft,
  facts: StepFacts,
): string | null {
  if (step === 'basics') {
    const name = draft.name.trim()
    if (name === '') return 'The round needs a name.'
    if (name.length > 120) return 'Keep the name under 120 characters.'
    if (facts.opens === 'unreadable') return 'The open date is unreadable.'
    if (facts.closes === 'unreadable') return 'The close date is unreadable.'
    if (
      typeof facts.opens === 'number' &&
      typeof facts.closes === 'number' &&
      facts.closes <= facts.opens
    ) {
      return 'The round must close after it opens.'
    }
    const cap = draft.reviewerCap.trim()
    if (cap !== '') {
      const value = Number(cap)
      if (!Number.isInteger(value) || value < 1) {
        return 'The per-reviewer cap must be a whole number, at least 1.'
      }
    }
    return null
  }
  if (step === 'scorecard') {
    const converted = scorecardFromDrafts(draft.criteria)
    return 'problem' in converted ? converted.problem : null
  }
  if (step === 'reviewers') {
    return facts.poolSize === 0
      ? 'Add at least one reviewer to this round.'
      : null
  }
  if (step === 'proposals') {
    return facts.selectedCount === 0
      ? 'Select at least one proposal for this round.'
      : null
  }
  if (step === 'policy') {
    const value = Number(facts.perProposal.trim())
    if (!Number.isInteger(value) || value < 1) {
      return 'Reviews per proposal must be a whole number, at least 1.'
    }
    return null
  }
  return null
}

/** "Step 3 of 7 · Reviewers" — progress said in words, not a bare bar. */
export function stepProgressLabel(index: number): string {
  return `Step ${index + 1} of ${LAUNCH_STEPS.length} · ${LAUNCH_STEPS[index].label}`
}
