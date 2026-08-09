import { useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import {
  AUDIENCE_META,
  AUDIENCE_ORDER,
  ONE_OFF_VARS,
  renderDraftSubject,
  sampleVars,
  variablesIn,
} from './model'
import { ContactSelect, useEventContacts } from './ContactSelect'
import { VariableChip } from './primitives'
import type * as React from 'react'
import type { Id } from '@convex/_generated/dataModel'
import type { AudienceKind } from './model'
import {
  Button,
  Callout,
  Card,
  Dialog,
  Field,
  Input,
  RadioGroup,
  Select,
  Textarea,
} from '~/ds'
import { useLastLoaded, useNow } from '~/components/tasks/useNow'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'

// A one-off operational send. Not a newsletter: every audience here is derived
// from event state, there is no list to import, and the confirm states the
// count before anything leaves the building.

/** convex/model/audiences.ts — one send never fans out past this. */
const MAX_AUDIENCE = 200

type Mode = 'contact' | 'audience'

export function SendPanel({
  eventSlug,
  eventName,
}: {
  eventSlug: string
  eventName: string
}) {
  const now = useNow()
  const send = useMutation(api.comms.sendOneOff)
  const contacts = useEventContacts(eventSlug)
  const audiences = useLastLoaded(
    useQuery(api.comms.listAudiences, { eventSlug, now }),
  )
  const { pending, error, setError, run } = usePending()

  const [mode, setMode] = useState<Mode>('contact')
  const [contactId, setContactId] = useState<Id<'eventContacts'> | ''>('')
  const [audience, setAudience] = useState<AudienceKind>('allSpeakers')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [confirming, setConfirming] = useState(false)

  const audienceRow = audiences?.find((row) => row.kind === audience)
  const recipientCount =
    mode === 'contact' ? (contactId === '' ? 0 : 1) : (audienceRow?.count ?? 0)

  const vars = useMemo(() => sampleVars(eventName), [eventName])
  // A one-off send builds its own tiny variable bag, so anything outside it —
  // even a name a template would resolve — comes out empty here.
  const unknown = useMemo(
    () =>
      [...variablesIn(subject), ...variablesIn(message)].filter(
        (path) => !ONE_OFF_VARS.includes(path),
      ),
    [subject, message],
  )

  const blocked = (() => {
    if (mode === 'contact' && contactId === '') return 'Choose a recipient.'
    if (mode === 'audience' && audiences === undefined) {
      return 'Counting the audience…'
    }
    if (recipientCount === 0) {
      return 'Nobody in this audience has a reachable email address.'
    }
    if (recipientCount > MAX_AUDIENCE) {
      return `A single send reaches at most ${MAX_AUDIENCE} recipients.`
    }
    if (subject.trim() === '') return 'Write a subject.'
    if (message.trim() === '') return 'Write a message.'
    return null
  })()

  const contactName =
    contacts?.find((c) => c.eventContactId === contactId)?.name ?? 'this speaker'

  const submit = () => {
    if (mode === 'contact' && contactId === '') return
    const to =
      mode === 'contact' && contactId !== ''
        ? ({ kind: 'contact', eventContactId: contactId } as const)
        : ({ kind: 'audience', audience } as const)
    void run(async () => {
      const result = await send({
        eventSlug,
        to,
        subject: subject.trim(),
        html: message.trim(),
        now: Date.now(),
      })
      setConfirming(false)
      setSubject('')
      setMessage('')
      pushToast(
        `${result.sent} ${result.sent === 1 ? 'email' : 'emails'} sent`,
        result.skipped === 0
          ? 'Recorded in the comms log for every recipient.'
          : `${result.skipped} skipped — no reachable address. Recorded in the comms log for the rest.`,
      )
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <Card
        title="Recipients"
        subtitle="Audiences are derived from event state — StageStack has no imported lists."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <RadioGroup
            name="send-mode"
            row
            value={mode}
            options={[
              { value: 'contact', label: 'One contact' },
              { value: 'audience', label: 'Audience' },
            ]}
            onChange={(value) => {
              setMode(value === 'audience' ? 'audience' : 'contact')
              setError(null)
            }}
          />

          {mode === 'contact' ? (
            contacts === undefined ? (
              <p style={{ color: 'var(--text-tertiary)' }}>Loading speakers…</p>
            ) : contacts.length === 0 ? (
              <Callout tone="neutral" title="No speakers yet">
                Speakers appear here once a session has participants. Until
                then there is nobody to write to.
              </Callout>
            ) : (
              <Field
                label="Speaker"
                htmlFor="send-contact"
                hint="Sends to the address StageStack holds for them."
              >
                <ContactSelect
                  id="send-contact"
                  contacts={contacts}
                  value={contactId}
                  disabled={pending}
                  onChange={(value) => {
                    setContactId(value as Id<'eventContacts'>)
                  }}
                />
              </Field>
            )
          ) : (
            <Field
              label="Audience"
              htmlFor="send-audience"
              hint={AUDIENCE_META[audience].description}
            >
              <Select
                id="send-audience"
                value={audience}
                disabled={pending}
                options={AUDIENCE_ORDER.map((kind) => {
                  const row = audiences?.find((a) => a.kind === kind)
                  return {
                    value: kind,
                    label:
                      row === undefined
                        ? AUDIENCE_META[kind].label
                        : `${AUDIENCE_META[kind].label} — ${row.count}`,
                  }
                })}
                onChange={(e) => {
                  setAudience(e.target.value as AudienceKind)
                }}
              />
            </Field>
          )}

          {mode === 'audience' &&
          audienceRow !== undefined &&
          audienceRow.skipped > 0 ? (
            <Callout tone="attention" title={`${audienceRow.skipped} skipped`}>
              {audienceRow.skipped === 1 ? 'One speaker' : 'These speakers'} in
              this audience {audienceRow.skipped === 1 ? 'has' : 'have'} no
              reachable address — neither their own nor a primary
              manager&rsquo;s. They are not counted below and will not receive
              this.
            </Callout>
          ) : null}
        </div>
      </Card>

      <Card
        title="Message"
        subtitle="Substituted per recipient, so one send reads as a personal one."
        footer={
          <div style={footerRow}>
            <span
              style={{
                font: 'var(--type-caption)',
                color:
                  blocked === null ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                marginRight: 'auto',
              }}
            >
              {blocked ??
                `Sends ${recipientCount} ${recipientCount === 1 ? 'email' : 'emails'}.`}
            </span>
            {error === null ? null : (
              <span
                style={{ font: 'var(--type-caption)', color: 'var(--text-danger)' }}
              >
                {error}
              </span>
            )}
            <Button
              variant="primary"
              iconLeft="mail"
              disabled={pending || blocked !== null}
              onClick={() => {
                setConfirming(true)
              }}
            >
              Send message
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Field label="Subject" htmlFor="send-subject" required>
            <Input
              id="send-subject"
              value={subject}
              disabled={pending}
              placeholder="A change to the Thursday schedule"
              onChange={(e) => {
                setSubject(e.target.value)
              }}
            />
          </Field>

          <Field
            label="Message"
            htmlFor="send-body"
            required
            hint="HTML. StageStack wraps it in the branded shell — write paragraphs as <p>…</p>."
          >
            <Textarea
              id="send-body"
              rows={10}
              value={message}
              disabled={pending}
              placeholder="<p>Hi {{speaker.firstName}},</p>"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
              }}
              onChange={(e) => {
                setMessage(e.target.value)
              }}
            />
          </Field>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <span
              style={{ font: 'var(--type-label)', color: 'var(--text-secondary)' }}
            >
              Variables
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              {ONE_OFF_VARS.map((path) => (
                <VariableChip key={path} path={path} />
              ))}
            </div>
            <p style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
              These are resolved per recipient. A one-off send knows nothing
              about a proposal or a task, so only these names have values here —
              anything else renders as nothing.
            </p>
          </div>

          {unknown.length === 0 ? null : (
            <Callout tone="attention" title="These render as empty">
              {unknown.map((path) => `{{${path}}}`).join(', ')}
            </Callout>
          )}

          {subject.trim() === '' ? null : (
            <div style={previewLine}>
              <span
                style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}
              >
                Subject, as Ada Lovelace would see it
              </span>
              <span style={{ font: 'var(--type-label)' }}>
                {renderDraftSubject(subject, vars)}
              </span>
            </div>
          )}
        </div>
      </Card>

      {confirming ? (
        <Dialog
          open
          width={480}
          title="Send this message?"
          description={
            mode === 'contact'
              ? `Sends 1 email to ${contactName} now, and it is recorded in the comms log.`
              : `Sends ${recipientCount} ${recipientCount === 1 ? 'email' : 'emails'} to ${AUDIENCE_META[audience].label.toLowerCase()} now — they are recorded in the comms log.`
          }
          onClose={
            pending
              ? undefined
              : () => {
                  setConfirming(false)
                }
          }
          footer={
            <>
              <Button
                disabled={pending}
                onClick={() => {
                  setConfirming(false)
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" disabled={pending} onClick={submit}>
                {pending ? 'Sending…' : 'Send message'}
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {error === null ? null : <Callout tone="blocked">{error}</Callout>}
            <div style={previewLine}>
              <span
                style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}
              >
                Subject
              </span>
              <span style={{ font: 'var(--type-label)' }}>
                {renderDraftSubject(subject, vars)}
              </span>
            </div>
            <p style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
              This cannot be recalled once it leaves.
            </p>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

const footerRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  width: '100%',
}

const previewLine: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
  padding: 'var(--space-3)',
  background: 'var(--surface-sunken)',
  borderRadius: 'var(--radius-control)',
  overflowWrap: 'anywhere',
}
