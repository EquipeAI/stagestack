import { useState } from 'react'
import { speakerName } from './model'
import type * as React from 'react'
import type { Doc } from '@convex/_generated/dataModel'
import {
  Badge,
  Button,
  Card,
  DescriptionList,
  Field,
  IconButton,
  Input,
  Textarea,
} from '~/ds'

// The speaker list editor, shared by the wizard's Participants step and the
// manage page. Replace-all semantics: the whole list is written on every save,
// so the local draft is the single source of truth while editing.

export const MAX_SPEAKERS = 10

// Social handles are plain text, so the DS Input's per-type mobile defaults do
// not apply — but iOS still autocapitalises and autocorrects them, which turns
// a submitted handle like "alvaro" into "Alvaro" and quietly breaks the link on
// the published program. Handles are case- and spelling-sensitive strings, not
// prose.
const HANDLE_INPUT = {
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
} as const

export type SpeakerDraft = {
  key: string
  firstName: string
  lastName: string
  email: string
  phone: string
  tagline: string
  bio: string
  website: string
  twitter: string
  linkedin: string
  github: string
  isPrimary: boolean
}

let keySeq = 0
function nextKey() {
  keySeq += 1
  return `speaker-${keySeq}`
}

export function emptySpeaker(isPrimary: boolean): SpeakerDraft {
  return {
    key: nextKey(),
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    tagline: '',
    bio: '',
    website: '',
    twitter: '',
    linkedin: '',
    github: '',
    isPrimary,
  }
}

export function speakersFromDocs(
  docs: Array<Doc<'proposalSpeakers'>>,
): Array<SpeakerDraft> {
  if (docs.length === 0) return [emptySpeaker(true)]
  return docs.map((doc, index) => ({
    key: doc._id,
    firstName: doc.firstName,
    lastName: doc.lastName,
    email: doc.email ?? '',
    phone: doc.phone ?? '',
    tagline: doc.tagline ?? '',
    bio: doc.bio ?? '',
    website: doc.links?.website ?? '',
    twitter: doc.links?.twitter ?? '',
    linkedin: doc.links?.linkedin ?? '',
    github: doc.links?.github ?? '',
    isPrimary: doc.isPrimary || index === 0,
  }))
}

type SpeakerInput = {
  firstName: string
  lastName: string
  email?: string
  phone?: string
  tagline?: string
  bio?: string
  links?: {
    website?: string
    twitter?: string
    linkedin?: string
    github?: string
  }
  isPrimary: boolean
}

function trimmed(value: string): string | undefined {
  const out = value.trim()
  return out.length > 0 ? out : undefined
}

export function speakersToInput(
  drafts: Array<SpeakerDraft>,
): Array<SpeakerInput> {
  return drafts.map((draft) => {
    const links = {
      website: trimmed(draft.website),
      twitter: trimmed(draft.twitter),
      linkedin: trimmed(draft.linkedin),
      github: trimmed(draft.github),
    }
    const hasLinks = Object.values(links).some((v) => v !== undefined)
    return {
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      email: trimmed(draft.email),
      phone: trimmed(draft.phone),
      tagline: trimmed(draft.tagline),
      bio: trimmed(draft.bio),
      links: hasLinks ? links : undefined,
      isPrimary: draft.isPrimary,
    }
  })
}

/** The backend rejects a nameless speaker, so an incomplete card is never sent. */
export function speakersComplete(drafts: Array<SpeakerDraft>): boolean {
  return (
    drafts.length > 0 &&
    drafts.every(
      (d) => d.firstName.trim().length > 0 && d.lastName.trim().length > 0,
    )
  )
}

/** Which cards are missing a name — listed in the Review step. */
export function incompleteSpeakers(drafts: Array<SpeakerDraft>): Array<number> {
  return drafts
    .map((d, i) =>
      d.firstName.trim().length > 0 && d.lastName.trim().length > 0 ? -1 : i,
    )
    .filter((i) => i >= 0)
}

export type SelfDetails = {
  firstName: string
  lastName: string
  email: string
}

