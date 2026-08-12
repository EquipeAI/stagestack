import { SESSION_TABS, parseSessionWorkspaceSearch } from './tabs'
import type { SessionTab } from './tabs'

// Where a W4 publication blocker is repaired, as route props (W10).
//
// ONE mapping. The model composes the sentence and names the destination
// (`convex/model/readiness.ts`); this file is the only place that turns that
// destination into a link, so the publish center and the session workspace
// cannot send an organizer to two different pages to fix the same blocker.
//
// The session-scoped repairs now land on the session WORKSPACE tab that
// performs the repair — W9 shipped `…/sessions/$id?tab=content` after the
// vocabulary was written, so until now a session-scoped reason handed over an
// id with nowhere to put it. The `?tab=` value is run through the workspace's
// OWN `validateSearch` here, so a link can never name a tab the route would
// silently drop.

export type PublicationRepair = {
  tab: 'sessions' | 'agenda' | 'publish'
  params?: { sessionId?: string }
  sessionTab?: 'overview' | 'content'
}

export type RepairTarget = {
  to: string
  params: Record<string, string>
  search?: { tab?: SessionTab }
  label: string
}

/** Event-level destinations: the switch or the board that owns the blocker. */
const EVENT_TARGET: Record<
  PublicationRepair['tab'],
  { to: string; label: string }
> = {
  sessions: { to: '/app/e/$eventSlug/sessions', label: 'Open Sessions' },
  agenda: { to: '/app/e/$eventSlug/agenda', label: 'Open Agenda' },
  publish: { to: '/app/e/$eventSlug/publish', label: 'Open the public page' },
}

const TAB_LABEL = new Map<string, string>(
  SESSION_TABS.map((tab) => [tab.id, tab.label]),
)

export function repairTarget(
  eventSlug: string,
  repair: PublicationRepair,
): RepairTarget {
  const sessionId = repair.params?.sessionId
  if (sessionId !== undefined && repair.sessionTab !== undefined) {
    return {
      to: '/app/e/$eventSlug/sessions/$sessionId',
      params: { eventSlug, sessionId },
      // The route's own parser, so the tab that survives the link is the tab
      // that renders — including its "the first tab wears no param" rule.
      search: parseSessionWorkspaceSearch({ tab: repair.sessionTab }),
      label: `Open ${TAB_LABEL.get(repair.sessionTab) ?? 'the session'}`,
    }
  }
  const target = EVENT_TARGET[repair.tab]
  return { to: target.to, params: { eventSlug }, label: target.label }
}
