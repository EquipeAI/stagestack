import { useId, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { checkBrandColor } from '@convex/shared/brandColor'
import type { PublicProgram } from '@convex/model/publish'
import type { Id } from '@convex/_generated/dataModel'
import type { PublicationRow } from '~/components/publish/model'
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Icon,
  Input,
  Select,
  Switch,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { copyToClipboard } from '~/lib/clipboard'
import { pushToast } from '~/components/toast'
import { CopyLinkRow } from '~/components/CopyLinkRow'
import { BrandColorField } from '~/components/publish/BrandColorField'
import { ChannelCard } from '~/components/publish/ChannelCard'
import { formatDateTime } from '~/lib/datetime'
import { useNow } from '~/components/tasks/useNow'
import {
  ProgramView,
  embedSnippet,
  publicLinks,
} from '~/components/public/ProgramView'
import { distinct } from '~/components/public/widgets/shared'
import { siteOrigin } from '~/lib/origin'

// The publish center (W10). LINEUP AND SCHEDULE ARE TWO DECISIONS, so they are
// two cards — each with its own state sentence, its own blockers, its own diff
// preview, its own publish/unpublish, and the per-entry toggles that belong to
// it. One route still (the nav's Publish entry); the restructure is information
// architecture, not new URLs.
//
// The strings are not written here. The channel sentence and its "last
// published by …" attribution come from convex/model/controlCenter.ts (the same
// producer the control center prints), the blockers from convex/model/
// readiness.ts, the diff and the eligibility arithmetic from convex/model/
// publish.ts + publishBulk.ts — which is the code the publish mutation
// enforces. A publish console that re-derives publication state in TSX is the
// bug this workstream removes.

export const Route = createFileRoute('/app/e/$eventSlug/publish')({
  component: PublishConsole,
})

function PublishConsole() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })
  const isOrganizer = data?.role === 'organizer'
  const skip = isOrganizer ? { eventSlug } : 'skip'
  const now = useNow()
  const state = useQuery(api.publish.state, skip)
  const board = useQuery(api.agenda.board, skip)
  const diff = useQuery(api.publish.diff, skip)
  // W4: publication state is composed once in convex/model/readiness.ts and
  // printed verbatim here. This console must never re-derive "is it public"
  // from flags and slots in TSX — that is how the surfaces drifted apart.
  const publication = useQuery(api.readiness.publication, skip)
  // W8 owns the "last published by … at …" sentence. CONSUMED, not re-composed:
  // there is exactly one producer of that line in the repository.
  const upNext = useQuery(
    api.readiness.upNext,
    isOrganizer ? { eventSlug, now } : 'skip',
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
  if (
    state === undefined ||
    board === undefined ||
    publication === undefined ||
    diff === undefined ||
    upNext === undefined
  ) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
  }
  // F6: the live preview rides on `state` — one projection for state+stale.
  const preview = state.preview

  const slug = data.event.slug
  const zone = data.event.timezone
  const links = publicLinks(slug, import.meta.env.VITE_CONVEX_URL)
  const rows = publication as Array<PublicationRow>
  const sentenceFor = (id: 'lineup' | 'agenda') =>
    upNext.channels.find((channel) => channel.id === id)?.sentence ?? ''

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <ChannelCard
        eventSlug={eventSlug}
        channel="lineup"
        label="Lineup"
        subtitle="Accepted sessions and confirmed speaker profiles on the public page. No slots required — the schedule is a separate decision."
        published={state.lineupPublished}
        stateSentence={sentenceFor('lineup')}
        version={state.version}
        stale={state.stale}
        diff={diff.lineup}
        rows={rows}
      >
        <SessionsSection
          eventSlug={eventSlug}
          sessions={board.sessions}
          publishedIds={new Set(state.publishedSessionIds)}
          summaries={new Map(rows.map((row) => [row.sessionId, row.publication]))}
        />
      </ChannelCard>

      <ChannelCard
        eventSlug={eventSlug}
        channel="agenda"
        label="Schedule"
        subtitle="Released, scheduled sessions and the agenda items around them. Publishing it exposes times and rooms; the lineup is unaffected."
        published={state.agendaPublished}
        stateSentence={sentenceFor('agenda')}
        version={state.version}
        stale={state.stale}
        diff={diff.agenda}
        rows={rows}
      >
        <AgendaItemsSection
          eventSlug={eventSlug}
          items={board.agendaItems}
          publishedIds={new Set(state.publishedAgendaItemIds)}
          zone={zone}
        />
      </ChannelCard>

      <ShareCard slug={slug} links={links} />
      <EmbedsCard eventSlug={eventSlug} preview={preview} />
      <PreviewCard program={preview} />
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
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <CopyLinkRow
          label="Public link"
          value={links.pageUrl}
          toast="Public link copied"
        />
        <CopyLinkRow
          label="API URL"
          value={links.apiUrl}
          toast="API URL copied"
        />
        <CopyLinkRow
          label="iCal feed"
          value={links.apiUrl !== '' ? `${links.apiUrl}.ics` : ''}
          toast="iCal feed URL copied"
        />
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
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
                marginTop: 'var(--space-3)',
              }}
            >
              <EmbedRow slug={slug} section="lineup" />
              <EmbedRow slug={slug} section="agenda" />
            </div>
          ) : null}
        </div>
      </div>
    </Card>
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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
        }}
      >
        <Badge tone="neutral">{section}</Badge>
        <Button
          variant="ghost"
          size="sm"
          iconLeft="copy"
          onClick={() =>
            void copyToClipboard(snippet, `${section} embed copied`)
          }
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

