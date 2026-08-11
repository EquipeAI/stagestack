import { useState } from 'react'
import { DateTime } from 'luxon'
import type * as React from 'react'
import type {
  PublicProgram,
  PublicSession,
  PublicSpeaker,
} from '@convex/model/publish'
import { Icon } from '~/ds'
import { DATE_LOCALE } from '~/lib/datetime'

// Shared derivations for the embeddable public widgets. Everything here is
// pure over the published program blob — no Convex, no network, SSR-safe.

// ── accent ────────────────────────────────────────────────────────────────
// The optional `accent` prop is an organiser-supplied brand colour; without
// one the widgets fall back to Spotlight amber.
export function accentOr(accent?: string) {
  return accent !== undefined && accent !== '' ? accent : 'var(--amber-400)'
}

// ── search normalization ──────────────────────────────────────────────────
export function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

/** Case- and diacritic-insensitive substring match over several fields. */
export function matchesQuery(
  query: string,
  haystacks: Array<string | undefined>,
) {
  const q = normalize(query.trim())
  if (q === '') return true
  return haystacks.some((h) => h !== undefined && normalize(h).includes(q))
}

// ── speakers ──────────────────────────────────────────────────────────────
export function surnameKey(name: string) {
  const last = name.trim().split(/\s+/).at(-1)
  return normalize(last !== undefined && last !== '' ? last : name)
}

export function bySurname(a: { name: string }, b: { name: string }) {
  const s = surnameKey(a.name).localeCompare(surnameKey(b.name))
  return s !== 0 ? s : normalize(a.name).localeCompare(normalize(b.name))
}

export function initialsOf(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words.at(0)?.charAt(0) ?? ''
  const last = words.length > 1 ? (words.at(-1)?.charAt(0) ?? '') : ''
  return `${first}${last}`.toUpperCase() || '?'
}

/** "jobTitle, company" when either exists, else the tagline. */
export function speakerAffiliation(sp: PublicSpeaker): string | undefined {
  const parts = [sp.jobTitle, sp.company].filter(
    (v): v is string => v !== undefined && v !== '',
  )
  if (parts.length > 0) return parts.join(', ')
  return sp.tagline
}

function mergeSpeaker(a: PublicSpeaker, b: PublicSpeaker): PublicSpeaker {
  return {
    ...a,
    tagline: a.tagline ?? b.tagline,
    jobTitle: a.jobTitle ?? b.jobTitle,
    company: a.company ?? b.company,
    bio: a.bio ?? b.bio,
    headshotUrl: a.headshotUrl ?? b.headshotUrl,
    links: a.links ?? b.links,
  }
}

// ── sessions ──────────────────────────────────────────────────────────────
/** Lineup ∪ agenda sessions, deduped by sessionId; the agenda copy fills in
 * schedule fields the lineup copy may lack. */
export function allSessions(program: PublicProgram): Array<PublicSession> {
  const byId = new Map<string, PublicSession>()
  for (const s of program.lineup) byId.set(s.sessionId, s)
  for (const e of program.agenda) {
    if (e.kind !== 'session') continue
    const existing = byId.get(e.sessionId)
    if (existing === undefined) {
      byId.set(e.sessionId, e)
      continue
    }
    byId.set(e.sessionId, {
      ...existing,
      startsAt: existing.startsAt ?? e.startsAt,
      endsAt: existing.endsAt ?? e.endsAt,
      roomName: existing.roomName ?? e.roomName,
    })
  }
  return [...byId.values()]
}

/** Chronological; unscheduled sessions sort last, ties break on title. */
export function byStartTime(
  a: { startsAt?: number; title: string },
  b: { startsAt?: number; title: string },
) {
  const sa = a.startsAt ?? Number.MAX_SAFE_INTEGER
  const sb = b.startsAt ?? Number.MAX_SAFE_INTEGER
  if (sa !== sb) return sa - sb
  return normalize(a.title).localeCompare(normalize(b.title))
}

export type SpeakerEntry = {
  speaker: PublicSpeaker
  sessions: Array<PublicSession>
}

/** One entry per person across lineup + agenda, keyed by speakerId, with that
 * person's sessions in time order. Sorted alphabetically by surname. */
export function speakerEntries(program: PublicProgram): Array<SpeakerEntry> {
  const sessions = [...allSessions(program)].sort(byStartTime)
  const map = new Map<string, SpeakerEntry>()
  for (const session of sessions) {
    for (const sp of session.speakers) {
      // Blobs published before speakerId existed fall back to the name —
      // without this, every legacy speaker collapses under one undefined key.
      // The cast reflects the runtime reality the static type can't: stored
      // blobs may predate the field.
      const key = (sp.speakerId as string | undefined) ?? sp.name
      const entry = map.get(key)
      if (entry === undefined) {
        map.set(key, { speaker: sp, sessions: [session] })
      } else {
        entry.speaker = mergeSpeaker(entry.speaker, sp)
        if (!entry.sessions.some((s) => s.sessionId === session.sessionId)) {
          entry.sessions.push(session)
        }
      }
    }
  }
  return [...map.values()].sort((a, b) => bySurname(a.speaker, b.speaker))
}

