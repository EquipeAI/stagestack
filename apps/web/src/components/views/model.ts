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
  | { kind: 'custom'; name: 'Custom view' }

/**
 * Which view the table is currently showing.
 *
 * A saved view WINS over a preset with the same params: the organizer named it,
 * so the name they chose is the one the toolbar says.
 */
export function activeView(
  module: ViewModule,
  params: ViewParams,
  saved: ReadonlyArray<StoredView>,
): ActiveView {
  const mine = saved.find((view) => sameParams(view.params, params))
  if (mine !== undefined) {
    return {
      kind: 'saved',
      id: mine.viewId,
      name: mine.name,
      isDefault: mine.isDefault,
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
