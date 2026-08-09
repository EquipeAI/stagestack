import { useMemo, useRef, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Doc } from '@convex/_generated/dataModel'
import type * as React from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  Field,
  IconButton,
  Input,
  Select,
  StatusPill,
  Switch,
  Tag,
  Textarea,
} from '~/ds'
import { fromInputValue, timezoneOptions, toInputValue } from '~/lib/datetime'
import { usePending } from '~/lib/usePending'
import { errorMessage } from '~/lib/errors'
import { pushToast } from '~/components/toast'

export const Route = createFileRoute('/app/e/$eventSlug/settings')({
  component: Settings,
})

/** Swatches are design-system colour tokens, so tracks stay on-palette. */
const PALETTE = [
  'var(--amber-400)',
  'var(--jade-500)',
  'var(--beam-500)',
  'var(--iris-500)',
  'var(--rust-500)',
  'var(--ember-500)',
  'var(--gray-500)',
]

function Settings() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })

  if (data === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading settings…</p>
  }

  if (data.role !== 'organizer') {
    return (
      <Callout tone="blocked" title="Settings are organizer-only">
        You have reviewer access to this event.
      </Callout>
    )
  }

  const { event } = data

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <DetailsSection key={`details-${event._id}`} eventSlug={eventSlug} event={event} />
      <SlugSection key={`slug-${event._id}`} eventSlug={eventSlug} event={event} />
      <DatesSection key={`dates-${event._id}`} eventSlug={eventSlug} event={event} />
      <CfpSection key={`cfp-${event._id}`} eventSlug={eventSlug} event={event} />
      <CommsSection key={`comms-${event._id}`} eventSlug={eventSlug} event={event} />
      <LibrarySections eventSlug={eventSlug} />
    </div>
  )
}

// ── Section forms ─────────────────────────────────────────────────────────

type FormValues = Record<string, string | boolean>

function sameValues(a: FormValues, b: FormValues) {
  for (const key of Object.keys(a)) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/**
 * A section form seeded from the live doc. Convex pushes every change, so a
 * form nobody has touched follows the server; a form holding local edits keeps
 * them and reports the divergence, because saving sends the whole section and
 * the organizer has to see what they are about to overwrite.
 */
function useSectionForm<T extends FormValues>(server: T) {
  const [seed, setSeed] = useState<T>(server)
  const [draft, setDraft] = useState<T>(server)
  // A save normalises what it stores (trimming, mostly), so what comes back
  // right after one is the truth for this form even though the fields differ
  // from it — that is this form's own write, not somebody else's.
  const followNext = useRef(false)

  let values = draft
  let base = seed
  // Adjusted during render so this same pass shows the server's value.
  if (
    !sameValues(seed, server) &&
    (followNext.current ||
      sameValues(draft, seed) ||
      sameValues(draft, server))
  ) {
    followNext.current = false
    base = server
    values = server
    setSeed(server)
    setDraft(server)
  }

  return {
    values,
    set<TKey extends keyof T>(key: TKey, value: T[TKey]) {
      followNext.current = false
      setDraft((prev) => ({ ...prev, [key]: value }))
    },
    /** Called after this form's own successful save. */
    saved() {
      followNext.current = true
    },
    /** The server moved under edits this form has not saved. */
    conflict: !sameValues(base, server),
    discard() {
      setSeed(server)
      setDraft(server)
    },
  }
}

function ConflictNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <Callout
      tone="attention"
      title="This section changed somewhere else"
      actions={
        <Button size="sm" onClick={onDiscard}>
          Discard my edits
        </Button>
      }
    >
      Another tab or another organizer saved different values while you were
      editing. Saving replaces theirs with what is on this screen.
    </Callout>
  )
}

function SectionFooter({
  pending,
  error,
  onSave,
  label = 'Save changes',
}: {
  pending: boolean
  error: string | null
  onSave: () => void
  label?: string
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        justifyContent: 'flex-end',
      }}
    >
      {error !== null ? (
        <span style={{ color: 'var(--text-danger)', font: 'var(--type-caption)' }}>
          {error}
        </span>
      ) : null}
      <Button variant="primary" onClick={onSave} disabled={pending}>
        {pending ? 'Saving…' : label}
      </Button>
    </div>
  )
}

// ── Details ───────────────────────────────────────────────────────────────

