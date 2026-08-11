import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { useUser } from '@clerk/tanstack-react-start'
import { api } from '@convex/_generated/api'
import { allFields } from '@convex/shared/formDef'
import type * as React from 'react'
import { Button, Card, Icon, StatusPill } from '~/ds'
import { PROPOSAL_STATUS_LABEL } from '~/components/cfp/model'
import { PageBody } from '~/components/PageBody'
import { formatDateRange, formatDateTime } from '~/lib/datetime'
import {
  CfpNotOpen,
  CfpRouteError,
  CfpWindowBanner,
  Mono,
  useNow,
} from '~/components/cfp/CfpChrome'
import { cfpWindowState } from '~/components/cfp/model'

// The public landing page for a call for speakers. Unauthenticated, fast, and
// the only page most submitters will ever link to.

export const Route = createFileRoute('/cfp/$eventSlug/')({
  component: CfpLanding,
  errorComponent: CfpRouteError,
})

function CfpLanding() {
  const { eventSlug } = Route.useParams()
  const cfp = useQuery(api.cfpPublic.get, { eventSlug })
  const now = useNow()
  // Signed-in submitters get their proposals for THIS event right on the
  // landing page — the one URL they were given (eval: "no unified submitter
  // dashboard was found"; /app/home has the cross-event list).
  const { isSignedIn } = useUser()
  const mine = useQuery(api.cfp.myProposals, isSignedIn === true ? {} : 'skip')
  const myRows = (mine ?? []).filter((row) => row.eventSlug === eventSlug)

  if (cfp === undefined) {
    return (
      <PageBody narrow>
        <p style={{ color: 'var(--text-tertiary)' }}>Loading the call…</p>
      </PageBody>
    )
  }
  if (cfp === null) return <CfpNotOpen />

  const { event } = cfp
  const zone = event.timezone
  const state = cfpWindowState({
    openAt: cfp.cfpOpenAt,
    closeAt: cfp.cfpCloseAt,
    now,
  })
  const sections = cfp.form.sections
  const questionCount = allFields(cfp.form).length

  return (
    <PageBody narrow>
      <header
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        <span
          style={{
            font: 'var(--type-eyebrow)',
            letterSpacing: 'var(--tracking-caps)',
            textTransform: 'uppercase',
            color: 'var(--text-brand)',
          }}
        >
          Call for speakers
        </span>
        <h1
          style={{
            font: 'var(--type-title-1)',
            letterSpacing: 'var(--tracking-tight)',
            color: 'var(--text-primary)',
            margin: 'var(--space-0)',
          }}
        >
          {event.name}
        </h1>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-2) var(--space-5)',
            color: 'var(--text-secondary)',
          }}
        >
          <Detail icon="calendar-days">
            <Mono>{formatDateRange(event.startsAt, event.endsAt, zone)}</Mono>
          </Detail>
          {event.location !== undefined ? (
            <Detail icon="map-pin">{event.location}</Detail>
          ) : null}
          <Detail icon="clock">
            <Mono>{zone}</Mono>
          </Detail>
        </div>
      </header>

      <CfpWindowBanner
        state={state}
        openAt={cfp.cfpOpenAt}
        closeAt={cfp.cfpCloseAt}
        zone={zone}
      />

      {event.description !== undefined ? (
        <p
          style={{
            font: 'var(--type-body-lg)',
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            margin: 'var(--space-0)',
          }}
        >
          {event.description}
        </p>
      ) : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        {state === 'open' ? (
          <Link to="/cfp/$eventSlug/submit" params={{ eventSlug }}>
            <Button variant="brand" size="lg" iconRight="arrow-right">
              Submit a proposal
            </Button>
          </Link>
        ) : (
          <Button variant="brand" size="lg" disabled>
            Submit a proposal
          </Button>
        )}
        {event.website !== undefined ? (
          <a href={event.website} target="_blank" rel="noreferrer">
            <Button variant="ghost" size="lg" iconRight="external-link">
              Event website
            </Button>
          </a>
        ) : null}
      </div>

      {myRows.length > 0 ? (
        <Card
          title="Your proposals"
          subtitle="Everything you have submitted or drafted for this event."
        >
          <ul
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              margin: 'var(--space-0)',
              padding: 'var(--space-0)',
              listStyle: 'none',
            }}
          >
            {myRows.map(({ proposal }) => (
              <li
                key={proposal._id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--space-3)',
                  flexWrap: 'wrap',
                }}
              >
                <Link
                  to="/cfp/$eventSlug/proposal/$proposalId"
                  params={{ eventSlug, proposalId: proposal._id }}
                  style={{ color: 'var(--text-primary)' }}
                >
                  {proposal.title === '' ? '(untitled draft)' : proposal.title}
                </Link>
                <StatusPill status={PROPOSAL_STATUS_LABEL[proposal.status]} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card
        title="What the form asks"
        subtitle={`${sections.length} section${sections.length === 1 ? '' : 's'} · ${questionCount} question${questionCount === 1 ? '' : 's'}. You can save a draft and come back${
          cfp.cfpCloseAt === undefined
            ? '.'
            : ` until ${formatDateTime(cfp.cfpCloseAt, zone)}.`
        }`}
      >
        <ol
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
            margin: 'var(--space-0)',
            padding: 'var(--space-0)',
            listStyle: 'none',
          }}
        >
          {sections.map((section, index) => (
            <li
              key={section.id}
              style={{
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'baseline',
              }}
            >
              <span
                style={{
                  font: 'var(--type-mono)',
                  color: 'var(--text-tertiary)',
                  minWidth: 'var(--space-5)',
                }}
              >
                {String(index + 1).padStart(2, '0')}
              </span>
              <span
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-1)',
                }}
              >
                <span style={{ color: 'var(--text-primary)' }}>
                  {section.title}
                </span>
                {section.description !== undefined ? (
                  <span
                    style={{
                      font: 'var(--type-caption)',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    {section.description}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </Card>

      <p
        style={{
          font: 'var(--type-caption)',
          color: 'var(--text-tertiary)',
          margin: 'var(--space-0)',
        }}
      >
        You will be asked to create a StageStack account before you submit, so
        you can edit your proposal until the call closes.
      </p>
    </PageBody>
  )
}

function Detail({
  icon,
  children,
}: {
  icon: string
  children: React.ReactNode
}) {
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}
    >
      <Icon name={icon} size={16} />
      {children}
    </span>
  )
}
