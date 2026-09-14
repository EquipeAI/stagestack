import type { TaskStatus } from './model'
import type { DerivedTaskFilter } from '@convex/shared/viewParams'

// The speaker-tasks route's URL vocabulary (W8), parsed by the shared
// definition (`convex/shared/viewParams.ts`) since W2.
//
// `outstanding` is not a status — it is the `isOpen` predicate, i.e. every
// task somebody still owes, which spans Outstanding, Awaiting Review and
// Changes Requested. It exists because the control center counts exactly that
// set, and a count whose link shows a shorter list than the number on it is
// worse than no link at all.

export {
  DERIVED_TASK_FILTERS,
  TASK_TABS,
  parseTasksSearch,
} from '@convex/shared/viewParams'
export type { TaskTab, TasksSearch } from '@convex/shared/viewParams'

/** The chip row's vocabulary. `all` is the default and never in the URL. */
export type TaskFilter = TaskStatus | 'all' | DerivedTaskFilter