/** Distinct defined values, in first-appearance order. */
export function distinct(values: Array<string | undefined>): Array<string> {
  const out: Array<string> = []
  for (const v of values) {
    if (v !== undefined && v !== '' && !out.includes(v)) out.push(v)
  }
  return out
}

// ── time (event zone is authoritative, locale is pinned) ──────────────────
function at(ms: number, zone: string) {
  return DateTime.fromMillis(ms, { zone, locale: DATE_LOCALE })
}

export function fmtTime(ms: number, zone: string) {
  const dt = at(ms, zone)
  return dt.isValid ? dt.toFormat('HH:mm') : '—'
}

export function dayKeyOf(ms: number, zone: string) {
  return at(ms, zone).toFormat('yyyy-LL-dd')
}

export function dayLabelOf(ms: number, zone: string) {
  const dt = at(ms, zone)
  return dt.isValid ? dt.toFormat('cccc, d LLL yyyy') : '—'
}

export function dayTabLabelOf(ms: number, zone: string) {
  const dt = at(ms, zone)
  return dt.isValid ? dt.toFormat('ccc d LLL') : '—'
}

/** "Tue 3 Jun 2026, 09:00–09:30" — undefined when the session is unscheduled. */
export function sessionWhen(
  session: { startsAt?: number; endsAt?: number },
  zone: string,
): string | undefined {
  if (session.startsAt === undefined) return undefined
  const start = at(session.startsAt, zone)
  if (!start.isValid) return undefined
  const day = start.toFormat('ccc d LLL yyyy')
  const from = start.toFormat('HH:mm')
  const to =
    session.endsAt !== undefined ? fmtTime(session.endsAt, zone) : undefined
  return to !== undefined ? `${day}, ${from}–${to}` : `${day}, ${from}`
}

// ── tiny presentational helpers ───────────────────────────────────────────
export const linkButtonStyle: React.CSSProperties = {
  font: 'var(--type-caption)',
  color: 'var(--text-link)',
  background: 'none',
  border: 'none',
  padding: 'var(--space-0)',
  cursor: 'pointer',
}

/** Body text truncated at a word boundary with an in-place
 * "Show more"/"Show less" toggle. Short text renders plain. */
export function ShowMoreText({
  text,
  clampChars = 220,
  style,
}: {
  text: string
  clampChars?: number
  style?: React.CSSProperties
}) {
  const [expanded, setExpanded] = useState(false)
  const needsClamp = text.length > clampChars
  let shown = text
  if (needsClamp && !expanded) {
    const cut = text.slice(0, clampChars)
    const space = cut.lastIndexOf(' ')
    shown = `${cut.slice(0, space > 0 ? space : clampChars)}…`
  }
  return (
    <p
      style={{
        font: 'var(--type-body)',
        color: 'var(--text-secondary)',
        whiteSpace: 'pre-wrap',
        margin: 'var(--space-0)',
        ...style,
      }}
    >
      {shown}
      {needsClamp ? (
        <>
          {' '}
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            style={linkButtonStyle}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        </>
      ) : null}
    </p>
  )
}

/** Icon + text meta line (time, room, …). */
export function IconLine({
  icon,
  mono = false,
  children,
}: {
  icon: string
  mono?: boolean
  children: React.ReactNode
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        font: mono ? 'var(--type-mono)' : 'var(--type-caption)',
        color: 'var(--text-secondary)',
      }}
    >
      <Icon name={icon} size={14} />
      {children}
    </span>
  )
}

/** A clearable chip-set facet filter (Track / Format / Room / …). */
export function FilterChips({
  label,
  options,
  value,
  onChange,
  accent,
}: {
  label: string
  options: Array<string>
  value: string | null
  onChange: (next: string | null) => void
  accent?: string
}) {
  if (options.length === 0) return null
  const color = accentOr(accent)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 'var(--space-2)',
      }}
    >
      <span
        style={{
          font: 'var(--type-eyebrow)',
          letterSpacing: 'var(--tracking-caps)',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
          marginRight: 'var(--space-1)',
        }}
      >
        {label}
      </span>
      {options.map((option) => {
        const selected = value === option
        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(selected ? null : option)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-1) var(--space-3)',
              borderRadius: 'var(--radius-full)',
              border: 'var(--space-px) solid',
              borderColor: selected ? color : 'var(--border-default)',
              boxShadow: selected
                ? `inset 0 0 0 var(--space-px) ${color}`
                : 'none',
              background: 'var(--surface-card)',
              font: 'var(--type-caption)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
            }}
          >
            {selected ? (
              <span
                aria-hidden="true"
                style={{
                  width: 'var(--space-2)',
                  height: 'var(--space-2)',
                  borderRadius: 'var(--radius-full)',
                  background: color,
                }}
              />
            ) : null}
            {option}
          </button>
        )
      })}
    </div>
  )
}
