import { Link, createFileRoute } from '@tanstack/react-router'
import { Show, SignInButton } from '@clerk/tanstack-react-start'
import { Button, Logo } from '~/ds'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-6)',
        padding: 'var(--pad-section) var(--page-gutter)',
        textAlign: 'center',
      }}
    >
      <Logo size={28} />
      <p
        style={{
          color: 'var(--text-secondary)',
          font: 'var(--type-body-lg)',
          maxWidth: 'var(--content-max-prose)',
        }}
      >
        Open source speaker and content management for events — call for
        speakers, review, speaker operations, and the published program.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <Show when="signed-out">
          <SignInButton mode="modal">
            <Button variant="brand" size="lg">
              Sign in
            </Button>
          </SignInButton>
        </Show>
        <Show when="signed-in">
          <Link to="/app">
            <Button variant="brand" size="lg" iconRight="arrow-right">
              Open StageStack
            </Button>
          </Link>
        </Show>
      </div>
    </main>
  )
}
