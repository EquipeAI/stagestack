import { DateTime } from 'luxon'
import type * as React from 'react'
import type {
  PublicAgendaItem,
  PublicProgram,
  PublicSession,
  PublicSpeaker,
} from '@convex/model/publish'
import { Avatar, Badge, Icon, Logo, Tag } from '~/ds'
import { DATE_LOCALE, formatDateRange } from '~/lib/datetime'

// One renderer for the published program, reused by the public event page
// (/e/<slug>), the organizer's live preview, and the external embed
// (/embed/<slug>) so the three can never drift. Everything here draws from the
// single privacy-filtered blob — no private fields exist to leak.

export type { PublicProgram }

// ── time helpers (event zone is authoritative, locale is pinned) ─────────
// This renderer is server-rendered on the public page; day and month names
// must not depend on the reader's locale or the two renders disagree.
function fmtTime(ms: number, zone: string) {
  const dt = DateTime.fromMillis(ms, { zone, locale: DATE_LOCALE })
  return dt.isValid ? dt.toFormat('HH:mm') : '—'
}
function dayKey(ms: number, zone: string) {
  return DateTime.fromMillis(ms, { zone, locale: DATE_LOCALE }).toFormat(
    'yyyy-LL-dd',
  )
}
function dayLabel(ms: number, zone: string) {
  const dt = DateTime.fromMillis(ms, { zone, locale: DATE_LOCALE })
  return dt.isValid ? dt.toFormat('cccc, d LLL yyyy') : '—'
}

const PRODUCT_ORIGIN = 'https://stagestack.dev'

/**
 * The origin this app is served from — a link handed out from a preview
 * deployment has to point back at that deployment, not at production. The
 * browser knows its own origin; a server render falls back to the production
 * host, which is where these links are generated in practice.
 */
export function siteOrigin() {
  return typeof window === 'undefined' ? PRODUCT_ORIGIN : window.location.origin
}

/** Public link surface derived from one slug + the deployment URL. */
export function publicLinks(
  slug: string,
  convexUrl: string | undefined,
  origin: string = siteOrigin(),
) {
  const site = (convexUrl ?? '').replace('.convex.cloud', '.convex.site')
  return {
    pageUrl: `${origin}/e/${slug}`,
    apiUrl: site ? `${site}/api/events/${slug}/program` : '',
  }
}

/** The <script>/<iframe> an external site pastes to embed a section. */
export function embedSnippet(
  slug: string,
  section: 'lineup' | 'agenda',
  origin: string = siteOrigin(),
) {
  return `<iframe src="${origin}/embed/${slug}?section=${section}" title="StageStack ${section}" style="width:100%;border:0;min-height:640px" loading="lazy"></iframe>`
}

// ── section eyebrow ───────────────────────────────────────────────────────
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        font: 'var(--type-eyebrow)',
        letterSpacing: 'var(--tracking-caps)',
        textTransform: 'uppercase',
        color: 'var(--text-brand)',
      }}
    >
      {children}
    </span>
  )
}

function SectionHeading({
  eyebrow,
  title,
  count,
}: {
  eyebrow: string
  title: string
  count?: string
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        marginBottom: 'var(--space-5)',
      }}
    >
      <Eyebrow>{eyebrow}</Eyebrow>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <h2
          style={{
            font: 'var(--type-title-2)',
            letterSpacing: 'var(--tracking-tight)',
            color: 'var(--text-primary)',
            margin: 'var(--space-0)',
          }}
        >
          {title}
        </h2>
        {count !== undefined ? (
          <span
            style={{ font: 'var(--type-mono)', color: 'var(--text-tertiary)' }}
          >
            {count}
          </span>
        ) : null}
      </div>
    </div>
  )
}

