import { useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import {
  AUDIENCE_META,
  AUDIENCE_ORDER,
  NO_ADDRESS_BLOCKED,
  ONE_OFF_CADENCE_COPY,
  ONE_OFF_VARS,
  audienceExclusions,
  missingAddressExclusion,
  overCapRefusal,
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
  Checkbox,
  DescriptionList,
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

type Mode = 'contact' | 'selection' | 'audience'

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
  const roster = useQuery(api.speakers.roster, { eventSlug })
  const audiences = useLastLoaded(
    useQuery(api.comms.listAudiences, { eventSlug, now }),
  )
  const { pending, error, setError, run } = usePending()

  const [mode, setMode] = useState<Mode>('contact')
  const [contactId, setContactId] = useState<Id<'eventContacts'> | ''>('')
  const [selectedIds, setSelectedIds] = useState<Array<Id<'eventContacts'>>>([])
  const [contactFilter, setContactFilter] = useState('')
  const [audience, setAudience] = useState<AudienceKind>('allSpeakers')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [confirming, setConfirming] = useState(false)

  const audienceRow = audiences?.find((row) => row.kind === audience)

  // Whether StageStack holds an address for one speaker. `roster` is the only
  // client-side source that carries the email, and a contact it has not loaded
  // is UNKNOWN — never asserted as missing, which would be a confident wrong
  // exclusion.
  const rosterById = new Map(
    (roster ?? []).map((contact) => [contact.eventContactId, contact]),
  )
  const addressState = (
    id: Id<'eventContacts'>,
  ): 'has' | 'missing' | 'unknown' => {
    const row = rosterById.get(id)
    if (roster === undefined || row === undefined) return 'unknown'
    return (row.email ?? '').trim() === '' ? 'missing' : 'has'
  }
  // The backend skips these rather than failing (sendOneOff's `contacts`
  // branch), so they are excluded from the count the confirmation states.
  const selectionWithoutAddress = selectedIds.filter(
    (id) => addressState(id) === 'missing',
  ).length
  const contactWithoutAddress =
    contactId !== '' && addressState(contactId) === 'missing'

  const recipientCount =
    mode === 'contact'
      ? contactId === '' || contactWithoutAddress
        ? 0
        : 1
      : mode === 'selection'
        ? selectedIds.length - selectionWithoutAddress
        : (audienceRow?.count ?? 0)
  const selectableContacts = (roster ?? []).map((contact) => ({
    eventContactId: contact.eventContactId,
    name:
      `${contact.firstName} ${contact.lastName}`.trim() || 'Unnamed speaker',
  }))
  const filteredContacts = selectableContacts.filter((contact) =>
    contact.name.toLowerCase().includes(contactFilter.trim().toLowerCase()),
  )

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

  const overCap =
    mode === 'audience' && audienceRow !== undefined
      ? overCapRefusal(audienceRow, MAX_AUDIENCE)
      : null

  const blocked = (() => {
    if (mode === 'contact' && contactId === '') return 'Choose a recipient.'
    if (mode === 'contact' && contactWithoutAddress) return NO_ADDRESS_BLOCKED
    if (mode === 'selection' && selectedIds.length === 0) {
      return 'Choose at least one speaker.'
    }
    if (mode === 'audience' && audiences === undefined) {
      return 'Counting the audience…'
    }
    // `listAudiences.count` is already capped, so the old `count > MAX` guard
    // could never fire and the send failed AFTER the confirmation. The cap is
    // detectable only through `truncated`.
    if (overCap !== null) return overCap
    if (recipientCount === 0) {
      return 'Nobody in this audience has a reachable email address.'
    }
    // Selection mode is capped on the number of IDs SENT, before addresses are
    // resolved (`sendOneOff` throws `invalid_audience` on `uniqueIds.length`),
    // so the guard counts the selection, not the reachable subset.
    if (mode === 'selection' && selectedIds.length > MAX_AUDIENCE) {
      return `Choose between 1 and ${MAX_AUDIENCE} speakers.`
    }
    if (recipientCount > MAX_AUDIENCE) {
      return `A single send reaches at most ${MAX_AUDIENCE} recipients.`
    }
    if (subject.trim() === '') return 'Write a subject.'
    if (message.trim() === '') return 'Write a message.'
    return null
  })()

  const contactName =
    contacts?.find((c) => c.eventContactId === contactId)?.name ??
    'this speaker'

  // The audience statement the confirmation shows. The backend already exposes
  // the arithmetic (count / skipped / totalKnown / truncated); this only puts
  // it into sentences.
  const qualifies =
    mode === 'contact'
      ? `${contactName} only — sent to the address StageStack holds for them.`
      : mode === 'selection'
        ? `${recipientCount} of the ${selectedIds.length} ${selectedIds.length === 1 ? 'speaker' : 'speakers'} you selected.`
        : `${AUDIENCE_META[audience].label}: ${AUDIENCE_META[audience].description} ${recipientCount} ${recipientCount === 1 ? 'recipient' : 'recipients'}.`
  const exclusions = (
    mode === 'audience' && audienceRow !== undefined
      ? [...audienceExclusions(audienceRow), overCap]
      : mode === 'selection'
        ? [missingAddressExclusion(selectionWithoutAddress)]
        : [contactWithoutAddress ? NO_ADDRESS_BLOCKED : null]
  ).filter((reason): reason is string => reason !== null)

  const submit = () => {
    if (mode === 'contact' && contactId === '') return
    const to =
      mode === 'contact' && contactId !== ''
        ? ({ kind: 'contact', eventContactId: contactId } as const)
        : mode === 'selection'
          ? ({ kind: 'contacts', eventContactIds: selectedIds } as const)
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
        `${result.sent} accepted · ${result.failed} failed · ${result.skipped} skipped`,
        result.failed > 0
          ? 'Provider-refused messages did not leave StageStack. Every attempt is recorded in the comms log.'
          : result.skipped === 0
            ? 'The provider accepted every message, and each is recorded in the comms log.'
            : `${result.skipped} had no reachable address. The provider accepted the rest.`,
      )
    })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <Card
        title="Recipients"
        subtitle="Audiences are derived from event state — StageStack has no imported lists."
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
          }}
        >
          <RadioGroup
            name="send-mode"
            row
            value={mode}
            options={[
              { value: 'contact', label: 'One contact' },
              { value: 'selection', label: 'Selected speakers' },
              { value: 'audience', label: 'Audience' },
            ]}
            onChange={(value) => {
              setMode(
                value === 'audience'
                  ? 'audience'
                  : value === 'selection'
                    ? 'selection'
                    : 'contact',
              )
              setError(null)
            }}
          />

          {mode === 'contact' ? (
            contacts === undefined ? (
              <p style={{ color: 'var(--text-tertiary)' }}>Loading speakers…</p>
            ) : contacts.length === 0 ? (
              <Callout tone="neutral" title="No speakers yet">
                Speakers appear here once a session has participants. Until then
                there is nobody to write to.
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
          ) : mode === 'selection' ? (
            roster === undefined ? (
              <p style={{ color: 'var(--text-tertiary)' }}>Loading speakers…</p>
            ) : (
              <Field
                label="Speakers"
                htmlFor="send-contact-filter"
                hint={`${selectedIds.length} selected. Search, then select the currently filtered group.`}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-2)',
                  }}
                >
                  <Input
                    id="send-contact-filter"
                    value={contactFilter}
                    placeholder="Filter speakers…"
                    disabled={pending}
                    onChange={(event) => setContactFilter(event.target.value)}
                  />
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Button
                      size="sm"
                      disabled={pending || filteredContacts.length === 0}
                      onClick={() => {
                        setSelectedIds((current) => [
                          ...new Set([
                            ...current,
                            ...filteredContacts.map((c) => c.eventContactId),
                          ]),
                        ])
                      }}
                    >
                      Select filtered ({filteredContacts.length})
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || selectedIds.length === 0}
                      onClick={() => setSelectedIds([])}
                    >
                      Clear
                    </Button>
                  </div>
                  <div
                    style={{
                      maxHeight: '16rem',
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-2)',
                    }}
                  >
                    {filteredContacts.map((contact) => (
                      <Checkbox
                        key={contact.eventContactId}
                        label={contact.name}
                        checked={selectedIds.includes(contact.eventContactId)}
                        disabled={pending}
                        onChange={(event) => {
                          setSelectedIds((current) =>
                            event.target.checked
                              ? [
                                  ...new Set([
                                    ...current,
                                    contact.eventContactId,
                                  ]),
                                ]
                              : current.filter(
                                  (id) => id !== contact.eventContactId,
                                ),
                          )
                        }}
                      />
                    ))}
                  </div>
                </div>
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
                  blocked === null
                    ? 'var(--text-tertiary)'
                    : 'var(--text-secondary)',
                marginRight: 'auto',
              }}
            >
              {blocked ??
                `Sends ${recipientCount} ${recipientCount === 1 ? 'email' : 'emails'}.`}
            </span>
            {error === null ? null : (
              <span
                style={{
                  font: 'var(--type-caption)',
                  color: 'var(--text-danger)',
                }}
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
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
          }}
        >
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

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
            }}
          >
            <span
              style={{
                font: 'var(--type-label)',
                color: 'var(--text-secondary)',
              }}
            >
              Variables
            </span>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--space-2)',
              }}
            >
              {ONE_OFF_VARS.map((path) => (
                <VariableChip key={path} path={path} />
              ))}
            </div>
            <p
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
              }}
            >
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
                style={{
                  font: 'var(--type-caption)',
                  color: 'var(--text-tertiary)',
                }}
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
              : mode === 'selection'
                ? `Sends to ${recipientCount} selected speakers now. The result reports exact accepted, failed and skipped counts, and each attempt is recorded in the comms log.`
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
              {/* Re-checked here, not only on the opener: the audience is
                  reactive, so it can grow past the cap (or empty out) while
                  the confirmation is open — the backend would refuse. */}
              <Button
                variant="primary"
                disabled={pending || blocked !== null}
                onClick={submit}
              >
                {pending ? 'Sending…' : 'Send message'}
              </Button>
            </>
          }
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
            }}
          >
            {error === null ? null : <Callout tone="blocked">{error}</Callout>}
            {blocked === null || pending ? null : (
              <Callout tone="blocked">{blocked}</Callout>
            )}
            <div style={previewLine}>
              <span
                style={{
                  font: 'var(--type-caption)',
                  color: 'var(--text-tertiary)',
                }}
              >
                Subject
              </span>
              <span style={{ font: 'var(--type-label)' }}>
                {renderDraftSubject(subject, vars)}
              </span>
            </div>

            {/* Who qualifies, who does not, and what sending changes. Stated
                before the send, not discovered in the result (W1). */}
            <DescriptionList
              stacked
              items={[
                { term: 'Who qualifies', value: qualifies },
                {
                  term: 'Who is excluded',
                  value:
                    exclusions.length === 0
                      ? 'Nobody — every qualifying recipient is included.'
                      : exclusions.join(' '),
                },
                { term: 'Effect on reminders', value: ONE_OFF_CADENCE_COPY },
              ]}
            />

            <p
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
              }}
            >
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
