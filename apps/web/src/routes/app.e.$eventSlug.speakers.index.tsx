import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type * as React from 'react'
import type { ParticipantState } from '~/lib/labels'
import type { ActiveFilter } from '~/ds'
import type { RosterRow } from '~/components/speakers/SpeakerProfileForm'
import {
  ActiveFilters,
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  EmptyState,
  SearchInput,
  Select,
  StatusPill,
  Toolbar,
} from '~/ds'
import { PARTICIPANT_STATE_LABEL } from '~/lib/labels'
import { ImportCsvDialog } from '~/components/speakers/ImportCsvDialog'
import {
  matchesState,
  parseSpeakersSearch,
} from '~/components/speakers/search'
import { SavedViewsMenu } from '~/components/views/SavedViewsMenu'
import { paramsFromSearch } from '~/components/views/model'
import { visibleFilters } from '~/lib/filters'

// The speaker roster (SPK-01): every publishable snapshot on the event, with
// session links and participation state, searchable, and fed by a deterministic
// CSV import. Organizer-only, like Sessions.
//
// W9: a row is a LINK now, not a dialog trigger. Everything about one speaker
// — profile, participations, readiness, tasks, files, comments, comms — lives
// at /speakers/$eventContactId, so this stays what it is good at: the batch
// view. There is no second detail surface here to disagree with it.
//
// W12: toolbar slots in the standard order (search · filters), the active
// filters as removable chips that write straight back to the URL, a skeleton
// while the roster loads, and a card list on a phone.

export const Route = createFileRoute('/app/e/$eventSlug/speakers/')({
  component: Speakers,
  // Search text and the participation filter live in the URL, so the control
  // center's "3 speakers have not answered" lands on exactly those three.
  validateSearch: parseSpeakersSearch,
})

type Row = RosterRow & { id: string }

/**
 * Which participation states the filter offers.
 *
 * `awaiting` keeps its place at zero because that zero is the answer to the
 * organizer's actual question — nobody is sitting on an unanswered invitation.
 * An empty Declined or Withdrawn says nothing anyone came here to learn, so
 * those disappear until they have someone in them.
 */
const STATE_FILTERS: ReadonlyArray<{
  id: ParticipantState
  meaningfulZero: boolean
}> = [
  { id: 'awaiting', meaningfulZero: true },
  { id: 'confirmed', meaningfulZero: false },
  { id: 'declined', meaningfulZero: false },
  { id: 'withdrawn', meaningfulZero: false },
]

