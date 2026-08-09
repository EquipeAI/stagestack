import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Doc } from '@convex/_generated/dataModel'
import type * as React from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
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
      <LibrarySections eventSlug={eventSlug} />
    </div>
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
  const [name, setName] = useState(event.name)
  const [type, setType] = useState(event.type ?? '')
  const [location, setLocation] = useState(event.location ?? '')
  const [website, setWebsite] = useState(event.website ?? '')
  const [description, setDescription] = useState(event.description ?? '')

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
    })
  }

  return (
    <Card
      title="Details"
      subtitle="What this event is, and where to send people."
      footer={<SectionFooter pending={pending} error={error} onSave={save} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Field label="Name" htmlFor="s-name">
          <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div style={twoCol}>
          <Field
            label="Type"
            htmlFor="s-type"
            optional
            hint="e.g. Conference, Summit, Meetup."
          >
            <Input id="s-type" value={type} onChange={(e) => setType(e.target.value)} />
          </Field>
          <Field label="Location" htmlFor="s-location" optional>
            <Input
              id="s-location"
              value={location}
              placeholder="San Francisco, CA"
              onChange={(e) => setLocation(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Website" htmlFor="s-website" optional>
          <Input
            id="s-website"
            type="url"
            value={website}
            placeholder="https://example.com"
            onChange={(e) => setWebsite(e.target.value)}
          />
        </Field>
        <Field label="Description" htmlFor="s-description" optional>
          <Textarea
            id="s-description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
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
  const [slug, setSlug] = useState(event.slug)

  const save = () => {
    const next = slug.trim()
    if (next === '') return setError('The slug cannot be empty.')
    if (next === event.slug) return setError('That is already the slug.')
    void run(async () => {
      await update({ eventSlug, patch: { slug: next } })
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
        <Field label="Slug" htmlFor="s-slug" hint={`stagestack.dev/e/${slug.trim()}`}>
          <Input
            id="s-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
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
  const [timezone, setTimezone] = useState(event.timezone)
  const [startsAt, setStartsAt] = useState(
    toInputValue(event.startsAt, event.timezone),
  )
  const [endsAt, setEndsAt] = useState(toInputValue(event.endsAt, event.timezone))
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
    })
  }

  return (
    <Card
      title="Dates"
      subtitle="Event time is authoritative — every screen states this zone."
      footer={<SectionFooter pending={pending} error={error} onSave={save} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={twoCol}>
          <Field label="Starts" htmlFor="s-starts">
            <Input
              id="s-starts"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </Field>
          <Field label="Ends" htmlFor="s-ends">
            <Input
              id="s-ends"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
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
            onChange={(e) => setTimezone(e.target.value)}
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
  const [openAt, setOpenAt] = useState(toInputValue(event.cfpOpenAt, event.timezone))
  const [closeAt, setCloseAt] = useState(
    toInputValue(event.cfpCloseAt, event.timezone),
  )
  const [published, setPublished] = useState(event.cfpPublished)

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
                onChange={(e) => setOpenAt(e.target.value)}
              />
              <Button size="sm" onClick={() => setOpenAt('')} disabled={openAt === ''}>
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
                onChange={(e) => setCloseAt(e.target.value)}
              />
              <Button
                size="sm"
                onClick={() => setCloseAt('')}
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
          onChange={(e) => setPublished(e.target.checked)}
        />
        <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
          Publishing makes the public CFP page reachable. The form builder
          arrives with M1.
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

function useLibrary(eventSlug: string) {
  const add = useMutation(api.library.add)
  const remove = useMutation(api.library.remove)
  const { pending, error, setError, run } = usePending()
  return { add, remove, pending, error, setError, run, eventSlug }
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
              removing={lib.pending}
              onRemove={() => {
                void lib.run(() =>
                  lib.remove({ eventSlug, table: 'tracks', id: item._id }),
                )
              }}
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
              onRemove={() => {
                void lib.run(() =>
                  lib.remove({ eventSlug, table: 'tags', id: item._id }),
                )
              }}
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
    const parsed = capacity.trim() === '' ? undefined : Number(capacity)
    if (parsed !== undefined && !Number.isFinite(parsed)) {
      return lib.setError('Capacity must be a number.')
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
              removing={lib.pending}
              onRemove={() => {
                void lib.run(() =>
                  lib.remove({ eventSlug, table: 'rooms', id: item._id }),
                )
              }}
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
              removing={lib.pending}
              onRemove={() => {
                void lib.run(() =>
                  lib.remove({ eventSlug, table: 'customFields', id: item._id }),
                )
              }}
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
