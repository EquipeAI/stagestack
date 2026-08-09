import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { PublicProgram } from '@convex/model/publish'
import type { Id } from '@convex/_generated/dataModel'
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Icon,
  StatusPill,
  Switch,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { formatDateTime } from '~/lib/datetime'
import {
  ProgramView,
  embedSnippet,
  publicLinks,
} from '~/components/public/ProgramView'

// The organizer's publication console (M7). Two independent master switches
// (lineup / agenda), per-session and per-item controls, share links, and a
// live preview rendered from api.publish.preview — the exact projection the
// public read path would serve given the current flags, so the organizer sees
// the page before the public does. Every toggle is a mutation with its own
// pending state and surfaces the backend's ConvexError message.

export const Route = createFileRoute('/app/e/$eventSlug/publish')({
  component: PublishConsole,
})

function copyToClipboard(text: string, toast: string) {
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined'
  ) {
    void navigator.clipboard.writeText(text).then(() => pushToast(toast))
  }
}

function PublishConsole() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })
  const isOrganizer = data?.role === 'organizer'
  const state = useQuery(
    api.publish.state,
    isOrganizer ? { eventSlug } : 'skip',
  )
  const preview = useQuery(
    api.publish.preview,
    isOrganizer ? { eventSlug } : 'skip',
  )
  const board = useQuery(
    api.agenda.board,
    isOrganizer ? { eventSlug } : 'skip',
  )

  if (data === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
  }
  if (!isOrganizer) {
    return (
      <Callout tone="blocked" title="Publishing is organizer-only">
        Reviewers score proposals under Reviews. Ask an organizer if the public
        page needs to change.
      </Callout>
    )
  }
  if (state === undefined || preview === undefined || board === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
  }

  const slug = data.event.slug
  const zone = data.event.timezone
  const links = publicLinks(slug, import.meta.env.VITE_CONVEX_URL)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <MastersCard eventSlug={eventSlug} state={state} zone={zone} />
      <ShareCard slug={slug} links={links} />
      <SessionsCard
        eventSlug={eventSlug}
        sessions={board.sessions}
        publishedIds={new Set(state.publishedSessionIds)}
        lineupPublished={state.lineupPublished}
      />
      <AgendaItemsCard
        eventSlug={eventSlug}
        items={board.agendaItems}
        publishedIds={new Set(state.publishedAgendaItemIds)}
        agendaPublished={state.agendaPublished}
        zone={zone}
      />
      <PreviewCard program={preview} />
    </div>
  )
}

// ── master switches ───────────────────────────────────────────────────────
function MastersCard({
  eventSlug,
  state,
  zone,
}: {
  eventSlug: string
  state: {
    lineupPublished: boolean
    agendaPublished: boolean
    version: number | null
    publishedAt: number | null
    acceptedSessions: number
    releasedSessions: number
  }
  zone: string
}) {
  const setLineup = useMutation(api.publish.setLineup)
  const setAgenda = useMutation(api.publish.setAgenda)
  const lineup = usePending()
  const agenda = usePending()

  return (
    <Card
      title="Publication"
      subtitle="The public page, read API and embeds are read-only copies of one published program. Lineup and agenda publish independently."
      actions={
        state.version !== null ? (
          <span
            style={{
              display: 'inline-flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 'var(--space-1)',
            }}
          >
            <Badge tone="neutral">Version {state.version}</Badge>
            {state.publishedAt !== null ? (
              <span
                style={{
                  font: 'var(--type-caption)',
                  color: 'var(--text-tertiary)',
                }}
              >
                Published {formatDateTime(state.publishedAt, zone)}
              </span>
            ) : null}
          </span>
        ) : (
          <Badge tone="neutral">Never published</Badge>
        )
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <MasterRow
          title="Public event page"
          published={state.lineupPublished}
          pending={lineup.pending}
          error={lineup.error}
          description={`Exposes accepted sessions and confirmed speaker profiles. ${state.acceptedSessions} session${state.acceptedSessions === 1 ? '' : 's'} accepted. Each session still needs its own toggle below.`}
          onToggle={(next) =>
            void lineup.run(async () => {
              await setLineup({ eventSlug, enabled: next })
              pushToast(
                next ? 'Public page published' : 'Public page unpublished',
              )
            })
          }
        />
        <MasterRow
          title="Public agenda / schedule"
          published={state.agendaPublished}
          pending={agenda.pending}
          error={agenda.error}
          description={`Adds released, scheduled sessions and agenda items to the page. ${state.releasedSessions} session${state.releasedSessions === 1 ? '' : 's'} released.`}
          onToggle={(next) =>
            void agenda.run(async () => {
              await setAgenda({ eventSlug, enabled: next })
              pushToast(next ? 'Agenda published' : 'Agenda unpublished')
            })
          }
        />
      </div>
    </Card>
  )
}

function MasterRow({
  title,
  description,
  published,
  pending,
  error,
  onToggle,
}: {
  title: string
  description: string
  published: boolean
  pending: boolean
  error: string | null
  onToggle: (next: boolean) => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-4)',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', maxWidth: 'var(--content-max-prose)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}>
            {title}
          </span>
          <StatusPill status={published ? 'Published' : 'Unpublished'} size="sm" />
        </div>
        <span style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>
          {description}
        </span>
        {error !== null ? (
          <span style={{ font: 'var(--type-caption)', color: 'var(--text-danger)' }}>
            {error}
          </span>
        ) : null}
      </div>
      <Switch
        checked={published}
        disabled={pending}
        onChange={(e) => onToggle(e.target.checked)}
      />
    </div>
  )
}

