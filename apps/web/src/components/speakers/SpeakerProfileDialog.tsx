import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useAuth } from '@clerk/tanstack-react-start'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Doc, Id } from '@convex/_generated/dataModel'
import type * as React from 'react'
import type { FunctionReturnType } from 'convex/server'
import {
  Avatar,
  Button,
  Callout,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { errorMessage } from '~/lib/errors'
import { pushToast } from '~/components/toast'
import { isSupportedHeadshot, uploadHeadshot } from '~/lib/headshotUpload'

// Organizer-side edit of one speaker's event snapshot (SPK-15 / CNT-10):
// the profile fields the portal lets a speaker edit themselves, plus the
// event's speaker-scoped custom fields (logistics values the speaker never
// sees). One Save writes both surfaces.

export type RosterRow = FunctionReturnType<typeof api.speakers.roster>[number]

type Draft = {
  firstName: string
  lastName: string
  email: string
  jobTitle: string
  company: string
  tagline: string
  bio: string
  website: string
  twitter: string
  linkedin: string
  github: string
}

function draftFrom(row: RosterRow): Draft {
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email ?? '',
    jobTitle: row.jobTitle ?? '',
    company: row.company ?? '',
    tagline: row.tagline ?? '',
    bio: row.bio ?? '',
    website: row.links?.website ?? '',
    twitter: row.links?.twitter ?? '',
    linkedin: row.links?.linkedin ?? '',
    github: row.links?.github ?? '',
  }
}

type CustomValues = Record<string, string | Array<string>>

