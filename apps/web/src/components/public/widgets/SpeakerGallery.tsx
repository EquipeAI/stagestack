import { useMemo, useState } from 'react'
import {
  IconLine,
  ShowMoreText,
  accentOr,
  initialsOf,
  matchesQuery,
  sessionWhen,
  speakerAffiliation,
  speakerEntries,
} from './shared'
import type * as React from 'react'
import type { PublicProgram } from '@convex/model/publish'
import type { SpeakerEntry } from './shared'
import { Dialog, SearchInput } from '~/ds'

// EMB-12/13 — photo-forward speaker gallery: big square headshots with an
// initials fallback, alphabetized by surname, name search, and a detail modal
// per speaker. Distinct look from the compact SpeakersDirectory list.

function Headshot({
  entry,
  accent,
  size,
}: {
  entry: SpeakerEntry
  accent?: string
  size?: number | string
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const common: React.CSSProperties = {
    width: size ?? '100%',
    aspectRatio: '1 / 1',
    borderRadius: 'var(--radius-card)',
    border: 'var(--space-px) solid var(--border-default)',
    display: 'block',
  }
  if (
    entry.speaker.headshotUrl !== undefined &&
    entry.speaker.headshotUrl !== '' &&
    failedSrc !== entry.speaker.headshotUrl
  ) {
    return (
      <img
        src={entry.speaker.headshotUrl}
        alt={entry.speaker.name}
        loading="lazy"
        decoding="async"
        onError={() => setFailedSrc(entry.speaker.headshotUrl ?? null)}
        style={{ ...common, objectFit: 'cover' }}
      />
    )
  }
  return (
    <div
      aria-hidden="true"
      style={{
        ...common,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--surface-hover)',
        color: accentOr(accent),
        font: 'var(--type-title-2)',
        letterSpacing: 'var(--tracking-tight)',
      }}
    >
      {initialsOf(entry.speaker.name)}
    </div>
  )
}

function GalleryDetail({ entry, zone }: { entry: SpeakerEntry; zone: string }) {
  const affiliation = speakerAffiliation(entry.speaker)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-4)',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ width: 'var(--space-32)', flex: 'none' }}>
          <Headshot entry={entry} />
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
            minWidth: 0,
            flex: '1 1 12rem',
          }}
        >
          <span
            style={{
              font: 'var(--type-title-3)',
              letterSpacing: 'var(--tracking-tight)',
              color: 'var(--text-primary)',
            }}
          >
            {entry.speaker.name}
          </span>
          {entry.speaker.jobTitle !== undefined ? (
            <span
              style={{
                font: 'var(--type-body)',
                color: 'var(--text-secondary)',
              }}
            >
              {entry.speaker.jobTitle}
            </span>
          ) : null}
          {entry.speaker.company !== undefined ? (
            <span
              style={{
                font: 'var(--type-body)',
                color: 'var(--text-secondary)',
              }}
            >
              {entry.speaker.company}
            </span>
          ) : null}
          {entry.speaker.jobTitle === undefined &&
          entry.speaker.company === undefined &&
          affiliation !== undefined ? (
            <span
              style={{
                font: 'var(--type-body)',
                color: 'var(--text-secondary)',
              }}
            >
              {affiliation}
            </span>
          ) : null}
        </div>
      </div>
      {entry.speaker.bio !== undefined ? (
        <ShowMoreText text={entry.speaker.bio} clampChars={420} />
      ) : null}
      {entry.sessions.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          <span
            style={{
              font: 'var(--type-eyebrow)',
              letterSpacing: 'var(--tracking-caps)',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
            }}
          >
            Sessions ({entry.sessions.length})
          </span>
          {entry.sessions.map((session) => {
            const when = sessionWhen(session, zone)
            return (
              <div
                key={session.sessionId}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-1)',
                  paddingTop: 'var(--space-2)',
                  borderTop: 'var(--space-px) solid var(--border-subtle)',
                }}
              >
                <span
                  style={{
                    font: 'var(--type-label)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {session.title}
                </span>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 'var(--space-2) var(--space-4)',
                  }}
                >
                  {when !== undefined ? (
                    <IconLine icon="calendar-days" mono>
                      {when}
                    </IconLine>
                  ) : null}
                  {session.roomName !== undefined ? (
                    <IconLine icon="map-pin">{session.roomName}</IconLine>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function SpeakerGallery({
  program,
  accent,
}: {
  program: PublicProgram
  accent?: string
}) {
  const zone = program.event.timezone
  const entries = useMemo(() => speakerEntries(program), [program])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filtered = entries.filter((e) => matchesQuery(query, [e.speaker.name]))
  const selected =
    selectedId !== null ? entries.find((e) => e.key === selectedId) : undefined

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        <div style={{ flex: '1 1 16rem', maxWidth: '24rem' }}>
          <SearchInput
            placeholder="Search speakers"
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setQuery(e.target.value)
            }
          />
        </div>
        <span
          style={{ font: 'var(--type-mono)', color: 'var(--text-tertiary)' }}
        >
          {filtered.length} of {entries.length} speaker
          {entries.length === 1 ? '' : 's'}
        </span>
      </div>
      {filtered.length === 0 ? (
        <p
          style={{
            font: 'var(--type-body)',
            color: 'var(--text-tertiary)',
            margin: 'var(--space-0)',
          }}
        >
          No speakers match that name.
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gap: 'var(--space-5) var(--space-4)',
            gridTemplateColumns:
              'repeat(auto-fill, minmax(min(100%, 11rem), 1fr))',
          }}
        >
          {filtered.map((entry) => {
            const affiliation = speakerAffiliation(entry.speaker)
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => setSelectedId(entry.key)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-0)',
                  border: 'none',
                  background: 'none',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <Headshot entry={entry} accent={accent} />
                <span
                  style={{
                    font: 'var(--type-label)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {entry.speaker.name}
                </span>
                {affiliation !== undefined ? (
                  <span
                    style={{
                      font: 'var(--type-caption)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {affiliation}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}
      {selected !== undefined ? (
        <Dialog
          open
          title={selected.speaker.name}
          width={640}
          onClose={() => setSelectedId(null)}
        >
          <GalleryDetail entry={selected} zone={zone} />
        </Dialog>
      ) : null}
    </section>
  )
}
