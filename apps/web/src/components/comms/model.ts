import type { FunctionReturnType } from 'convex/server'
import type { api } from '@convex/_generated/api'
import { siteOrigin } from '~/lib/origin'

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

// ── Delivery ──────────────────────────────────────────────────────────────

/** Resend's delivery lifecycle. These are not StageStack workflow states, so
 * the tone is stated rather than looked up from StatusPill's map. */
export const DELIVERY_STATUS: Record<
  DeliveryStatus,
  { label: string; tone: PillTone }
> = {
  queued: { label: 'Queued', tone: 'info' },
  sent: { label: 'Sent', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  delivery_delayed: { label: 'Delayed', tone: 'attention' },
  bounced: { label: 'Bounced', tone: 'blocked' },
  complained: { label: 'Complained', tone: 'blocked' },
  failed: { label: 'Failed', tone: 'blocked' },
}

// ── Templates ─────────────────────────────────────────────────────────────

/** convex/model/comms.ts — the kind stamped on a manual send. */
export const ONE_OFF_KIND = 'manual.oneoff'

/**
 * What each built-in template's own copy references, mirrored from
 * DEFAULT_TEMPLATES in convex/model/templates.ts. The organizer may use any
 * variable from `SAMPLE_VAR_PATHS` in any template — this list is the "what
 * the shipped wording already uses" hint, not a restriction.
 */
export const TEMPLATE_VARS: Record<string, Array<string>> = {
  'cfp.confirmation': [
    'subjectLead',
    'intro',
    'event.name',
    'proposal.title',
    'link',
  ],
  'cfp.adminNotification': [
    'subjectLead',
    'intro',
    'event.name',
    'proposal.title',
    'proposal.speakers',
    'link',
  ],
  'cfp.withdrawn': ['event.name', 'proposal.title', 'link'],
  'decision.accepted': ['event.name', 'proposal.title', 'link'],
  'decision.declined': ['event.name', 'proposal.title', 'link'],
  'decision.corrected': [
    'event.name',
    'proposal.title',
    'decision',
    'note',
    'link',
  ],
  'invitation.direct': [
    'speaker.firstName',
    'event.name',
    'session.title',
    'event.whenWhere',
    'link',
  ],
  'team.invite': ['inviter.name', 'scope.label', 'role.label', 'link'],
  'portal.invite': ['speaker.firstName', 'event.name', 'link'],
  'portal.handoffInvite': ['session.title', 'event.name', 'link'],
  'task.changesRequested': ['task.title', 'event.name', 'note', 'link'],
  'schedule.released': [
    'speaker.firstName',
    'event.name',
    'session.title',
    'slot.when',
    'slot.room',
    'link',
  ],
  'schedule.updated': [
    'speaker.firstName',
    'event.name',
    'session.title',
    'slot.when',
    'slot.room',
    'link',
  ],
  'schedule.cancelled': [
    'speaker.firstName',
    'event.name',
    'session.title',
    'slot.when',
    'link',
  ],
  'reminder.tasks': ['speaker.firstName', 'event.name', 'tasks', 'link'],
  'reminder.participation': ['speaker.firstName', 'event.name', 'body', 'link'],
}

/** Available in every template and in a one-off send. */
export const UNIVERSAL_VARS = [
  'event.name',
  'speaker.firstName',
  'speaker.lastName',
  'speaker.fullName',
  'speaker.email',
  'link',
]

/** What a one-off send substitutes, per recipient (convex/model/comms.ts). */
export const ONE_OFF_VARS = UNIVERSAL_VARS

/**
 * `RAW_KEYS` in convex/model/templates.ts: server-built HTML blocks that are
 * interpolated unescaped. Everything else is escaped, so a speaker named
 * `<script>` can never execute.
 */
export const RAW_VARS: ReadonlySet<string> = new Set(['tasks', 'body'])

/** Every path `sampleVars` supplies. A name outside this set is not an error —
 * it renders as the empty string — but it is almost always a typo. */
export const SAMPLE_VAR_PATHS: ReadonlyArray<string> = [
  'event.name',
  'event.when',
  'event.location',
  'event.whenWhere',
  'speaker.firstName',
  'speaker.lastName',
  'speaker.fullName',
  'speaker.email',
  'session.title',
  'slot.when',
  'slot.room',
  'proposal.title',
  'proposal.speakers',
  'task.title',
  'inviter.name',
  'scope.label',
  'role.label',
  'decision',
  'note',
  'intro',
  'subjectLead',
  'link',
  'tasks',
  'body',
]

const KNOWN_VARS: ReadonlySet<string> = new Set(SAMPLE_VAR_PATHS)

export function isKnownVar(path: string): boolean {
  return KNOWN_VARS.has(path)
}

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

// ── Draft rendering ───────────────────────────────────────────────────────
//
// `templates.preview` renders the SAVED template, so an unsaved draft has
// nothing on the server to preview. These mirror `substituteHtml` /
// `substituteSubject` in convex/model/templates.ts so the editor can show the
// draft as it types. The server's rendering stays authoritative — the editor
// shows it the moment the draft is saved, branded shell and all.

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}