// ── event hero ────────────────────────────────────────────────────────────
export function EventHero({ event }: { event: PublicProgram['event'] }) {
  return (
    <header
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      {event.logoUrl !== undefined ? (
        <img
          src={event.logoUrl}
          alt=""
          style={{
            height: 'var(--space-12)',
            width: 'auto',
            maxWidth: '100%',
            objectFit: 'contain',
            alignSelf: 'flex-start',
          }}
        />
      ) : null}
      <Eyebrow>Program</Eyebrow>
      <h1
        style={{
          font: 'var(--type-display)',
          letterSpacing: 'var(--tracking-tighter)',
          color: 'var(--text-primary)',
          margin: 'var(--space-0)',
        }}
      >
        {event.name}
      </h1>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-2) var(--space-5)',
          font: 'var(--type-body-lg)',
          color: 'var(--text-secondary)',
        }}
      >
        <Detail icon="calendar-days">
          <span style={{ font: 'var(--type-mono)' }}>
            {formatDateRange(event.startsAt, event.endsAt, event.timezone)}
          </span>
        </Detail>
        {event.location !== undefined ? (
          <Detail icon="map-pin">{event.location}</Detail>
        ) : null}
        <Detail icon="clock">
          <span style={{ font: 'var(--type-mono)' }}>{event.timezone}</span>
        </Detail>
      </div>
      {event.description !== undefined ? (
        <p
          style={{
            font: 'var(--type-body-lg)',
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            maxWidth: 'var(--content-max-prose)',
            margin: 'var(--space-0)',
          }}
        >
          {event.description}
        </p>
      ) : null}
      {event.website !== undefined ? (
        <a
          href={event.website}
          target="_blank"
          // Organizer-supplied URL: the opened page gets no opener handle.
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            font: 'var(--type-label)',
            color: 'var(--text-link)',
            textDecoration: 'none',
            alignSelf: 'flex-start',
          }}
        >
          Event website
          <Icon name="external-link" size={16} />
        </a>
      ) : null}
    </header>
  )
}

function Detail({
  icon,
  children,
}: {
  icon: string
  children: React.ReactNode
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
      }}
    >
      <Icon name={icon} size={18} />
      {children}
    </span>
  )
}

// ── speakers ──────────────────────────────────────────────────────────────
function SpeakerRow({ speaker }: { speaker: PublicSpeaker }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'flex-start',
      }}
    >
      <Avatar name={speaker.name} src={speaker.headshotUrl} size={40} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0 }}>
        <span style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}>
          {speaker.name}
        </span>
        {speaker.tagline !== undefined ? (
          <span style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>
            {speaker.tagline}
          </span>
        ) : null}
        {speaker.bio !== undefined ? (
          <details style={{ marginTop: 'var(--space-1)' }}>
            <summary
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-link)',
                cursor: 'pointer',
                listStyle: 'none',
              }}
            >
              Read bio
            </summary>
            <p
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap',
                margin: 'var(--space-2) var(--space-0) var(--space-0)',
              }}
            >
              {speaker.bio}
            </p>
          </details>
        ) : null}
      </div>
    </div>
  )
}

function ToBeAnnounced() {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'center',
        color: 'var(--text-tertiary)',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 'var(--space-10)',
          height: 'var(--space-10)',
          borderRadius: 'var(--radius-full)',
          border: 'var(--space-px) dashed var(--border-strong)',
          flex: 'none',
        }}
      >
        <Icon name="user-round" size={18} />
      </span>
      <span style={{ font: 'var(--type-caption)' }}>Speaker to be announced</span>
    </div>
  )
}

function SessionCard({ session }: { session: PublicSession }) {
  const hasNamed = session.speakers.length > 0
  return (
    <article
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
        padding: 'var(--pad-card)',
        background: 'var(--surface-card)',
        border: 'var(--space-px) solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        boxShadow: 'var(--shadow-xs)',
        height: '100%',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        {session.format !== undefined ? (
          <Badge tone="neutral">{session.format}</Badge>
        ) : null}
        {session.trackName !== undefined ? <Tag>{session.trackName}</Tag> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
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
          <p
            style={{
              font: 'var(--type-body)',
              color: 'var(--text-secondary)',
              margin: 'var(--space-0)',
              display: '-webkit-box',
              WebkitLineClamp: 4,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {session.description}
          </p>
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
          marginTop: 'auto',
          paddingTop: 'var(--space-2)',
        }}
      >
        {session.speakers.map((speaker, i) => (
          <SpeakerRow key={`${speaker.name}-${i}`} speaker={speaker} />
        ))}
        {session.toBeAnnounced || !hasNamed ? <ToBeAnnounced /> : null}
      </div>
    </article>
  )
}

export function LineupSection({ lineup }: { lineup: Array<PublicSession> }) {
  if (lineup.length === 0) return null
  return (
    <section>
      <SectionHeading
        eyebrow="Speakers & sessions"
        title="Lineup"
        count={`${lineup.length} session${lineup.length === 1 ? '' : 's'}`}
      />
      <div
        style={{
          display: 'grid',
          gap: 'var(--space-4)',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 20rem), 1fr))',
          alignItems: 'stretch',
        }}
      >
        {lineup.map((session) => (
          <SessionCard key={session.sessionId} session={session} />
        ))}
      </div>
    </section>
  )
}

