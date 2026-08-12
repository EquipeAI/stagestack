// The event shell's navigation vocabulary (W7).
//
// Everything about "where can I go inside an event" lives here as data and
// pure functions: the tab → route map, the lifecycle grouping the rail and the
// mobile drawer both render, the active-entry resolver, and the count
// formatter. The route file composes them; it decides nothing on its own.
//
// Two invariants this module exists to hold:
//   1. Every path an earlier release published keeps resolving. `/dashboard`
//      is a redirect, not a 404, and the root is still the root.
//   2. A renamed label keeps its old wording as a spoken alias, so a harness
//      (or a person) that learned the old name still finds the entry.

/**
 * Tab id → route path. Read both ways: pathname → active tab, and selected
 * tab → navigation target.
 *
 * `dashboard` is deliberately absent. The event root IS the control center now
 * (decision 5); `/app/e/$eventSlug/dashboard` still resolves, as a redirect to
 * the root — see routes/app.e.$eventSlug.dashboard.tsx.
 */
export const TAB_PATHS = {
  overview: '/app/e/$eventSlug',
  details: '/app/e/$eventSlug/details',
  cfp: '/app/e/$eventSlug/cfp',
  comms: '/app/e/$eventSlug/comms',
  proposals: '/app/e/$eventSlug/proposals',
  reviews: '/app/e/$eventSlug/reviews',
  sessions: '/app/e/$eventSlug/sessions',
  speakers: '/app/e/$eventSlug/speakers',
  agenda: '/app/e/$eventSlug/agenda',
  import: '/app/e/$eventSlug/import',
  publish: '/app/e/$eventSlug/publish',
  settings: '/app/e/$eventSlug/settings',
  tasks: '/app/e/$eventSlug/tasks',
  team: '/app/e/$eventSlug/team',
} as const

export type TabId = keyof typeof TAB_PATHS

/**
 * Every path the shell published BEFORE this workstream. Kept as data so the
 * route-resolution check (the plan's cross-cutting requirement: redirect,
 * never 404) is a test over a list rather than a memory of one.
 */
export const LEGACY_TAB_PATHS = {
  dashboard: '/app/e/$eventSlug/dashboard',
  overview: '/app/e/$eventSlug',
  cfp: '/app/e/$eventSlug/cfp',
  comms: '/app/e/$eventSlug/comms',
  proposals: '/app/e/$eventSlug/proposals',
  reviews: '/app/e/$eventSlug/reviews',
  sessions: '/app/e/$eventSlug/sessions',
  speakers: '/app/e/$eventSlug/speakers',
  agenda: '/app/e/$eventSlug/agenda',
  import: '/app/e/$eventSlug/import',
  publish: '/app/e/$eventSlug/publish',
  settings: '/app/e/$eventSlug/settings',
  tasks: '/app/e/$eventSlug/tasks',
  team: '/app/e/$eventSlug/team',
} as const

/**
 * The Select group's Decisions entry is a saved view of Proposals, not a
 * fifteenth module (decision 6): the staged queues are exactly the two
 * reversible states, and the proposals route's own `validateSearch` already
 * speaks them (`BUILT_IN_VIEWS`' "Queues"). No search vocabulary was added.
 */
export const DECISIONS_STATUSES = ['acceptQueue', 'declineQueue'] as const
export const DECISIONS_SEARCH = {
  status: DECISIONS_STATUSES.join(','),
} as const

/** True when a proposals URL is showing exactly the staged-decision queues. */
export function isDecisionsView(search: { status?: string } | undefined) {
  const raw = search?.status
  if (raw === undefined) return false
  const seen = new Set(raw.split(',').filter((s) => s !== ''))
  return (
    seen.size === DECISIONS_STATUSES.length &&
    DECISIONS_STATUSES.every((s) => seen.has(s))
  )
}

/** Nav entry id: a routed tab, or the one deep-link entry. */
export type NavId = TabId | 'decisions'

/**
 * `requires` hides an entry from anyone without that role on this event.
 * `alias` is spoken but not shown — it carries the entry's PREVIOUS label so a
 * rename never makes a capability unfindable by its old name.
 * `attention` names the key this entry reads from `api.readiness.attention`.
 */
export type NavItem = {
  id: NavId
  label: string
  icon: string
  requires?: 'organizer'
  alias?: string
  attention?: AttentionKey
}

export type NavGroup = { label: string; items: Array<NavItem> }

/**
 * The rail, grouped by the lifecycle an event actually runs through rather
 * than by module. One flat list of fourteen entries was a memory test; six
 * short groups are a map of the job.
 */