// ── share links + embed ─────────────────────────────────────────────────────
function ShareCard({
  slug,
  links,
}: {
  slug: string
  links: { pageUrl: string; apiUrl: string }
}) {
  const [showEmbed, setShowEmbed] = useState(false)
  return (
    <Card
      title="Share"
      subtitle="The same published program, three ways: a page to link, a JSON API to read, and an embed for an external site."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <LinkRow label="Public link" value={links.pageUrl} toast="Public link copied" />
        <LinkRow label="API URL" value={links.apiUrl} toast="API URL copied" />
        <div>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={showEmbed ? 'eye' : 'globe'}
            onClick={() => setShowEmbed((v) => !v)}
          >
            {showEmbed ? 'Hide embed snippet' : 'Embed snippet'}
          </Button>
          {showEmbed ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
              <EmbedRow slug={slug} section="lineup" />
              <EmbedRow slug={slug} section="agenda" />
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  )
}

function LinkRow({
  label,
  value,
  toast,
}: {
  label: string
  value: string
  toast: string
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          font: 'var(--type-eyebrow)',
          letterSpacing: 'var(--tracking-caps)',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
          minWidth: 'var(--space-16)',
        }}
      >
        {label}
      </span>
      <code
        style={{
          font: 'var(--type-mono)',
          color: 'var(--text-secondary)',
          background: 'var(--surface-sunken)',
          padding: 'var(--space-1) var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}
      >
        {value || '—'}
      </code>
      <Button
        variant="secondary"
        size="sm"
        iconLeft="copy"
        onClick={() => copyToClipboard(value, toast)}
        disabled={value === ''}
      >
        Copy
      </Button>
    </div>
  )
}

function EmbedRow({
  slug,
  section,
}: {
  slug: string
  section: 'lineup' | 'agenda'
}) {
  const snippet = embedSnippet(slug, section)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
        <Badge tone="neutral">{section}</Badge>
        <Button
          variant="ghost"
          size="sm"
          iconLeft="copy"
          onClick={() => copyToClipboard(snippet, `${section} embed copied`)}
        >
          Copy snippet
        </Button>
      </div>
      <pre
        style={{
          font: 'var(--type-mono)',
          color: 'var(--text-secondary)',
          background: 'var(--surface-sunken)',
          padding: 'var(--space-3)',
          borderRadius: 'var(--radius-sm)',
          margin: 'var(--space-0)',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {snippet}
      </pre>
    </div>
  )
}

// ── per-session controls ─────────────────────────────────────────────────────
type BoardSession = {
  sessionId: string
  title: string
  releasedSlot?: unknown
  participants: Array<{ state: string }>
}

function SessionsCard({
  eventSlug,
  sessions,
  publishedIds,
  lineupPublished,
}: {
  eventSlug: string
  sessions: Array<BoardSession>
  publishedIds: Set<string>
  lineupPublished: boolean
}) {
  return (
    <Card
      title="Sessions in the lineup"
      subtitle="A session appears on the public page only when its toggle is on and the public page is published. With no Confirmed speaker it still publishes, shown as Speaker to be announced."
    >
      {!lineupPublished ? (
        <Callout tone="info" title="The public page is off">
          These toggles take effect once you publish the public event page above.
        </Callout>
      ) : null}
      {sessions.length === 0 ? (
        <EmptyState
          icon="presentation"
          title="No accepted sessions yet"
          description="Accept proposals and build sessions first; they become publishable here."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: lineupPublished ? 'var(--space-0)' : 'var(--space-4)' }}>
          {sessions.map((session) => (
            <SessionRow
              key={session.sessionId}
              eventSlug={eventSlug}
              session={session}
              published={publishedIds.has(session.sessionId)}
            />
          ))}
        </div>
      )}
    </Card>
  )
}

