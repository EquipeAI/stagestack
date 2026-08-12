import type * as React from 'react'
import { Tabs } from '~/ds'
import { useEventHeaderSlot } from '~/components/shell/EventHeader'

// The chrome a routed workspace wears (W9).
//
// ── The chrome budget ────────────────────────────────────────────────────
// The event layout already renders ONE PageHeader above every child route,
// and the phone bar above that is already sticky. A workspace that added its
// own sticky title would put three stacked bars over a 375px screen before a
// single fact about the record appeared.
//
// So the workspace ABSORBS the existing header rather than stacking under it:
// it contributes its title, its description and its crumb through W7's
// `useEventHeaderSlot`, and the shared header renders them. There is exactly
// one title area on the page and it is the one that was already there.
//
// ── Why the primary action is NOT in the header slot ─────────────────────
// `EventHeaderSlot.actions` is a React node, and the slot's change detection
// keys on the SERIALISABLE half (title/description/crumbs) only — a node that
// changes while the strings stay put does not re-publish. That is fine for a
// static link and wrong for a button that says "Save speaker" and then
// "Saving…". So the header slot carries only the stable strings, and the
// primary action lives in this component's own action bar.
//
// ── Thumb reach ──────────────────────────────────────────────────────────
// That bar is inline beside the tab strip at desktop width, and BOTTOM-
// ANCHORED below 640px, where the top of a phone is the one place a thumb
// cannot reach. It is `position: sticky`, not `fixed`: a fixed bar overlays
// the last row of whatever the tab is showing, and a workspace's last row is
// routinely the thing the button acts on.

export type WorkspaceTab = { id: string; label: string; icon?: string }

export function WorkspaceShell({
  title,
  description,
  crumbs,
  tabs,
  activeTab,
  onTabChange,
  primaryAction,
  tabsLabel,
  children,
}: {
  title: string
  description?: string
  /** List → record, appended after the event crumb by the shared header. */
  crumbs: Array<{ label: string; href?: string }>
  tabs: ReadonlyArray<WorkspaceTab>
  activeTab: string
  onTabChange: (id: string) => void
  /** The one action this record's current tab is for. May be null. */
  primaryAction?: React.ReactNode
  tabsLabel: string
  children: React.ReactNode
}) {
  useEventHeaderSlot({
    title,
    description,
    crumbs,
  })

  return (
    <div className="ss-workspace">
      <div className="ss-workspace__bar">
        {/* The DS's own overflow-scrolling strip (navigation.css) — the tabs
            scroll sideways on a phone rather than wrapping into three rows. */}
        <Tabs
          aria-label={tabsLabel}
          tabs={tabs as Array<WorkspaceTab>}
          value={activeTab}
          onChange={onTabChange}
        />
        {primaryAction === undefined || primaryAction === null ? null : (
          <div className="ss-workspace__actions">{primaryAction}</div>
        )}
      </div>
      <div className="ss-workspace__body">{children}</div>
    </div>
  )
}

/**
 * A tab's contents, labelled and associated with its tab button.
 *
 * `role="tabpanel"` without a matching `aria-controls` on the button would be
 * a half-implemented pattern, so the panel takes the accessible name instead
 * and is focusable — which is also what makes "activate tab, then Tab once"
 * land inside the panel rather than on the next tab button.
 */
export function WorkspacePanel({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section
      role="tabpanel"
      aria-label={label}
      tabIndex={-1}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      {children}
    </section>
  )
}
