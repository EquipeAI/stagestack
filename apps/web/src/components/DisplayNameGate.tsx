import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { ReactNode } from 'react'
import { Button, Callout, Card, Field, Input } from '~/ds'
import { PageBody } from '~/components/PageBody'
import { usePending } from '~/lib/usePending'

/**
 * StageStack attributes durable work to a stable authenticated user id. This
 * one-time gate collects only the human label shown beside that work; it never
 * changes the account's authorization or delivery address.
 */
export function DisplayNameGate({ children }: { children: ReactNode }) {
  const profile = useQuery(api.users.currentProfile, {})
  const setDisplayName = useMutation(api.users.setDisplayName)
  const [displayName, setDisplayNameInput] = useState('')
  const { pending, error, setError, run } = usePending()

  if (profile === undefined) {
    return (
      <PageBody narrow>
        <p
          style={{
            color: 'var(--text-tertiary)',
            textAlign: 'center',
            padding: 'var(--space-10) var(--space-0)',
          }}
        >
          Loading your profile…
        </p>
      </PageBody>
    )
  }

  if (!profile.needsDisplayName) return children

  const cleaned = displayName.trim().replace(/\s+/g, ' ')
  const disabled = pending || cleaned.length === 0

  return (
    <PageBody narrow>
      <Card
        variant="raised"
        title="Put a name to your work"
        subtitle="Comments, file uploads and content history should read like a team record, not an inbox log."
      >
        <form
          aria-label="Complete your StageStack profile"
          onSubmit={(event) => {
            event.preventDefault()
            if (cleaned.length === 0) {
              setError('Enter the name your team knows you by.')
              return
            }
            void run(() => setDisplayName({ displayName: cleaned }))
          }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
          }}
        >
          {error === null ? null : <Callout tone="blocked">{error}</Callout>}
          <Field
            required
            label="Display name"
            htmlFor="account-display-name"
            hint="Shown to collaborators beside your actions. Your sign-in email stays private."
          >
            <Input
              id="account-display-name"
              name="name"
              value={displayName}
              autoComplete="name"
              autoFocus
              placeholder="Avery Chen"
              suffix={`${displayName.length}/200`}
              disabled={pending}
              onChange={(event) => {
                setDisplayNameInput(event.target.value.slice(0, 200))
              }}
            />
          </Field>
          <div>
            <Button type="submit" variant="primary" disabled={disabled}>
              {pending ? 'Saving…' : 'Save and continue'}
            </Button>
          </div>
        </form>
      </Card>
    </PageBody>
  )
}