function SessionRow({
  eventSlug,
  session,
  published,
}: {
  eventSlug: string
  session: BoardSession
  published: boolean
}) {
  const setSession = useMutation(api.publish.setSession)
  const { pending, error, run } = usePending()
  const confirmed = session.participants.filter(
    (p) => p.state === 'confirmed',
  ).length
  const released = session.releasedSlot !== undefined && session.releasedSlot !== null

  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-4)',
        alignItems: 'center',
        padding: 'var(--space-4) var(--space-0)',
        borderTop: 'var(--space-px) solid var(--border-subtle)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', flex: 1, minWidth: 0 }}>
        <span style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}>
          {session.title}
        </span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <Badge tone={confirmed > 0 ? 'success' : 'neutral'}>
            {confirmed > 0
              ? `${confirmed} confirmed speaker${confirmed === 1 ? '' : 's'}`
              : 'Speaker to be announced'}
          </Badge>
          <Badge tone={released ? 'info' : 'neutral'}>
            {released ? 'Slot released' : 'Not on agenda until released'}
          </Badge>
        </div>
        {error !== null ? (
          <span style={{ font: 'var(--type-caption)', color: 'var(--text-danger)' }}>
            {error}
          </span>
        ) : null}
      </div>
      <Switch
        checked={published}
        disabled={pending}
        onChange={(e) =>
          void run(async () => {
            await setSession({
              eventSlug,
              sessionId: session.sessionId as Id<'sessions'>,
              published: e.target.checked,
            })
          })
        }
      />
    </div>
  )
}

// ── per-item controls ────────────────────────────────────────────────────────
type BoardItem = {
  itemId: string
  title: string
  startsAt: number
  endsAt: number
}

function AgendaItemsCard({
  eventSlug,
  items,
  publishedIds,
  agendaPublished,
  zone,
}: {
  eventSlug: string
  items: Array<BoardItem>
  publishedIds: Set<string>
  agendaPublished: boolean
  zone: string
}) {
  if (items.length === 0) return null
  return (
    <Card
      title="Agenda items"
      subtitle="Breaks, keynotes and other non-session blocks. They appear on the public agenda only when the agenda is published and the item's toggle is on."
    >
      {!agendaPublished ? (
        <Callout tone="info" title="The agenda is off">
          These items appear once you publish the agenda above.
        </Callout>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: agendaPublished ? 'var(--space-0)' : 'var(--space-4)' }}>
        {items.map((item) => (
          <AgendaItemRow
            key={item.itemId}
            eventSlug={eventSlug}
            item={item}
            published={publishedIds.has(item.itemId)}
            zone={zone}
          />
        ))}
      </div>
    </Card>
  )
}

function AgendaItemRow({
  eventSlug,
  item,
  published,
  zone,
}: {
  eventSlug: string
  item: BoardItem
  published: boolean
  zone: string
}) {
  const setAgendaItem = useMutation(api.publish.setAgendaItem)
  const { pending, error, run } = usePending()
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-4)',
        alignItems: 'center',
        padding: 'var(--space-4) var(--space-0)',
        borderTop: 'var(--space-px) solid var(--border-subtle)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', flex: 1, minWidth: 0 }}>
        <span style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}>
          {item.title}
        </span>
        <span style={{ font: 'var(--type-mono)', color: 'var(--text-tertiary)' }}>
          {formatDateTime(item.startsAt, zone)}
        </span>
        {error !== null ? (
          <span style={{ font: 'var(--type-caption)', color: 'var(--text-danger)' }}>
            {error}
          </span>
        ) : null}
      </div>
      <Switch
        checked={published}
        disabled={pending}
        onChange={(e) =>
          void run(async () => {
            await setAgendaItem({
              eventSlug,
              itemId: item.itemId as Id<'agendaItems'>,
              published: e.target.checked,
            })
          })
        }
      />
    </div>
  )
}

// ── live preview ──────────────────────────────────────────────────────────
function PreviewCard({ program }: { program: PublicProgram }) {
  const empty =
    program.lineup.length === 0 && program.agenda.length === 0
  return (
    <Card
      title="Live preview"
      subtitle="Exactly what the public read path would serve right now, given the toggles above."
      actions={
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            font: 'var(--type-caption)',
            color: 'var(--text-tertiary)',
          }}
        >
          <Icon name="eye" size={16} />
          Preview
        </span>
      }
    >
      <div
        style={{
          border: 'var(--space-px) solid var(--border-default)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface-canvas)',
          padding: 'var(--space-6)',
          overflow: 'hidden',
        }}
      >
        {empty ? (
          <EmptyState
            icon="globe"
            title="Nothing is public yet"
            description="Publish the page or agenda and toggle sessions on to see them here."
          />
        ) : (
          <ProgramView program={program} />
        )}
      </div>
    </Card>
  )
}