// ── embeds ───────────────────────────────────────────────────────────────────
type EmbedWidgetId =
  'sessions' | 'speakers' | 'agenda' | 'itinerary' | 'gallery'

const WIDGET_LABELS: Record<EmbedWidgetId, string> = {
  sessions: 'Sessions list',
  speakers: 'Speakers list',
  agenda: 'Agenda',
  itinerary: 'Schedule itinerary',
  gallery: 'Speaker gallery',
}

const HIDEABLE_FIELDS = [
  { id: 'description', label: 'Descriptions' },
  { id: 'speakers', label: 'Speakers' },
  { id: 'room', label: 'Rooms' },
] as const

type EmbedConfig = {
  trackName?: string
  brandColor?: string
  hiddenFields?: Array<string>
}

type EmbedRowData = {
  embedId: Id<'embeds'>
  name: string
  widget: EmbedWidgetId
  enabled: boolean
  config: EmbedConfig
  updatedAt: number
}

/** Every URL an embed exposes: the page/iframe on this site plus the two feed
 * formats served by the Convex HTTP router (same origin derivation as the
 * program API URL above). */
function embedUrls(embedId: string) {
  const convexSite = (import.meta.env.VITE_CONVEX_URL ?? '').replace(
    '.convex.cloud',
    '.convex.site',
  )
  const pageUrl = `${siteOrigin()}/embed/w/${embedId}`
  return {
    pageUrl,
    iframe: `<iframe src="${pageUrl}" style="width:100%;height:640px;border:0" loading="lazy"></iframe>`,
    jsonUrl: convexSite ? `${convexSite}/api/embeds/${embedId}` : '',
    icsUrl: convexSite ? `${convexSite}/api/embeds/${embedId}.ics` : '',
  }
}

/** Track names that actually appear in the published projection — the only
 * values a track filter can match. */
function previewTrackNames(preview: PublicProgram): Array<string> {
  return distinct([
    ...preview.lineup.map((s) => s.trackName),
    ...preview.agenda.map((e) =>
      e.kind === 'session' ? e.trackName : undefined,
    ),
  ])
}

