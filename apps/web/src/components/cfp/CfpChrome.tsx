import { Link } from '@tanstack/react-router'
import type * as React from 'react'
import type { WindowState } from './model'
import { Button, Callout, Card, EmptyState, Logo } from '~/ds'
import { PageBody } from '~/components/PageBody'
import { formatDateTime } from '~/lib/datetime'
import { errorMessage } from '~/lib/errors'
import { useNow as useTick } from '~/lib/useNow'

/** Wall clock that advances, so a window closing mid-session is noticed. */
export function useNow(intervalMs = 30_000) {
  return useTick(intervalMs)
}

export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {children}
    </span>
  )
}

/** Shown when `cfpPublic.get` returns null: no such CFP, or not published. */
export function CfpNotOpen({ detail }: { detail?: string }) {
  return (
    <PageBody narrow>
      <Card>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            paddingBottom: 'var(--space-4)',
          }}
        >
          <Logo size={24} />
        </div>
        <EmptyState
          icon="mic-vocal"
          title="This call for speakers isn't open"
          description={
            detail ??
            'The organizers have not published a call for this event, or the link is out of date. Check the event website for the current one.'
          }
          action={
            <Link to="/">
              <Button>Go to StageStack</Button>
            </Link>
          }
        />
      </Card>
    </PageBody>
  )
}

/**
 * The submission window, stated in the event's timezone. The state is always
 * computed on the client from the raw timestamps.
 */
export function CfpWindowBanner({
  state,
  openAt,
  closeAt,
  zone,
  reopenedUntil,
}: {
  state: WindowState
  openAt?: number | null
  closeAt?: number | null
  zone: string
  reopenedUntil?: number | null
}) {
  // A ticking clock, not Date.now() in render: a reopen expiring mid-session
  // must flip the banner without a re-render from elsewhere.
  const now = useNow()
  if (
    reopenedUntil !== undefined &&
    reopenedUntil !== null &&
    reopenedUntil > now
  ) {
    return (
      <Callout tone="attention" title="The organizers reopened this proposal">
        You can edit and resubmit until{' '}
        <Mono>{formatDateTime(reopenedUntil, zone)}</Mono>.
      </Callout>
    )
  }

  if (state === 'before') {
    return (
      <Callout tone="info" title="Submissions have not opened yet">
        This call opens{' '}
        <Mono>
          {openAt === undefined || openAt === null
            ? 'soon'
            : formatDateTime(openAt, zone)}
        </Mono>
        .
      </Callout>
    )
  }

  if (state === 'closed') {
    return (
      <Callout tone="attention" title="Submissions are closed">
        This call closed{' '}
        <Mono>
          {closeAt === undefined || closeAt === null
            ? ''
            : formatDateTime(closeAt, zone)}
        </Mono>
        . Proposals can no longer be changed.
      </Callout>
    )
  }

  if (closeAt === undefined || closeAt === null) {
    return (
      <Callout tone="info" title="Submissions are open">
        The organizers have not announced a closing date.
      </Callout>
    )
  }

  return (
    <Callout tone="info" title="Submissions are open">
      Closes <Mono>{formatDateTime(closeAt, zone)}</Mono>.
    </Callout>
  )
}

/**
 * Route-level error boundary for the submitter screens. A mistyped or expired
 * link is the common case, so it leads with that rather than with the error.
 */
export function CfpRouteError({ error }: { error: Error }) {
  return (
    <PageBody narrow>
      <Callout
        tone="blocked"
        title="This page could not be opened"
        actions={
          <Link to="/">
            <Button>Go to StageStack</Button>
          </Link>
        }
      >
        {errorMessage(
          error,
          'The link may be wrong, or this proposal no longer exists.',
        )}
      </Callout>
    </PageBody>
  )
}

/** One-line "Saved" / "Saving…" indicator, kept identical across screens. */
export function SaveIndicator({
  label,
  tone = 'muted',
}: {
  label: string | null
  tone?: 'muted' | 'danger'
}) {
  if (label === null) return null
  return (
    <span
      style={{
        font: 'var(--type-caption)',
        color: tone === 'danger' ? 'var(--text-danger)' : 'var(--text-tertiary)',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}
