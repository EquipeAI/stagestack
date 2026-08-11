import { visibleFields } from '@convex/shared/formDef'
import type { AnswerValue, FieldDef, FormDef } from '@convex/shared/formDef'
import type { Doc } from '@convex/_generated/dataModel'

// Everything the submitter-side CFP screens agree on: answer shapes, the
// window state (computed on the client, never trusted from the server), the
// vocabulary a submitter is allowed to see, and the required-field preview
// that both the wizard's Review step and the manage page render.

export type Answers = Record<string, AnswerValue>
export type ProposalStatus = Doc<'proposals'>['status']

/** Filenames for file answers uploaded in this browser session, by field id. */
export type UploadedNames = Record<string, string>

/**
 * What a submitter is told the state is. `acceptQueue`/`declineQueue` are
 * organizer-internal staging states — a decision that has not been released
 * must read as Under Review, never as the pending outcome.
 */
export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  draft: 'Draft',
  pending: 'Submitted',
  acceptQueue: 'Under Review',
  declineQueue: 'Under Review',
  accepted: 'Accepted',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_RE = /^https?:\/\/[^\s.]+\.\S+$/i

export function isEmailLike(value: string) {
  return EMAIL_RE.test(value.trim())
}

export function isUrlLike(value: string) {
  return URL_RE.test(value.trim())
}

export function isBlankAnswer(value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'string') return value.trim().length === 0
  return false
}

/** Answer coerced to the single string a text-ish control binds to. */
export function answerString(value: AnswerValue | undefined): string {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/** Answer coerced to the list a multiselect binds to. */
export function answerList(value: AnswerValue | undefined): Array<string> {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

export type WindowState = 'before' | 'open' | 'closed'

export type ProposalEditAccess = 'eligible' | 'expired-grant' | 'locked'

/** Status-side edit gate, separate from the CFP date window. Undecided
 * proposals use the ordinary event window; a released acceptance requires its
 * own explicit organizer grant even when the event-wide CFP is open again.
 * Remembering an expired accepted grant lets an already-mounted editor keep
 * unsent local changes visible instead of unmounting them at the deadline.
 */
export function proposalEditAccess(input: {
  status: ProposalStatus
  reopenedUntil?: number | null
  archivedAt?: number | null
  now: number
}): ProposalEditAccess {
  const { status, reopenedUntil, archivedAt, now } = input
  if (archivedAt !== undefined && archivedAt !== null) return 'locked'
  if (
    status === 'draft' ||
    status === 'pending' ||
    status === 'acceptQueue' ||
    status === 'declineQueue'
  ) {
    return 'eligible'
  }
  if (
    status !== 'accepted' ||
    reopenedUntil === undefined ||
    reopenedUntil === null
  ) {
    return 'locked'
  }
  return reopenedUntil > now ? 'eligible' : 'expired-grant'
}

/**
 * Computed on the client from the raw timestamps, never read from a
 * server-computed boolean: a subscription can hand back a `windowOpen` that
 * was true when the query ran and is false by the time it renders.
 */
export function cfpWindowState(input: {
  openAt?: number | null
  closeAt?: number | null
  reopenedUntil?: number | null
  now: number
}): WindowState {
  const { openAt, closeAt, reopenedUntil, now } = input
  // An organizer-granted reopen overrides both bounds for this one proposal.
  if (
    reopenedUntil !== undefined &&
    reopenedUntil !== null &&
    reopenedUntil > now
  ) {
    return 'open'
  }
  if (openAt !== undefined && openAt !== null && now < openAt) return 'before'
  if (closeAt !== undefined && closeAt !== null && now > closeAt)
    return 'closed'
  return 'open'
}

export type MissingAnswer = { field: FieldDef; reason: string }

/**
 * The client-side mirror of the server's submit check: only visible fields
 * count, so a hidden conditional field is never required.
 */
export function missingAnswers(
  form: FormDef,
  answers: Answers,
): Array<MissingAnswer> {
  const out: Array<MissingAnswer> = []
  for (const field of visibleFields(form, answers)) {
    const value = answers[field.id]
    if (field.required && isBlankAnswer(value)) {
      out.push({ field, reason: 'This question is required.' })
      continue
    }
    const text = typeof value === 'string' ? value.trim() : ''
    if (text.length === 0) continue
    if (field.kind === 'email' && !isEmailLike(text)) {
      out.push({ field, reason: 'Enter a valid email address.' })
    }
    if (field.kind === 'url' && !isUrlLike(text)) {
      out.push({ field, reason: 'Enter a full URL, starting with https://' })
    }
  }
  return out
}

/** Stable dom id so the Review step can jump straight to a field. */
export function fieldDomId(fieldId: string) {
  return `cfp-field-${fieldId}`
}

/** How an answer reads on a read-only summary. */
export function answerSummary(
  field: FieldDef,
  value: AnswerValue | undefined,
  filename?: string,
): string {
  if (isBlankAnswer(value)) return '—'
  if (field.kind === 'file') return filename ?? 'Uploaded file'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

export function speakerName(speaker: { firstName: string; lastName: string }) {
  return `${speaker.firstName} ${speaker.lastName}`.trim()
}
