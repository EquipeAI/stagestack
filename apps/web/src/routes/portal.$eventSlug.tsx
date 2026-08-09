import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Show, SignInButton, UserButton, useUser } from '@clerk/tanstack-react-start'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Id } from '@convex/_generated/dataModel'
import { Button, Callout, Card, DescriptionList, EmptyState } from '~/ds'
import { PageBody } from '~/components/PageBody'
import { QueryBoundary } from '~/components/QueryBoundary'
import { Mono } from '~/components/cfp/CfpChrome'
import { formatDateRange } from '~/lib/datetime'
import { errorMessage } from '~/lib/errors'
import { useProvisioning } from '~/lib/useProvisioning'
import { PortalShell, PreviewBanner } from '~/components/portal/PortalChrome'
import { PortalView } from '~/components/portal/PortalView'

// The speaker portal (M3). Direct invitations, acceptance emails and the CFP
// all deep-link here, so the page has to work for four different people at
// once: a signed-out invitee, a speaker whose email matches nothing yet, a
// speaker with sessions, and an organizer previewing someone else's view.
//
// Access is verified-email auto-claim: `portal.enter` runs once on mount and
// links every snapshot on this event carrying the signed-in address (and
// completes a pending manager handoff). Only then is `portal.context` worth
// subscribing to.

type PortalSearch = { previewAs?: string }

/** Route-level validateSearch: an unusable id is dropped, never trusted. */
function parsePortalSearch(input: Record<string, unknown>): PortalSearch {
  const raw = input.previewAs
  if (typeof raw !== 'string') return {}
  const value = raw.trim()
  if (value.length === 0 || value.length > 64) return {}
  return { previewAs: value }
}

export const Route = createFileRoute('/portal/$eventSlug')({
  component: PortalRoute,
  validateSearch: parsePortalSearch,
})

function PortalRoute() {
  const { eventSlug } = Route.useParams()
  const { previewAs } = Route.useSearch()

  return (
    <PortalShell>
      <Show when="signed-out">
        <SignedOutPortal eventSlug={eventSlug} />
      </Show>
      <Show when="signed-in">
        {previewAs === undefined ? (
          <QueryBoundary
            resetKey={eventSlug}
            title="This portal could not be loaded"
          >
            <SpeakerPortal eventSlug={eventSlug} />
          </QueryBoundary>
        ) : (
          <QueryBoundary
            resetKey={previewAs}
            title="This preview could not be loaded"
          >
            <PreviewPortal
              eventSlug={eventSlug}
              eventContactId={previewAs as Id<'eventContacts'>}
            />
          </QueryBoundary>
        )}
      </Show>
    </PortalShell>
  )
}

// ── Signed out ───────────────────────────────────────────────────────────

/**
 * Everything here is public: `cfpPublic.get` is the only query a signed-out
 * visitor may run, and it is null for an event without a published call. The
 * page still has to say something true.
 */
function SignedOutPortal({ eventSlug }: { eventSlug: string }) {
  const cfp = useQuery(api.cfpPublic.get, { eventSlug })
  const event = cfp?.event ?? null

  return (
    <PageBody narrow>
      <Card
        title={event === null ? 'Speaker portal' : `${event.name} · speaker portal`}
        subtitle="Confirm your sessions and keep your speaker profile current."
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-5)',
          }}
        >
          <p
            style={{
              font: 'var(--type-body-lg)',
              color: 'var(--text-secondary)',
              margin: 'var(--space-0)',
            }}
          >
            This is where invited speakers answer the organizers, edit the bio
            and photo that get published, and see where each of their sessions
            stands.
          </p>

          {event === null ? null : (
            <DescriptionList
              items={[
                { term: 'Event', value: event.name },
                {
                  term: 'Dates',
                  value: (
                    <Mono>
                      {formatDateRange(
                        event.startsAt,
                        event.endsAt,
                        event.timezone,
                      )}
                    </Mono>
                  ),
                },
                ...(event.location === undefined
                  ? []
                  : [{ term: 'Location', value: event.location }]),
              ]}
            />
          )}

          <Callout
            tone="info"
            title="Sign in with the email your invitation was sent to"
            actions={
              <SignInButton mode="modal">
                <Button variant="primary">Sign in</Button>
              </SignInButton>
            }
          >
            Your access is matched by email address — there is no separate
            portal password. Sign in with the address the organizers used and
            everything they have for you appears here.
          </Callout>
        </div>
      </Card>
    </PageBody>
  )
}