export const NAV_GROUPS: Array<NavGroup> = [
  {
    label: 'Setup',
    items: [
      // The root. Organizers get the operational control center here;
      // reviewers and speakers get the event facts, because the root has
      // always been a page they can open and must not become an empty
      // organizer-only shell for them.
      {
        id: 'overview',
        label: 'Overview',
        icon: 'layout-grid',
        alias: 'Dashboard',
      },
      // Where the stable facts went when the root became operational: dates,
      // timezone, the CFP link, archive. Sits beside Settings because it is
      // the read-only face of the same information.
      { id: 'details', label: 'Event details', icon: 'file-text' },
      {
        id: 'settings',
        label: 'Settings',
        icon: 'settings',
        requires: 'organizer',
      },
      { id: 'team', label: 'Team', icon: 'users', requires: 'organizer' },
      // Import writes records with the organizer's authority, so the entry is
      // organizer-gated like the backend surface it fronts.
      { id: 'import', label: 'Import', icon: 'upload', requires: 'organizer' },
    ],
  },
  {
    label: 'Collect',
    items: [
      {
        id: 'cfp',
        label: 'Call for speakers',
        icon: 'mic-vocal',
        requires: 'organizer',
      },
    ],
  },
  {
    label: 'Select',
    items: [
      {
        id: 'proposals',
        label: 'Proposals',
        icon: 'inbox',
        requires: 'organizer',
        attention: 'proposals',
      },
      // Reviewers are assigned proposals to score, so Reviews is theirs too.
      { id: 'reviews', label: 'Reviews', icon: 'star', attention: 'reviews' },
      {
        id: 'decisions',
        label: 'Decisions',
        icon: 'check',
        requires: 'organizer',
      },
    ],
  },
  {
    label: 'Prepare',
    items: [
      {
        id: 'sessions',
        label: 'Sessions',
        icon: 'presentation',
        requires: 'organizer',
        attention: 'sessions',
      },
      {
        id: 'speakers',
        label: 'Speakers',
        icon: 'user-round',
        requires: 'organizer',
        attention: 'speakers',
      },
      {
        id: 'tasks',
        label: 'Tasks',
        icon: 'list-checks',
        requires: 'organizer',
        alias: 'Speaker tasks',
        attention: 'tasks',
      },
      {
        id: 'comms',
        label: 'Communications',
        icon: 'mail',
        requires: 'organizer',
      },
    ],
  },
  {
    label: 'Schedule',
    items: [
      {
        id: 'agenda',
        label: 'Agenda',
        icon: 'calendar-days',
        requires: 'organizer',
        attention: 'agenda',
      },
    ],
  },
  {
    label: 'Publish',
    items: [
      // The public page, the embeds and the feeds all live behind this one
      // entry; the group label carries the lifecycle step.
      {
        id: 'publish',
        label: 'Public page',
        icon: 'globe',
        requires: 'organizer',
        alias: 'Publish',
        attention: 'publish',
      },
    ],
  },
]

// ── Active entry ─────────────────────────────────────────────────────────

function resolve(path: string, eventSlug: string) {
  return path.replace('$eventSlug', eventSlug)
}

/**
 * Longest-prefix match, not equality.
 *
 * Exact equality highlighted the root for every deeper route, which is fine
 * while every tab is a leaf and wrong the moment W9's `/sessions/$id`
 * workspaces land. The root is matched exactly on purpose — it is a prefix of
 * literally every other path in the event, so treating it as one would make it
 * the answer to everything.
 */
export function activeTabId(pathname: string, eventSlug: string): TabId {
  const current = pathname.replace(/\/+$/, '')
  const root = resolve(TAB_PATHS.overview, eventSlug)
  let best: TabId = 'overview'
  let bestLength = -1
  for (const id of Object.keys(TAB_PATHS) as Array<TabId>) {
    const path = resolve(TAB_PATHS[id], eventSlug)
    const hit =
      path === root
        ? current === root
        : current === path || current.startsWith(`${path}/`)
    if (hit && path.length > bestLength) {
      best = id
      bestLength = path.length
    }
  }
  return best
}

/**
 * The rail's active entry: the routed tab, except that Proposals filtered to
 * exactly the staged queues is the Decisions view and says so.
 */
export function activeNavId(
  pathname: string,
  eventSlug: string,
  search?: { status?: string },
): NavId {
  const tab = activeTabId(pathname, eventSlug)
  if (tab === 'proposals' && isDecisionsView(search)) return 'decisions'
  return tab
}

/** The group an entry belongs to — what the phone bar names as "where am I". */
export function groupOf(id: NavId): string | undefined {
  for (const group of NAV_GROUPS) {
    if (group.items.some((item) => item.id === id)) return group.label
  }
  return undefined
}

export function itemOf(id: NavId): NavItem | undefined {
  for (const group of NAV_GROUPS) {
    const found = group.items.find((item) => item.id === id)
    if (found) return found
  }
  return undefined
}

// ── Attention counts ─────────────────────────────────────────────────────

export type AttentionKey =
  | 'proposals'
  | 'reviews'
  | 'sessions'
  | 'speakers'
  | 'agenda'
  | 'tasks'
  | 'publish'

export type Attention = {
  counts: Record<AttentionKey, number>
  capped: boolean
}

/**
 * The badge convention, stated once.
 *
 * A zero renders as no badge at all — an empty queue is not news. A capped
 * read renders `12+`, never a bare `12`: `api.readiness.attention` truncates
 * rather than refusing, so its numbers are floors, and printing a floor as an
 * exact total is the kind of quiet lie this whole plan exists to remove.
 */
export function formatCount(
  value: number | undefined,
  capped: boolean,
): string | undefined {
  if (value === undefined || value <= 0) return undefined
  return capped ? `${value}+` : String(value)
}

/** What the count means, spoken — the badge alone is a bare number. */
export function countHint(
  value: number | undefined,
  capped: boolean,
): string | undefined {
  if (value === undefined || value <= 0) return undefined
  return capped
    ? `at least ${value} needing attention`
    : `${value} needing attention`
}

/** One sentence for the phone menu button, so the drawer is worth opening. */
export function attentionSummary(attention: Attention | null): string {
  if (attention === null) return 'Event menu'
  let total = 0
  for (const key of Object.keys(attention.counts) as Array<AttentionKey>) {
    total += attention.counts[key]
  }
  if (total === 0) return 'Event menu · nothing needs attention'
  const prefix = attention.capped ? 'at least ' : ''
  return `Event menu · ${prefix}${total} ${total === 1 ? 'item needs' : 'items need'} attention`
}
