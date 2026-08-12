import { TASK_STATUS_LABEL } from './model'
import type { TaskStatus } from './model'

// The speaker-tasks route's URL vocabulary (W8). The page already had a tab
// and a status chip row; this makes them addressable, so "12 tasks are
// outstanding" can open the tasks tab already filtered to the outstanding ones
// instead of dropping the organizer on the requirements list.

export const TASK_TABS = ['requirements', 'instances', 'files'] as const
export type TaskTab = (typeof TASK_TABS)[number]

/**
 * The chip row's vocabulary. `all` is the default and never in the URL.
 *
 * `outstanding` is not a status — it is the `isOpen` predicate, i.e. every task
 * somebody still owes, which spans Outstanding, Awaiting Review and Changes
 * Requested. It exists because the control center counts exactly that set, and
 * a count whose link shows a shorter list than the number on it is worse than
 * no link at all.
 */
export type TaskFilter = TaskStatus | 'all' | 'overdue' | 'outstanding'

/** The cross-status filters, in the order the chip row shows them. */
export const DERIVED_TASK_FILTERS = ['outstanding', 'overdue'] as const
type DerivedTaskFilter = (typeof DERIVED_TASK_FILTERS)[number]

function isTaskStatus(value: string): value is TaskStatus {
  return Object.hasOwn(TASK_STATUS_LABEL, value)
}

export type TasksSearch = {
  tab?: TaskTab
  status?: TaskStatus | DerivedTaskFilter
  /** The requirement narrowing. W8 left this one out because the control
   * shipped before the vocabulary did; W12 owns filter state, so it is in the
   * URL now like every other filter on the page. Not validated against the
   * event's requirement ids — those are per-event and only the route can know
   * them, so an id that matches nothing simply shows an empty list. */
  requirement?: string
}

/** Route-level validateSearch: unknown params are dropped, never trusted. */
export function parseTasksSearch(input: Record<string, unknown>): TasksSearch {
  const out: TasksSearch = {}
  const tab = input.tab
  if (typeof tab === 'string' && (TASK_TABS as ReadonlyArray<string>).includes(tab)) {
    out.tab = tab as TaskTab
  }
  const status = input.status
  if (typeof status === 'string') {
    if ((DERIVED_TASK_FILTERS as ReadonlyArray<string>).includes(status)) {
      out.status = status as DerivedTaskFilter
    } else if (isTaskStatus(status)) {
      out.status = status
    }
  }
  const requirement = input.requirement
  if (
    typeof requirement === 'string' &&
    requirement !== '' &&
    requirement !== 'all'
  ) {
    out.requirement = requirement.slice(0, 64)
  }
  return out
}