export function SpeakerProfileDialog({
  eventSlug,
  row,
  customFields,
  archived,
  onClose,
}: {
  eventSlug: string
  row: RosterRow
  /** The event's speaker-scoped custom field definitions, already filtered. */
  customFields: Array<Doc<'customFields'>>
  archived: boolean
  onClose: () => void
}) {
  const { getToken } = useAuth()
  const updateProfile = useMutation(api.speakers.updateProfile)
  const setCustomValues = useMutation(api.speakers.setCustomValues)
  const beginHeadshotUpload = useMutation(api.speakers.beginHeadshotUpload)
  const attachHeadshot = useMutation(api.speakers.attachHeadshot)
  const discardHeadshot = useMutation(api.speakers.discardHeadshotUpload)
  const { pending, error, setError, run } = usePending()

  const [draft, setDraft] = useState<Draft>(() => draftFrom(row))
  const [values, setValues] = useState<CustomValues>(() => ({
    ...row.customValues,
  }))
  const [localPhoto, setLocalPhoto] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const patch = (partial: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...partial }))
  }

  const upload = async (file: File) => {
    if (!isSupportedHeadshot(file)) {
      return setError('Choose a JPEG, PNG, or WebP image for the headshot.')
    }
    if (file.size > 4 * 1024 * 1024) {
      return setError('Source headshots must be 4 MB or smaller.')
    }
    setUploading(true)
    setError(null)
    let uploadId: Id<'headshotUploads'> | undefined
    try {
      const token = await getToken({ template: 'convex' })
      if (token === null) throw new Error('Sign in to upload a headshot.')
      const ticket = await beginHeadshotUpload({
        eventSlug,
        eventContactId: row.eventContactId,
        contentType: file.type,
        size: file.size,
      })
      uploadId = ticket.uploadId
      await uploadHeadshot({
        convexUrl: import.meta.env.VITE_CONVEX_URL,
        convexSiteUrl: import.meta.env.VITE_CONVEX_SITE_URL,
        uploadId,
        token,
        file,
      })
      await attachHeadshot({
        eventSlug,
        eventContactId: row.eventContactId,
        uploadId,
      })
      setLocalPhoto(URL.createObjectURL(file))
      pushToast(
        'Photo saved',
        'The headshot is attached now. Other unsaved speaker edits are still here.',
        'check',
      )
    } catch (err) {
      if (uploadId !== undefined) {
        await discardHeadshot({
          eventSlug,
          eventContactId: row.eventContactId,
          uploadId,
        }).catch(() => undefined)
      }
      setError(errorMessage(err, 'That photo could not be uploaded.'))
    } finally {
      setUploading(false)
    }
  }

  const save = () => {
    if (draft.firstName.trim() === '') {
      return setError(
        'The speaker needs a first name — it is how they are listed.',
      )
    }
    const linkValues = {
      website: draft.website.trim(),
      twitter: draft.twitter.trim(),
      linkedin: draft.linkedin.trim(),
      github: draft.github.trim(),
    }
    void run(async () => {
      await updateProfile({
        eventSlug,
        eventContactId: row.eventContactId,
        patch: {
          firstName: draft.firstName.trim(),
          lastName: draft.lastName.trim(),
          email: draft.email.trim(),
          jobTitle: draft.jobTitle,
          company: draft.company,
          tagline: draft.tagline,
          bio: draft.bio,
          // Prefilled from the roster, so what's on screen IS the truth:
          // clearing a field clears the stored link.
          links: {
            website: linkValues.website === '' ? undefined : linkValues.website,
            twitter: linkValues.twitter === '' ? undefined : linkValues.twitter,
            linkedin:
              linkValues.linkedin === '' ? undefined : linkValues.linkedin,
            github: linkValues.github === '' ? undefined : linkValues.github,
          },
        },
      })
      if (customFields.length > 0) {
        // Only keys that are still speaker fields go back — a stale value for
        // a deleted field would fail the backend's validation.
        const defIds = new Set<string>(customFields.map((def) => def._id))
        const cleaned = Object.fromEntries(
          Object.entries(values).filter(([key]) => defIds.has(key)),
        )
        await setCustomValues({
          eventSlug,
          eventContactId: row.eventContactId,
          values: cleaned,
        })
      }
      pushToast(
        'Speaker saved',
        `${draft.firstName.trim()} ${draft.lastName.trim()}`.trim() +
          "'s profile was updated.",
        'check',
      )
      onClose()
    })
  }

  const name = `${row.firstName} ${row.lastName}`.trim()
  const photo = localPhoto ?? row.headshotUrl ?? undefined
  const disabled = archived || pending || uploading
  const idBase = `speaker-${row.eventContactId}`

  return (
    <Dialog
      open
      width={640}
      title={name === '' ? 'Speaker profile' : name}
      description="Edits land on this event's snapshot immediately — and on the published program once it rebuilds."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={disabled}>
            {pending ? 'Saving…' : 'Save speaker'}
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
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        {archived ? (
          <Callout tone="attention" title="This event is archived">
            Archived events are read-only — unarchive from Overview to edit.
          </Callout>
        ) : null}

        <Field
          label="Headshot"
          hint="Square images crop best. Where a headshot is missing, initials are used."
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <Avatar name={name} src={photo} size={64} />
            {uploading || disabled ? (
              <Button size="sm" iconLeft="upload" disabled>
                {uploading ? 'Uploading…' : 'Upload a photo'}
              </Button>
            ) : (
              <Button as="label" size="sm" iconLeft="upload">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (file !== undefined) void upload(file)
                  }}
                />
                {photo === undefined ? 'Upload a photo' : 'Replace photo'}
              </Button>
            )}
          </div>
          {localPhoto !== null ? (
            <p
              style={{
                margin: 'var(--space-2) 0 0',
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
              }}
            >
              Photo saved. Other edits still need Save speaker.
            </p>
          ) : null}
        </Field>

        <div
          style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}
        >
          <div style={{ flex: '1 1 12rem' }}>
            <Field label="First name" htmlFor={`${idBase}-first`} required>
              <Input
                id={`${idBase}-first`}
                value={draft.firstName}
                disabled={disabled}
                onChange={(e) => {
                  patch({ firstName: e.target.value })
                }}
              />
            </Field>
          </div>
          <div style={{ flex: '1 1 12rem' }}>
            <Field label="Last name" htmlFor={`${idBase}-last`}>
              <Input
                id={`${idBase}-last`}
                value={draft.lastName}
                disabled={disabled}
                onChange={(e) => {
                  patch({ lastName: e.target.value })
                }}
              />
            </Field>
          </div>
        </div>

        <Field
          label="Email"
          htmlFor={`${idBase}-email`}
          hint="Clearing this removes the address from the snapshot."
        >
          <Input
            id={`${idBase}-email`}
            type="email"
            value={draft.email}
            disabled={disabled}
            onChange={(e) => {
              patch({ email: e.target.value })
            }}
          />
        </Field>

        <div
          style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}
        >
          <div style={{ flex: '1 1 12rem' }}>
            <Field label="Job title" htmlFor={`${idBase}-job`}>
              <Input
                id={`${idBase}-job`}
                value={draft.jobTitle}
                disabled={disabled}
                onChange={(e) => {
                  patch({ jobTitle: e.target.value })
                }}
              />
            </Field>
          </div>
          <div style={{ flex: '1 1 12rem' }}>
            <Field label="Company" htmlFor={`${idBase}-company`}>
              <Input
                id={`${idBase}-company`}
                value={draft.company}
                disabled={disabled}
                onChange={(e) => {
                  patch({ company: e.target.value })
                }}
              />
            </Field>
          </div>
        </div>

        <Field
          label="Tagline"
          htmlFor={`${idBase}-tagline`}
          hint="One line: role and company, as it should appear in the program."
        >
          <Input
            id={`${idBase}-tagline`}
            value={draft.tagline}
            disabled={disabled}
            placeholder="Head of Platform, Example"
            onChange={(e) => {
              patch({ tagline: e.target.value })
            }}
          />
        </Field>

        <Field label="Bio" htmlFor={`${idBase}-bio`}>
          <Textarea
            id={`${idBase}-bio`}
            rows={5}
            value={draft.bio}
            disabled={disabled}
            onChange={(e) => {
              patch({ bio: e.target.value })
            }}
          />
        </Field>

        <div
          style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}
        >
          {(
            [
              ['website', 'Website'],
              ['linkedin', 'LinkedIn'],
              ['twitter', 'X'],
              ['github', 'GitHub'],
            ] as const
          ).map(([key, label]) => (
            <div key={key} style={{ flex: '1 1 12rem' }}>
              <Field label={label} htmlFor={`${idBase}-${key}`}>
                <Input
                  id={`${idBase}-${key}`}
                  value={draft[key]}
                  disabled={disabled}
                  placeholder="https://"
                  onChange={(e) => {
                    patch({ [key]: e.target.value })
                  }}
                />
              </Field>
            </div>
          ))}
        </div>
        <span
          style={{
            font: 'var(--type-caption)',
            color: 'var(--text-tertiary)',
          }}
        >
          Links are saved as shown — clear a field to remove that link.
        </span>

        <div
          style={{
            borderTop: 'var(--space-px) solid var(--border-subtle)',
            paddingTop: 'var(--space-4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
          }}
        >
          <span
            style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}
          >
            Custom fields
          </span>
          {customFields.length === 0 ? (
            <span
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
              }}
            >
              This event has no speaker custom fields yet — define them (dietary
              needs, travel booked, …) in{' '}
              <Link to="/app/e/$eventSlug/settings" params={{ eventSlug }}>
                Settings
              </Link>
              .
            </span>
          ) : (
            customFields.map((def) => (
              <CustomFieldInput
                key={def._id}
                def={def}
                value={values[def._id]}
                disabled={disabled}
                onChange={(value) => {
                  setValues((current) => ({ ...current, [def._id]: value }))
                }}
              />
            ))
          )}
        </div>
      </div>
    </Dialog>
  )
}