export function SpeakersEditor({
  speakers,
  onChange,
  disabled = false,
  self,
}: {
  speakers: Array<SpeakerDraft>
  onChange: (next: Array<SpeakerDraft>) => void
  disabled?: boolean
  /** Signed-in user's details, for the "That's me" quick fill. */
  self?: SelfDetails
}) {
  const update = (key: string, patch: Partial<SpeakerDraft>) => {
    onChange(speakers.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  }

  const remove = (key: string) => {
    const next = speakers.filter((s) => s.key !== key)
    // Exactly one primary at all times.
    if (next.length > 0 && !next.some((s) => s.isPrimary)) {
      next[0] = { ...next[0], isPrimary: true }
    }
    onChange(next)
  }

  const makePrimary = (key: string) => {
    onChange(speakers.map((s) => ({ ...s, isPrimary: s.key === key })))
  }

  const add = () => {
    onChange([...speakers, emptySpeaker(speakers.length === 0)])
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      {speakers.map((speaker, index) => (
        <SpeakerCard
          key={speaker.key}
          speaker={speaker}
          index={index}
          disabled={disabled}
          canRemove={speakers.length > 1}
          self={self}
          onPatch={(patch) => {
            update(speaker.key, patch)
          }}
          onRemove={() => {
            remove(speaker.key)
          }}
          onMakePrimary={() => {
            makePrimary(speaker.key)
          }}
        />
      ))}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <Button
          iconLeft="plus"
          onClick={add}
          disabled={disabled || speakers.length >= MAX_SPEAKERS}
        >
          Add speaker
        </Button>
        <span
          style={{
            font: 'var(--type-caption)',
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {speakers.length} of {MAX_SPEAKERS}
        </span>
      </div>
    </div>
  )
}

function SpeakerCard({
  speaker,
  index,
  disabled,
  canRemove,
  self,
  onPatch,
  onRemove,
  onMakePrimary,
}: {
  speaker: SpeakerDraft
  index: number
  disabled: boolean
  canRemove: boolean
  self?: SelfDetails
  onPatch: (patch: Partial<SpeakerDraft>) => void
  onRemove: () => void
  onMakePrimary: () => void
}) {
  const [showLinks, setShowLinks] = useState(
    speaker.website.length > 0 ||
      speaker.twitter.length > 0 ||
      speaker.linkedin.length > 0 ||
      speaker.github.length > 0,
  )
  const idBase = `speaker-${index}`
  const named = speakerName(speaker)

  return (
    <Card
      title={named.length > 0 ? named : `Speaker ${index + 1}`}
      subtitle={
        speaker.isPrimary
          ? 'Lead speaker — listed first in the program. Proposal email goes to your account.'
          : undefined
      }
      actions={
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
        >
          {speaker.isPrimary ? (
            <Badge tone="brand">Primary</Badge>
          ) : (
            <Button size="sm" onClick={onMakePrimary} disabled={disabled}>
              Make primary
            </Button>
          )}
          {canRemove ? (
            <IconButton
              icon="trash-2"
              label={`Remove ${named.length > 0 ? named : `speaker ${index + 1}`}`}
              size="sm"
              onClick={onRemove}
              disabled={disabled}
            />
          ) : null}
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
        {self !== undefined && !disabled ? (
          <div>
            <Button
              size="sm"
              variant="ghost"
              iconLeft="user-round"
              onClick={() => {
                onPatch({
                  firstName: self.firstName,
                  lastName: self.lastName,
                  email: self.email,
                })
              }}
            >
              That&rsquo;s me
            </Button>
          </div>
        ) : null}
        <TwoUp>
          <Field label="First name" htmlFor={`${idBase}-first`} required>
            <Input
              id={`${idBase}-first`}
              value={speaker.firstName}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => {
                onPatch({ firstName: e.target.value })
              }}
            />
          </Field>
          <Field label="Last name" htmlFor={`${idBase}-last`} required>
            <Input
              id={`${idBase}-last`}
              value={speaker.lastName}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => {
                onPatch({ lastName: e.target.value })
              }}
            />
          </Field>
        </TwoUp>
        <TwoUp>
          <Field
            label="Email"
            htmlFor={`${idBase}-email`}
            hint="Used for speaker logistics if the proposal is accepted."
          >
            <Input
              id={`${idBase}-email`}
              type="email"
              value={speaker.email}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => {
                onPatch({ email: e.target.value })
              }}
            />
          </Field>
          <Field label="Phone" htmlFor={`${idBase}-phone`} optional>
            <Input
              id={`${idBase}-phone`}
              type="tel"
              value={speaker.phone}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => {
                onPatch({ phone: e.target.value })
              }}
            />
          </Field>
        </TwoUp>
        <Field
          label="Tagline"
          htmlFor={`${idBase}-tagline`}
          hint="One line: role and company, as it should appear in the program."
        >
          <Input
            id={`${idBase}-tagline`}
            value={speaker.tagline}
            disabled={disabled}
            autoComplete="off"
            onChange={(e) => {
              onPatch({ tagline: e.target.value })
            }}
          />
        </Field>
        <Field label="Bio" htmlFor={`${idBase}-bio`}>
          <Textarea
            id={`${idBase}-bio`}
            rows={4}
            value={speaker.bio}
            disabled={disabled}
            onChange={(e) => {
              onPatch({ bio: e.target.value })
            }}
          />
        </Field>
        {showLinks ? (
          <TwoUp>
            <Field label="Website" htmlFor={`${idBase}-website`}>
              <Input
                id={`${idBase}-website`}
                type="url"
                placeholder="https://"
                value={speaker.website}
                disabled={disabled}
                autoComplete="off"
                onChange={(e) => {
                  onPatch({ website: e.target.value })
                }}
              />
            </Field>
            <Field label="LinkedIn" htmlFor={`${idBase}-linkedin`}>
              <Input
                id={`${idBase}-linkedin`}
                value={speaker.linkedin}
                disabled={disabled}
                autoComplete="off"
                {...HANDLE_INPUT}
                onChange={(e) => {
                  onPatch({ linkedin: e.target.value })
                }}
              />
            </Field>
            <Field label="X" htmlFor={`${idBase}-twitter`}>
              <Input
                id={`${idBase}-twitter`}
                value={speaker.twitter}
                disabled={disabled}
                autoComplete="off"
                {...HANDLE_INPUT}
                onChange={(e) => {
                  onPatch({ twitter: e.target.value })
                }}
              />
            </Field>
            <Field label="GitHub" htmlFor={`${idBase}-github`}>
              <Input
                id={`${idBase}-github`}
                value={speaker.github}
                disabled={disabled}
                autoComplete="off"
                {...HANDLE_INPUT}
                onChange={(e) => {
                  onPatch({ github: e.target.value })
                }}
              />
            </Field>
          </TwoUp>
        ) : (
          <div>
            <Button
              size="sm"
              variant="ghost"
              iconLeft="link"
              disabled={disabled}
              onClick={() => {
                setShowLinks(true)
              }}
            >
              Add links
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}

export function SpeakersSummary({
  speakers,
}: {
  speakers: Array<SpeakerDraft>
}) {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      {speakers.map((speaker, index) => {
        const named = speakerName(speaker)
        return (
          <Card
            key={speaker.key}
            variant="flat"
            title={named.length > 0 ? named : `Speaker ${index + 1}`}
            actions={speaker.isPrimary ? <Badge tone="brand">Primary</Badge> : undefined}
          >
            <DescriptionList
              stacked
              items={[
                { term: 'Email', value: speaker.email || '—' },
                { term: 'Tagline', value: speaker.tagline || '—' },
                {
                  term: 'Bio',
                  value: (
                    <span style={{ whiteSpace: 'pre-wrap' }}>
                      {speaker.bio || '—'}
                    </span>
                  ),
                },
              ]}
            />
          </Card>
        )
      })}
    </div>
  )
}

function TwoUp({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
        gap: 'var(--space-4)',
      }}
    >
      {children}
    </div>
  )
}