function DetailsSection({
  eventSlug,
  event,
}: {
  eventSlug: string
  event: Doc<'events'>
}) {
  const update = useMutation(api.events.updateSettings)
  const { pending, error, setError, run } = usePending()
  const form = useSectionForm({
    name: event.name,
    type: event.type ?? '',
    location: event.location ?? '',
    website: event.website ?? '',
    description: event.description ?? '',
  })
  const { name, type, location, website, description } = form.values

  const save = () => {
    if (name.trim() === '') return setError('The event needs a name.')
    void run(async () => {
      await update({
        eventSlug,
        patch: {
          name: name.trim(),
          type: blankToNull(type),
          location: blankToNull(location),
          website: blankToNull(website),
          description: blankToNull(description),
        },
      })
      pushToast('Details saved', name.trim())
      form.saved()
    })
  }

  return (
    <Card
      title="Details"
      subtitle="What this event is, and where to send people."
      footer={<SectionFooter pending={pending} error={error} onSave={save} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {form.conflict ? <ConflictNotice onDiscard={form.discard} /> : null}
        <Field label="Name" htmlFor="s-name">
          <Input
            id="s-name"
            value={name}
            onChange={(e) => form.set('name', e.target.value)}
          />
        </Field>
        <div style={twoCol}>
          <Field
            label="Type"
            htmlFor="s-type"
            optional
            hint="e.g. Conference, Summit, Meetup."
          >
            <Input
              id="s-type"
              value={type}
              onChange={(e) => form.set('type', e.target.value)}
            />
          </Field>
          <Field label="Location" htmlFor="s-location" optional>
            <Input
              id="s-location"
              value={location}
              placeholder="San Francisco, CA"
              onChange={(e) => form.set('location', e.target.value)}
            />
          </Field>
        </div>
        <Field label="Website" htmlFor="s-website" optional>
          <Input
            id="s-website"
            type="url"
            value={website}
            placeholder="https://example.com"
            onChange={(e) => form.set('website', e.target.value)}
          />
        </Field>
        <Field label="Description" htmlFor="s-description" optional>
          <Textarea
            id="s-description"
            rows={4}
            value={description}
            onChange={(e) => form.set('description', e.target.value)}
          />
        </Field>
      </div>
    </Card>
  )
}

// ── Slug ──────────────────────────────────────────────────────────────────

function SlugSection({
  eventSlug,
  event,
}: {
  eventSlug: string
  event: Doc<'events'>
}) {
  const update = useMutation(api.events.updateSettings)
  const navigate = useNavigate()
  const { pending, error, setError, run } = usePending()
  const form = useSectionForm({ slug: event.slug })
  const { slug } = form.values

  const save = () => {
    const next = slug.trim()
    if (next === '') return setError('The slug cannot be empty.')
    if (next === event.slug) return setError('That is already the slug.')
    void run(async () => {
      await update({ eventSlug, patch: { slug: next } })
      form.saved()
      pushToast('Slug changed', `Public URLs now use /e/${next}`)
      await navigate({
        to: '/app/e/$eventSlug/settings',
        params: { eventSlug: next },
        replace: true,
      })
    })
  }

  return (
    <Card
      title="Slug"
      subtitle="The event's public identifier."
      footer={
        <SectionFooter
          pending={pending}
          error={error}
          onSave={save}
          label="Change slug"
        />
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Callout tone="attention" title="Changing the slug changes every URL">
          Links already shared — the CFP page, the public program, invitations —
          stop resolving the moment you save.
        </Callout>
        {form.conflict ? <ConflictNotice onDiscard={form.discard} /> : null}
        <Field label="Slug" htmlFor="s-slug" hint={`stagestack.dev/e/${slug.trim()}`}>
          <Input
            id="s-slug"
            value={slug}
            onChange={(e) => form.set('slug', e.target.value)}
          />
        </Field>
      </div>
    </Card>
  )
}

// ── Dates ─────────────────────────────────────────────────────────────────

function DatesSection({
  eventSlug,
  event,
}: {
  eventSlug: string
  event: Doc<'events'>
}) {
  const update = useMutation(api.events.updateSettings)
  const { pending, error, setError, run } = usePending()
  const form = useSectionForm({
    startsAt: toInputValue(event.startsAt, event.timezone),
    endsAt: toInputValue(event.endsAt, event.timezone),
    timezone: event.timezone,
  })
  const { startsAt, endsAt, timezone } = form.values
  const zones = useMemo(() => timezoneOptions(timezone), [timezone])

  const save = () => {
    const start = fromInputValue(startsAt, timezone)
    const end = fromInputValue(endsAt, timezone)
    if (start === null) return setError('Set a start date and time.')
    if (end === null) return setError('Set an end date and time.')
    if (end < start) return setError('The event cannot end before it starts.')
    void run(async () => {
      await update({
        eventSlug,
        patch: { startsAt: start, endsAt: end, timezone },
      })
      pushToast('Dates saved', `Event time is now stated in ${timezone}.`)
      form.saved()
    })
  }

  return (
    <Card
      title="Dates"
      subtitle="Event time is authoritative — every screen states this zone."
      footer={<SectionFooter pending={pending} error={error} onSave={save} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {form.conflict ? <ConflictNotice onDiscard={form.discard} /> : null}
        <div style={twoCol}>
          <Field label="Starts" htmlFor="s-starts">
            <Input
              id="s-starts"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => form.set('startsAt', e.target.value)}
            />
          </Field>
          <Field label="Ends" htmlFor="s-ends">
            <Input
              id="s-ends"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => form.set('endsAt', e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Timezone"
          htmlFor="s-tz"
          hint="Changing the zone re-reads the times above as wall-clock in the new zone."
        >
          <Select
            id="s-tz"
            options={zones}
            value={timezone}
            onChange={(e) => form.set('timezone', e.target.value)}
          />
        </Field>
      </div>
    </Card>
  )
}

// ── CFP ───────────────────────────────────────────────────────────────────

function CfpSection({
  eventSlug,
  event,
}: {
  eventSlug: string
  event: Doc<'events'>
}) {
  const update = useMutation(api.events.updateSettings)
  const { pending, error, setError, run } = usePending()
  const form = useSectionForm({
    openAt: toInputValue(event.cfpOpenAt, event.timezone),
    closeAt: toInputValue(event.cfpCloseAt, event.timezone),
    published: event.cfpPublished,
  })
  const { openAt, closeAt, published } = form.values

  const save = () => {
    const open = openAt === '' ? null : fromInputValue(openAt, event.timezone)
    const close = closeAt === '' ? null : fromInputValue(closeAt, event.timezone)
    if (openAt !== '' && open === null) return setError('The open date is unreadable.')
    if (closeAt !== '' && close === null) {
      return setError('The close date is unreadable.')
    }
    if (open !== null && close !== null && close < open) {
      return setError('The CFP cannot close before it opens.')
    }
    void run(async () => {
      await update({
        eventSlug,
        patch: { cfpOpenAt: open, cfpCloseAt: close, cfpPublished: published },
      })
      pushToast(
        'CFP settings saved',
        published ? 'The CFP is published.' : 'The CFP is unpublished.',
      )
      form.saved()
    })
  }

  return (
    <Card
      title="Call for speakers"
      subtitle="The window and the publication state are independent."
      actions={<StatusPill status={published ? 'Published' : 'Unpublished'} />}
      footer={<SectionFooter pending={pending} error={error} onSave={save} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {form.conflict ? <ConflictNotice onDiscard={form.discard} /> : null}
        <div style={twoCol}>
          <Field
            label="Opens"
            htmlFor="s-cfp-open"
            optional
            hint={`Stated in ${event.timezone}.`}
          >
            <div style={dateRow}>
              <Input
                id="s-cfp-open"
                type="datetime-local"
                value={openAt}
                onChange={(e) => form.set('openAt', e.target.value)}
              />
              <Button
                size="sm"
                onClick={() => form.set('openAt', '')}
                disabled={openAt === ''}
              >
                Clear
              </Button>
            </div>
          </Field>
          <Field
            label="Closes"
            htmlFor="s-cfp-close"
            optional
            hint={`Stated in ${event.timezone}.`}
          >
            <div style={dateRow}>
              <Input
                id="s-cfp-close"
                type="datetime-local"
                value={closeAt}
                onChange={(e) => form.set('closeAt', e.target.value)}
              />
              <Button
                size="sm"
                onClick={() => form.set('closeAt', '')}
                disabled={closeAt === ''}
              >
                Clear
              </Button>
            </div>
          </Field>
        </div>
        <Switch
          label="CFP published"
          checked={published}
          onChange={(e) => form.set('published', e.target.checked)}
        />
        <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
          Publishing makes the public CFP page reachable; the window above
          controls when submissions are accepted. Build the questions in the{' '}
          <Link to="/app/e/$eventSlug/cfp" params={{ eventSlug }}>
            form builder
          </Link>
          .
        </p>
      </div>
    </Card>
  )
}

// ── Communications ────────────────────────────────────────────────────────

// One @, no spaces, a dotted domain. Delivery is the real validator; this only
// catches the typo before mail is addressed to nobody.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function CommsSection({
  eventSlug,
  event,
}: {
  eventSlug: string
  event: Doc<'events'>
}) {
  const update = useMutation(api.events.updateSettings)
  const { pending, error, setError, run } = usePending()
  const form = useSectionForm({
    cadence:
      event.reminderCadenceDays === undefined
        ? ''
        : String(event.reminderCadenceDays),
    replyTo: event.replyTo ?? '',
  })
  const { cadence, replyTo } = form.values

  const save = () => {
    const trimmed = cadence.trim()
    const days = trimmed === '' ? null : Number(trimmed)
    if (days !== null && (!Number.isInteger(days) || days < 1)) {
      return setError('Cadence must be a whole number of days, at least 1.')
    }
    const address = replyTo.trim()
    if (address !== '' && !EMAIL_SHAPE.test(address)) {
      return setError('That does not look like an email address.')
    }
    void run(async () => {
      await update({
        eventSlug,
        patch: {
          reminderCadenceDays: days,
          replyTo: address === '' ? null : address,
        },
      })
      pushToast(
        'Communications saved',
        days === null
          ? 'Reminders are off for this event.'
          : `Reminders go out every ${days} ${days === 1 ? 'day' : 'days'}.`,
      )
      form.saved()
    })
  }

  return (
    <Card
      title="Communications"
      subtitle="How StageStack chases outstanding work, and where replies land."
      actions={
        <Badge tone={cadence.trim() === '' ? 'neutral' : 'success'} dot>
          {cadence.trim() === ''
            ? 'Reminders off'
            : `Every ${cadence.trim()} days`}
        </Badge>
      }
      footer={<SectionFooter pending={pending} error={error} onSave={save} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {form.conflict ? <ConflictNotice onDiscard={form.discard} /> : null}
        <div style={twoCol}>
          <Field
            label="Reminder cadence"
            htmlFor="s-cadence"
            optional
            hint="Days between reminders. Leave empty to send none."
          >
            <Input
              id="s-cadence"
              type="number"
              value={cadence}
              placeholder="7"
              onChange={(e) => form.set('cadence', e.target.value)}
            />
          </Field>
          <Field
            label="Reply-to"
            htmlFor="s-reply-to"
            optional
            hint="Replies to event email go here."
          >
            <Input
              id="s-reply-to"
              type="email"
              value={replyTo}
              placeholder="speakers@example.com"
              onChange={(e) => form.set('replyTo', e.target.value)}
            />
          </Field>
        </div>
        <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
          Consolidated task reminders are sent on this cadence — one message
          listing everything outstanding, never one email per item. Unconfirmed
          speakers get participation reminders instead of task chasing, because
          the only thing they owe is an answer.
        </p>
      </div>
    </Card>
  )
}

// ── Library ───────────────────────────────────────────────────────────────

function LibrarySections({ eventSlug }: { eventSlug: string }) {
  const library = useQuery(api.library.list, { eventSlug })

  if (library === undefined) {
    return (
      <Card title="Library">
        <p style={{ color: 'var(--text-tertiary)' }}>Loading library…</p>
      </Card>
    )
  }

  return (
    <>
      <TracksSection eventSlug={eventSlug} items={library.tracks} />
      <TagsSection eventSlug={eventSlug} items={library.tags} />
      <RoomsSection eventSlug={eventSlug} items={library.rooms} />
      <CustomFieldsSection eventSlug={eventSlug} items={library.customFields} />
    </>
  )
}

type LibraryTable = 'tracks' | 'tags' | 'rooms' | 'customFields'

/** What the confirmation dialog is about to delete. */
type RemoveTarget = { table: LibraryTable; id: string; kind: string; label: string }

function useLibrary(eventSlug: string) {
  const add = useMutation(api.library.add)
  const removeItem = useMutation(api.library.remove)
  const { pending, error, setError, run } = usePending()
  // Removal is tracked per row — one shared flag disables every row's button
  // and hides which one is actually working — and it goes through a
  // confirmation, because the delete is immediate and has no undo.
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<RemoveTarget | null>(null)

  const remove = (target: RemoveTarget) => {
    setConfirming(null)
    setRemovingId(target.id)
    setError(null)
    void removeItem({ eventSlug, table: target.table, id: target.id })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setRemovingId(null))
  }

  return {
    add,
    pending,
    error,
    setError,
    run,
    eventSlug,
    removingId,
    confirming,
    askRemove: setConfirming,
    remove,
  }
}

function RemoveConfirm({
  target,
  onCancel,
  onConfirm,
}: {
  target: RemoveTarget | null
  onCancel: () => void
  onConfirm: (target: RemoveTarget) => void
}) {
  if (target === null) return null
  return (
    <Dialog
      title={`Remove this ${target.kind}?`}
      description="It disappears from every picker on this event, and removing it cannot be undone."
      width={480}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={() => onConfirm(target)}>
            Remove
          </Button>
        </>
      }
    >
      <p style={{ font: 'var(--type-body)' }}>{target.label}</p>
    </Dialog>
  )
}

function LibraryShell({
  title,
  subtitle,
  error,
  count,
  children,
}: {
  title: string
  subtitle: string
  error: string | null
  count: number
  children: React.ReactNode
}) {
  return (
    <Card
      title={title}
      subtitle={subtitle}
      actions={
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-tertiary)',
          }}
        >
          {count}
        </span>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        {children}
      </div>
    </Card>
  )
}