function EmbedsCard({
  eventSlug,
  preview,
}: {
  eventSlug: string
  preview: PublicProgram
}) {
  const embeds = useQuery(api.embeds.list, { eventSlug })
  const [creating, setCreating] = useState(false)
  const trackOptions = previewTrackNames(preview)

  return (
    <Card
      title="Embeds"
      subtitle="Configured widgets an external site can drop in: each one gets an iframe snippet, a page URL, and JSON + iCal feeds, all serving only the published program."
      actions={
        <Button
          variant="secondary"
          size="sm"
          iconLeft="plus"
          onClick={() => setCreating(true)}
        >
          New embed
        </Button>
      }
    >
      {embeds === undefined ? (
        <p style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
      ) : embeds.length === 0 ? (
        <EmptyState
          icon="globe"
          title="No embeds yet"
          description="Create one to hand an external site a widget scoped to exactly what you want shown."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {embeds.map((embed) => (
            <EmbedListRow
              key={embed.embedId}
              eventSlug={eventSlug}
              embed={embed}
            />
          ))}
        </div>
      )}
      {creating ? (
        <NewEmbedDialog
          eventSlug={eventSlug}
          trackOptions={trackOptions}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </Card>
  )
}

function EmbedListRow({
  eventSlug,
  embed,
}: {
  eventSlug: string
  embed: EmbedRowData
}) {
  const updateEmbed = useMutation(api.embeds.update)
  const removeEmbed = useMutation(api.embeds.remove)
  const toggle = usePending()
  const removal = usePending()
  const [showCode, setShowCode] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const urls = embedUrls(embed.embedId)
  const error = toggle.error ?? removal.error

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-4) var(--space-0)',
        borderTop: 'var(--space-px) solid var(--border-subtle)',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-4)',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
            flex: 1,
            minWidth: 0,
          }}
        >
          <span
            style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}
          >
            {embed.name}
          </span>
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}
          >
            <Badge tone="neutral">{WIDGET_LABELS[embed.widget]}</Badge>
            {embed.config.trackName !== undefined ? (
              <Badge tone="info">Track: {embed.config.trackName}</Badge>
            ) : null}
            {(embed.config.hiddenFields?.length ?? 0) > 0 ? (
              <Badge tone="neutral">
                Hides {embed.config.hiddenFields?.join(', ')}
              </Badge>
            ) : null}
          </div>
          {error !== null ? (
            <span
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-danger)',
              }}
            >
              {error}
            </span>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          iconLeft={showCode ? 'chevron-down' : 'chevron-right'}
          onClick={() => setShowCode((v) => !v)}
        >
          Get code
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconLeft="trash-2"
          disabled={removal.pending}
          onClick={() => setConfirmingDelete(true)}
        >
          Delete
        </Button>
        <Switch
          aria-label={`Embed enabled: ${embed.name}`}
          checked={embed.enabled}
          disabled={toggle.pending}
          onChange={(e) =>
            void toggle.run(async () => {
              await updateEmbed({
                eventSlug,
                embedId: embed.embedId,
                enabled: e.target.checked,
              })
              pushToast(e.target.checked ? 'Embed enabled' : 'Embed disabled')
            })
          }
        />
      </div>
      {showCode ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
            padding: 'var(--space-3)',
            background: 'var(--surface-sunken)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <CopyLinkRow
            label="Iframe"
            value={urls.iframe}
            toast="Iframe snippet copied"
          />
          <CopyLinkRow
            label="Page URL"
            value={urls.pageUrl}
            toast="Embed page URL copied"
          />
          <CopyLinkRow
            label="JSON feed"
            value={urls.jsonUrl}
            toast="JSON feed URL copied"
          />
          <CopyLinkRow
            label="iCal feed"
            value={urls.icsUrl}
            toast="iCal feed URL copied"
          />
        </div>
      ) : null}
      {confirmingDelete ? (
        <Dialog
          title="Delete this embed?"
          description="Sites embedding it will show an unavailable card, and deleting cannot be undone."
          width={480}
          onClose={() => setConfirmingDelete(false)}
          footer={
            <>
              <Button onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={removal.pending}
                onClick={() => {
                  setConfirmingDelete(false)
                  void removal.run(async () => {
                    await removeEmbed({ eventSlug, embedId: embed.embedId })
                    pushToast('Embed deleted')
                  })
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p style={{ font: 'var(--type-body)' }}>{embed.name}</p>
        </Dialog>
      ) : null}
    </div>
  )
}

function NewEmbedDialog({
  eventSlug,
  trackOptions,
  onClose,
}: {
  eventSlug: string
  trackOptions: Array<string>
  onClose: () => void
}) {
  const createEmbed = useMutation(api.embeds.create)
  const { pending, error, run } = usePending()
  const uid = useId()
  const [name, setName] = useState('')
  const [widget, setWidget] = useState<EmbedWidgetId>('sessions')
  const [trackName, setTrackName] = useState('')
  const [brandColor, setBrandColor] = useState('')
  const [hidden, setHidden] = useState<Array<string>>([])

  const toggleHidden = (id: string, on: boolean) =>
    setHidden((prev) =>
      on ? distinct([...prev, id]) : prev.filter((v) => v !== id),
    )

  const submit = () =>
    void run(async () => {
      await createEmbed({
        eventSlug,
        name: name.trim(),
        widget,
        config: {
          trackName: trackName.trim() === '' ? undefined : trackName.trim(),
          brandColor: brandColor.trim() === '' ? undefined : brandColor.trim(),
          hiddenFields: hidden.length > 0 ? hidden : undefined,
        },
      })
      pushToast('Embed created')
      onClose()
    })

  return (
    <Dialog
      title="New embed"
      description="A configured widget an external site can drop in; you can disable or delete it later without touching the site."
      width={640}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={
              pending ||
              name.trim() === '' ||
              checkBrandColor(brandColor).error !== null
            }
            onClick={submit}
          >
            Create embed
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <Field label="Name" htmlFor={`${uid}-name`} required>
          <Input
            id={`${uid}-name`}
            value={name}
            placeholder="Homepage speaker wall"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Widget" htmlFor={`${uid}-widget`} required>
          <Select
            id={`${uid}-widget`}
            value={widget}
            options={(Object.keys(WIDGET_LABELS) as Array<EmbedWidgetId>).map(
              (id) => ({ value: id, label: WIDGET_LABELS[id] }),
            )}
            onChange={(e) => setWidget(e.target.value as EmbedWidgetId)}
          />
        </Field>
        <Field
          label="Track filter"
          htmlFor={`${uid}-track`}
          optional
          hint="Only sessions on this track appear in the embed."
        >
          {trackOptions.length > 0 ? (
            <Select
              id={`${uid}-track`}
              value={trackName}
              options={[
                { value: '', label: 'All tracks' },
                ...trackOptions.map((t) => ({ value: t, label: t })),
              ]}
              onChange={(e) => setTrackName(e.target.value)}
            />
          ) : (
            <Input
              id={`${uid}-track`}
              value={trackName}
              placeholder="Track name (as published)"
              onChange={(e) => setTrackName(e.target.value)}
            />
          )}
        </Field>
        <BrandColorField value={brandColor} onChange={setBrandColor} />
        <Field label="Hide fields" optional>
          {/* A checkbox list is not labelable, so `htmlFor` would name
              nothing; role="group" is what makes Field point the label at it
              with aria-labelledby instead. */}
          <div
            role="group"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
            }}
          >
            {HIDEABLE_FIELDS.map((field) => (
              <Checkbox
                key={field.id}
                label={field.label}
                checked={hidden.includes(field.id)}
                onChange={(e) => toggleHidden(field.id, e.target.checked)}
              />
            ))}
          </div>
        </Field>
        {error !== null ? (
          <span
            style={{ font: 'var(--type-caption)', color: 'var(--text-danger)' }}
          >
            {error}
          </span>
        ) : null}
      </div>
    </Dialog>
  )
}

