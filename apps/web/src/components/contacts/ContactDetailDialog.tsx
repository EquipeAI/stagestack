import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Doc, Id } from '@convex/_generated/dataModel'
import {
  Button,
  Callout,
  Dialog,
  Field,
  Input,
  Select,
  Tag,
  Textarea,
} from '~/ds'
import {
  DeliveryLifecycle,
  DeliveryPill,
} from '~/components/comms/DeliveryLifecycle'
import { pushToast } from '~/components/toast'
import { usePending } from '~/lib/usePending'
import { browserTimezone, formatDateTime } from '~/lib/datetime'

type ContactDoc = Doc<'contacts'>

/**
 * The light-CRM view of one directory contact: the editable profile on top,
 * then tags (saved inline), internal notes and the contact's event history.
 */
export function ContactDetailDialog({
  orgSlug,
  contact,
  showCrmActivity = false,
  onClose,
}: {
  orgSlug: string
  contact: ContactDoc
  showCrmActivity?: boolean
  onClose: () => void
}) {
  const update = useMutation(api.contacts.update)
  const { pending, error, setError, run } = usePending()
  const [firstName, setFirstName] = useState(contact.firstName)
  const [lastName, setLastName] = useState(contact.lastName)
  const [email, setEmail] = useState(contact.email ?? '')
  const [phone, setPhone] = useState(contact.phone ?? '')
  const [jobTitle, setJobTitle] = useState(contact.jobTitle ?? '')
  const [company, setCompany] = useState(contact.company ?? '')
  const [tagline, setTagline] = useState(contact.tagline ?? '')
  const [bio, setBio] = useState(contact.bio ?? '')

  const submit = () => {
    if (firstName.trim() === '' || lastName.trim() === '') {
      return setError('First and last name are both required.')
    }
    const profile = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim() === '' ? undefined : email.trim(),
      phone: phone.trim() === '' ? undefined : phone.trim(),
      jobTitle: jobTitle.trim() === '' ? undefined : jobTitle.trim(),
      company: company.trim() === '' ? undefined : company.trim(),
      tagline: tagline.trim() === '' ? undefined : tagline.trim(),
      bio: bio.trim() === '' ? undefined : bio.trim(),
      headshotId: contact.headshotId,
      links: contact.links,
    }
    void run(async () => {
      await update({ orgSlug, contactId: contact._id, profile })
      pushToast('Contact updated', `${profile.firstName} ${profile.lastName}`)
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={760}
      title={`${contact.firstName} ${contact.lastName}`}
      description="Contacts are the org-wide directory of people you may invite to speak."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Close
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Save contact'}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-6)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
          }}
        >
          {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))',
              gap: 'var(--space-4)',
            }}
          >
            <Field label="First name" htmlFor="cd-first" required>
              <Input
                id="cd-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </Field>
            <Field label="Last name" htmlFor="cd-last" required>
              <Input
                id="cd-last"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </Field>
            <Field label="Email" htmlFor="cd-email" optional>
              <Input
                id="cd-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Phone" htmlFor="cd-phone" optional>
              <Input
                id="cd-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <Field label="Job title" htmlFor="cd-job" optional>
              <Input
                id="cd-job"
                value={jobTitle}
                placeholder="CTO"
                onChange={(e) => setJobTitle(e.target.value)}
              />
            </Field>
            <Field label="Company" htmlFor="cd-company" optional>
              <Input
                id="cd-company"
                value={company}
                placeholder="Acme"
                onChange={(e) => setCompany(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Tagline"
            htmlFor="cd-tagline"
            optional
            hint="Short role line, e.g. CTO, Acme."
          >
            <Input
              id="cd-tagline"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
            />
          </Field>
          <Field label="Bio" htmlFor="cd-bio" optional>
            <Textarea
              id="cd-bio"
              rows={3}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
            />
          </Field>
        </div>
        <TagsEditor orgSlug={orgSlug} contact={contact} />
        <AddToEvent orgSlug={orgSlug} contact={contact} />
        <NotesSection orgSlug={orgSlug} contactId={contact._id} />
        {showCrmActivity ? (
          <CrmActivitySection orgSlug={orgSlug} contactId={contact._id} />
        ) : null}
        <ConnectionsSection orgSlug={orgSlug} contactId={contact._id} />
      </div>
    </Dialog>
  )
}