function Speakers() {
  const { eventSlug } = Route.useParams()
  const event = useQuery(api.events.get, { eventSlug })
  const isOrganizer = event?.role === 'organizer'
  const params = Route.useSearch()
  const navigate = Route.useNavigate()
  const search = params.q ?? ''
  const stateFilter = params.state
  // Filter tweaks REPLACE. A filter is a view of the page the organizer is
  // already on, not a place they travelled to: pushing one history entry per
  // chip would bury the count they arrived from under six back presses.
  const setSearch = (next: string) => {
    void navigate({
      search: (prev) => ({ ...prev, q: next === '' ? undefined : next }),
      replace: true,
    })
  }
  const setState = (next: ParticipantState | undefined) => {
    void navigate({
      search: (prev) => ({ ...prev, state: next }),
      replace: true,
    })
  }
  // The list is small (≤2000 scan server-side) — the search arg goes straight
  // through and the reactive query keeps up per keystroke.
  const roster = useQuery(
    api.speakers.roster,
    isOrganizer
      ? { eventSlug, search: search.trim() === '' ? undefined : search }
      : 'skip',
  )
  const [importing, setImporting] = useState(false)
  const archived = event?.event.archivedAt !== undefined

  if (event === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading speakers…</p>
  }

  if (!isOrganizer) {
    return (
      <Callout tone="blocked" title="The speaker roster is organizer-only">
        Reviewers see the proposals assigned to them under Reviews. Ask an
        organizer if you need access to the roster.
      </Callout>
    )
  }

  const loading = roster === undefined
  const all = roster ?? []
  const rows: Array<Row> = all
    .filter((row) => matchesState(row.sessions, stateFilter))
    .map((row) => ({
      ...row,
      id: row.eventContactId,
    }))
  const searching = search.trim() !== ''

  // Counted over the whole (search-matched) roster, so narrowing to one state
  // never makes the other options read zero and vanish under their own filter.
  const stateOptions = visibleFilters(
    STATE_FILTERS.map((filter) => ({
      id: filter.id,
      label: PARTICIPANT_STATE_LABEL[filter.id],
      count: all.filter((row) => matchesState(row.sessions, filter.id)).length,
      meaningfulZero: filter.meaningfulZero,
    })),
    stateFilter === undefined ? [] : [stateFilter],
  )

  const chips: Array<ActiveFilter> = [
    ...(searching
      ? [
          {
            id: 'q',
            label: `Search: ${search}`,
            onRemove: () => setSearch(''),
          },
        ]
      : []),
    ...(stateFilter === undefined
      ? []
      : [
          {
            id: `state:${stateFilter}`,
            label: `Participation: ${PARTICIPANT_STATE_LABEL[stateFilter]}`,
            onRemove: () => setState(undefined),
          },
        ]),
  ]

  const importButton = (
    <Button
      variant="primary"
      iconLeft="upload"
      disabled={archived}
      onClick={() => {
        setImporting(true)
      }}
    >
      Import CSV
    </Button>
  )

  const speakerName = (row: Row) => {
    const name = `${row.firstName} ${row.lastName}`.trim()
    return name === '' ? 'Unnamed contact' : name
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <Toolbar
        // Slot order (W12): search · filters · saved view (W2). There is no
        // column picker or export on the roster, and none is invented here.
        left={
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 'var(--space-3)',
            }}
          >
            <SearchInput
              aria-label="Search speakers"
              placeholder="Search name, email, company…"
              value={search}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setSearch(e.target.value)
              }}
            />
            <Select
              size="sm"
              aria-label="Filter by participation"
              value={stateFilter ?? ''}
              options={[
                { value: '', label: 'Any participation' },
                ...stateOptions.map((option) => ({
                  value: option.id,
                  label: `${option.label} (${option.count})`,
                })),
              ]}
              onChange={(e) => {
                setState(
                  e.target.value === ''
                    ? undefined
                    : (e.target.value as ParticipantState),
                )
              }}
            />
            <SavedViewsMenu
              eventSlug={eventSlug}
              module="speakers"
              params={paramsFromSearch(params)}
              onApply={(next) => {
                void navigate({
                  search: () => parseSpeakersSearch(next),
                  replace: true,
                })
              }}
            />
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--text-tertiary)',
              }}
            >
              {loading ? '—' : rows.length} speaker
              {rows.length === 1 ? '' : 's'}
            </span>
          </span>
        }
        right={importButton}
      />

      {/* Arriving here from a control-center count must not look like a roster
          that lost people: the chips say what is in force, and remove it. */}
      <ActiveFilters
        chips={chips}
        onClearAll={() => {
          void navigate({ search: {}, replace: true })
        }}
      />

      {loading ? (
        <Card padded={false}>
          <DataTable
            aria-label="Speaker roster"
            loading
            loadingLabel="Loading the speaker roster…"
            rows={[]}
            columns={COLUMNS_SKELETON}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="user-round"
            title={searching ? 'No speakers match' : 'No speakers yet'}
            description={
              searching
                ? 'Nothing on the roster matches that search — it covers names, emails, taglines, job titles and companies.'
                : 'Speakers appear here when a proposal is accepted, a speaker is invited to a session, or you import a CSV.'
            }
            action={searching ? undefined : importButton}
          />
        </Card>
      ) : (
        <Card padded={false}>
          <DataTable
            aria-label="Speaker roster"
            rowKey="id"
            // DataTable rows are already focusable and activate on
            // Enter/Space (W6), so wiring activation to a navigation makes the
            // roster keyboard-openable without a per-row button.
            onRowClick={(row: Row) => {
              void navigate({
                to: '/app/e/$eventSlug/speakers/$eventContactId',
                params: { eventSlug, eventContactId: row.eventContactId },
              })
            }}
            // Under 640px the roster is a card list: who they are, where they
            // speak and whether the portal is claimed. Tapping opens the
            // workspace, exactly as clicking a row does.
            cardRow={(row: Row) => (
              <>
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                  }}
                >
                  <Avatar
                    name={speakerName(row)}
                    src={row.headshotUrl ?? undefined}
                    size={32}
                  />
                  <span
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      minWidth: 0,
                    }}
                  >
                    <span style={{ color: 'var(--text-primary)' }}>
                      {speakerName(row)}
                    </span>
                    <span
                      style={{
                        font: 'var(--type-caption)',
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      {row.company ?? row.email ?? 'No company on file'}
                    </span>
                  </span>
                </span>
                <span
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                  }}
                >
                  {row.sessions.length === 0 ? (
                    <span
                      style={{
                        font: 'var(--type-caption)',
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      No sessions
                    </span>
                  ) : (
                    <StatusPill
                      status={PARTICIPANT_STATE_LABEL[row.sessions[0].state]}
                    />
                  )}
                  {row.claimed ? (
                    <Badge tone="info">Claimed</Badge>
                  ) : (
                    <Badge tone="neutral">Unclaimed</Badge>
                  )}
                </span>
              </>
            )}
            columns={[
              {
                key: 'name',
                header: 'Speaker',
                cell: (row: Row) => (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                    }}
                  >
                    <Avatar
                      name={speakerName(row)}
                      src={row.headshotUrl ?? undefined}
                      size={28}
                    />
                    <span style={{ color: 'var(--text-primary)' }}>
                      {speakerName(row)}
                    </span>
                  </span>
                ),
              },
              {
                key: 'email',
                header: 'Email',
                cell: (row: Row) =>
                  row.email === undefined ? (
                    <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                  ) : (
                    row.email
                  ),
              },
              {
                key: 'jobTitle',
                header: 'Job title',
                cell: (row: Row) =>
                  row.jobTitle ?? (
                    <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                  ),
              },
              {
                key: 'company',
                header: 'Company',
                cell: (row: Row) =>
                  row.company ?? (
                    <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                  ),
              },
              {
                key: 'sessions',
                header: 'Sessions',
                cell: (row: Row) =>
                  row.sessions.length === 0 ? (
                    <span style={{ color: 'var(--text-tertiary)' }}>None</span>
                  ) : (
                    <span
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 'var(--space-2)',
                      }}
                    >
                      {row.sessions.map((session) => (
                        <span
                          key={session.sessionId}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 'var(--space-2)',
                          }}
                        >
                          <span>{session.title}</span>
                          <StatusPill
                            status={PARTICIPANT_STATE_LABEL[session.state]}
                          />
                        </span>
                      ))}
                    </span>
                  ),
              },
              {
                key: 'claimed',
                header: 'Portal',
                width: '7rem',
                cell: (row: Row) =>
                  row.claimed ? (
                    <Badge tone="info">Claimed</Badge>
                  ) : (
                    <Badge tone="neutral">Unclaimed</Badge>
                  ),
              },
            ]}
            rows={rows}
          />
        </Card>
      )}

      {importing ? (
        <ImportCsvDialog
          eventSlug={eventSlug}
          archived={archived}
          onClose={() => {
            setImporting(false)
          }}
        />
      ) : null}
    </div>
  )
}

/** Headers only — the skeleton has to hold the same shape the rows will take,
 * or the table jumps a column wider the moment the roster arrives. */
const COLUMNS_SKELETON = [
  { key: 'name', header: 'Speaker' },
  { key: 'email', header: 'Email' },
  { key: 'jobTitle', header: 'Job title' },
  { key: 'company', header: 'Company' },
  { key: 'sessions', header: 'Sessions' },
  { key: 'claimed', header: 'Portal', width: '7rem' },
]
