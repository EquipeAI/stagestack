import { Show, SignInButton } from '@clerk/tanstack-react-start'
import type * as React from 'react'
import { Button, Callout, Card } from '~/ds'
import { DisplayNameGate } from '~/components/DisplayNameGate'
import { PageBody } from '~/components/PageBody'
import { useProvisioning } from '~/lib/useProvisioning'

/**
 * Every authed query throws `user_not_provisioned` until `users.ensure` has
 * run, so the gate provisions first and mounts children only after it resolves.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoading, provisioned, error, retry } = useProvisioning()

  if (isLoading) return <GateStatus>Checking your session…</GateStatus>

  return (
    <>
      <Show when="signed-out">
        <SignedOutPrompt />
      </Show>
      <Show when="signed-in">
        {error !== null ? (
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
              {error}
            </Callout>
          </PageBody>
        ) : provisioned ? (
          <DisplayNameGate>{children}</DisplayNameGate>
        ) : (
          <GateStatus>Preparing your account…</GateStatus>
        )}
      </Show>
    </>
  )
}

function SignedOutPrompt() {
  return (
    <PageBody narrow>
      <Card
        title="Sign in to StageStack"
        subtitle="Your organizations, events and speaker operations live behind sign-in."
        footer={
          <SignInButton mode="modal">
            <Button variant="primary">Sign in</Button>
          </SignInButton>
        }
      >
        <p style={{ color: 'var(--text-secondary)' }}>
          StageStack uses your email to match you to any invitations already
          waiting for you.
        </p>
      </Card>
    </PageBody>
  )
}

function GateStatus({ children }: { children: React.ReactNode }) {
  return (
    <PageBody narrow>
      <p
        style={{
          color: 'var(--text-tertiary)',
          textAlign: 'center',
          padding: 'var(--space-10) var(--space-0)',
        }}
      >
        {children}
      </p>
    </PageBody>
  )
}
