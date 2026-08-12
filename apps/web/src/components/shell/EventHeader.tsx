import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type * as React from 'react'

// A route-aware header for the event shell (W7, consumed by W9).
//
// The event layout renders ONE `PageHeader` above every child route. That was
// fine while every child was a top-level module — the header said the event's
// name and the crumbs stopped at the event. A routed workspace
// (`/sessions/$id`) needs to say its own name and add its own crumb, and the
// mobile chrome budget forbids it stacking a second sticky header underneath
// this one.
//
// So the header becomes a slot. A child route calls `useEventHeaderSlot(...)`
// and the layout renders the result; a route that says nothing gets exactly
// today's three levels. Nothing is imperative and nothing is global: the slot
// is context state, cleared when the contributing route unmounts.

export type EventCrumb = { label: string; href?: string }

export type EventHeaderSlot = {
  /** Replaces the event name as the page's <h1>. */
  title?: string
  /** Replaces the event's date range under the title. */
  description?: string
  /** Appended after the event crumb, in order. */
  crumbs?: Array<EventCrumb>
  /** Right-hand actions for this route, rendered in the shared header. */
  actions?: React.ReactNode
}

type Ctx = {
  slot: EventHeaderSlot | null
  setSlot: (owner: symbol, key: string, value: EventHeaderSlot | null) => void
}

const EventHeaderContext = createContext<Ctx | null>(null)

export function EventHeaderProvider({
  children,
}: {
  children: React.ReactNode
}) {
  // Keyed by owner so a route that unmounts after another has already claimed
  // the header (a fast navigation) cannot clear the new owner's slot.
  const [state, setState] = useState<{
    owner: symbol | null
    key: string
    slot: EventHeaderSlot | null
  }>({ owner: null, key: '', slot: null })

  // Stable for the provider's whole life. It cannot close over `state` or
  // depend on it: the setter is a dependency of the consumers' effect, so a
  // setter that changed identity whenever the slot changed would make every
  // contribution re-fire its own effect — a render loop, not a header.
  const setSlot = useCallback<Ctx['setSlot']>((owner, key, slot) => {
    setState((prev) => {
      if (slot === null) {
        return prev.owner === owner ? { owner: null, key: '', slot: null } : prev
      }
      // Same route, same content: no state change, so no re-render.
      if (prev.owner === owner && prev.key === key) return prev
      return { owner, key, slot }
    })
  }, [])

  const value = useMemo<Ctx>(
    () => ({ slot: state.slot, setSlot }),
    [state.slot, setSlot],
  )

  return (
    <EventHeaderContext.Provider value={value}>
      {children}
    </EventHeaderContext.Provider>
  )
}

/** What the layout renders. Null outside a provider, and null by default. */
export function useEventHeader(): EventHeaderSlot | null {
  return useContext(EventHeaderContext)?.slot ?? null
}

/**
 * Contribute this route's title and crumbs to the shared header.
 *
 * The value is compared structurally, so a caller may pass an object literal
 * without memoising it — the common case in a route component, and the one
 * that would otherwise loop.
 */
export function useEventHeaderSlot(slot: EventHeaderSlot | null) {
  const ctx = useContext(EventHeaderContext)
  const owner = useMemo(() => Symbol('event-header'), [])
  // `actions` is a React node and never serialises; it rides along with
  // whatever change to the serialisable half triggered the update, which is
  // what a route re-render does anyway.
  const key = JSON.stringify(
    slot === null
      ? null
      : {
          title: slot.title,
          description: slot.description,
          crumbs: slot.crumbs,
        },
  )
  // The value is read through a ref rather than depended on. A route passes an
  // inline object, so its identity changes every render; as an effect
  // dependency that would tear the slot down and rebuild it on every render —
  // which is a state update per render, which is a loop. `key` is the value's
  // structural identity and is the honest dependency.
  const latest = useRef(slot)
  latest.current = slot
  const setSlot = ctx?.setSlot
  useEffect(() => {
    if (setSlot === undefined) return
    setSlot(owner, key, latest.current)
    return () => {
      setSlot(owner, key, null)
    }
  }, [key, setSlot, owner])
}
