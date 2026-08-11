import { useMemo, useState } from 'react'
import {
  IconLine,
  PublicSpeakerAvatar,
  ShowMoreText,
  matchesQuery,
  sessionWhen,
  speakerAffiliation,
  speakerEntries,
} from './shared'
import type * as React from 'react'
import type { PublicProgram } from '@convex/model/publish'
import type { SpeakerEntry } from './shared'
import { Dialog, Icon, SearchInput } from '~/ds'

// EMB-04/05 — speaker directory: everyone across lineup + agenda, deduped by
// speakerId and ordered alphabetically by surname. Clicking an entry opens a
// detail dialog (bio, links, sessions); closing restores the list.

const LINK_LABELS: Record<string, string> = {
  website: 'Website',
  twitter: 'Twitter',
  linkedin: 'LinkedIn',
  github: 'GitHub',
}

function SpeakerLinks({ entry }: { entry: SpeakerEntry }) {
  const links = entry.speaker.links
  if (links === undefined) return null
  const pairs = Object.entries(LINK_LABELS)
    .map(([key, label]) => ({
      label,
      href: links[key as keyof typeof links],
      icon: key === 'website' ? 'globe' : 'link',
    }))
    .filter((p): p is { label: string; href: string; icon: string } =>
      Boolean(p.href),
    )
  if (pairs.length === 0) return null
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--space-2) var(--space-4)',
      }}
    >
      {pairs.map((p) => (
        <a
          key={p.label}
          href={p.href}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            font: 'var(--type-caption)',
            color: 'var(--text-link)',
            textDecoration: 'none',
          }}
        >
          <Icon name={p.icon} size={14} />
          {p.label}
        </a>
      ))}
    </div>
  )
}

function SpeakerDetail({ entry, zone }: { entry: SpeakerEntry; zone: string }) {
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
          alignItems: 'center',
        }}
      >
        <PublicSpeakerAvatar speaker={entry.speaker} size={64} />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
            minWidth: 0,
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
          {affiliation !== undefined ? (
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
      <SpeakerLinks entry={entry} />
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

export function SpeakersDirectory({
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
            display: 'flex',
            flexDirection: 'column',
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
                  gap: 'var(--space-3)',
                  alignItems: 'center',
                  padding: 'var(--space-3) var(--space-2)',
                  borderTop: 'var(--space-px) solid var(--border-subtle)',
                  borderRight: 'none',
                  borderBottom: 'none',
                  borderLeft: 'none',
                  background: 'none',
                  textAlign: 'left',
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                <PublicSpeakerAvatar speaker={entry.speaker} size={40} />
                <span
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-1)',
                    minWidth: 0,
                  }}
                >
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
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    color: accent ?? 'var(--text-tertiary)',
                    display: 'inline-flex',
                  }}
                >
                  <Icon name="chevron-right" size={16} />
                </span>
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
          <SpeakerDetail entry={selected} zone={zone} />
        </Dialog>
      ) : null}
    </section>
  )
}