/** Every distinct variable a draft references, in first-appearance order. */
export function variablesIn(text: string): Array<string> {
  const found: Array<string> = []
  for (const match of text.matchAll(VAR_RE)) {
    const path = match[1]
    if (!found.includes(path)) found.push(path)
  }
  return found
}

/** Believable stand-in values — the same shape as `sampleVars` on the server,
 * flattened to the dotted paths the substitution actually looks up.
 *
 * The `link` sample is origin-derived: it is the one URL a self-hoster sees in
 * the template preview, and a hardcoded stagestack.dev there reads as "this
 * install emails links to someone else's site". */
export function sampleVars(
  eventName: string,
  origin: string = siteOrigin(),
): Record<string, string> {
  return {
    'event.name': eventName,
    'event.when': '2026-09-01 – 2026-09-03 (America/Los_Angeles)',
    'event.location': 'Moscone West',
    'event.whenWhere':
      '2026-09-01 – 2026-09-03 (America/Los_Angeles) — Moscone West',
    'speaker.firstName': 'Ada',
    'speaker.lastName': 'Lovelace',
    'speaker.fullName': 'Ada Lovelace',
    'speaker.email': 'ada@example.com',
    'session.title': 'Analytical engines in production',
    'slot.when':
      'Tue, Sep 1, 2:00 PM – Tue, Sep 1, 2:45 PM (America/Los_Angeles)',
    'slot.room': 'Main Stage',
    'proposal.title': 'Analytical engines in production',
    'proposal.speakers': 'Ada Lovelace',
    'task.title': 'Speaker headshot',
    'inviter.name': 'Grace Hopper',
    'scope.label': eventName,
    'role.label': 'organizer',
    decision: 'accepted',
    note: 'Sample note from the organizer.',
    intro: 'Thanks for submitting to',
    subjectLead: 'We received your proposal',
    link: `${origin}/portal/sample-event`,
    tasks:
      '<ul>\n<li><strong>Speaker headshot</strong> — Analytical engines in production (due 2026-08-20)</li>\n<li><strong>Final slides</strong> — Analytical engines in production (due 2026-08-25)</li>\n</ul>',
    body: '<ul>\n<li><strong>Analytical engines in production</strong></li>\n</ul>',
  }
}

/** Body substitution: escaped unless the path is one of the RAW blocks. */
export function renderDraftHtml(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(VAR_RE, (_match, path: string) => {
    const value = vars[path]
    if (value === undefined) return ''
    return RAW_VARS.has(path) ? value : escapeHtml(value)
  })
}

/** Subject substitution: plain text, newlines collapsed (header-safe). */
export function renderDraftSubject(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template
    .replace(VAR_RE, (_match, path: string) => vars[path] ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}
