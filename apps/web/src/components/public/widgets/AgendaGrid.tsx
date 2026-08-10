import { useMemo, useState } from 'react'
import { DateTime } from 'luxon'
import {
  IconLine,
  ShowMoreText,
  accentOr,
  dayKeyOf,
  dayLabelOf,
  dayTabLabelOf,
  fmtTime,
  speakerAffiliation,
} from './shared'
import type { PublicProgram } from '@convex/model/publish'
import { Avatar, Badge, Dialog, Tabs, Tag } from '~/ds'
import { DATE_LOCALE } from '~/lib/datetime'

// EMB-06..08 — per-day room-columns × time-gutter agenda grid. Lightweight on
// purpose: absolutely-positioned blocks in relative columns, no dependency on
// the internal organizer TimeGrid. Falls back to a time-ordered list per day
// when the program has no rooms at all.

type AgendaEntry = PublicProgram['agenda'][number]
type SessionEntry = Extract<AgendaEntry, { kind: 'session' }>

const HOUR_PX = 88
const HOUR_MS = 3_600_000
const GENERAL = 'General'

function entryStart(entry: AgendaEntry): number | undefined {
  return entry.startsAt
}
function entryEnd(entry: AgendaEntry): number | undefined {
  return entry.endsAt ?? (entry.startsAt !== undefined ? entry.startsAt : undefined)
}

type Day = {
  key: string
  label: string
  tabLabel: string
  entries: Array<AgendaEntry>
}

function groupDays(agenda: Array<AgendaEntry>, zone: string): Array<Day> {
  const days: Array<Day> = []
  for (const entry of agenda) {
    const start = entryStart(entry)
    if (start === undefined) continue // unscheduled sessions never reach the agenda blob
    const key = dayKeyOf(start, zone)
    let day = days.find((d) => d.key === key)
    if (day === undefined) {
      day = {
        key,
        label: dayLabelOf(start, zone),
        tabLabel: dayTabLabelOf(start, zone),
        entries: [],
      }
      days.push(day)
    }
    day.entries.push(entry)
  }
  for (const day of days) {
    day.entries.sort((a, b) => (entryStart(a) ?? 0) - (entryStart(b) ?? 0))
  }
  return days
}

function SessionDialog({
  session,
  zone,
  accent,
  onClose,
}: {
  session: SessionEntry
  zone: string
  accent?: string
  onClose: () => void
}) {
  const start = session.startsAt
  const end = session.endsAt
  return (
    <Dialog open title={session.title} width={640} onClose={onClose}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
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
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-2) var(--space-4)',
          }}
        >
          {start !== undefined ? (
            <IconLine icon="clock" mono>
              {dayLabelOf(start, zone)}, {fmtTime(start, zone)}
              {end !== undefined ? `–${fmtTime(end, zone)}` : ''} ({zone})
            </IconLine>
          ) : null}
          {session.roomName !== undefined ? (
            <IconLine icon="map-pin">{session.roomName}</IconLine>
          ) : null}
        </div>
        {session.description !== undefined ? (
          <ShowMoreText text={session.description} clampChars={420} />
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
        ) : session.toBeAnnounced ? (
          <span
            style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}
          >
            Speaker to be announced
          </span>
        ) : null}
      </div>
    </Dialog>
  )
}