function ItemRow({
  children,
  onRemove,
  removing,
}: {
  children: React.ReactNode
  onRemove: () => void
  removing: boolean
}) {
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        minHeight: 'var(--row-height-md)',
        borderBottom: 'var(--space-px) solid var(--border-subtle)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      <IconButton
        icon="trash-2"
        label="Remove"
        size="sm"
        disabled={removing}
        onClick={onRemove}
      />
    </li>
  )
}

function List({ children }: { children: React.ReactNode }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{children}</ul>
  )
}

function Swatches({
  value,
  onChange,
}: {
  value: string
  onChange: (color: string) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      {PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`Use colour ${color}`}
          onClick={() => onChange(value === color ? '' : color)}
          style={{
            width: 'var(--space-6)',
            height: 'var(--space-6)',
            borderRadius: 'var(--radius-pill)',
            background: color,
            cursor: 'pointer',
            border:
              value === color
                ? 'var(--space-half) solid var(--gray-900)'
                : 'var(--space-px) solid var(--border-default)',
          }}
        />
      ))}
    </div>
  )
}

function TracksSection({
  eventSlug,
  items,
}: {
  eventSlug: string
  items: Array<Doc<'tracks'>>
}) {
  const lib = useLibrary(eventSlug)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('')

  const addItem = () => {
    if (name.trim() === '') return lib.setError('Name the track.')
    void lib.run(async () => {
      await lib.add({
        eventSlug,
        table: 'tracks',
        item: {
          name: name.trim(),
          description: description.trim() === '' ? undefined : description.trim(),
          color: color === '' ? undefined : color,
        },
      })
      setName('')
      setDescription('')
      setColor('')
    })
  }

  return (
    <LibraryShell
      title="Tracks"
      subtitle="The programme's top-level split — sessions belong to one track."
      error={lib.error}
      count={items.length}
    >
      {items.length === 0 ? (
        <Muted>No tracks yet. Sessions can be assigned once you add one.</Muted>
      ) : (
        <List>
          {items.map((item) => (
            <ItemRow
              key={item._id}
              removing={lib.removingId === item._id}
              onRemove={() =>
                lib.askRemove({
                  table: 'tracks',
                  id: item._id,
                  kind: 'track',
                  label: item.name,
                })
              }
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  flexWrap: 'wrap',
                }}
              >
                <Tag color={item.color}>{item.name}</Tag>
                {item.description !== undefined ? (
                  <span
                    style={{
                      color: 'var(--text-tertiary)',
                      font: 'var(--type-caption)',
                    }}
                  >
                    {item.description}
                  </span>
                ) : null}
              </span>
            </ItemRow>
          ))}
        </List>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div style={twoCol}>
          <Field label="Track name" htmlFor="lib-track-name">
            <Input
              id="lib-track-name"
              value={name}
              placeholder="AI Engineering"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Description" htmlFor="lib-track-desc" optional>
            <Input
              id="lib-track-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Colour" optional hint="Shown on agenda blocks and tags.">
          <Swatches value={color} onChange={setColor} />
        </Field>
        <div>
          <Button iconLeft="plus" onClick={addItem} disabled={lib.pending}>
            {lib.pending ? 'Working…' : 'Add track'}
          </Button>
        </div>
      </div>
      <RemoveConfirm
        target={lib.confirming}
        onCancel={() => lib.askRemove(null)}
        onConfirm={lib.remove}
      />
    </LibraryShell>
  )
}