// ── Signed in: the speaker's own portal ──────────────────────────────────

function SpeakerPortal({ eventSlug }: { eventSlug: string }) {
  const { provisioned, error: accountError, retry } = useProvisioning()
  const enter = useMutation(api.portal.enter)
  const [entered, setEntered] = useState(false)
  const [enterError, setEnterError] = useState<string | null>(null)

  // Claim access exactly once per mount: linking snapshots and completing a
  // handoff are idempotent, but they are writes — they don't belong in a
  // subscription.
  useEffect(() => {
    if (!provisioned) return
    let cancelled = false
    enter({ eventSlug })
      .then(() => {
        if (!cancelled) setEntered(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setEnterError(errorMessage(err))
        setEntered(true)
      })
    return () => {
      cancelled = true
    }
  }, [provisioned, enter, eventSlug])

  const context = useQuery(
    api.portal.context,
    provisioned && entered ? { eventSlug } : 'skip',
  )

  if (accountError !== null) {
    return (
      <PageBody narrow>
        <Callout
          tone="blocked"
          title="Could not load your account"
          actions={
            <Button variant="primary" onClick={retry}>
              Try again
            </Button>
          }
        >
          {accountError}
        </Callout>
      </PageBody>
    )
  }

  if (context === undefined) {
    return (
      <PageBody narrow>
        <p style={{ color: 'var(--text-tertiary)' }}>Opening your portal…</p>
      </PageBody>
    )
  }

  return (
    <>
      {enterError === null ? null : (
        <PageBody narrow>
          <Callout tone="attention" title="Your access could not be refreshed">
            {enterError}
          </Callout>
        </PageBody>
      )}
      <PortalView
        eventSlug={eventSlug}
        context={context}
        readOnly={false}
        emptyState={<NothingHere />}
      />
    </>
  )
}

/** `hasAccess: false` — signed in, but this event has nothing for this address. */
function NothingHere() {
  const { user } = useUser()
  const email = user?.primaryEmailAddress?.emailAddress ?? null

  return (
    <Card>
      <EmptyState
        icon="mail"
        title="Nothing here for this email (yet)"
        description={
          email === null
            ? 'Make sure you signed in with the address the organizers used for you. Your access appears the moment the addresses match.'
            : `You are signed in as ${email}. Make sure that is the address the organizers used for you — access is matched by email, and appears here the moment it matches.`
        }
        action={<UserButton />}
      />
    </Card>
  )
}

// ── Signed in: the organizer's read-only preview ─────────────────────────

function PreviewPortal({
  eventSlug,
  eventContactId,
}: {
  eventSlug: string
  eventContactId: Id<'eventContacts'>
}) {
  const { provisioned } = useProvisioning()
  const context = useQuery(
    api.sessions.previewPortalContext,
    provisioned ? { eventSlug, eventContactId } : 'skip',
  )

  if (context === undefined) {
    return (
      <PageBody narrow>
        <p style={{ color: 'var(--text-tertiary)' }}>Loading the preview…</p>
      </PageBody>
    )
  }

  return (
    <>
      <PreviewBanner contactName={context.contactName} eventSlug={eventSlug} />
      <PortalView
        eventSlug={eventSlug}
        context={context}
        readOnly
        emptyState={
          <Card>
            <EmptyState
              icon="eye"
              title="This speaker's portal is empty"
              description="They have no sessions, no managed sessions and no proposals on this event, so signing in would show them nothing."
            />
          </Card>
        }
      />
    </>
  )
}
