import { Component, useEffect } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type * as React from 'react'
import type { Attention } from './nav'

// The rail's badge feed (W7), and the shape it has for one reason: navigation
// may never break.
//
// `api.readiness.attention` is the cheap counts query W4 shipped for exactly
// this — `takeCapped` reads with a `capped` flag, and no ticking argument, so
// the shell subscribes once and stays subscribed. The shell must NOT subscribe
// `Readiness.dashboard` / `tasks.dashboard`: those refuse over-ceiling events
// and take a per-minute `now`, which under every page in the product would
// turn one large table into "navigation is broken everywhere".
//
// Even the cheap query can fail (an outage, a permission change mid-session),
// and `useQuery` reports that by THROWING during render. So the subscription
// lives in a leaf component behind a boundary that renders nothing: a failure
// costs the badges and nothing else. The rail, the drawer and every link keep
// working.

/** Subscribes and reports upward. Renders nothing; may throw. */
function Probe({
  eventSlug,
  onData,
}: {
  eventSlug: string
  onData: (value: Attention | null) => void
}) {
  const value = useQuery(api.readiness.attention, { eventSlug })
  useEffect(() => {
    onData(value ?? null)
  }, [value, onData])
  return null
}

type BoundaryProps = { children: React.ReactNode; onFail: () => void }

class QuietBoundary extends Component<BoundaryProps, { failed: boolean }> {
  constructor(props: BoundaryProps) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch() {
    // Degrade to no badges. Deliberately silent for the user — a count they
    // cannot see is not something to interrupt them about — and the failure
    // is already reported by whichever page actually needs that data.
    this.props.onFail()
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * Feeds attention counts to the shell. Renders nothing in every case.
 *
 * `enabled` is false for reviewers: the query is organizer-only, so asking as
 * a reviewer would be a guaranteed failure rather than a degraded one.
 */
export function AttentionCounts({
  eventSlug,
  enabled,
  onData,
}: {
  eventSlug: string
  enabled: boolean
  onData: (value: Attention | null) => void
}) {
  // Counts must never outlive what produced them: when the role gate closes
  // or the event changes, clear the parent's copy so the previous event's
  // numbers (or an ex-organizer's view) never label the current rail.
  useEffect(() => {
    if (!enabled) onData(null)
  }, [enabled, onData])
  useEffect(() => {
    return () => {
      onData(null)
    }
  }, [eventSlug, onData])

  if (!enabled) return null
  return (
    <QuietBoundary
      // Remounting on a new event drops a failure that belonged to the old one.
      key={eventSlug}
      onFail={() => {
        onData(null)
      }}
    >
      <Probe eventSlug={eventSlug} onData={onData} />
    </QuietBoundary>
  )
}
