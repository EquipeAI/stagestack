import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { NavId } from '~/components/shell/nav'
import type { CommandPaletteGroup } from '~/ds'
import { Button, CommandPalette } from '~/ds'
import { useProvisioning } from '~/lib/useProvisioning'
import { DECISIONS_SEARCH, TAB_PATHS } from '~/components/shell/nav'
import { matchDestinations } from '~/components/shell/paletteNav'

// ─────────────────────────────────────────────────────────────────────────
// Global search + the command palette (W1).
//
// It lives in the topbar, above every /app route, for two reasons: the
// shortcut has to work wherever you are, and the BUTTON has to be visible —
// a palette that can only be opened by a keystroke you have to already know
// is a feature for the person who wrote it.
//
// Navigation only, on purpose. Every row is a jump; nothing here writes.
//
// The two halves of the answer come from two places and are never mixed:
//   · destinations are the shell's own nav data, matched on the current label
//     AND the old one (components/shell/paletteNav.ts);
//   · records come from `api.search.everything`, which decides what this
//     caller may see and writes every sentence about the answer. This file
//     re-words none of them.
// ─────────────────────────────────────────────────────────────────────────

/** Long enough that a fast typist makes one query, short enough to feel live. */
const DEBOUNCE_MS = 150

const MIN_TERM = 2

type Hit = {
  kind: 'event' | 'session' | 'speaker' | 'proposal' | 'review'
  id: string
  eventSlug: string
  title: string
  subtitle?: string
  query?: string
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')

  // The shortcut is bound once for the whole app. metaKey OR ctrlKey: one
  // binding, both platforms, and no third-party key library to keep current.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      setOpen(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        iconLeft="search"
        aria-label="Search StageStack"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(true)
        }}
      >
        Search
      </Button>
      {open ? (
        <Palette
          term={term}
          onTermChange={setTerm}
          onClose={() => {
            setOpen(false)
            setTerm('')
          }}
        />
      ) : null}
    </>
  )
}

/**
 * Mounted only while open, so the subscription exists only while somebody is
 * looking at it — and so the debounce starts fresh every time.
 */
function Palette({
  term,
  onTermChange,
  onClose,
}: {
  term: string
  onTermChange: (value: string) => void
  onClose: () => void
}) {
  const navigate = useNavigate()
  const params = useParams({ strict: false })
  const eventSlug = params.eventSlug
  // The topbar sits outside AuthGate, so every authed query has to wait for
  // provisioning the way EventSwitcher does.
  const { provisioned } = useProvisioning()

  const [debounced, setDebounced] = useState(term)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(term)
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [term])

  const trimmed = debounced.trim()
  const results = useQuery(
    api.search.everything,
    provisioned && trimmed.length >= MIN_TERM
      ? { term: trimmed, eventSlug }
      : 'skip',
  )

  // Role, so the destination list never offers a reviewer an organizer-only
  // page. The shell subscribes to the same query, so this costs nothing new.
  const event = useQuery(
    api.events.get,
    provisioned && eventSlug !== undefined ? { eventSlug } : 'skip',
  )

  const { groups, actions } = useMemo(() => {
    const built: Array<CommandPaletteGroup> = []
    const jumps = new Map<string, () => void>()

    if (eventSlug !== undefined) {
      const matched = matchDestinations(term, event?.role)
      if (matched.length > 0) {
        built.push({
          id: 'go',
          label: 'Go to',
          items: matched.map((destination) => ({
            id: `go:${destination.id}`,
            label: destination.label,
            hint: destination.group,
            icon: destination.icon,
          })),
        })
        for (const destination of matched) {
          jumps.set(`go:${destination.id}`, () => {
            goToTab(navigate, eventSlug, destination.id)
          })
        }
      }
    }

    for (const group of results?.groups ?? []) {
      // A capped group with no hits carries an admission, not a jump target.
      // Its truth is already in `results.summary`, which is printed verbatim
      // above the list; a header with nothing under it would be noise.
      if (group.hits.length === 0) continue
      built.push({
        id: group.kind,
        label: group.label,
        items: group.hits.map((hit, index) => ({
          id: `${group.kind}:${index}`,
          label: hit.title,
          hint: hit.subtitle,
        })),
      })
      group.hits.forEach((hit, index) => {
        jumps.set(`${group.kind}:${index}`, () => {
          goToHit(navigate, hit)
        })
      })
    }

    return { groups: built, actions: jumps }
  }, [eventSlug, event?.role, term, results, navigate])

  const status =
    term.trim().length === 0
      ? 'Jump to a page, or type to search this event.'
      : term.trim().length < MIN_TERM || results === undefined
        ? 'Searching…'
        : // Verbatim from the capability — the palette never re-words a count.
          results.summary

  return (
    <CommandPalette
      open
      id="global-search"
      title="Search"
      label="Search events, sessions, speakers and proposals"
      placeholder="Search or jump to…"
      shortcut="⌘K"
      value={term}
      onValueChange={onTermChange}
      status={status}
      emptyLabel="Nothing here matches. Try a title, a name, or an event."
      groups={groups}
      onSelect={(id) => {
        const jump = actions.get(id)
        if (jump === undefined) return
        onClose()
        jump()
      }}
      onClose={onClose}
    />
  )
}

type Navigate = ReturnType<typeof useNavigate>

/** The rail's own tab→route map, so the palette can never invent a path. */
function goToTab(navigate: Navigate, eventSlug: string, id: NavId) {
  if (id === 'decisions') {
    void navigate({
      to: TAB_PATHS.proposals,
      params: { eventSlug },
      search: DECISIONS_SEARCH,
    })
    return
  }
  void navigate({ to: TAB_PATHS[id], params: { eventSlug } })
}

/**
 * Where a record lives.
 *
 * Sessions and speakers have workspaces of their own (W9). A proposal does
 * not: its surface is the abstracts table, so the row lands there already
 * filtered to the title — using the `q` param that route's own validateSearch
 * has always parsed. A reviewer's assignment goes to Reviews, which is where
 * a reviewer's proposals live at all.
 */
function goToHit(navigate: Navigate, hit: Hit) {
  const eventSlug = hit.eventSlug
  if (hit.kind === 'session') {
    void navigate({
      to: '/app/e/$eventSlug/sessions/$sessionId',
      params: { eventSlug, sessionId: hit.id },
    })
    return
  }
  if (hit.kind === 'speaker') {
    void navigate({
      to: '/app/e/$eventSlug/speakers/$eventContactId',
      params: { eventSlug, eventContactId: hit.id },
    })
    return
  }
  if (hit.kind === 'proposal') {
    void navigate({
      to: TAB_PATHS.proposals,
      params: { eventSlug },
      search: { q: hit.query ?? hit.title },
    })
    return
  }
  if (hit.kind === 'review') {
    void navigate({ to: TAB_PATHS.reviews, params: { eventSlug } })
    return
  }
  void navigate({ to: TAB_PATHS.overview, params: { eventSlug } })
}
