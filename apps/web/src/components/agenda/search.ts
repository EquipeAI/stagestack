// The agenda route's URL vocabulary. Extracted from the route file (W8), then
// moved into `convex/shared/viewParams.ts` (W2) so the saved-view capability
// validates stored params with the route's own parser rather than a copy.

export { AGENDA_VIEWS, parseAgendaSearch } from '@convex/shared/viewParams'
export type { AgendaSearch } from '@convex/shared/viewParams'
