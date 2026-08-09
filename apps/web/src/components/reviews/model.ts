import type { FunctionReturnType } from 'convex/server'
import type { api } from '@convex/_generated/api'

// What the reviewer screen agrees on: the shape of one assignment, the
// vocabulary for a review's state, and how an answer reads when the form
// definition is not available (it is organizer-only — see the route's notes).

export type Assignment = FunctionReturnType<
  typeof api.reviews.myAssignments
>[number]

export type ReviewStatus = Assignment['status']
export type Recommendation = NonNullable<Assignment['recommendation']>
export type ReviewerSpeaker = Assignment['proposal']['speakers'][number]
export type Answers = Assignment['proposal']['answers']

/** Review state, written exactly as the product says it. */
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  assigned: 'Awaiting Review',
  draft: 'Draft',
  submitted: 'Submitted',
  locked: 'Locked',
}

export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  accept: 'Accept',
  neutral: 'Neutral',
  decline: 'Decline',
}

export const RECOMMENDATIONS: ReadonlyArray<Recommendation> = [
  'accept',
  'neutral',
  'decline',
]

export const SCORES: ReadonlyArray<number> = [1, 2, 3, 4, 5]

/** A review still waiting on this reviewer. Drives "unfinished first". */
export function isUnfinished(assignment: Assignment): boolean {
  return assignment.status === 'assigned' || assignment.status === 'draft'
}

/** A locked review is evidence: it is shown, never edited. */
export function isEditable(assignment: Assignment): boolean {
  return assignment.status !== 'locked'
}

/**
 * Contact answers are stripped from the speaker projection, so they are
 * stripped here too — a reviewer sees professional identity only.
 */
const HIDDEN_FIELD_IDS: ReadonlySet<string> = new Set([
  'firstName',
  'lastName',
  'email',
])

const SYSTEM_FIELD_LABEL: Record<string, string | undefined> = {
  talkTitle: 'Talk title',
  abstract: 'Abstract',
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
}

/**
 * Field ids are the only thing a reviewer's payload carries — the form
 * definition is organizer-only (`cfp.getForm`), so the question's real label
 * is not available here. System fields get their product wording; everything
 * else is the id with its collision suffix dropped, read back in sentence case
 * ("session-format-s1" → "Session format").
 */
export function fieldLabel(fieldId: string): string {
  const system = SYSTEM_FIELD_LABEL[fieldId]
  if (system !== undefined) return system
  const stem = fieldId.replace(/-[a-z0-9]{2,4}$/i, '')
  const words = (stem === '' ? fieldId : stem)
    .split(/[-_]+/)
    .filter((word) => word !== '')
  if (words.length === 0) return fieldId
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** How an answer reads on the read-only proposal. */
export function answerText(value: Answers[string] | undefined): string {
  if (value === undefined || value === null) return '—'
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join(', ')
  const text = String(value)
  return text.trim() === '' ? '—' : text
}

export type ReadableAnswer = {
  fieldId: string
  label: string
  text: string
  /** Download link for file answers. */
  href?: string
}

/**
 * The answers a reviewer reads, in the order they help: the abstract first,
 * then the rest in the published form's order. The backend now strips contact
 * fields and ships a `fields` projection with real labels/kinds plus signed
 * URLs for file answers; the id-prettifying fallback stays for older rows.
 */
export function readableAnswers(
  proposal: Assignment['proposal'],
  proposalTitle: string,
): Array<ReadableAnswer> {
  const { answers, fields, fileUrls } = proposal
  const byId = new Map(fields.map((f) => [f.id, f]))
  const orderedIds =
    fields.length > 0
      ? fields.map((f) => f.id).filter((id) => id in answers)
      : Object.keys(answers)
  const rows: Array<ReadableAnswer> = []
  for (const fieldId of orderedIds) {
    if (HIDDEN_FIELD_IDS.has(fieldId)) continue
    const field = byId.get(fieldId)
    const raw = answers[fieldId]
    let text = answerText(raw)
    let href: string | undefined
    if (field?.kind === 'file' && typeof raw === 'string' && raw !== '') {
      const url = fileUrls[raw]
      href = url ?? undefined
      text = href === undefined ? 'Uploaded file (expired)' : 'Uploaded file'
    }
    if (fieldId === 'talkTitle' && text === proposalTitle) continue
    if (text === '—') continue
    rows.push({ fieldId, label: field?.label ?? fieldLabel(fieldId), text, href })
  }
  return rows.sort((a, b) => {
    const rank = (id: string) => (id === 'abstract' ? 0 : 1)
    return rank(a.fieldId) - rank(b.fieldId)
  })
}

export function speakerName(speaker: ReviewerSpeaker): string {
  return `${speaker.firstName} ${speaker.lastName}`.trim()
}

/** "3 of 12 reviewed" — counts are concrete and mono everywhere. */
export function submittedCount(assignments: ReadonlyArray<Assignment>): number {
  return assignments.filter((row) => !isUnfinished(row)).length
}