function CrmActivitySection({
  orgSlug,
  contactId,
}: {
  orgSlug: string
  contactId: Id<'contacts'>
}) {
  const history = useQuery(api.contacts.pipelineHistory, { orgSlug, contactId })
  const outreach = useQuery(api.contacts.outreachHistory, {
    orgSlug,
    contactId,
  })
  const zone = browserTimezone()
  const label = (stage: string | null) =>
    stage === null
      ? 'Not enrolled'
      : stage.charAt(0).toUpperCase() + stage.slice(1)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <SectionTitle>CRM activity</SectionTitle>
      {history === undefined || outreach === undefined ? (
        <p style={{ margin: 0, color: 'var(--text-tertiary)' }}>
          Loading activity…
        </p>
      ) : history.length === 0 && outreach.length === 0 ? (
        <p
          style={{
            margin: 0,
            color: 'var(--text-tertiary)',
            font: 'var(--type-caption)',
          }}
        >
          No pipeline moves or CRM outreach yet.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {history.map((row) => (
            <li key={row.historyId}>
              <span>
                {label(row.fromStage)} → {label(row.toStage)}
              </span>{' '}
              <span
                style={{
                  color: 'var(--text-tertiary)',
                  font: 'var(--type-caption)',
                }}
              >
                {formatDateTime(row.changedAt, zone)} ·{' '}
                {row.changedBy ?? 'Unknown'}
              </span>
            </li>
          ))}
          {outreach.map((row) => (
            <li
              key={row.messageId}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
              }}
            >
              <span>
                <span>Email: {row.subject}</span>{' '}
                <DeliveryPill status={row.deliveryStatus} />
              </span>
              <span
                style={{
                  color: 'var(--text-tertiary)',
                  font: 'var(--type-caption)',
                }}
              >
                {formatDateTime(row.sentAt, zone)} · {row.toEmail}
              </span>
              {/* Same lifecycle rendering as the comms log — the CRM must not
                  word delivery differently from the event surfaces. */}
              <DeliveryLifecycle
                status={row.deliveryStatus}
                timezone={zone}
                updatedAt={row.deliveryUpdatedAt}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        margin: 0,
        font: 'var(--type-body-strong)',
        color: 'var(--text-primary)',
      }}
    >
      {children}
    </h3>
  )
}

// ── Tags ──────────────────────────────────────────────────────────────────

function TagsEditor({
  orgSlug,
  contact,
}: {
  orgSlug: string
  contact: ContactDoc
}) {
  const setTagsMutation = useMutation(api.contacts.setTags)
  const { pending, error, run } = usePending()
  // The dialog holds a snapshot of the row it was opened with, so tags are
  // tracked locally and each change is saved inline right away.
  const [tags, setTags] = useState<Array<string>>(contact.tags ?? [])
  const [draft, setDraft] = useState('')

  const save = (next: Array<string>) => {
    const before = tags
    setTags(next)
    void run(async () => {
      await setTagsMutation({ orgSlug, contactId: contact._id, tags: next })
    }).then((ok) => {
      if (!ok) setTags(before)
    })
  }

  const add = () => {
    const tag = draft.trim()
    if (tag === '') return
    setDraft('')
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return
    save([...tags, tag])
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <SectionTitle>Tags</SectionTitle>
      {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'var(--space-2)',
        }}
      >
        {tags.length === 0 ? (
          <span
            style={{
              color: 'var(--text-tertiary)',
              font: 'var(--type-caption)',
            }}
          >
            No tags yet.
          </span>
        ) : (
          tags.map((tag) => (
            <Tag key={tag} onRemove={() => save(tags.filter((t) => t !== tag))}>
              {tag}
            </Tag>
          ))
        )}
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Input
          id="cd-tag-input"
          value={draft}
          placeholder="Add a tag"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <Button onClick={add} disabled={pending || draft.trim() === ''}>
          Add tag
        </Button>
      </div>
    </div>
  )
}

// ── Add to event ──────────────────────────────────────────────────────────

