import type { TabId } from '~/components/shell/nav'
import { TAB_PATHS } from '~/components/shell/nav'

// Deep links, resolved in one place (W8).
//
// The backend names the destination — a tab id from the shell's vocabulary,
// plus that route's OWN search params — and this module turns it into
// navigation. Nothing here invents a filter: if the control center says "3
// speakers have not answered", the search it carries is the search the
// speakers route parses, and the test that proves it runs the destination's
// `validateSearch` over exactly this object.

/** What `convex/model/controlCenter.ts` emits. */
export type ControlLink = {
  tab: string
  search?: Record<string, string>
}

export type LinkTarget = {
  to: (typeof TAB_PATHS)[TabId]
  params: { eventSlug: string }
  search: Record<string, string>
}

function isTabId(tab: string): tab is TabId {
  return Object.hasOwn(TAB_PATHS, tab)
}

/**
 * The navigation props for one link.
 *
 * An unknown tab id resolves to the event root rather than throwing: a backend
 * that learns a new destination before the client does should cost the
 * organizer a precise landing, never the whole panel.
 */
export function linkTarget(
  link: ControlLink,
  eventSlug: string,
): LinkTarget {
  const tab: TabId = isTabId(link.tab) ? link.tab : 'overview'
  return {
    to: TAB_PATHS[tab],
    params: { eventSlug },
    search: link.search ?? {},
  }
}