// ── agenda ────────────────────────────────────────────────────────────────
type AgendaEntry = PublicProgram['agenda'][number]

function speakerNames(entry: Extract<AgendaEntry, { kind: 'session' }>) {
  const names = entry.speakers.map((s) => s.name)
  if (names.length === 0) return entry.toBeAnnounced ? 'Speaker to be announced' : ''
  return names.join(', ')
}

function AgendaRow({
  entry,
  zone,
}: {
  entry: AgendaEntry
  zone: string
}) {
  const isItem = entry.kind === 'item'
  const startsAt = entry.kind === 'session' ? entry.startsAt : entry.startsAt
  const endsAt = entry.kind === 'session' ? entry.endsAt : entry.endsAt
  const speakers = entry.kind === 'session' ? speakerNames(entry) : ''
  const room =
    entry.kind === 'session' ? entry.roomName : (entry as PublicAgendaItem).roomName
  const track = entry.kind === 'session' ? entry.trackName : undefined

  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-4)',
        padding: 'var(--space-4) var(--space-0)',
        borderTop: 'var(--space-px) solid var(--border-subtle)',
        alignItems: 'flex-start',
      }}
    >
      <div
        style={{
          font: 'var(--type-mono)',
          color: 'var(--text-secondary)',
          flex: 'none',
          width: 'var(--space-24)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {startsAt !== undefined ? fmtTime(startsAt, zone) : '—'}
        {endsAt !== undefined ? `–${fmtTime(endsAt, zone)}` : ''}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0 }}>
        <span
          style={{
            font: 'var(--type-label)',
            color: isItem ? 'var(--text-secondary)' : 'var(--text-primary)',
          }}
        >
          {entry.title}
        </span>
        {speakers ? (
          <span style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>
            {speakers}
          </span>
        ) : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
          {track !== undefined ? <Tag>{track}</Tag> : null}
          {room !== undefined ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
              }}
            >
              <Icon name="map-pin" size={14} />
              {room}
            </span>
          ) : null}
          {isItem ? <Badge tone="neutral">Break</Badge> : null}
        </div>
      </div>
    </div>
  )
}

export function AgendaSection({
  agenda,
  timezone,
}: {
  agenda: PublicProgram['agenda']
  timezone: string
}) {
  if (agenda.length === 0) return null
  // Group time-ordered entries by calendar day in the event zone.
  const days: Array<{ key: string; label: string; entries: Array<AgendaEntry> }> = []
  for (const entry of agenda) {
    const at = entry.kind === 'session' ? (entry.startsAt ?? 0) : entry.startsAt
    const key = dayKey(at, timezone)
    let group = days.find((d) => d.key === key)
    if (group === undefined) {
      group = { key, label: dayLabel(at, timezone), entries: [] }
      days.push(group)
    }
    group.entries.push(entry)
  }

  return (
    <section>
      <SectionHeading
        eyebrow="Schedule"
        title="Agenda"
        count={`${timezone}`}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
        {days.map((day) => (
          <div key={day.key}>
            <h3
              style={{
                font: 'var(--type-heading)',
                color: 'var(--text-primary)',
                margin: 'var(--space-0) var(--space-0) var(--space-2)',
              }}
            >
              {day.label}
            </h3>
            <div>
              {day.entries.map((entry) => (
                <AgendaRow
                  key={entry.kind === 'session' ? entry.sessionId : entry.itemId}
                  entry={entry}
                  zone={timezone}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── footer ────────────────────────────────────────────────────────────────
export function PoweredBy({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href="https://stagestack.dev"
      target="_blank"
      rel="noreferrer"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        font: 'var(--type-caption)',
        color: 'var(--text-tertiary)',
        textDecoration: 'none',
      }}
    >
      {compact ? null : <span>Powered by</span>}
      <Logo size={14} />
    </a>
  )
}

// ── full program (public page + preview) ──────────────────────────────────
export function ProgramView({ program }: { program: PublicProgram }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-12)' }}>
      <EventHero event={program.event} />
      <LineupSection lineup={program.lineup} />
      <AgendaSection agenda={program.agenda} timezone={program.event.timezone} />
    </div>
  )
}
