// The workspaces' tab vocabulary (W9), as data and pure functions.
//
// Tab state lives in the URL — `…/sessions/$id?tab=content` — for three
// reasons that all matter more than the extra file:
//   1. W4's publication blockers need somewhere to link to. "Content is Draft"
//      is only a useful sentence if the repair is one hop away, and the hop
//      has to land on the content tab, not on the workspace's front page.
//   2. Back works. A phone user who taps through four tabs and presses Back
//      expects the previous tab, not the list they came from three screens ago.
//   3. A link is shareable. "Look at the publication state of this session" is
//      a URL, not an instruction.
//
// An unknown or missing `tab` resolves to the first tab rather than erroring:
// a stale link from an older release must still open the record.

export const SPEAKER_TABS = [
  { id: 'identity', label: 'Identity', icon: 'user-round' },
  { id: 'sessions', label: 'Sessions', icon: 'presentation' },
  { id: 'readiness', label: 'Readiness', icon: 'circle-check' },
  { id: 'tasks', label: 'Tasks', icon: 'list-checks' },
  { id: 'files', label: 'Files', icon: 'paperclip' },
  { id: 'comments', label: 'Comments', icon: 'message-square' },
  { id: 'comms', label: 'Communication', icon: 'mail' },
] as const

export const SESSION_TABS = [
  { id: 'overview', label: 'Overview', icon: 'layout-grid' },
  { id: 'proposal', label: 'Source proposal', icon: 'inbox' },
  { id: 'speakers', label: 'Speakers', icon: 'user-round' },
  { id: 'content', label: 'Content', icon: 'file-text' },
  { id: 'tasks', label: 'Tasks & files', icon: 'list-checks' },
  { id: 'schedule', label: 'Schedule', icon: 'calendar-days' },
  { id: 'publication', label: 'Publication', icon: 'globe' },
  { id: 'history', label: 'History', icon: 'clock' },
] as const

export type SpeakerTab = (typeof SPEAKER_TABS)[number]['id']
export type SessionTab = (typeof SESSION_TABS)[number]['id']

export type WorkspaceSearch<T extends string> = { tab?: T }

/**
 * Build a route `validateSearch` over a fixed tab list.
 *
 * The first tab is the default and is written as ABSENT, not as `?tab=…`: the
 * canonical URL of a record is the bare one, so a link to the record and a
 * link to its first tab are the same link and the browser history has one
 * entry for them, not two.
 */
export function workspaceSearchParser<T extends string>(
  tabs: ReadonlyArray<{ id: T }>,
): (input: Record<string, unknown>) => WorkspaceSearch<T> {
  const known = new Set<string>(tabs.map((t) => t.id))
  const first = tabs[0].id
  return (input) => {
    const raw = input.tab
    if (typeof raw !== 'string') return {}
    if (!known.has(raw)) return {}
    // The default tab never earns a param.
    if (raw === first) return {}
    return { tab: raw as T }
  }
}

/** The tab a URL is showing — never undefined, so a render cannot be blank. */
export function activeWorkspaceTab<T extends string>(
  tabs: ReadonlyArray<{ id: T }>,
  search: WorkspaceSearch<T>,
): T {
  const wanted = search.tab
  if (wanted !== undefined && tabs.some((t) => t.id === wanted)) return wanted
  return tabs[0].id
}

export const parseSpeakerWorkspaceSearch = workspaceSearchParser(SPEAKER_TABS)
export const parseSessionWorkspaceSearch = workspaceSearchParser(SESSION_TABS)
