import { useEffect, useState } from 'react'
import { useAuth } from '@clerk/tanstack-react-start'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { optionalText, personName } from './model'
import type { Id } from '@convex/_generated/dataModel'
import type * as React from 'react'
import type { PortalProfile } from './model'
import { Avatar, Button, Callout, Card, Field, Input, Textarea } from '~/ds'
import { usePending } from '~/lib/usePending'
import { errorMessage } from '~/lib/errors'
import { pushToast } from '~/components/toast'
import { FileButton } from '~/components/FileButton'
import { isSupportedHeadshot, uploadHeadshot } from '~/lib/headshotUpload'
import {
  ActionError,
  ButtonRow,
  FieldRow,
  PreviewLock,
} from '~/components/portal/PortalChrome'

// Self-editing the publishable profile — the portal's second job, and the one
// organizers otherwise do by hand from email threads.
//
// `portal.updateMyProfile` takes the WHOLE profile: an omitted optional is a
// removal, so every field is prefilled from the current snapshot and every
// save sends all of them.

type Draft = {
  firstName: string
  lastName: string
  tagline: string
  jobTitle: string
  company: string
  bio: string
  website: string
  twitter: string
  linkedin: string
  github: string
}

function draftFrom(profile: PortalProfile): Draft {
  return {
    firstName: profile.firstName,
    lastName: profile.lastName,
    tagline: profile.tagline ?? '',
    jobTitle: profile.jobTitle ?? '',
    company: profile.company ?? '',
    bio: profile.bio ?? '',
    website: profile.links?.website ?? '',
    twitter: profile.links?.twitter ?? '',
    linkedin: profile.links?.linkedin ?? '',
    github: profile.links?.github ?? '',
  }
}

/** Text/link identity of the row. Headshot changes intentionally do not reset
 * an in-progress text edit. */
export function profileDraftServerKey(profile: PortalProfile): string {
  return JSON.stringify([
    profile._id,
    profile.firstName,
    profile.lastName,
    profile.tagline,
    profile.jobTitle,
    profile.company,
    profile.bio,
    profile.links,
  ])
}

/** Headshot identity gets its own reactive lane so upload/remove responses can
 * clear a local preview without overwriting the draft form. */
export function profileHeadshotServerKey(profile: PortalProfile): string {
  return JSON.stringify([profile._id, profile.headshotId, profile.headshotUrl])
}

