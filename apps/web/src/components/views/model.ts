import {
  baseViewParams,
  presetsFor,
  sameParams,
} from '@convex/shared/viewParams'
import type { PresetView, ViewModule, ViewParams } from '@convex/shared/viewParams'

// The view picker's pure half (W2). Nothing here reads the network or the DOM,
// so the route wiring and the tests exercise the same functions.

export type StoredView = {
  viewId: string
  name: string
  params: ViewParams
  isDefault: boolean
}

/** A route's typed search object as the params a view stores: strings only,
 * absent keys omitted. Numbers and booleans never appear in these routes'
 * vocabularies, so anything else is dropped rather than stringified. */
export function paramsFromSearch(search: Record<string, unknown>): ViewParams {
  const out: ViewParams = {}
  for (const key of Object.keys(search)) {
    const value = search[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

export type ActiveView =
  | { kind: 'preset'; id: string; name: string }
  | { kind: 'saved'; id: string; name: string; isDefault: boolean }
  /** The params belong to SEVERAL saved views and nothing says which one is
   * being looked at. Naming one would be a guess, and rename/default/delete
   * would then act on a row the organizer never pointed at. */
  | { kind: 'ambiguous'; name: string; ids: ReadonlyArray<string> }
  | { kind: 'custom'; name: 'Custom view' }

/**
 * Which view the table is currently showing.
 *
 * A saved view WINS over a preset with the same params: the organizer named it,
 * so the name they chose is the one the toolbar says.
 *
 * IDENTITY COMES FROM THE PICK, NOT FROM THE PARAMS. Two views can hold exactly
 * the same filters under two names — a rehearsal copy, a rename in progress —
 * and params alone cannot tell them apart, so inferring backwards from the URL
 * silently collapsed them onto the first row and pointed Delete at it.
 * `selectedViewId` is what the organizer actually chose in the picker; it stays
 * authoritative only while the URL still carries that view's params, so any
 * navigation away from it drops the selection instead of keeping a stale name.
 */
export function activeView(
  module: ViewModule,
  params: ViewParams,
  saved: ReadonlyArray<StoredView>,
  selectedViewId: string | null = null,
): ActiveView {
  const matching = saved.filter((view) => sameParams(view.params, params))
  const picked =
    selectedViewId === null
      ? undefined
      : matching.find((view) => view.viewId === selectedViewId)
  const mine = picked ?? (matching.length === 1 ? matching[0] : undefined)
  if (mine !== undefined) {
    return {
      kind: 'saved',
      id: mine.viewId,
      name: mine.name,
      isDefault: mine.isDefault,
    }
  }
  if (matching.length > 1) {
    return {
      kind: 'ambiguous',
      name: `${matching.length} saved views match`,
      ids: matching.map((view) => view.viewId),
    }
  }
  const preset = presetsFor(module).find((view) =>
    sameParams(view.params, params),
  )
  if (preset !== undefined) {
    return { kind: 'preset', id: preset.id, name: preset.name }
  }
  return { kind: 'custom', name: 'Custom view' }
}

export function presetList(module: ViewModule): ReadonlyArray<PresetView> {
  return presetsFor(module)
}

/** True when the URL carries no narrowing of its own — the only moment a
 * personal default may apply, because a link's own filters always win. */
export function isUnnarrowed(module: ViewModule, params: ViewParams): boolean {
  return sameParams(params, baseViewParams(module))
}