function AddToEvent({
  orgSlug,
  contact,
}: {
  orgSlug: string
  contact: ContactDoc
}) {
  const events = useQuery(api.events.listForOrg, { orgSlug })
  const addToEvent = useMutation(api.contacts.addToEvent)
  const { pending, error, run } = usePending()
  const active = (events ?? []).filter(
    (event) => event.archivedAt === undefined,
  )
  const [eventId, setEventId] = useState('')

  if (events !== undefined && active.length === 0) return null

  const submit = () => {
    const target = active.find((event) => event._id === eventId)
    if (target === undefined) return
    void run(async () => {
      const { created } = await addToEvent({
        orgSlug,
        contactId: contact._id,
        eventId: target._id,
      })
      if (created) {
        pushToast(
          `Added to ${target.name}`,
          `${contact.firstName} ${contact.lastName}`,
        )
      } else {
        pushToast(
          "Already on that event's roster",
          `${contact.firstName} ${contact.lastName} — ${target.name}`,
        )
      }
    })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <SectionTitle>Add to event</SectionTitle>
      {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
      <div
        style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
      >
        <div style={{ flex: '1 1 14rem' }}>
          <Select
            id="cd-add-event"
            value={eventId}
            options={[
              { value: '', label: 'Pick an event…' },
              ...active.map((event) => ({
                value: event._id,
                label: event.name,
              })),
            ]}
            onChange={(e) => setEventId(e.target.value)}
          />
        </div>
        <Button
          iconLeft="plus"
          onClick={submit}
          disabled={pending || eventId === ''}
        >
          {pending ? 'Adding…' : 'Add to event'}
        </Button>
      </div>
    </div>
  )
}

// ── Internal notes ────────────────────────────────────────────────────────

function NotesSection({
  orgSlug,
  contactId,
}: {
  orgSlug: string
  contactId: Id<'contacts'>
}) {
  const notes = useQuery(api.contacts.notes, { orgSlug, contactId })
  const addNote = useMutation(api.contacts.addNote)
  const { pending, error, run } = usePending()
  const [draft, setDraft] = useState('')
  const zone = browserTimezone()

  const submit = () => {
    const body = draft.trim()
    if (body === '') return
    void run(async () => {
      await addNote({ orgSlug, contactId, body })
      setDraft('')
    })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <SectionTitle>Internal notes</SectionTitle>
      {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
      {notes === undefined ? (
        <p style={{ margin: 0, color: 'var(--text-tertiary)' }}>
          Loading notes…
        </p>
      ) : notes.length === 0 ? (
        <p
          style={{
            margin: 0,
            color: 'var(--text-tertiary)',
            font: 'var(--type-caption)',
          }}
        >
          No notes yet. Notes are internal to the organizing team — never
          published.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          {notes.map((note) => (
            <li
              key={note.noteId}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
              }}
            >
              <span
                style={{
                  color: 'var(--text-tertiary)',
                  font: 'var(--type-caption)',
                }}
              >
                {note.authorName ?? 'Unknown'} ·{' '}
                {formatDateTime(note.createdAt, zone)}
              </span>
              <span style={{ whiteSpace: 'pre-wrap' }}>{note.body}</span>
            </li>
          ))}
        </ul>
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
      >
        <Textarea
          id="cd-note-input"
          rows={2}
          value={draft}
          placeholder="Add an internal note…"
          onChange={(e) => setDraft(e.target.value)}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={submit} disabled={pending || draft.trim() === ''}>
            {pending ? 'Adding…' : 'Add note'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Events & sessions ─────────────────────────────────────────────────────

function ConnectionsSection({
  orgSlug,
  contactId,
}: {
  orgSlug: string
  contactId: Id<'contacts'>
}) {
  const connections = useQuery(api.contacts.connections, { orgSlug, contactId })
  const zone = browserTimezone()

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <SectionTitle>Events &amp; sessions</SectionTitle>
      {connections === undefined ? (
        <p style={{ margin: 0, color: 'var(--text-tertiary)' }}>Loading…</p>
      ) : connections.length === 0 ? (
        <p
          style={{
            margin: 0,
            color: 'var(--text-tertiary)',
            font: 'var(--type-caption)',
          }}
        >
          Not on any event roster yet.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          {connections.map((connection) => (
            <li
              key={connection.eventId}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
              }}
            >
              <span>
                {connection.eventName}{' '}
                <span
                  style={{
                    color: 'var(--text-tertiary)',
                    font: 'var(--type-caption)',
                  }}
                >
                  {formatDateTime(connection.startsAt, zone)}
                </span>
              </span>
              {connection.sessions.length === 0 ? (
                <span
                  style={{
                    color: 'var(--text-tertiary)',
                    font: 'var(--type-caption)',
                  }}
                >
                  No sessions yet.
                </span>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {connection.sessions.map((session, index) => (
                    <li
                      key={index}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                      }}
                    >
                      <span>{session.title}</span>
                      <Tag>{session.state}</Tag>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
