import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  StatusPill,
} from '~/ds'
import { PageBody } from '~/components/PageBody'
import { EventCard, EventGrid } from '~/components/EventCard'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { browserTimezone, formatDateTime } from '~/lib/datetime'
import { PROPOSAL_STATUS_LABEL } from '~/components/cfp/model'
import { PARTICIPANT_STATE_LABEL } from '~/components/portal/model'

export const Route = createFileRoute('/app/')({
  component: Home,
})

function Home() {
  const home = useQuery(api.orgs.myHome, {})
  const [creating, setCreating] = useState(false)

  if (home === undefined) {
    return (
      <PageBody>
        <p style={{ color: 'var(--text-tertiary)' }}>Loading your organizations…</p>
      </PageBody>
    )
  }

  if (home.length === 0) {
    return (
      <PageBody narrow>
        <Onboarding />
        <MyProposals />
        <MySpeaking />
      </PageBody>
    )
  }

  return (
    <PageBody>
      <PageHeader
        title="My StageStack"
        description="Organizations you belong to, and the events you can work on."
        actions={
          <Button iconLeft="plus" onClick={() => setCreating(true)}>
            New organization
          </Button>
        }
      />
      {home.map((entry) => (
        <section
          key={entry.org._id}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
        >
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
          >
            <Link
              to="/app/org/$orgSlug"
              params={{ orgSlug: entry.org.slug }}
              style={{
                font: 'var(--type-heading)',
                color: 'var(--text-primary)',
              }}
            >
              {entry.org.name}
            </Link>
            {entry.role !== null ? (
              <Badge tone="neutral">
                {entry.role === 'owner' ? 'Owner' : 'Admin'}
              </Badge>
            ) : null}
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                color: 'var(--text-tertiary)',
              }}
            >
              {entry.events.length} event{entry.events.length === 1 ? '' : 's'}
            </span>
          </div>
          {entry.events.length === 0 ? (
            <Card>
              <EmptyState
                icon="calendar-days"
                title="No events yet"
                description="Events you create appear here, with their CFP and team."
                action={
                  <Link to="/app/org/$orgSlug" params={{ orgSlug: entry.org.slug }}>
                    <Button variant="primary">Open organization</Button>
                  </Link>
                }
              />
            </Card>
          ) : (
            <EventGrid>
              {entry.events.map((event) => (
                <EventCard key={event._id} event={event} />
              ))}
            </EventGrid>
          )}
        </section>
      ))}
      <MyProposals />
      <MySpeaking />
      {creating ? <NewOrgDialog onClose={() => setCreating(false)} /> : null}
    </PageBody>
  )
}

/**
 * Proposals this person submitted as a speaker — a different hat from the
 * organizations above, so it gets its own section and only appears when there
 * is something in it.
 */
function MyProposals() {
  const proposals = useQuery(api.cfp.myProposals, {})
  const zone = browserTimezone()

  if (proposals === undefined || proposals.length === 0) return null

  return (
    <section
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <h2
          style={{
            font: 'var(--type-heading)',
            color: 'var(--text-primary)',
            margin: 'var(--space-0)',
          }}
        >
          My proposals
        </h2>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-tertiary)',
          }}
        >
          {proposals.length} proposal{proposals.length === 1 ? '' : 's'}
        </span>
      </div>
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
      >
        {proposals.map((row) => (
          <Link
            key={row.proposal._id}
            to="/cfp/$eventSlug/proposal/$proposalId"
            params={{
              eventSlug: row.eventSlug,
              proposalId: row.proposal._id,
            }}
            style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
          >
            <Card
              variant="interactive"
              title={row.proposal.title}
              subtitle={row.eventName}
              actions={
                <StatusPill
                  status={PROPOSAL_STATUS_LABEL[row.proposal.status]}
                />
              }
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-tertiary)',
                }}
              >
                Updated {formatDateTime(row.proposal.updatedAt, zone)}
              </span>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  )
}

/**
 * Sessions this person is speaking at, across every event — the other half of
 * the speaker's hat. Same rule as My proposals: it only appears when there is
 * something in it, so an organizer never sees an empty band.
 */
function MySpeaking() {
  const speaking = useQuery(api.portal.mySpeaking, {})

  if (speaking === undefined || speaking.length === 0) return null

  return (
    <section
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <h2
          style={{
            font: 'var(--type-heading)',
            color: 'var(--text-primary)',
            margin: 'var(--space-0)',
          }}
        >
          Speaking
        </h2>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-tertiary)',
          }}
        >
          {speaking.length} session{speaking.length === 1 ? '' : 's'}
        </span>
      </div>
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
      >
        {speaking.map((row, index) => (
          <Link
            key={`${row.eventSlug}-${row.sessionTitle}-${index}`}
            to="/portal/$eventSlug"
            params={{ eventSlug: row.eventSlug }}
            style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
          >
            <Card
              variant="interactive"
              title={row.sessionTitle}
              subtitle={row.eventName}
              actions={
                <StatusPill status={PARTICIPANT_STATE_LABEL[row.state]} />
              }
            >
              <span style={{ color: 'var(--text-tertiary)' }}>
                {row.state === 'awaiting'
                  ? 'The organizers are waiting for your answer — open your speaker portal.'
                  : 'Open your speaker portal to update your profile or answer.'}
              </span>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  )
}

function useCreateOrg() {
  const createOrg = useMutation(api.orgs.create)
  const navigate = useNavigate()
  const { pending, error, run } = usePending()

  const submit = (name: string) =>
    run(async () => {
      const { slug } = await createOrg({ name: name.trim() })
      pushToast('Organization created', name.trim())
      await navigate({ to: '/app/org/$orgSlug', params: { orgSlug: slug } })
    })

  return { pending, error, submit }
}

function Onboarding() {
  const [name, setName] = useState('')
  const { pending, error, submit } = useCreateOrg()
  const disabled = pending || name.trim().length === 0

  return (
    <Card
      title="Create your organization"
      subtitle="An organization holds your events, your speaker directory and your team."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!disabled) void submit(name)
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        <Field
          label="Organization name"
          htmlFor="org-name"
          hint="Shown to speakers on your CFP and public pages."
          error={error ?? undefined}
        >
          <Input
            id="org-name"
            value={name}
            autoFocus
            placeholder="AI Engineer"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div>
          <Button variant="primary" type="submit" disabled={disabled}>
            {pending ? 'Creating…' : 'Create organization'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function NewOrgDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const { pending, error, submit } = useCreateOrg()
  const disabled = pending || name.trim().length === 0

  return (
    <Dialog
      open
      title="New organization"
      description="You become its owner. You can invite admins afterwards."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() => {
              void submit(name).then((ok) => {
                if (ok) onClose()
              })
            }}
          >
            {pending ? 'Creating…' : 'Create organization'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        <Field label="Organization name" htmlFor="new-org-name">
          <Input
            id="new-org-name"
            value={name}
            autoFocus
            placeholder="AI Engineer"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  )
}
