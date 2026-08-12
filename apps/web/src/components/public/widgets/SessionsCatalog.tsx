import { useMemo } from 'react'
import {
  FilterChips,
  IconLine,
  ShowMoreText,
  accentOr,
  allSessions,
  byStartTime,
  distinct,
  matchesQuery,
  sessionWhen,
  speakerAffiliation,
} from './shared'
import type * as React from 'react'
import type { PublicProgram, PublicSession } from '@convex/model/publish'
import type { PublicSearchController } from '~/lib/publicSearch'
import { clearSearchKeys, useSearchState } from '~/lib/publicSearch'
import { Avatar, Badge, Button, SearchInput, Tag } from '~/ds'

// EMB-01..03 — filterable session catalog for external embedding. Derives
// everything from the published program prop; no backend calls.

function CatalogCard({
  session,
  zone,
  accent,
}: {
  session: PublicSession
  zone: string
  accent?: string
}) {
  const when = sessionWhen(session, zone)
  return (
    <article
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--pad-card)',
        background: 'var(--surface-card)',
        border: 'var(--space-px) solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        boxShadow: 'var(--shadow-xs)',
        height: '100%',
      }}
    >
      {session.format !== undefined || session.trackName !== undefined ? (
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}
        >
          {session.format !== undefined ? (
            <Badge tone="neutral">{session.format}</Badge>
          ) : null}
          {session.trackName !== undefined ? (
            <Tag color={accentOr(accent)}>{session.trackName}</Tag>
          ) : null}
        </div>
      ) : null}
      <h3
        style={{
          font: 'var(--type-title-3)',
          letterSpacing: 'var(--tracking-tight)',
          color: 'var(--text-primary)',
          margin: 'var(--space-0)',
        }}
      >
        {session.title}
      </h3>
      {session.description !== undefined ? (
        <ShowMoreText text={session.description} clampChars={200} />
      ) : null}
      {when !== undefined || session.roomName !== undefined ? (
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
      ) : null}
      {session.speakers.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
            marginTop: 'auto',
            paddingTop: 'var(--space-1)',
          }}
        >
          {session.speakers.map((sp) => {
            const affiliation = speakerAffiliation(sp)
            return (
              <div
                key={sp.speakerId}
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  alignItems: 'center',
                  minWidth: 0,
                }}
              >
                <Avatar name={sp.name} src={sp.headshotUrl} size={28} />
                <span
                  style={{
                    font: 'var(--type-label)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {sp.name}
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
              </div>
            )
          })}
        </div>
      ) : null}
    </article>
  )
}

export function SessionsCatalog({
  program,
  accent,
  url,
}: {
  program: PublicProgram
  accent?: string
  /** Present on the public page, where filters are URL state; absent inside an
   * embed iframe, which does not own the address bar (W5). */
  url?: PublicSearchController
}) {
  const zone = program.event.timezone
  // Card per lineup session; when only the agenda is published, fall back to
  // the agenda's sessions so the widget never renders empty for no reason.
  const sessions = useMemo(() => {
    const base =
      program.lineup.length > 0
        ? allSessions(program).filter((s) =>
            program.lineup.some((l) => l.sessionId === s.sessionId),
          )
        : allSessions(program)
    return [...base].sort(byStartTime)
  }, [program])

  const [queryValue, setQueryValue] = useSearchState(url, 'q')
  const query = queryValue ?? ''
  const setQuery = (next: string) => setQueryValue(next === '' ? null : next)
  const [track, setTrack] = useSearchState(url, 'track')
  const [format, setFormat] = useSearchState(url, 'format')
  const [room, setRoom] = useSearchState(url, 'room')

  const tracks = useMemo(
    () => distinct(sessions.map((s) => s.trackName)),
    [sessions],
  )
  const formats = useMemo(
    () => distinct(sessions.map((s) => s.format)),
    [sessions],
  )
  const rooms = useMemo(
    () => distinct(sessions.map((s) => s.roomName)),
    [sessions],
  )

  const filtered = sessions.filter(
    (s) =>
      matchesQuery(query, [s.title, ...s.speakers.map((sp) => sp.name)]) &&
      (track === null || s.trackName === track) &&
      (format === null || s.format === format) &&
      (room === null || s.roomName === room),
  )
  const hasFilters =
    query.trim() !== '' || track !== null || format !== null || room !== null

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
            aria-label="Search sessions and speakers"
            placeholder="Search sessions and speakers"
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setQuery(e.target.value)
            }
          />
        </div>
        <span
          role="status"
          style={{ font: 'var(--type-mono)', color: 'var(--text-tertiary)' }}
        >
          {filtered.length} of {sessions.length} session
          {sessions.length === 1 ? '' : 's'}
        </span>
        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // One patch, so Back undoes the whole clear rather than
              // restoring three quarters of it (W5).
              clearSearchKeys(url, ['q', 'track', 'format', 'room'], () => {
                setQuery('')
                setTrack(null)
                setFormat(null)
                setRoom(null)
              })
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
      >
        <FilterChips
          label="Track"
          options={tracks}
          value={track}
          onChange={setTrack}
          accent={accent}
        />
        <FilterChips
          label="Format"
          options={formats}
          value={format}
          onChange={setFormat}
          accent={accent}
        />
        <FilterChips
          label="Room"
          options={rooms}
          value={room}
          onChange={setRoom}
          accent={accent}
        />
      </div>
      {filtered.length === 0 ? (
        <p
          role="status"
          style={{
            font: 'var(--type-body)',
            color: 'var(--text-tertiary)',
            margin: 'var(--space-0)',
          }}
        >
          No sessions match. Clear the search or filters to see the full
          program.
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gap: 'var(--space-4)',
            gridTemplateColumns:
              'repeat(auto-fill, minmax(min(100%, 20rem), 1fr))',
            alignItems: 'stretch',
          }}
        >
          {filtered.map((session) => (
            <CatalogCard
              key={session.sessionId}
              session={session}
              zone={zone}
              accent={accent}
            />
          ))}
        </div>
      )}
    </section>
  )
}
