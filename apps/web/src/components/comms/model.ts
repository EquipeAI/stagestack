import type { FunctionReturnType } from 'convex/server'
import type { api } from '@convex/_generated/api'

// Communications (M5) read model. Every type here is derived from the deployed
// Convex surface, so a backend shape change shows up as a type error rather
// than as a silently wrong label.

export type TemplateRow = FunctionReturnType<typeof api.templates.list>[number]
export type AudienceRow = FunctionReturnType<
  typeof api.comms.listAudiences
>[number]
export type AudienceKind = AudienceRow['kind']
export type MessageRow = FunctionReturnType<typeof api.comms.contactLog>[number]
export type DeliveryStatus = MessageRow['deliveryStatus']

type PillTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'attention'
  | 'blocked'
  | 'brand'
  | 'agent'

// ── Audiences ─────────────────────────────────────────────────────────────

/** Presentation order. Mirrors AUDIENCE_KINDS in convex/model/audiences.ts. */
export const AUDIENCE_ORDER: Array<AudienceKind> = [
  'allSpeakers',
  'confirmedSpeakers',
  'unconfirmedSpeakers',
  'overdueTasks',
  'assignedReviewers',
]

/**
 * The description states the routing rule, because who actually receives the
 * mail is not obvious from the name: routine task chasing goes to the primary
 * manager while a speaker has not claimed their own portal access, and
 * personal-action mail always tries the speaker first.
 */
export const AUDIENCE_META: Record<
  AudienceKind,
  { label: string; description: string }
> = {
  allSpeakers: {
    label: 'All speakers',
    description:
      'Every speaker on a planned session who has not declined or withdrawn. Reaches the speaker, or their primary manager when we hold no address for them.',
  },
  confirmedSpeakers: {
    label: 'Confirmed speakers',
    description: 'Speakers who have confirmed they are presenting.',
  },
  unconfirmedSpeakers: {
    label: 'Speakers awaiting response',
    description:
      'Speakers who have neither confirmed nor declined. Confirming is their own decision, so this reaches them directly wherever possible.',
  },
  overdueTasks: {
    label: 'Speakers with overdue tasks',
    description:
      'Speakers owing at least one task past its due date. Routine chasing goes to the primary manager until the speaker claims their own portal access.',
  },
  assignedReviewers: {
    label: 'Assigned reviewers',
    description: 'Everyone assigned at least one proposal to review.',
  },
}

/**
 * What a one-off send does to the reminder automation — which is nothing.
 *
 * Checked against the code, not assumed: `convex/comms.ts sendOneOff` never
 * touches `lastRemindedAt`, so unlike `reminders.sendOutstandingNow` (which
 * deliberately stamps the tasks it included) a one-off message leaves every
 * cadence clock exactly where it was.
 */
export const ONE_OFF_CADENCE_COPY =
  'A one-off message is not a reminder: it does not reset anyone’s reminder cadence, so scheduled reminders continue unchanged.'

/**
 * Who an audience send leaves out, and why. Empty when nobody is excluded.
 *
 * The over-cap case is NOT an exclusion, it is a refusal: `sendOneOff`
 * (convex/model/comms.ts) throws `audience_too_large` on `resolved.truncated`
 * rather than mailing the first MAX_AUDIENCE — so the copy must not imply a
 * partial send. `overCapRefusal` states that separately.
 */
export function audienceExclusions(row: {
  skipped: number
  totalKnown: number
  truncated: boolean
  count: number
}): Array<string> {
  const reasons: Array<string> = []
  if (row.skipped > 0) {
    reasons.push(
      `${row.skipped} ${row.skipped === 1 ? 'speaker has' : 'speakers have'} no reachable address — neither their own nor a primary manager’s.`,
    )
  }
  return reasons
}

/** The refusal sentence for an over-cap audience, or null when it fits. */
export function overCapRefusal(
  row: { totalKnown: number; truncated: boolean },
  cap: number,
): string | null {
  return row.truncated
    ? `This send will be refused: the audience has ${row.totalKnown} reachable recipients and a single send reaches at most ${cap}. Narrow it down.`
    : null
}

/** A selected speaker StageStack holds no address for is silently skipped by
 * the backend (`sendOneOff`'s `contacts` branch increments `skipped`), so the
 * confirmation has to say it before the result does. */
export function missingAddressExclusion(count: number): string | null {
  return count === 0
    ? null
    : `${count} selected ${count === 1 ? 'speaker has' : 'speakers have'} no email address on this event and will be skipped.`
}

/** One contact with no address is a hard stop: `contactRecipient` throws
 * `invalid_email` rather than skipping. */
export const NO_ADDRESS_BLOCKED =
  'StageStack holds no email address for this speaker on this event. Add one on their profile first.'

// ── Delivery ──────────────────────────────────────────────────────────────

/**
 * Resend's delivery lifecycle. These are not StageStack workflow states, so
 * the tone is stated rather than looked up from StatusPill's map.
 *
 * The lifecycle is Queued → Provider accepted → Delivered / Failed, and the
 * labels say exactly where a row sits in it (W1). Two rules the review paid
 * for: a row the provider accepted is NEVER labelled "Queued" — it is "Sent —
 * delivery unconfirmed" until a delivery event arrives — and no label claims a
 * delivery StageStack has not been told about.
 */