export function ProfileCard({
  eventSlug,
  profile,
  readOnly,
  children,
}: {
  eventSlug: string
  profile: PortalProfile
  readOnly: boolean
  /** The sessions this snapshot speaks at — listed so the scope is obvious. */
  children?: React.ReactNode
}) {
  const { getToken } = useAuth()
  const updateProfile = useMutation(api.portal.updateMyProfile)
  const removeHeadshot = useMutation(api.portal.removeMyHeadshot)
  const beginHeadshotUpload = useMutation(api.portal.beginHeadshotUpload)
  const attachHeadshot = useMutation(api.portal.attachHeadshot)
  const discardHeadshot = useMutation(api.portal.discardHeadshotUpload)
  const { pending, error, setError, run } = usePending({ announce: false })

  const draftKey = profileDraftServerKey(profile)
  const headshotKey = profileHeadshotServerKey(profile)
  const [draft, setDraft] = useState<Draft>(() => draftFrom(profile))
  const [localPhoto, setLocalPhoto] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  // Text changes re-seed the form, but a reactive photo attach/remove preserves
  // any unsaved text the speaker is still editing.
  useEffect(() => {
    setDraft(draftFrom(profile))
  }, [draftKey])

  useEffect(() => {
    setLocalPhoto(null)
  }, [headshotKey])

  const patch = (values: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...values }))
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(profile))

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
        eventContactId: profile._id,
        contentType: file.type,
        size: file.size,
        filename: file.name,
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
        eventContactId: profile._id,
        uploadId,
      })
      setLocalPhoto(URL.createObjectURL(file))
      pushToast(
        'Photo saved',
        'The headshot is attached now. Other unsaved profile edits are still here.',
        'check',
      )
    } catch (err) {
      if (uploadId !== undefined) {
        await discardHeadshot({
          eventSlug,
          eventContactId: profile._id,
          uploadId,
        }).catch(() => undefined)
      }
      setError(errorMessage(err, 'That photo could not be uploaded.'))
    } finally {
      setUploading(false)
    }
  }

  const save = () => {
    if (draft.firstName.trim().length === 0) {
      return setError('Your first name is required — it is how you are listed.')
    }
    const links = {
      website: optionalText(draft.website),
      twitter: optionalText(draft.twitter),
      linkedin: optionalText(draft.linkedin),
      github: optionalText(draft.github),
    }
    const anyLink = Object.values(links).some((value) => value !== undefined)
    void run(async () => {
      await updateProfile({
        eventSlug,
        eventContactId: profile._id,
        profile: {
          firstName: draft.firstName.trim(),
          lastName: draft.lastName.trim(),
          tagline: optionalText(draft.tagline),
          jobTitle: optionalText(draft.jobTitle),
          company: optionalText(draft.company),
          bio: optionalText(draft.bio),
          links: anyLink ? links : undefined,
        },
      })
      pushToast(
        'Profile saved',
        'The organizers see this version now, and your reusable profile was refreshed.',
        'check',
      )
    })
  }

  const idBase = `profile-${profile._id}`
  const disabled = readOnly || pending || uploading
  const photo = localPhoto ?? profile.headshotUrl ?? undefined

  return (
    <Card
      title={personName(profile) || 'Your speaker profile'}
      subtitle="This is exactly what the organizers can publish for this event. It also updates your reusable profile for future events."
      actions={<Avatar name={personName(profile)} src={photo} size={44} />}
      footer={
        <ButtonRow>
          <span
            // Dirty→saved is only signalled here, so it has to be spoken.
            role="status"
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-tertiary)',
              marginRight: 'auto',
            }}
          >
            {readOnly
              ? 'Read-only preview'
              : dirty
                ? 'Unsaved changes'
                : 'Saved'}
          </span>
          {readOnly ? (
            <PreviewLock>
              <Button variant="primary" disabled>
                Save profile
              </Button>
            </PreviewLock>
          ) : (
            <Button
              variant="primary"
              disabled={disabled || !dirty}
              onClick={save}
            >
              {pending ? 'Saving…' : 'Save profile'}
            </Button>
          )}
        </ButtonRow>
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

        {children}

        <FieldRow>
          <Field label="First name" htmlFor={`${idBase}-first`} required>
            <Input
              id={`${idBase}-first`}
              value={draft.firstName}
              disabled={disabled}
              autoComplete="given-name"
              onChange={(e) => {
                patch({ firstName: e.target.value })
              }}
            />
          </Field>
          <Field label="Last name" htmlFor={`${idBase}-last`}>
            <Input
              id={`${idBase}-last`}
              value={draft.lastName}
              disabled={disabled}
              autoComplete="family-name"
              onChange={(e) => {
                patch({ lastName: e.target.value })
              }}
            />
          </Field>
        </FieldRow>

        <Field
          label="Tagline"
          htmlFor={`${idBase}-tagline`}
          hint="One line: role and company, as it should appear in the program."
        >
          <Input
            id={`${idBase}-tagline`}
            value={draft.tagline}
            disabled={disabled}
            autoComplete="off"
            placeholder="Head of Platform, Example"
            onChange={(e) => {
              patch({ tagline: e.target.value })
            }}
          />
        </Field>

        <FieldRow>
          <Field
            label="Job title"
            htmlFor={`${idBase}-jobtitle`}
            hint="Used where the program lists structured fields."
          >
            <Input
              id={`${idBase}-jobtitle`}
              value={draft.jobTitle}
              disabled={disabled}
              autoComplete="organization-title"
              onChange={(e) => {
                patch({ jobTitle: e.target.value })
              }}
            />
          </Field>
          <Field label="Company" htmlFor={`${idBase}-company`}>
            <Input
              id={`${idBase}-company`}
              value={draft.company}
              disabled={disabled}
              autoComplete="organization"
              onChange={(e) => {
                patch({ company: e.target.value })
              }}
            />
          </Field>
        </FieldRow>

        <Field
          label="Bio"
          htmlFor={`${idBase}-bio`}
          hint="Written in the third person reads best in a program."
        >
          <Textarea
            id={`${idBase}-bio`}
            rows={6}
            value={draft.bio}
            disabled={disabled}
            onChange={(e) => {
              patch({ bio: e.target.value })
            }}
          />
        </Field>

        <Field
          label="Headshot"
          hint="Square images crop best. Where a headshot is missing, your initials are used."
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <Avatar name={personName(profile)} src={photo} size={64} />
            {readOnly ? (
              <PreviewLock>
                <Button size="sm" iconLeft="upload" disabled>
                  Upload a photo
                </Button>
              </PreviewLock>
            ) : uploading || pending ? (
              <Button size="sm" iconLeft="upload" disabled>
                {uploading ? 'Uploading…' : 'Upload a photo'}
              </Button>
            ) : (
              <FileButton
                size="sm"
                iconLeft="upload"
                accept="image/jpeg,image/png,image/webp"
                onFile={(file) => {
                  void upload(file)
                }}
              >
                {photo === undefined ? 'Upload a photo' : 'Replace photo'}
              </FileButton>
            )}
            {photo !== undefined && !readOnly ? (
              <Button
                size="sm"
                variant="ghost"
                iconLeft="trash-2"
                disabled={disabled}
                onClick={() => {
                  void run(async () => {
                    await removeHeadshot({
                      eventSlug,
                      eventContactId: profile._id,
                    })
                    setLocalPhoto(null)
                    pushToast(
                      'Photo removed',
                      'The headshot was removed from this event profile.',
                      'check',
                    )
                  })
                }}
              >
                Remove photo
              </Button>
            ) : null}
          </div>
        </Field>

        {localPhoto !== null ? (
          <Callout tone="info" title="Photo saved">
            The headshot is attached now. Other profile edits still need Save
            profile.
          </Callout>
        ) : null}

        <FieldRow>
          <Field label="Website" htmlFor={`${idBase}-website`}>
            <Input
              id={`${idBase}-website`}
              type="url"
              placeholder="https://"
              value={draft.website}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => {
                patch({ website: e.target.value })
              }}
            />
          </Field>
          <Field label="LinkedIn" htmlFor={`${idBase}-linkedin`}>
            <Input
              id={`${idBase}-linkedin`}
              value={draft.linkedin}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => {
                patch({ linkedin: e.target.value })
              }}
            />
          </Field>
          <Field label="X" htmlFor={`${idBase}-twitter`}>
            <Input
              id={`${idBase}-twitter`}
              value={draft.twitter}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => {
                patch({ twitter: e.target.value })
              }}
            />
          </Field>
          <Field label="GitHub" htmlFor={`${idBase}-github`}>
            <Input
              id={`${idBase}-github`}
              value={draft.github}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => {
                patch({ github: e.target.value })
              }}
            />
          </Field>
        </FieldRow>
      </div>
    </Card>
  )
}
