import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Doc, Id } from '@convex/_generated/dataModel'
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  Input,
  Select,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { useLastLoaded, useNow } from '~/components/tasks/useNow'
import { copyToClipboard } from '~/lib/clipboard'
import { pushToast } from '~/components/toast'
import { formatDateTime } from '~/lib/datetime'
import { ROLE_LABEL } from '~/lib/roles'

export const Route = createFileRoute('/app/e/$eventSlug/team')({
  component: Team,
})

type Member = {
  userId: Id<'users'>
  name: string | null
  email: string | null
  imageUrl: string | null
  role: 'owner' | 'admin' | 'organizer' | 'reviewer'
  scope: 'organization' | 'event'
  eventMemberId: Id<'eventMembers'> | null
}

function Team() {
  const { eventSlug } = Route.useParams()
  const event = useQuery(api.events.get, { eventSlug })
  // Team reads take `now` (invitation expiry is time-derived); hold the last
  // result across the once-a-minute re-subscribe so the page doesn't blink.
  const now = useNow()
  const team = useLastLoaded(useQuery(api.team.listForEvent, { eventSlug, now }))
  const canManage = event?.role === 'organizer'

  if (team === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading team…</p>
  }

  const pendingInvitations = team.invitations.filter((i) => i.status === 'pending')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <Card
        title="Members"
        subtitle="Organization owners and admins can act on every event; event members are scoped to this one."
        padded={false}
      >
        <DataTable
          rowKey="userId"
          columns={[
            {
              key: 'name',
              header: 'Member',
              cell: (row: Member) => (
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                  }}
                >
                  <Avatar
                    name={row.name ?? row.email ?? 'Unknown'}
                    src={row.imageUrl ?? undefined}
                    size={24}
                  />
                  {row.name ?? '—'}
                </span>
              ),
            },
            {
              key: 'email',
              header: 'Email',
              cell: (row: Member) => row.email ?? '—',
            },
            {
              key: 'role',
              header: 'Role',
              cell: (row: Member) => (
                <Badge tone={row.scope === 'organization' ? 'info' : 'neutral'}>
                  {ROLE_LABEL[row.role]}
                </Badge>
              ),
            },
            {
              key: 'scope',
              header: 'Scope',
              cell: (row: Member) =>
                row.scope === 'organization' ? (
                  <span style={{ color: 'var(--text-tertiary)' }}>org-wide</span>
                ) : (
                  <span style={{ color: 'var(--text-tertiary)' }}>this event</span>
                ),
            },
            {
              key: 'actions',
              header: '',
              width: '4rem',
              align: 'right',
              cell: (row: Member) =>
                row.eventMemberId !== null && canManage ? (
                  <RemoveMemberButton
                    eventSlug={eventSlug}
                    member={row}
                  />
                ) : null,
            },
          ]}
          rows={team.members}
        />
      </Card>

      <Card
        title="Pending invitations"
        subtitle="Invitations expire; revoke one to make its link stop working immediately."
      >
        {pendingInvitations.length === 0 ? (
          <EmptyState
            icon="mail"
            title="No pending invitations"
            description="People you invite appear here until they accept."
          />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {pendingInvitations.map((invitation) => (
              <InvitationRow
                key={invitation._id}
                eventSlug={eventSlug}
                invitation={invitation}
                timezone={event?.event.timezone ?? 'UTC'}
                canManage={canManage === true}
              />
            ))}
          </ul>
        )}
      </Card>

      {canManage ? <InviteForm eventSlug={eventSlug} /> : null}
    </div>
  )
}

function RemoveMemberButton({
  eventSlug,
  member,
}: {
  eventSlug: string
  member: Member
}) {
  const removeMember = useMutation(api.team.removeEventMember)
  const { pending, run } = usePending()
  return (
    <IconButton
      icon="trash-2"
      label={`Remove ${member.name ?? member.email ?? 'member'}`}
      size="sm"
      disabled={pending}
      onClick={() => {
        void run(async () => {
          if (member.eventMemberId === null) return
          await removeMember({
            eventSlug,
            eventMemberId: member.eventMemberId,
          })
          pushToast('Member removed', member.name ?? member.email ?? undefined)
        })
      }}
    />
  )
}

function InvitationRow({
  eventSlug,
  invitation,
  timezone,
  canManage,
}: {
  eventSlug: string
  invitation: Doc<'invitations'>
  timezone: string
  canManage: boolean
}) {
  const revoke = useMutation(api.team.revokeInvitation)
  const { pending, error, run } = usePending()
  const [copied, setCopied] = useState(false)
  const expired = invitation.expiresAt < Date.now()

  const copyLink = () => {
    if (typeof window === 'undefined') return
    const url = `${window.location.origin}/invite/${invitation.token}`
    void copyToClipboard(url, 'Invitation link copied').then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        flexWrap: 'wrap',
        minHeight: 'var(--row-height-lg)',
        borderBottom: 'var(--space-px) solid var(--border-subtle)',
      }}
    >
      <span style={{ flex: '1 1 14rem', minWidth: 0 }}>{invitation.email}</span>
      <Badge tone="neutral">{ROLE_LABEL[invitation.role]}</Badge>
      {expired ? (
        <Badge tone="attention" dot>
          Expired
        </Badge>
      ) : (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-tertiary)',
          }}
        >
          expires {formatDateTime(invitation.expiresAt, timezone)}
        </span>
      )}
      {error !== null ? (
        <span style={{ color: 'var(--text-danger)', font: 'var(--type-caption)' }}>
          {error}
        </span>
      ) : null}
      <Button size="sm" iconLeft="copy" onClick={copyLink}>
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      {canManage ? (
        <Button
          size="sm"
          variant="danger"
          disabled={pending}
          onClick={() => {
            void run(async () => {
              await revoke({ eventSlug, invitationId: invitation._id })
              pushToast('Invitation revoked', invitation.email)
            })
          }}
        >
          {pending ? 'Revoking…' : 'Revoke'}
        </Button>
      ) : null}
    </li>
  )
}

function InviteForm({ eventSlug }: { eventSlug: string }) {
  const invite = useMutation(api.team.inviteToEvent)
  const { pending, error, setError, run } = usePending()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('organizer')

  const submit = () => {
    if (email.trim() === '') return setError('Enter the email to invite.')
    void run(async () => {
      await invite({
        eventSlug,
        email: email.trim(),
        role: role === 'reviewer' ? 'reviewer' : 'organizer',
      })
      pushToast(
        'Invitation sent',
        `${email.trim()} was invited as ${role}. The email leaves immediately.`,
        'mail',
      )
      setEmail('')
    })
  }

  return (
    <Card
      title="Invite to this event"
      subtitle="Organizers run the event; reviewers only see and score proposals."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: '1 1 16rem' }}>
            <Field label="Email" htmlFor="invite-email">
              <Input
                id="invite-email"
                type="email"
                value={email}
                placeholder="person@example.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Role" htmlFor="invite-role">
            <Select
              id="invite-role"
              value={role}
              options={[
                { value: 'organizer', label: 'Organizer' },
                { value: 'reviewer', label: 'Reviewer' },
              ]}
              onChange={(e) => setRole(e.target.value)}
            />
          </Field>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Sending…' : 'Send invitation'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
