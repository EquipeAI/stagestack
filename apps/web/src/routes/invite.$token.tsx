import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Show, SignInButton } from '@clerk/tanstack-react-start'
import { useConvexAuth, useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { Badge, Button, Callout, Card, DescriptionList, Logo } from '~/ds'
import { PageBody } from '~/components/PageBody'
import { usePending } from '~/lib/usePending'
import { ROLE_LABEL } from '~/lib/roles'

export const Route = createFileRoute('/invite/$token')({
  component: InvitePage,
})

function InvitePage() {
  const { token } = Route.useParams()
  const invitation = useQuery(api.team.previewInvitation, { token })

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--surface-canvas)' }}>
      <header
        style={{
          height: 'var(--topbar-height)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 var(--page-gutter)',
          background: 'var(--surface-card)',
          borderBottom: 'var(--space-px) solid var(--border-default)',
        }}
      >
        <Link to="/" style={{ display: 'flex', alignItems: 'center' }}>
          <Logo size={18} />
        </Link>
      </header>
      <PageBody narrow>
        {invitation === undefined ? (
          <p style={{ color: 'var(--text-tertiary)' }}>Loading invitation…</p>
        ) : invitation === null ? (
          <Callout tone="blocked" title="This invitation link is not valid">
            The link may have been mistyped, or the invitation was deleted. Ask
            whoever invited you to send a new one.
          </Callout>
        ) : (
          <InvitationCard token={token} invitation={invitation} />
        )}
      </PageBody>
    </div>
  )
}

type Invitation = {
  orgName: string
  eventName: string | null
  role: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
}

function InvitationCard({
  token,
  invitation,
}: {
  token: string
  invitation: Invitation
}) {
  // The API types `role` loosely, so fall back to the raw slug.
  const roleLabel =
    invitation.role in ROLE_LABEL
      ? ROLE_LABEL[invitation.role as keyof typeof ROLE_LABEL]
      : invitation.role

  return (
    <Card
      title={
        invitation.eventName === null
          ? `Join ${invitation.orgName}`
          : `Join ${invitation.eventName}`
      }
      subtitle="You were invited to StageStack."
      actions={
        <Badge tone="neutral">{roleLabel}</Badge>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <DescriptionList
          items={[
            { term: 'Organization', value: invitation.orgName },
            { term: 'Event', value: invitation.eventName ?? 'Organization-wide' },
            {
              term: 'Role',
              value: roleLabel,
            },
          ]}
        />
        {invitation.status === 'pending' ? (
          <PendingActions token={token} />
        ) : invitation.status === 'accepted' ? (
          <Callout
            tone="success"
            title="This invitation was already accepted"
            actions={
              <Link to="/app">
                <Button variant="primary">Open StageStack</Button>
              </Link>
            }
          >
            If it was not you, ask the organizer to invite you again.
          </Callout>
        ) : invitation.status === 'revoked' ? (
          <Callout tone="blocked" title="This invitation was revoked">
            The link no longer works. Ask the organizer for a new invitation.
          </Callout>
        ) : (
          <Callout tone="attention" title="This invitation expired">
            Invitations are time-limited. Ask the organizer to send a fresh one.
          </Callout>
        )}
      </div>
    </Card>
  )
}

function PendingActions({ token }: { token: string }) {
  const { isLoading } = useConvexAuth()
  const ensure = useMutation(api.users.ensure)
  const accept = useMutation(api.team.acceptInvitation)
  const navigate = useNavigate()
  const { pending, error, run } = usePending()

  const acceptInvitation = () => {
    void run(async () => {
      // The invitation is accepted as the signed-in user, so the user row has
      // to exist first.
      await ensure({})
      const result = await accept({ token })
      if (result.eventSlug !== null) {
        await navigate({
          to: '/app/e/$eventSlug',
          params: { eventSlug: result.eventSlug },
        })
      } else {
        await navigate({
          to: '/app/org/$orgSlug',
          params: { orgSlug: result.orgSlug },
        })
      }
    })
  }

  if (isLoading) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Checking your session…</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
      <Show when="signed-out">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p style={{ color: 'var(--text-secondary)' }}>
            Sign in to accept. Use the address the invitation was sent to.
          </p>
          <div>
            <SignInButton mode="modal">
              <Button variant="primary">Sign in to accept</Button>
            </SignInButton>
          </div>
        </div>
      </Show>
      <Show when="signed-in">
        <div>
          <Button variant="primary" onClick={acceptInvitation} disabled={pending}>
            {pending ? 'Accepting…' : 'Accept invitation'}
          </Button>
        </div>
      </Show>
    </div>
  )
}
