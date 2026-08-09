import type { FunctionReturnType } from 'convex/server'
import type { api } from '@convex/_generated/api'

// Speaker ops (M4) read model. Every type here is derived from the deployed
// Convex surface, so a backend shape change shows up as a type error rather
// than as a silently wrong column.

export type RequirementRow = FunctionReturnType<
  typeof api.tasks.listRequirements
>[number]
export type InstanceRow = FunctionReturnType<
  typeof api.tasks.listInstances
>[number]
export type UploadRow = FunctionReturnType<typeof api.tasks.listUploads>[number]
export type DashboardData = FunctionReturnType<typeof api.tasks.dashboard>
export type SpeakerRow = DashboardData['speakers'][number]
export type SessionReadinessRow = DashboardData['sessions'][number]
export type PortalTask = FunctionReturnType<typeof api.portal.myTasks>[number]

export type TaskStatus = InstanceRow['status']
export type Scope = InstanceRow['scope']
export type Evidence = InstanceRow['evidence']
export type ReadinessStatus = SessionReadinessRow['readiness']['status']

/**
 * The organizer's vocabulary, written exactly as the design system fixes it.
 * `provided` only ever occurs on a review-gated requirement, which is why it
 * reads "Awaiting Review" rather than "Provided" — that is what the organizer
 * has to do about it.
 */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Outstanding',
  provided: 'Awaiting Review',
  changesRequested: 'Changes Requested',
  approved: 'Approved',
  complete: 'Complete',
  notApplicable: 'Not Applicable',
}

type PillTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'attention'
  | 'blocked'
  | 'brand'
  | 'agent'

/**
 * The speaker's vocabulary. These deliberately leave the organizer's state
 * names behind ("Awaiting Review" is not the speaker's problem), so the tone
 * has to be stated rather than looked up from the label.
 */
export const PORTAL_TASK_STATUS: Record<
  TaskStatus,
  { label: string; tone: PillTone }
> = {
  pending: { label: 'To do', tone: 'info' },
  provided: { label: 'Submitted — awaiting review', tone: 'info' },
  changesRequested: { label: 'Changes requested', tone: 'attention' },
  approved: { label: 'Done', tone: 'success' },
  complete: { label: 'Done', tone: 'success' },
  notApplicable: { label: 'Waived', tone: 'neutral' },
}

export const SCOPE_LABEL: Record<Scope, string> = {
  participant: 'Per speaker',
  session: 'Per session',
}

export const EVIDENCE_LABEL: Record<Evidence, string> = {
  manual: 'Manual',
  file: 'File upload',
  profileField: 'Profile field',
}

export const READINESS_LABEL: Record<ReadinessStatus, string> = {
  ready: 'Ready',
  needsAttention: 'Needs Attention',
  blocked: 'Blocked',
}

export const FIELD_KEYS = ['bio', 'headshot', 'tagline'] as const

/** Mirrors convex/model/tasks.ts — Not Applicable counts as satisfied. */
const SETTLED: ReadonlySet<TaskStatus> = new Set([
  'approved',
  'complete',
  'notApplicable',
])

export function isOpen(status: TaskStatus): boolean {
  return !SETTLED.has(status)
}

/** Overdue is derived against a client-held clock: a Convex query is not
 * re-run because time passed, so `now` always comes from the caller. */
export function isOverdue(
  task: { status: TaskStatus; dueAt: number },
  now: number,
): boolean {
  return isOpen(task.status) && task.dueAt < now
}

export function speakerLabel(instance: InstanceRow): string {
  if (instance.scope === 'session') return 'Session task'
  return instance.speakerName ?? 'Unassigned'
}

export function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}
