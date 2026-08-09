import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { Show, SignInButton, UserButton } from '@clerk/tanstack-react-start'
import { api } from '@convex/_generated/api'
import { Badge, Button, Card, Logo } from '~/ds'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const viewer = useQuery(api.auth.viewer)
  return (
    <main
      style={{
        maxWidth: 'var(--content-max-prose)',
        margin: '0 auto',
        padding: 'var(--pad-section) var(--page-gutter)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <Logo size={24} />
      <p style={{ color: 'var(--text-secondary)' }}>
        Open source speaker &amp; content management for events.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
        <Show when="signed-out">
          <SignInButton mode="modal">
            <Button variant="primary">Sign in</Button>
          </SignInButton>
        </Show>
        <Show when="signed-in">
          <UserButton />
        </Show>
      </div>
      <Card title="Auth round-trip" subtitle="Walking skeleton">
        {viewer === undefined ? (
          <p style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
        ) : viewer === null ? (
          <p>
            Convex sees you as: <Badge tone="neutral">anonymous</Badge>
          </p>
        ) : (
          <p>
            Convex sees you as:{' '}
            <Badge tone="success" dot>
              {viewer.name ?? viewer.subject}
            </Badge>
            {viewer.email ? (
              <span style={{ color: 'var(--text-tertiary)' }}> ({viewer.email})</span>
            ) : null}
          </p>
        )}
      </Card>
    </main>
  )
}
