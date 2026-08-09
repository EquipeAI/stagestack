import { useEffect, useState } from 'react'
import { Show, SignInButton } from '@clerk/tanstack-react-start'
import { useConvexAuth, useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import type * as React from 'react'
import { Button, Callout, Card } from '~/ds'
import { errorMessage } from '~/lib/errors'

/**
 * Every authed query throws `user_not_provisioned` until `users.ensure` has
 * run, so the gate provisions first and mounts children only after it resolves.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const ensure = useMutation(api.users.ensure)
  const [provisioned, setProvisioned] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isAuthenticated) {
      setProvisioned(false)
      return
    }
    let cancelled = false
    ensure({})
      .then(() => {
        if (!cancelled) setProvisioned(true)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, ensure])

  if (isLoading) return <GateStatus>Checking your session…</GateStatus>

  return (
    <>
      <Show when="signed-out">
        <SignedOutPrompt />
      </Show>
      <Show when="signed-in">
        {error !== null ? (
          <GateShell>
            <Callout tone="blocked" title="Could not load your account">
              {error}
            </Callout>
          </GateShell>
        ) : provisioned ? (
          children
        ) : (
          <GateStatus>Preparing your account…</GateStatus>
        )}
      </Show>
    </>
  )
}

function SignedOutPrompt() {
  return (
    <GateShell>
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
    </GateShell>
  )
}

function GateStatus({ children }: { children: React.ReactNode }) {
  return (
    <GateShell>
      <p
        style={{
          color: 'var(--text-tertiary)',
          textAlign: 'center',
          padding: 'var(--space-10) var(--space-0)',
        }}
      >
        {children}
      </p>
    </GateShell>
  )
}

function GateShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        maxWidth: 'var(--content-max-prose)',
        margin: '0 auto',
        padding: 'var(--pad-section) var(--page-gutter)',
      }}
    >
      {children}
    </div>
  )
}
