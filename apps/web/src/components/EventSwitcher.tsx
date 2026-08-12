import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { Icon } from '~/ds'
import { useProvisioning } from '~/lib/useProvisioning'

/**
 * The topbar context switcher: which event (and which organization's event)
 * this session is looking at, and one click to any other. /app lands straight
 * in an event, so this is how you get out of it — the organization list is a
 * destination now, not a toll gate.
 */
export function EventSwitcher() {
  // The switcher sits in the topbar, outside AuthGate, so it waits on
  // provisioning itself: every authed query throws until `users.ensure` has
  // run. (The mutation is idempotent — portal.$eventSlug does the same.)
  const { provisioned } = useProvisioning()
  const home = useQuery(api.orgs.myHome, provisioned ? {} : 'skip')
  const params = useParams({ strict: false })
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const panelId = useId()

  const eventSlug = params.eventSlug
  const orgSlug = params.orgSlug

  // Close on anything that means "I'm done here": a click elsewhere, Escape,
  // or the navigation the menu itself caused.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        // Escape used to unmount the panel from under whichever menuitem had
        // focus, dropping the keyboard on <body> at the top of the document.
        trigger.current?.focus()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
        return
      }
      // role="menu" promises arrow-key navigation; without it the only way
      // through the list is Tab, which also walks straight out of the menu.
      const items = panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      if (items === undefined || items.length === 0) return
      const list = Array.prototype.slice.call(items) as Array<HTMLButtonElement>
      const at = list.indexOf(document.activeElement as HTMLButtonElement)
      event.preventDefault()
      if (event.key === 'Home') return list[0].focus()
      if (event.key === 'End') return list[list.length - 1].focus()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = at === -1 ? (step === 1 ? 0 : list.length - 1) : (at + step + list.length) % list.length
      list[next].focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Focus moves into the menu on open, so the keyboard is never left behind an
  // overlay it cannot see.
  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [open])

  const entries = home ?? []
  const currentOrg =
    entries.find((entry) =>
      eventSlug === undefined
        ? entry.org.slug === orgSlug
        : entry.events.some((event) => event.slug === eventSlug),
    ) ?? null
  const currentEvent =
    eventSlug === undefined
      ? undefined
      : currentOrg?.events.find((event) => event.slug === eventSlug)

  const label =
    currentEvent?.name ??
    (eventSlug !== undefined
      ? eventSlug
      : (currentOrg?.org.name ?? 'My StageStack'))

  const go = (to: () => void) => {
    setOpen(false)
    to()
  }

  return (
    <div className="switcher" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="switcher__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="switcher__label">{label}</span>
        <Icon name="chevron-down" size={14} />
      </button>

      {open ? (
        <div ref={panel} className="switcher__panel" id={panelId} role="menu">
          <button
            type="button"
            role="menuitem"
            className="switcher__item"
            aria-current={eventSlug === undefined && orgSlug === undefined}
            onClick={() => go(() => void navigate({ to: '/app/home' }))}
          >
            <Icon name="layout-grid" size={14} />
            <span className="switcher__item-label">My StageStack</span>
          </button>

          {home === undefined ? (
            <p className="switcher__note">Loading your organizations…</p>
          ) : entries.length === 0 ? (
            <p className="switcher__note">
              You are not in an organization yet. My StageStack has the form
              that creates one.
            </p>
          ) : (
            entries.map((entry) => (
              <div className="switcher__group" key={entry.org._id}>
                <button
                  type="button"
                  role="menuitem"
                  className="switcher__org"
                  onClick={() =>
                    go(() =>
                      void navigate({
                        to: '/app/org/$orgSlug',
                        params: { orgSlug: entry.org.slug },
                      }),
                    )
                  }
                >
                  <Icon name="building-2" size={14} />
                  <span className="switcher__item-label">{entry.org.name}</span>
                </button>
                {entry.events.length === 0 ? (
                  <p className="switcher__note">No events yet.</p>
                ) : (
                  entry.events.map((event) => (
                    <button
                      key={event._id}
                      type="button"
                      role="menuitem"
                      className="switcher__item switcher__item--event"
                      aria-current={event.slug === eventSlug}
                      onClick={() =>
                        go(() =>
                          void navigate({
                            to: '/app/e/$eventSlug',
                            params: { eventSlug: event.slug },
                          }),
                        )
                      }
                    >
                      <span className="switcher__item-label">{event.name}</span>
                      {event.slug === eventSlug ? (
                        <Icon name="check" size={14} />
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