// ── per-entry controls, nested in their channel ─────────────────────────────
type BoardSession = {
  sessionId: string
  title: string
}

/** The shared publication vocabulary (convex/model/readiness.ts). Rendered,
 * never re-derived: no flag arithmetic in this file. */
type PublicationSummary = {
  summary: string
  reasons: Array<{ sentence: string }>
}

/**
 * The per-session toggles, INSIDE the lineup card (W10).
 *
 * They used to be their own card halfway down the page, which made "publish
 * this session" look like a third decision alongside the two channels. It is
 * not: it is the fine-grained control of one channel, so it lives in that
 * channel's card, under that channel's blockers and diff.
 */
function SessionsSection({
  eventSlug,
  sessions,
  publishedIds,
  summaries,
}: {
  eventSlug: string
  sessions: Array<BoardSession>
  publishedIds: Set<string>
  summaries: Map<string, PublicationSummary>
}) {
  const [open, setOpen] = useState(false)
  if (sessions.length === 0) {
    return (
      <EmptyState
        icon="presentation"
        title="No accepted sessions yet"
        description="Accept proposals and build sessions first; they become publishable here."
      />
    )
  }
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        iconLeft={open ? 'chevron-down' : 'chevron-right'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open
          ? 'Hide the per-session toggles'
          : `Per-session toggles (${publishedIds.size} of ${sessions.length} on)`}
      </Button>
      {open ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {sessions.map((session) => (
            <SessionRow
              key={session.sessionId}
              eventSlug={eventSlug}
              session={session}
              published={publishedIds.has(session.sessionId)}
              publication={summaries.get(session.sessionId)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SessionRow({
  eventSlug,
  session,
  published,
  publication,
}: {
  eventSlug: string
  session: BoardSession
  published: boolean
  publication?: PublicationSummary
}) {
  const setSession = useMutation(api.publish.setSession)
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
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          flex: 1,
          minWidth: 0,
        }}
      >
        <span
          style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}
        >
          {session.title}
        </span>
        {publication === undefined ? null : (
          <span
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-secondary)',
            }}
          >
            {publication.summary}
          </span>
        )}
        {error !== null ? (
          <span
            style={{ font: 'var(--type-caption)', color: 'var(--text-danger)' }}
          >
            {error}
          </span>
        ) : null}
      </div>
      <Switch
        aria-label={`Release to the public page: ${session.title}`}
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

// ── agenda items, inside the schedule card ──────────────────────────────────
type BoardItem = {
  itemId: string
  title: string
  startsAt: number
  endsAt: number
}

function AgendaItemsSection({
  eventSlug,
  items,
  publishedIds,
  zone,
}: {
  eventSlug: string
  items: Array<BoardItem>
  publishedIds: Set<string>
  zone: string
}) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        iconLeft={open ? 'chevron-down' : 'chevron-right'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open
          ? 'Hide the agenda items'
          : `Agenda items (${publishedIds.size} of ${items.length} on)`}
      </Button>
      {open ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
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
      ) : null}
    </div>
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
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-1)',
          flex: 1,
          minWidth: 0,
        }}
      >
        <span
          style={{ font: 'var(--type-label)', color: 'var(--text-primary)' }}
        >
          {item.title}
        </span>
        <span
          style={{ font: 'var(--type-mono)', color: 'var(--text-tertiary)' }}
        >
          {formatDateTime(item.startsAt, zone)}
        </span>
        {error !== null ? (
          <span
            style={{ font: 'var(--type-caption)', color: 'var(--text-danger)' }}
          >
            {error}
          </span>
        ) : null}
      </div>
      <Switch
        aria-label={`Show on the public agenda: ${item.title}`}
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
  const empty = program.lineup.length === 0 && program.agenda.length === 0
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
