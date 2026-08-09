import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { PARTICIPANT_STATE_LABEL, personName } from './model'
import type * as React from 'react'
import type { SpeakingItem } from './model'
import { Button, Callout, Card, DescriptionList, Dialog, StatusPill } from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { browserTimezone, formatDateRange } from '~/lib/datetime'
import {
  ActionError,
  ButtonRow,
  PreviewLock,
} from '~/components/portal/PortalChrome'

const ACK_LABEL: Record<'awaitingAck' | 'acknowledged' | 'conflict', string> = {
  awaitingAck: 'Awaiting Acknowledgement',
  acknowledged: 'Acknowledged',
  conflict: 'Conflict',
}

// One participation: what the organizers asked this speaker for, what state it
// is in, and the two answers that resolve it. This card is the reason the
// portal exists — status first, action second, consequence stated before the
// irreversible one.

export function SpeakingCard({
  eventSlug,
  item,
  readOnly,
  timezone,
}: {
  eventSlug: string
  item: SpeakingItem
  readOnly: boolean
  /** Event timezone — the slot is shown in it and, if different, viewer local. */
  timezone: string
}) {
  const confirm = useMutation(api.portal.confirmParticipation)
  const withdraw = useMutation(api.portal.withdrawParticipation)
  const acknowledge = useMutation(api.portal.acknowledgeSlot)
  const { pending, error, run } = usePending()
  const [intent, setIntent] = useState<'confirmed' | 'declined' | null>(null)
  const [withdrawing, setWithdrawing] = useState(false)

  const ackSlot = (response: 'acknowledged' | 'conflict') => {
    void run(async () => {
      await acknowledge({ eventSlug, participantId: item.participantId, response })
      pushToast(
        response === 'acknowledged' ? 'Schedule acknowledged' : 'Conflict flagged',
        response === 'acknowledged'
          ? `You acknowledged your slot for "${item.sessionTitle}".`
          : `The organizers were told your slot for "${item.sessionTitle}" clashes. Your participation is unchanged.`,
        response === 'acknowledged' ? 'circle-check' : 'triangle-alert',
      )
    })
  }

  const decide = (to: 'confirmed' | 'declined') => {
    void run(async () => {
      await confirm({ eventSlug, participantId: item.participantId, to })
      setIntent(null)
      pushToast(
        to === 'confirmed' ? 'Participation confirmed' : 'Participation declined',
        to === 'confirmed'
          ? `You are confirmed for "${item.sessionTitle}". The organizers can now publish your profile for this event.`
          : `The organizers were told you cannot speak at "${item.sessionTitle}".`,
        to === 'confirmed' ? 'circle-check' : 'circle-alert',
      )
    })
  }

  const submitWithdrawal = () => {
    void run(async () => {
      await withdraw({ eventSlug, participantId: item.participantId })
      setWithdrawing(false)
      pushToast(
        'Withdrawn',
        `The organizers were alerted that you withdrew from "${item.sessionTitle}".`,
        'circle-alert',
      )
    })
  }

  const disabled = readOnly || pending
  const actionable = item.state !== 'withdrawn'

  return (
    <Card
      title={item.sessionTitle}
      subtitle={item.format}
      actions={<StatusPill status={PARTICIPANT_STATE_LABEL[item.state]} size="lg" />}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <p
          style={{
            font: 'var(--type-body)',
            color:
              item.sessionDescription === undefined
                ? 'var(--text-tertiary)'
                : 'var(--text-secondary)',
            margin: 'var(--space-0)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {item.sessionDescription ??
            'The organizers have not written a description for this session yet.'}
        </p>

        <ActionError error={error} />

        {item.releasedSlot !== undefined ? (
          <ScheduleSection
            item={item}
            timezone={timezone}
            readOnly={readOnly}
            pending={pending}
            onAck={ackSlot}
          />
        ) : null}

        {item.state === 'awaiting' ? (
          <Callout tone="info" title="The organizers are waiting for your answer">
            Confirming makes the profile below eligible for this event&rsquo;s
            published program. Declining tells the organizers to find someone
            else for this slot — you keep access to this page either way.
          </Callout>
        ) : null}

        {item.state === 'withdrawn' ? (
          <Callout tone="neutral" title="You withdrew from this session">
            The organizers were alerted. The session is still planned, and only
            your own participation changed. Ask the organizers if you need this
            reversed.
          </Callout>
        ) : null}

        <ButtonRow>
          {item.state !== 'confirmed' && actionable ? (
            <MaybeLocked locked={readOnly}>
              <Button
                variant="primary"
                iconLeft="circle-check"
                disabled={disabled}
                onClick={() => {
                  setIntent('confirmed')
                }}
              >
                Confirm you will speak
              </Button>
            </MaybeLocked>
          ) : null}

          {item.state !== 'declined' && actionable ? (
            <MaybeLocked locked={readOnly}>
              <Button
                disabled={disabled}
                onClick={() => {
                  setIntent('declined')
                }}
              >
                {item.state === 'confirmed' ? 'I can no longer speak' : 'Decline'}
              </Button>
            </MaybeLocked>
          ) : null}

          {actionable ? (
            <MaybeLocked locked={readOnly}>
              <Button
                variant="ghost"
                iconLeft="triangle-alert"
                disabled={disabled}
                onClick={() => {
                  setWithdrawing(true)
                }}
              >
                Withdraw from this session
              </Button>
            </MaybeLocked>
          ) : null}
        </ButtonRow>
      </div>

      {intent !== null ? (
        <DecisionDialog
          intent={intent}
          item={item}
          pending={pending}
          error={error}
          onClose={() => {
            setIntent(null)
          }}
          onConfirm={() => {
            decide(intent)
          }}
        />
      ) : null}

      {withdrawing ? (
        <Dialog
          open
          width={480}
          title="Withdraw from this session?"
          description={`The organizers are emailed immediately that you have withdrawn from "${item.sessionTitle}". You cannot undo this here.`}
          onClose={
            pending
              ? undefined
              : () => {
                  setWithdrawing(false)
                }
          }
          footer={
            <>
              <Button
                disabled={pending}
                onClick={() => {
                  setWithdrawing(false)
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={pending}
                onClick={submitWithdrawal}
              >
                {pending ? 'Withdrawing…' : 'Withdraw from this session'}
              </Button>
            </>
          }
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
            }}
          >
            <ActionError error={error} />
            <p style={{ color: 'var(--text-secondary)', margin: 'var(--space-0)' }}>
              The session stays in the program with its other speakers, or as a
              speaker to be announced. Your name and profile are suppressed from
              public output for it, and the organizers pick up the slot.
            </p>
          </div>
        </Dialog>
      ) : null}
    </Card>
  )
}

function MaybeLocked({
  locked,
  children,
}: {
  locked: boolean
  children: React.ReactNode
}) {
  if (!locked) return <>{children}</>
  return <PreviewLock>{children}</PreviewLock>
}

/**
 * The released slot as the speaker sees it (M6). Event time is authoritative
 * and labelled; the viewer's local time is a muted secondary line only when it
 * differs. A slot is acknowledged or flagged here — flagging never declines.
 */
function ScheduleSection({
  item,
  timezone,
  readOnly,
  pending,
  onAck,
}: {
  item: SpeakingItem
  timezone: string
  readOnly: boolean
  pending: boolean
  onAck: (response: 'acknowledged' | 'conflict') => void
}) {
  const slot = item.releasedSlot
  if (slot === undefined) return null
  const localZone = browserTimezone()
  const showLocal = localZone !== timezone

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-4)',
        borderRadius: 'var(--radius-md)',
        border: 'var(--space-px) solid var(--border-default)',
        background: 'var(--surface-canvas)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}>
          Your slot
        </span>
        {item.ack === undefined ? null : (
          <StatusPill status={ACK_LABEL[item.ack]} />
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-half)' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text-primary)',
          }}
        >
          {formatDateRange(slot.startsAt, slot.endsAt, timezone)} ({timezone})
        </span>
        {showLocal ? (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--text-tertiary)',
            }}
          >
            {formatDateRange(slot.startsAt, slot.endsAt, localZone)} (your time,{' '}
            {localZone})
          </span>
        ) : null}
        {slot.roomName === undefined ? null : (
          <span style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>
            {slot.roomName}
          </span>
        )}
      </div>

      {item.backstageUrl === undefined ? null : (
        <a
          href={item.backstageUrl}
          target="_blank"
          rel="noreferrer"
          style={{
            font: 'var(--type-body)',
            color: 'var(--text-link)',
            wordBreak: 'break-all',
          }}
        >
          Backstage link
        </a>
      )}

      {item.ack === 'awaitingAck' ? (
        <ButtonRow>
          <MaybeLocked locked={readOnly}>
            <Button
              variant="primary"
              iconLeft="circle-check"
              disabled={readOnly || pending}
              onClick={() => {
                onAck('acknowledged')
              }}
            >
              Acknowledge schedule
            </Button>
          </MaybeLocked>
          <MaybeLocked locked={readOnly}>
            <Button
              iconLeft="triangle-alert"
              disabled={readOnly || pending}
              onClick={() => {
                onAck('conflict')
              }}
            >
              Flag a conflict
            </Button>
          </MaybeLocked>
        </ButtonRow>
      ) : null}

      {item.ack === 'conflict' ? (
        <Callout tone="attention" title="You flagged a conflict">
          The organizers were told this slot clashes for you. Your participation
          is unchanged — they will reschedule or reach out.
        </Callout>
      ) : null}
    </div>
  )
}