export const DELIVERY_STAGES = ['queued', 'accepted', 'closed'] as const
export type DeliveryStage = (typeof DELIVERY_STAGES)[number]

/** Human name for each lifecycle step, in order. */
export const DELIVERY_STAGE_LABEL: Record<DeliveryStage, string> = {
  queued: 'Queued',
  accepted: 'Provider accepted',
  closed: 'Delivered',
}

export const DELIVERY_STATUS: Record<
  DeliveryStatus,
  {
    label: string
    tone: PillTone
    /** How far along the lifecycle this row has actually got. */
    stage: DeliveryStage
    /** True when the run ended badly — the last step is a failure, not a
     * clean delivery. */
    failed: boolean
    /** True when the recipient's server DID take the message. `complained`
     * counts: it was delivered and then reported as spam, so counting it as
     * "did not reach the recipient" would be its own small lie. */
    reached: boolean
    /** What the status means, in one sentence. */
    detail: string
  }
> = {
  queued: {
    label: 'Queued',
    tone: 'neutral',
    stage: 'queued',
    failed: false,
    reached: false,
    detail:
      'Recorded by StageStack and waiting to be handed to the mail provider.',
  },
  sent: {
    label: 'Sent — delivery unconfirmed',
    tone: 'info',
    stage: 'accepted',
    failed: false,
    reached: false,
    detail:
      'The mail provider accepted it. No delivery confirmation has arrived yet.',
  },
  delivered: {
    label: 'Delivered',
    tone: 'success',
    stage: 'closed',
    failed: false,
    reached: true,
    detail: 'The receiving mail server accepted it for the recipient.',
  },
  delivery_delayed: {
    label: 'Delayed — provider still retrying',
    tone: 'attention',
    stage: 'accepted',
    failed: false,
    reached: false,
    detail:
      'The receiving server deferred it. The provider keeps retrying; it has neither been delivered nor given up on.',
  },
  bounced: {
    label: 'Bounced — the address rejected it',
    tone: 'blocked',
    stage: 'closed',
    failed: true,
    reached: false,
    detail:
      'The receiving server refused it permanently. Check the address before re-sending.',
  },
  complained: {
    label: 'Delivered, then marked as spam',
    tone: 'blocked',
    stage: 'closed',
    failed: true,
    reached: true,
    detail:
      'The recipient received it and then reported it as spam. Do not re-send to this address without asking first.',
  },
  failed: {
    label: 'Failed — never sent',
    tone: 'blocked',
    stage: 'closed',
    failed: true,
    reached: false,
    detail:
      "The mail service refused this send, so it never left. Check the deployment's mail settings, then re-send it.",
  },
}

/**
 * Did this row definitively fail to reach the recipient?
 *
 * `complained` is the trap: it was DELIVERED and then reported as spam, so
 * counting it here would tell the organizer their mail never arrived. `queued`,
 * `sent` and `delivery_delayed` are unknown, not failures.
 */
export function didNotReach(status: DeliveryStatus): boolean {
  const delivery = DELIVERY_STATUS[status]
  return delivery.failed && !delivery.reached
}

// ── Templates ─────────────────────────────────────────────────────────────

/** convex/model/comms.ts — the kind stamped on a manual send. */
export const ONE_OFF_KIND = 'manual.oneoff'

/**
 * The variable catalog moved to convex/shared/templateVars.ts (W3). It used to
 * be mirrored here — and drifted: this file offered `speaker.firstName` in
 * every template while a decision send passes no speaker at all. Import
 * `varsForContext` / `isKnownVar` / `variablesIn` from the shared module; the
 * substitution itself is the server's and is never re-implemented here.
 */

/** `custom:<slug>` — mirrors CUSTOM_KEY_RE in convex/model/templates.ts. */
export function customKeyFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug === '' ? '' : `custom:${slug}`
}

export function isCustomKey(key: string): boolean {
  return key.startsWith('custom:')
}

/** Built-in template names, so the comms log can label a message by its kind
 * without loading the template list. */
export function messageKindLabel(kind: string): string {
  if (kind === ONE_OFF_KIND) return 'One-off message'
  return KIND_LABEL[kind] ?? kind
}

const KIND_LABEL: Record<string, string> = {
  'cfp.confirmation': 'CFP — submission confirmation',
  'cfp.adminNotification': 'CFP — organizer notification',
  'cfp.withdrawn': 'CFP — withdrawal notice',
  'decision.accepted': 'Decision — accepted',
  'decision.declined': 'Decision — declined',
  'decision.corrected': 'Decision — correction',
  'invitation.direct': 'Direct speaking invitation',
  'team.invite': 'Team invitation',
  'portal.invite': 'Speaker portal invitation',
  'portal.handoffInvite': 'Primary-manager handoff invitation',
  'task.changesRequested': 'Task — changes requested',
  'schedule.released': 'Schedule — slot released',
  'schedule.updated': 'Schedule — slot changed',
  'schedule.cancelled': 'Schedule — slot cancelled',
  'reminder.tasks': 'Reminder — outstanding tasks',
  'reminder.participation': 'Reminder — awaiting participation',
}