function DayGrid({
  day,
  zone,
  accent,
  onOpen,
}: {
  day: Day
  zone: string
  accent?: string
  onOpen: (session: SessionEntry) => void
}) {
  const color = accentOr(accent)
  const rooms = useMemo(() => {
    const seen: Array<string> = []
    let hasGeneral = false
    for (const entry of day.entries) {
      const room = entry.roomName
      if (room === undefined || room === '') hasGeneral = true
      else if (!seen.includes(room)) seen.push(room)
    }
    return hasGeneral ? [...seen, GENERAL] : seen
  }, [day])

  const starts = day.entries
    .map(entryStart)
    .filter((v): v is number => v !== undefined)
  const ends = day.entries
    .map(entryEnd)
    .filter((v): v is number => v !== undefined)
  if (starts.length === 0) return null
  const gridStart = DateTime.fromMillis(Math.min(...starts), {
    zone,
    locale: DATE_LOCALE,
  })
    .startOf('hour')
    .toMillis()
  const rawEnd = Math.max(...ends, Math.min(...starts) + HOUR_MS)
  const gridEnd = gridStart + Math.ceil((rawEnd - gridStart) / HOUR_MS) * HOUR_MS
  const height = ((gridEnd - gridStart) / HOUR_MS) * HOUR_PX

  const hours: Array<number> = []
  for (let t = gridStart; t < gridEnd; t += HOUR_MS) hours.push(t)

  return (
    <div style={{ overflowX: 'auto' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `var(--space-16) repeat(${rooms.length}, minmax(12rem, 1fr))`,
          gap: 'var(--space-0) var(--space-2)',
          minWidth: 'min-content',
        }}
      >
        <div />
        {rooms.map((room) => (
          <div
            key={room}
            style={{
              font: 'var(--type-label)',
              color: 'var(--text-primary)',
              padding: 'var(--space-2) var(--space-1)',
              borderBottom: 'var(--space-px) solid var(--border-default)',
            }}
          >
            {room}
          </div>
        ))}
        <div style={{ position: 'relative', height }}>
          {hours.map((t) => (
            <span
              key={t}
              style={{
                position: 'absolute',
                top: ((t - gridStart) / HOUR_MS) * HOUR_PX,
                right: 'var(--space-2)',
                font: 'var(--type-mono)',
                color: 'var(--text-tertiary)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {fmtTime(t, zone)}
            </span>
          ))}
        </div>
        {rooms.map((room) => {
          const entries = day.entries.filter((e) =>
            room === GENERAL
              ? e.roomName === undefined || e.roomName === ''
              : e.roomName === room,
          )
          return (
            <div
              key={room}
              style={{
                position: 'relative',
                height,
                borderLeft: 'var(--space-px) solid var(--border-subtle)',
              }}
            >
              {hours.map((t) => (
                <div
                  key={t}
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: ((t - gridStart) / HOUR_MS) * HOUR_PX,
                    left: 0,
                    right: 0,
                    borderTop: 'var(--space-px) solid var(--border-subtle)',
                  }}
                />
              ))}
              {entries.map((entry) => {
                const start = entryStart(entry)
                if (start === undefined) return null
                const end = entryEnd(entry) ?? start + HOUR_MS / 2
                const top = ((start - gridStart) / HOUR_MS) * HOUR_PX
                const blockHeight = Math.max(
                  ((end - start) / HOUR_MS) * HOUR_PX,
                  36,
                )
                const timeLabel = `${fmtTime(start, zone)}${
                  entry.endsAt !== undefined
                    ? `–${fmtTime(entry.endsAt, zone)}`
                    : ''
                }`
                if (entry.kind === 'item') {
                  return (
                    <div
                      key={entry.itemId}
                      style={{
                        position: 'absolute',
                        top,
                        height: blockHeight,
                        left: 'var(--space-1)',
                        right: 'var(--space-1)',
                        padding: 'var(--space-1) var(--space-2)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface-hover)',
                        border: 'var(--space-px) solid var(--border-subtle)',
                        overflow: 'hidden',
                      }}
                    >
                      <span
                        style={{
                          font: 'var(--type-mono)',
                          color: 'var(--text-tertiary)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {timeLabel}
                      </span>
                      <div
                        style={{
                          font: 'var(--type-caption)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {entry.title}
                      </div>
                    </div>
                  )
                }
                return (
                  <button
                    key={entry.sessionId}
                    type="button"
                    onClick={() => onOpen(entry)}
                    style={{
                      position: 'absolute',
                      top,
                      height: blockHeight,
                      left: 'var(--space-1)',
                      right: 'var(--space-1)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 'var(--space-1)',
                      padding: 'var(--space-1) var(--space-2)',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--surface-card)',
                      border: 'var(--space-px) solid var(--border-default)',
                      borderLeftWidth: 3,
                      borderLeftStyle: 'solid',
                      borderLeftColor: color,
                      boxShadow: 'var(--shadow-xs)',
                      overflow: 'hidden',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      style={{
                        font: 'var(--type-mono)',
                        color: 'var(--text-tertiary)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {timeLabel}
                    </span>
                    <span
                      style={{
                        font: 'var(--type-label)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {entry.title}
                    </span>
                    {entry.trackName !== undefined ||
                    entry.format !== undefined ? (
                      <span
                        style={{
                          font: 'var(--type-caption)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {entry.trackName ?? entry.format}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DayList({
  day,
  zone,
  onOpen,
}: {
  day: Day
  zone: string
  onOpen: (session: SessionEntry) => void
}) {
  return (
    <div>
      {day.entries.map((entry) => {
        const start = entryStart(entry)
        const timeLabel =
          start !== undefined
            ? `${fmtTime(start, zone)}${
                entry.endsAt !== undefined
                  ? `–${fmtTime(entry.endsAt, zone)}`
                  : ''
              }`
            : '—'
        const isSession = entry.kind === 'session'
        const row = (
          <>
            <span
              style={{
                font: 'var(--type-mono)',
                color: 'var(--text-secondary)',
                flex: 'none',
                width: 'var(--space-24)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {timeLabel}
            </span>
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
                  color: isSession
                    ? 'var(--text-primary)'
                    : 'var(--text-secondary)',
                }}
              >
                {entry.title}
              </span>
              {isSession && entry.trackName !== undefined ? (
                <span
                  style={{
                    font: 'var(--type-caption)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {entry.trackName}
                </span>
              ) : null}
            </span>
          </>
        )
        if (isSession) {
          return (
            <button
              key={entry.sessionId}
              type="button"
              onClick={() => onOpen(entry)}
              style={{
                display: 'flex',
                gap: 'var(--space-4)',
                alignItems: 'flex-start',
                padding: 'var(--space-3) var(--space-0)',
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
              {row}
            </button>
          )
        }
        return (
          <div
            key={entry.itemId}
            style={{
              display: 'flex',
              gap: 'var(--space-4)',
              alignItems: 'flex-start',
              padding: 'var(--space-3) var(--space-0)',
              borderTop: 'var(--space-px) solid var(--border-subtle)',
            }}
          >
            {row}
          </div>
        )
      })}
    </div>
  )
}

export function AgendaGrid({
  program,
  accent,
}: {
  program: PublicProgram
  accent?: string
}) {
  const zone = program.event.timezone
  const days = useMemo(() => groupDays(program.agenda, zone), [program, zone])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [selected, setSelected] = useState<SessionEntry | null>(null)

  if (days.length === 0) {
    return (
      <p
        style={{
          font: 'var(--type-body)',
          color: 'var(--text-tertiary)',
          margin: 'var(--space-0)',
        }}
      >
        The agenda has not been published yet.
      </p>
    )
  }

  const active = days.find((d) => d.key === activeKey) ?? days[0]
  const hasRooms = program.agenda.some(
    (e) => e.roomName !== undefined && e.roomName !== '',
  )

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
        {days.length > 1 ? (
          <Tabs
            variant="pill"
            tabs={days.map((d) => ({ id: d.key, label: d.tabLabel }))}
            value={active.key}
            onChange={(id: string) => setActiveKey(id)}
          />
        ) : (
          <span
            style={{ font: 'var(--type-heading)', color: 'var(--text-primary)' }}
          >
            {active.label}
          </span>
        )}
        <span
          style={{
            font: 'var(--type-mono)',
            color: 'var(--text-tertiary)',
            marginLeft: 'auto',
          }}
        >
          {zone}
        </span>
      </div>
      {hasRooms ? (
        <DayGrid
          day={active}
          zone={zone}
          accent={accent}
          onOpen={setSelected}
        />
      ) : (
        <DayList day={active} zone={zone} onOpen={setSelected} />
      )}
      {selected !== null ? (
        <SessionDialog
          session={selected}
          zone={zone}
          accent={accent}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  )
}