function CustomFieldInput({
  def,
  value,
  disabled,
  onChange,
}: {
  def: Doc<'customFields'>
  value: string | Array<string> | undefined
  disabled: boolean
  onChange: (value: string | Array<string>) => void
}) {
  const id = `custom-${def._id}`
  if (def.kind === 'multiselect') {
    const selected = Array.isArray(value) ? value : []
    return (
      <Field label={def.name}>
        <div
          role="group"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-3)',
          }}
        >
          {(def.options ?? []).map((option) => (
            <Checkbox
              key={option}
              label={option}
              checked={selected.includes(option)}
              disabled={disabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                onChange(
                  e.target.checked
                    ? [...selected, option]
                    : selected.filter((o) => o !== option),
                )
              }}
            />
          ))}
        </div>
      </Field>
    )
  }
  const text = typeof value === 'string' ? value : ''
  if (def.kind === 'select') {
    return (
      <Field label={def.name} htmlFor={id}>
        <Select
          id={id}
          value={text}
          disabled={disabled}
          options={['', ...(def.options ?? [])]}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
            onChange(e.target.value)
          }}
        />
      </Field>
    )
  }
  return (
    <Field label={def.name} htmlFor={id}>
      <Input
        id={id}
        type={
          def.kind === 'number' ? 'number' : def.kind === 'url' ? 'url' : 'text'
        }
        placeholder={def.kind === 'url' ? 'https://' : undefined}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
    </Field>
  )
}
