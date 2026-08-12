import { useState } from 'react'

// W5: the public widgets' facets, search and expanded record live in the URL,
// so a filtered program is a link somebody can send ("the AI track on day 2")
// and the browser's Back button undoes a filter instead of leaving the page.
//
// The schema is validated by TanStack's `validateSearch` on the public route —
// the mechanism ARCHITECTURE.md already prescribes for saved views — and every
// value is bounded and whitelisted here, because these params arrive from the
// open internet and are rendered straight back into the page.

export const PUBLIC_VIEWS = [
  'sessions',
  'speakers',
  'agenda',
  'itinerary',
  'gallery',
] as const
export type PublicView = (typeof PUBLIC_VIEWS)[number]

export type PublicSearch = {
  view?: PublicView
  /** Free-text search inside the active widget. */
  q?: string
  track?: string
  format?: string
  room?: string
  /** Agenda day key, `YYYY-MM-DD`. */
  day?: string
  /** The expanded session (agenda) — an opaque published id. */
  session?: string
  /** The expanded speaker (directory/gallery) — the widget's own entry key. */
  speaker?: string
}

/** Values are echoed into the page, so they are length-capped and stripped of
 * control characters before anything renders them. */
const MAX_VALUE = 200

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // Stripping control characters from untrusted query strings is the intent.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (cleaned === '' || cleaned.length > MAX_VALUE) return undefined
  return cleaned
}

/** Drop empty keys so a default state produces a bare `/e/slug` URL. */
function compact(search: PublicSearch): PublicSearch {
  const out: PublicSearch = {}
  const entries = Object.entries(search) as Array<
    [keyof PublicSearch, string | undefined]
  >
  for (const [key, value] of entries) {
    if (value !== undefined && value !== '') out[key] = value as never
  }
  return out
}

export function parsePublicSearch(
  input: Record<string, unknown>,
): PublicSearch {
  const view = text(input.view)
  return compact({
    // `sessions` is the default view and never needs to be in the URL.
    view:
      view !== undefined &&
      view !== 'sessions' &&
      (PUBLIC_VIEWS as ReadonlyArray<string>).includes(view)
        ? (view as PublicView)
        : undefined,
    q: text(input.q),
    track: text(input.track),
    format: text(input.format),
    room: text(input.room),
    day: text(input.day),
    session: text(input.session),
    speaker: text(input.speaker),
  })
}

/** Facet keys a view owns; changing the view clears the others so a stale
 * `?room=` from the sessions catalog cannot survive into the speakers tab. */
export const FACET_KEYS: ReadonlyArray<keyof PublicSearch> = [
  'q',
  'track',
  'format',
  'room',
  'day',
  'session',
  'speaker',
]

export function applyPatch(
  current: PublicSearch,
  patch: Partial<PublicSearch>,
): PublicSearch {
  return compact({ ...current, ...patch })
}

/** Switching views keeps only the view itself. */
export function forView(view: PublicView | undefined): PublicSearch {
  return compact({ view })
}

export type PublicSearchController = {
  value: PublicSearch
  patch: (patch: Partial<PublicSearch>) => void
}

/**
 * One widget-facing state slot. With a controller it is URL-backed (shareable,
 * reloadable, Back-able); without one — the `/embed/w/<id>` route, where the
 * widget is an iframe on somebody else's page and cannot own the address bar —
 * it falls back to ordinary local state, so both callers use one code path.
 */
export function useSearchState(
  url: PublicSearchController | undefined,
  key: keyof PublicSearch,
  initial: string | null = null,
): [string | null, (next: string | null) => void] {
  const [local, setLocal] = useState<string | null>(initial)
  if (url === undefined) return [local, setLocal]
  return [
    url.value[key] ?? null,
    (next: string | null) => {
      url.patch({ [key]: next ?? undefined })
    },
  ]
}

/**
 * Clear several slots at once. Sequential single-key writes cannot do this in
 * URL mode: each one patches the search this render was built from, so only
 * the last would survive. One patch, one navigation, one history entry.
 */
export function clearSearchKeys(
  url: PublicSearchController | undefined,
  keys: ReadonlyArray<keyof PublicSearch>,
  fallback: () => void,
): void {
  if (url === undefined) {
    fallback()
    return
  }
  const patch: Partial<PublicSearch> = {}
  for (const key of keys) patch[key] = undefined
  url.patch(patch)
}