function TagsSection({
  eventSlug,
  items,
}: {
  eventSlug: string
  items: Array<Doc<'tags'>>
}) {
  const lib = useLibrary(eventSlug)
  const [name, setName] = useState('')
  const [color, setColor] = useState('')

  const addItem = () => {
    if (name.trim() === '') return lib.setError('Name the tag.')
    void lib.run(async () => {
      await lib.add({
        eventSlug,
        table: 'tags',
        item: { name: name.trim(), color: color === '' ? undefined : color },
      })
      setName('')
      setColor('')
    })
  }

  return (
    <LibraryShell
      title="Tags"
      subtitle="Free-form labels for filtering proposals and sessions."
      error={lib.error}
      count={items.length}
    >
      {items.length === 0 ? (
        <Muted>No tags yet.</Muted>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          {items.map((item) => (
            <Tag
              key={item._id}
              color={item.color}
              onRemove={() =>
                lib.askRemove({
                  table: 'tags',
                  id: item._id,
                  kind: 'tag',
                  label: item.name,
                })
              }
            >
              {item.name}
            </Tag>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <Field label="Tag name" htmlFor="lib-tag-name">
          <Input
            id="lib-tag-name"
            value={name}
            placeholder="Beginner friendly"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Colour" optional>
          <Swatches value={color} onChange={setColor} />
        </Field>
        <div>
          <Button iconLeft="plus" onClick={addItem} disabled={lib.pending}>
            {lib.pending ? 'Working…' : 'Add tag'}
          </Button>
        </div>
      </div>
      <RemoveConfirm
        target={lib.confirming}
        onCancel={() => lib.askRemove(null)}
        onConfirm={lib.remove}
      />
    </LibraryShell>
  )
}

function RoomsSection({
  eventSlug,
  items,
}: {
  eventSlug: string
  items: Array<Doc<'rooms'>>
}) {
  const lib = useLibrary(eventSlug)
  const [name, setName] = useState('')
  const [capacity, setCapacity] = useState('')

  const addItem = () => {
    if (name.trim() === '') return lib.setError('Name the room.')
    const trimmed = capacity.trim()
    let parsed: number | undefined
    if (trimmed !== '') {
      const seats = Number(trimmed)
      if (!Number.isInteger(seats) || seats < 1) {
        return lib.setError('Capacity must be a whole number of seats, 1 or more.')
      }
      parsed = seats
    }
    void lib.run(async () => {
      await lib.add({
        eventSlug,
        table: 'rooms',
        item: { name: name.trim(), capacity: parsed },
      })
      setName('')
      setCapacity('')
    })
  }

  return (
    <LibraryShell
      title="Rooms"
      subtitle="Stages and rooms the agenda can schedule into."
      error={lib.error}
      count={items.length}
    >
      {items.length === 0 ? (
        <Muted>No rooms yet.</Muted>
      ) : (
        <List>
          {items.map((item) => (
            <ItemRow
              key={item._id}
              removing={lib.removingId === item._id}
              onRemove={() =>
                lib.askRemove({
                  table: 'rooms',
                  id: item._id,
                  kind: 'room',
                  label: item.name,
                })
              }
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                }}
              >
                {item.name}
                {item.capacity !== undefined ? (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    seats {item.capacity}
                  </span>
                ) : null}
              </span>
            </ItemRow>
          ))}
        </List>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div style={twoCol}>
          <Field label="Room name" htmlFor="lib-room-name">
            <Input
              id="lib-room-name"
              value={name}
              placeholder="Main Stage"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Capacity" htmlFor="lib-room-cap" optional>
            <Input
              id="lib-room-cap"
              type="number"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
          </Field>
        </div>
        <div>
          <Button iconLeft="plus" onClick={addItem} disabled={lib.pending}>
            {lib.pending ? 'Working…' : 'Add room'}
          </Button>
        </div>
      </div>
      <RemoveConfirm
        target={lib.confirming}
        onCancel={() => lib.askRemove(null)}
        onConfirm={lib.remove}
      />
    </LibraryShell>
  )
}

const FIELD_KINDS = ['text', 'number', 'select', 'multiselect', 'url'] as const
type FieldKind = (typeof FIELD_KINDS)[number]

function CustomFieldsSection({
  eventSlug,
  items,
}: {
  eventSlug: string
  items: Array<Doc<'customFields'>>
}) {
  const lib = useLibrary(eventSlug)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<FieldKind>('text')
  const [options, setOptions] = useState('')
  const [appliesTo, setAppliesTo] = useState<'session' | 'speaker'>('session')
  const needsOptions = kind === 'select' || kind === 'multiselect'

  const addItem = () => {
    if (name.trim() === '') return lib.setError('Name the field.')
    const parsed = options
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o !== '')
    if (needsOptions && parsed.length === 0) {
      return lib.setError('A select field needs at least one option.')
    }
    void lib.run(async () => {
      await lib.add({
        eventSlug,
        table: 'customFields',
        item: {
          name: name.trim(),
          kind,
          options: needsOptions ? parsed : undefined,
          appliesTo,
        },
      })
      setName('')
      setOptions('')
    })
  }

  return (
    <LibraryShell
      title="Custom fields"
      subtitle="Extra data you collect on sessions or on speakers."
      error={lib.error}
      count={items.length}
    >
      {items.length === 0 ? (
        <Muted>No custom fields yet.</Muted>
      ) : (
        <List>
          {items.map((item) => (
            <ItemRow
              key={item._id}
              removing={lib.removingId === item._id}
              onRemove={() =>
                lib.askRemove({
                  table: 'customFields',
                  id: item._id,
                  kind: 'custom field',
                  label: item.name,
                })
              }
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  flexWrap: 'wrap',
                }}
              >
                {item.name}
                <Badge tone="neutral">{item.kind}</Badge>
                <Badge tone="info">{item.appliesTo}</Badge>
                {item.options !== undefined && item.options.length > 0 ? (
                  <span
                    style={{
                      color: 'var(--text-tertiary)',
                      font: 'var(--type-caption)',
                    }}
                  >
                    {item.options.join(', ')}
                  </span>
                ) : null}
              </span>
            </ItemRow>
          ))}
        </List>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div style={twoCol}>
          <Field label="Field name" htmlFor="lib-cf-name">
            <Input
              id="lib-cf-name"
              value={name}
              placeholder="Session level"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Kind" htmlFor="lib-cf-kind">
            <Select
              id="lib-cf-kind"
              value={kind}
              options={[...FIELD_KINDS]}
              onChange={(e) => setKind(e.target.value as FieldKind)}
            />
          </Field>
        </div>
        <div style={twoCol}>
          <Field
            label="Options"
            htmlFor="lib-cf-options"
            optional={!needsOptions}
            hint="Comma separated, e.g. Beginner, Intermediate, Advanced."
          >
            <Input
              id="lib-cf-options"
              value={options}
              disabled={!needsOptions}
              onChange={(e) => setOptions(e.target.value)}
            />
          </Field>
          <Field label="Applies to" htmlFor="lib-cf-applies">
            <Select
              id="lib-cf-applies"
              value={appliesTo}
              options={[
                { value: 'session', label: 'Sessions' },
                { value: 'speaker', label: 'Speakers' },
              ]}
              onChange={(e) =>
                setAppliesTo(e.target.value === 'speaker' ? 'speaker' : 'session')
              }
            />
          </Field>
        </div>
        <div>
          <Button iconLeft="plus" onClick={addItem} disabled={lib.pending}>
            {lib.pending ? 'Working…' : 'Add field'}
          </Button>
        </div>
      </div>
      <RemoveConfirm
        target={lib.confirming}
        onCancel={() => lib.askRemove(null)}
        onConfirm={lib.remove}
      />
    </LibraryShell>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
      {children}
    </p>
  )
}

function blankToNull(value: string) {
  return value.trim() === '' ? null : value.trim()
}

const twoCol: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
  gap: 'var(--space-4)',
}

const dateRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
}
