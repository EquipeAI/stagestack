import { useEffect, useMemo, useState } from 'react'
import {
  FilterChips,
  IconLine,
  ShowMoreText,
  accentOr,
  allSessions,
  byStartTime,
  dayKeyOf,
  dayLabelOf,
  distinct,
  fmtTime,
  matchesQuery,
  sessionWhen,
  speakerAffiliation,
} from './shared'
import type * as React from 'react'
import type { PublicProgram, PublicSession } from '@convex/model/publish'
import { Avatar, Badge, Button, Icon, SearchInput, Tag } from '~/ds'

// EMB-09..11 — attendee itinerary: chronological sessions with time-group
// headers, search + track filter, and a personal schedule starred into
// localStorage (scoped per event slug) with a client-side .ics export.

const UNSCHEDULED = 'unscheduled'

function storageKey(slug: string) {
  return `ss-myschedule-${slug}`
}

function readStarred(slug: string): Array<string> {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(storageKey(slug))
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string')
      : []
  } catch {
    return []
  }
}

function writeStarred(slug: string, ids: Array<string>) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey(slug), JSON.stringify(ids))
  } catch {
    // Storage full or blocked — the in-memory schedule still works.
  }
}

// ── .ics generation (local, dependency-free) ──────────────────────────────
function icsEscape(s: string) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** Epoch ms → UTC basic format `YYYYMMDDTHHMMSSZ`. */
function icsUtc(ms: number) {
  return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`
}

function buildIcs(sessions: Array<PublicSession>, eventName: string) {
  const now = icsUtc(Date.now())
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//StageStack//My schedule//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsEscape(`${eventName} — my schedule`)}`,
  ]
  for (const session of sessions) {
    if (session.startsAt === undefined) continue
    lines.push(
      'BEGIN:VEVENT',
      `UID:${session.sessionId}@stagestack`,
      `DTSTAMP:${now}`,
      `DTSTART:${icsUtc(session.startsAt)}`,
      `DTEND:${icsUtc(session.endsAt ?? session.startsAt + 3_600_000)}`,
      `SUMMARY:${icsEscape(session.title)}`,
    )
    if (session.roomName !== undefined) {
      lines.push(`LOCATION:${icsEscape(session.roomName)}`)
    }
    if (session.description !== undefined) {
      lines.push(`DESCRIPTION:${icsEscape(session.description)}`)
    }
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

function downloadIcs(sessions: Array<PublicSession>, program: PublicProgram) {
  if (typeof window === 'undefined') return
  const blob = new Blob([buildIcs(sessions, program.event.name)], {
    type: 'text/calendar;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${program.event.slug}-my-schedule.ics`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// ── cards ─────────────────────────────────────────────────────────────────
function ItineraryCard({
  session,
  zone,
  accent,
  starred,
  onToggle,
}: {
  session: PublicSession
  zone: string
  accent?: string
  starred: boolean
  onToggle: () => void
}) {
  const color = accentOr(accent)
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
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 'var(--space-3)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
            minWidth: 0,
            flex: '1 1 auto',
          }}
        >
          {session.format !== undefined || session.trackName !== undefined ? (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--space-2)',
              }}
            >
              {session.trackName !== undefined ? (
                <Tag color={color}>{session.trackName}</Tag>
              ) : null}
              {session.format !== undefined ? (
                <Badge tone="neutral">{session.format}</Badge>
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
        </div>
        <button
          type="button"
          aria-pressed={starred}
          aria-label={
            starred ? 'Remove from my schedule' : 'Add to my schedule'
          }
          onClick={onToggle}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            padding: 'var(--space-1) var(--space-2)',
            borderRadius: 'var(--radius-full)',
            border: 'var(--space-px) solid',
            borderColor: starred ? color : 'var(--border-default)',
            background: 'var(--surface-card)',
            font: 'var(--type-caption)',
            color: starred ? 'var(--text-primary)' : 'var(--text-secondary)',
            cursor: 'pointer',
            flex: 'none',
          }}
        >
          <span
            style={{ color: starred ? color : 'inherit', display: 'inline-flex' }}
          >
            <Icon name="star" size={14} />
          </span>
          {starred ? 'Added' : 'Add'}
        </button>
      </div>
      {session.description !== undefined ? (
        <ShowMoreText text={session.description} clampChars={220} />
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

/** Sessions of one day, grouped under their start-time headers. */
function TimeGroupedList({
  sessions,
  zone,
  accent,
  starredIds,
  onToggle,
}: {
  sessions: Array<PublicSession>
  zone: string
  accent?: string
  starredIds: Array<string>
  onToggle: (id: string) => void
}) {
  const groups: Array<{ label: string; sessions: Array<PublicSession> }> = []
  for (const session of sessions) {
    const label =
      session.startsAt !== undefined
        ? fmtTime(session.startsAt, zone)
        : 'Time to be announced'
    let group = groups.find((g) => g.label === label)
    if (group === undefined) {
      group = { label, sessions: [] }
      groups.push(group)
    }
    group.sessions.push(session)
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      {groups.map((group) => (
        <div
          key={group.label}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          <span
            style={{
              font: 'var(--type-mono)',
              color: 'var(--text-secondary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {group.label}
          </span>
          {group.sessions.map((session) => (
            <ItineraryCard
              key={session.sessionId}
              session={session}
              zone={zone}
              accent={accent}
              starred={starredIds.includes(session.sessionId)}
              onToggle={() => onToggle(session.sessionId)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export function Itinerary({
  program,
  accent,
}: {
  program: PublicProgram
  accent?: string
}) {
  const zone = program.event.timezone
  const slug = program.event.slug
  const sessions = useMemo(
    () => [...allSessions(program)].sort(byStartTime),
    [program],
  )

  const [query, setQuery] = useState('')
  const [track, setTrack] = useState<string | null>(null)
  const [myOnly, setMyOnly] = useState(false)
  // localStorage is read after mount only, so the server and first client
  // render agree (SSR safety).
  const [starredIds, setStarredIds] = useState<Array<string>>([])
  useEffect(() => {
    setStarredIds(readStarred(slug))
  }, [slug])

  const toggleStar = (id: string) => {
    setStarredIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((v) => v !== id)
        : [...prev, id]
      writeStarred(slug, next)
      return next
    })
  }

  const tracks = useMemo(
    () => distinct(sessions.map((s) => s.trackName)),
    [sessions],
  )

  const visible = sessions.filter(
    (s) =>
      (!myOnly || starredIds.includes(s.sessionId)) &&
      matchesQuery(query, [s.title, ...s.speakers.map((sp) => sp.name)]) &&
      (track === null || s.trackName === track),
  )

  // Day sections from the visible sessions; unscheduled ones get their own.
  const days: Array<{
    key: string
    label: string
    sessions: Array<PublicSession>
  }> = []
  for (const session of visible) {
    const key =
      session.startsAt !== undefined
        ? dayKeyOf(session.startsAt, zone)
        : UNSCHEDULED
    let day = days.find((d) => d.key === key)
    if (day === undefined) {
      day = {
        key,
        label:
          session.startsAt !== undefined
            ? dayLabelOf(session.startsAt, zone)
            : 'Date to be announced',
        sessions: [],
      }
      days.push(day)
    }
    day.sessions.push(session)
  }

  const starredSessions = sessions.filter((s) =>
    starredIds.includes(s.sessionId),
  )
  const exportable = starredSessions.filter((s) => s.startsAt !== undefined)

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
            placeholder="Search sessions and speakers"
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setQuery(e.target.value)
            }
          />
        </div>
        <Button
          variant={myOnly ? 'primary' : 'secondary'}
          size="sm"
          iconLeft="star"
          onClick={() => setMyOnly((v) => !v)}
        >
          My schedule ({starredSessions.length})
        </Button>
        {myOnly ? (
          <Button
            variant="secondary"
            size="sm"
            iconLeft="download"
            disabled={exportable.length === 0}
            onClick={() => downloadIcs(exportable, program)}
          >
            Export my schedule (.ics)
          </Button>
        ) : null}
      </div>
      <FilterChips
        label="Track"
        options={tracks}
        value={track}
        onChange={setTrack}
        accent={accent}
      />
      {visible.length === 0 ? (
        <p
          style={{
            font: 'var(--type-body)',
            color: 'var(--text-tertiary)',
            margin: 'var(--space-0)',
          }}
        >
          {myOnly
            ? 'Your schedule is empty. Add sessions with the star on each card.'
            : 'No sessions match. Clear the search or filters to see the full program.'}
        </p>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-8)',
          }}
        >
          {days.map((day) => (
            <div
              key={day.key}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
              }}
            >
              <h3
                style={{
                  font: 'var(--type-heading)',
                  color: 'var(--text-primary)',
                  margin: 'var(--space-0)',
                }}
              >
                {day.label}
              </h3>
              <TimeGroupedList
                sessions={day.sessions}
                zone={zone}
                accent={accent}
                starredIds={starredIds}
                onToggle={toggleStar}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
