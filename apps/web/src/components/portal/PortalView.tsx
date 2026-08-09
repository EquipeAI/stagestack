import { Link } from '@tanstack/react-router'
import {
  PARTICIPANT_STATE_LABEL,
  distinctProfiles,
  sessionsForProfile,
} from './model'
import { SpeakingCard } from './SpeakingCard'
import { ProfileCard } from './ProfileCard'
import { ManagedSessionCard } from './ManagedSessionCard'
import type { PortalContext } from './model'
import type * as React from 'react'
import { Card, StatusPill } from '~/ds'
import { PageBody } from '~/components/PageBody'
import { Mono } from '~/components/cfp/CfpChrome'
import { formatDateRange } from '~/lib/datetime'
import { PortalSection } from '~/components/portal/PortalChrome'
import { PROPOSAL_STATUS_LABEL } from '~/components/cfp/model'

// The whole portal, rendered from one context object. The live portal and the
// organizer's read-only preview share this component so the preview is the
// real screen, not an approximation of it.

export function PortalView({
  eventSlug,
  context,
  readOnly,
  emptyState,
}: {
  eventSlug: string
  context: PortalContext
  readOnly: boolean
  /** Shown when the viewer has nothing on this event. */
  emptyState: React.ReactNode
}) {
  const { event, speaking, managing, myProposalsSummary } = context
  const profiles = distinctProfiles(speaking)
  const awaiting = speaking.filter((item) => item.state === 'awaiting').length

  return (
    <PageBody narrow>
      <header
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
      >
        <span
          style={{
            font: 'var(--type-eyebrow)',
            letterSpacing: 'var(--tracking-caps)',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
          }}
        >
          Speaker portal
        </span>
        <h1
          style={{
            font: 'var(--type-title-2)',
            color: 'var(--text-primary)',
            margin: 'var(--space-0)',
          }}
        >
          {event.name}
        </h1>
        <span style={{ color: 'var(--text-secondary)' }}>
          <Mono>
            {formatDateRange(event.startsAt, event.endsAt, event.timezone)}
          </Mono>
          {event.location === undefined ? null : ` · ${event.location}`}
        </span>
        {awaiting > 0 ? (
          <span style={{ color: 'var(--text-secondary)' }}>
            {awaiting === 1
              ? '1 session is waiting for your answer.'
              : `${awaiting} sessions are waiting for your answer.`}
          </span>
        ) : null}
      </header>

      {context.hasAccess ? null : emptyState}

      {speaking.length > 0 ? (
        <PortalSection
          title="Your sessions"
          description="What the organizers have you down for, and what they still need from you."
          meta={`${speaking.length} session${speaking.length === 1 ? '' : 's'}`}
        >
          {speaking.map((item) => (
            <SpeakingCard
              key={item.participantId}
              eventSlug={eventSlug}
              item={item}
              readOnly={readOnly}
            />
          ))}
        </PortalSection>
      ) : null}

      {profiles.length > 0 ? (
        <PortalSection
          title={profiles.length === 1 ? 'Your profile' : 'Your profiles'}
          description="Keep this current — the organizers publish it as it stands here."
        >
          {profiles.map((profile) => (
            <ProfileCard
              key={profile._id}
              eventSlug={eventSlug}
              profile={profile}
              readOnly={readOnly}
            >
              <ProfileScope
                sessions={sessionsForProfile(speaking, profile._id)}
              />
            </ProfileCard>
          ))}
        </PortalSection>
      ) : null}

      {managing.length > 0 ? (
        <PortalSection
          title="Sessions you manage"
          description="You are the primary manager: you own this session's shared content and can answer for its speakers."
          meta={`${managing.length} session${managing.length === 1 ? '' : 's'}`}
        >
          {managing.map((item) => (
            <ManagedSessionCard
              key={item.sessionId}
              eventSlug={eventSlug}
              item={item}
              readOnly={readOnly}
            />
          ))}
        </PortalSection>
      ) : null}

      {myProposalsSummary.length > 0 ? (
        <PortalSection
          title="Your proposals for this event"
          meta={`${myProposalsSummary.length} proposal${
            myProposalsSummary.length === 1 ? '' : 's'
          }`}
        >
          {myProposalsSummary.map((proposal) => (
            <Link
              key={proposal.proposalId}
              to="/cfp/$eventSlug/proposal/$proposalId"
              params={{ eventSlug, proposalId: proposal.proposalId }}
              style={{
                textDecoration: 'none',
                color: 'inherit',
                display: 'block',
              }}
            >
              <Card
                variant="interactive"
                title={proposal.title}
                actions={
                  <StatusPill
                    status={PROPOSAL_STATUS_LABEL[proposal.status]}
                  />
                }
              >
                <span style={{ color: 'var(--text-tertiary)' }}>
                  Open the proposal you submitted to this call.
                </span>
              </Card>
            </Link>
          ))}
        </PortalSection>
      ) : null}
    </PageBody>
  )
}

/** Which sessions this snapshot is attached to — the profile's blast radius. */
function ProfileScope({
  sessions,
}: {
  sessions: PortalContext['speaking']
}) {
  if (sessions.length === 0) return null
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 'var(--space-2)',
        font: 'var(--type-caption)',
        color: 'var(--text-tertiary)',
      }}
    >
      <span>Used for</span>
      {sessions.map((item) => (
        <span
          key={item.participantId}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            color: 'var(--text-secondary)',
          }}
        >
          {item.sessionTitle}
          <StatusPill status={PARTICIPANT_STATE_LABEL[item.state]} />
        </span>
      ))}
    </div>
  )
}
