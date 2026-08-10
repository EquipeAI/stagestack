import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  StatusPill,
} from '~/ds'
import { PageBody } from '~/components/PageBody'
import { EventCard, EventGrid } from '~/components/EventCard'
import { usePending } from '~/lib/usePending'
import { useHydrated } from '~/lib/useHydrated'
import { pushToast } from '~/components/toast'
import { browserTimezone, formatDateTime } from '~/lib/datetime'
import { PROPOSAL_STATUS_LABEL } from '~/components/cfp/model'
import { PARTICIPANT_STATE_LABEL } from '~/components/portal/model'

/**
 * "My StageStack" — the cross-organization home, one section per hat the user
 * wears. It lives at /app/home; /app itself opens the event you were last in,
 * because that is where an organizer spends the day (see routes/app.index).
 */
export function AppHome() {
  const home = useQuery(api.orgs.myHome, {})
  const [creating, setCreating] = useState(false)
  const hydrated = useHydrated()

  if (home === undefined) {
    return (
      <PageBody>
        <p style={{ color: 'var(--text-tertiary)' }}>Loading your StageStack…</p>
      </PageBody>
    )
  }

  const eventCount = home.reduce((n, entry) => n + entry.events.length, 0)

  return (
    <PageBody>
      <div className="home-hero">
        <header className="home-hero__head">
          <div>
            <h1 className="home-title">
              My <span className="mkt-hl">StageStack</span>
            </h1>
            <p className="home-sub">
              One account, three hats — you organize events, you submit talks,
              you speak on stage. Everything you're part of, across every
              organization, lands here.
            </p>
          </div>
          <Button
            iconLeft="plus"
            disabled={!hydrated}
            onClick={() => setCreating(true)}
          >
            New organization
          </Button>
        </header>
      </div>
      <CallLight />
      <HatSection
        verb="Organize"
        title="Your organizations"
        description="The events you run, grouped by the organization they belong to."
        count={
          home.length > 0
            ? `${home.length} organization${home.length === 1 ? '' : 's'} · ${eventCount} event${eventCount === 1 ? '' : 's'}`
            : undefined
        }
      >
        {home.length === 0 ? (
          <Onboarding />
        ) : (
          home.map((entry) => (
            <section
              key={entry.org._id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-4)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                }}
              >
                <Link
                  to="/app/org/$orgSlug"
                  params={{ orgSlug: entry.org.slug }}
                  style={{
                    font: 'var(--type-label)',
                    fontSize: 'var(--text-md)',
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
                      <Link
                        to="/app/org/$orgSlug"
                        params={{ orgSlug: entry.org.slug }}
                      >
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
          ))
        )}
      </HatSection>
      <MyProposals />
      <MySpeaking />
      {creating ? <NewOrgDialog onClose={() => setCreating(false)} /> : null}
    </PageBody>
  )
}

/**
 * The dashboard is organized by the hat the user wears, not by data type.
 * Every section opens with the same call-sheet device — a mono-caps verb
 * (ORGANIZE / SUBMIT / SPEAK) against a hairline — so the page reads as
 * "the things you can be here" instead of a pile of lists.
 */
function HatSection({
  verb,
  title,
  description,
  count,
  children,
}: {
  verb: string
  title: string
  description: string
  count?: string
  children: ReactNode
}) {
  return (
    <section className="home-hat">
      <div className="home-eyebrow">
        <span>{verb}</span>
        <span className="home-eyebrow__rule" aria-hidden="true" />
        {count !== undefined ? (
          <span className="home-eyebrow__count">{count}</span>
        ) : null}
      </div>
      <div className="home-hat__head">
        <h2
          style={{
            font: 'var(--type-heading)',
            color: 'var(--text-primary)',
            margin: 'var(--space-0)',
          }}
        >
          {title}
        </h2>
        <p
          style={{
            margin: 'var(--space-0)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-tertiary)',
          }}
        >
          {description}
        </p>
      </div>
      {children}
    </section>
  )
}

/**
 * The signature of the page: on a stage, what's lit is where you look.
 * Anything waiting on the user personally — a speaking invitation they
 * haven't answered, a draft nobody can see yet — is pulled out of the
 * lists below and put under the light at the top. It's the only surface
 * on the page allowed to wear amber.
 */
function CallLight() {
  const speaking = useQuery(api.portal.mySpeaking, {})
  const proposals = useQuery(api.cfp.myProposals, {})

  if (speaking === undefined || proposals === undefined) return null

  const invitations = speaking.filter((row) => row.state === 'awaiting')
  const drafts = proposals.filter((row) => row.proposal.status === 'draft')
  if (invitations.length === 0 && drafts.length === 0) return null

  return (
    <section className="home-call" aria-label="Needs your attention">
      <div className="home-call__head">
        <span className="home-live-dot" aria-hidden="true" />
        <span className="home-call__eyebrow">Needs your attention</span>
      </div>
      <div className="home-call__rows">
        {invitations.map((row, index) => (
          <Link
            key={`invite-${row.eventSlug}-${row.sessionTitle}-${index}`}
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
                You're invited to speak — the organizers are waiting for your
                answer.
              </span>
            </Card>
          </Link>
        ))}
        {drafts.map((row) => (
          <Link
            key={`draft-${row.proposal._id}`}
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
                <StatusPill status={PROPOSAL_STATUS_LABEL[row.proposal.status]} />
              }
            >
              <span style={{ color: 'var(--text-tertiary)' }}>
                Not submitted yet — the organizers can't see it until you send
                it.
              </span>
            </Card>
          </Link>
        ))}
      </div>
    </section>
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
    <HatSection
      verb="Submit"
      title="Your proposals"
      description="Talks you've sent to calls for papers — any event, any organization."
      count={`${proposals.length} proposal${proposals.length === 1 ? '' : 's'}`}
    >
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
    </HatSection>
  )
}

/**
 * Sessions this person is speaking at, across every event — the other half of
 * the speaker's hat. Same rule as Your proposals: it only appears when there
 * is something in it, so an organizer never sees an empty band.
 */
function MySpeaking() {
  const speaking = useQuery(api.portal.mySpeaking, {})

  if (speaking === undefined || speaking.length === 0) return null

  return (
    <HatSection
      verb="Speak"
      title="Your speaking"
      description="Sessions where you're on the lineup — the speaker portal holds the details."
      count={`${speaking.length} session${speaking.length === 1 ? '' : 's'}`}
    >
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
    </HatSection>
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
