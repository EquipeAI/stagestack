import { Link, createFileRoute } from '@tanstack/react-router'
import { Show, SignInButton, UserButton } from '@clerk/tanstack-react-start'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { Button, Callout, Card, DescriptionList, Logo } from '~/ds'
import { PageBody } from '~/components/PageBody'
import { formatDateRange } from '~/lib/datetime'
import { Mono } from '~/components/cfp/CfpChrome'

// The speaker portal placeholder. Direct-invitation emails already link here
// (convex/model/sessions.ts → portalLink), so the page has to stand on its own
// and say something true until M3 builds the real thing. The public CFP query
// is the only thing it reads — it may be null, and the page still works.

export const Route = createFileRoute('/portal/$eventSlug')({
  component: PortalPlaceholder,
})

function PortalPlaceholder() {
  const { eventSlug } = Route.useParams()
  const cfp = useQuery(api.cfpPublic.get, { eventSlug })
  const event = cfp?.event ?? null

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-canvas)',
      }}
    >
      <header
        style={{
          height: 'var(--topbar-height)',
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)',
          padding: '0 var(--page-gutter)',
          background: 'var(--surface-card)',
          borderBottom: 'var(--space-px) solid var(--border-default)',
        }}
      >
        <Link to="/" style={{ display: 'flex', alignItems: 'center' }}>
          <Logo size={18} />
        </Link>
        <div style={{ flex: 1 }} />
        <Show when="signed-in">
          <UserButton />
        </Show>
      </header>

      <main style={{ flex: 1, minHeight: 0 }}>
        <PageBody narrow>
          <Card
            title={
              event === null ? 'Speaker portal' : `${event.name} · speaker portal`
            }
            subtitle="Opening soon."
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
                The speaker portal for this event opens soon. Your invitation is
                on file — confirmations and speaker tasks will happen here.
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

              <Show when="signed-out">
                <Callout
                  tone="info"
                  title="Sign in to be ready"
                  actions={
                    <SignInButton mode="modal">
                      <Button variant="primary">Sign in</Button>
                    </SignInButton>
                  }
                >
                  Use the address your invitation was sent to. Signing in now
                  means the portal is already yours when it opens.
                </Callout>
              </Show>
              <Show when="signed-in">
                <p style={{ color: 'var(--text-tertiary)' }}>
                  You are signed in. Nothing is needed from you yet — the
                  organizers will email you when this page has something to do.
                </p>
              </Show>
            </div>
          </Card>
        </PageBody>
      </main>
    </div>
  )
}