/**
 * Confirming previews the exact fields the organizers may publish for this
 * event — the speaker sees what they are agreeing to before the button, not
 * after (MILESTONES M3).
 */
function DecisionDialog({
  intent,
  item,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  intent: 'confirmed' | 'declined'
  item: SpeakingItem
  pending: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}) {
  const profile = item.eventContact
  const links = profile.links ?? {}
  const linkList = [
    links.website,
    links.twitter,
    links.linkedin,
    links.github,
  ].filter((value): value is string => value !== undefined && value.length > 0)

  const confirming = intent === 'confirmed'

  return (
    <Dialog
      open
      width={640}
      title={confirming ? 'Confirm you will speak?' : 'Decline this session?'}
      description={
        confirming
          ? `The organizers of this event may publish these fields for "${item.sessionTitle}".`
          : `The organizers are told you cannot speak at "${item.sessionTitle}". You can change your answer here until they close the program.`
      }
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={confirming ? 'primary' : 'secondary'}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending
              ? 'Saving…'
              : confirming
                ? 'Confirm you will speak'
                : 'Decline this session'}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <ActionError error={error} />
        {confirming ? (
          <DescriptionList
            stacked
            items={[
              { term: 'Name', value: personName(profile) || '—' },
              { term: 'Tagline', value: profile.tagline ?? '—' },
              {
                term: 'Bio',
                value: (
                  <span style={{ whiteSpace: 'pre-wrap' }}>
                    {profile.bio ?? '—'}
                  </span>
                ),
              },
              {
                term: 'Headshot',
                value:
                  profile.headshotUrl === null
                    ? 'None — initials are used'
                    : 'Provided',
              },
              {
                term: 'Links',
                value: linkList.length === 0 ? '—' : linkList.join(' · '),
              },
              { term: 'Session', value: item.sessionTitle },
            ]}
          />
        ) : null}
        <p style={{ color: 'var(--text-secondary)', margin: 'var(--space-0)' }}>
          {confirming
            ? 'Anything above that is wrong can be edited on this page — the organizers see your edits immediately.'
            : 'Nothing is published for you on this session while it is Declined.'}
        </p>
      </div>
    </Dialog>
  )
}
