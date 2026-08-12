import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type * as React from 'react'
import type { RosterRow } from '~/components/speakers/SpeakerProfileDialog'
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  EmptyState,
  SearchInput,
  StatusPill,
  Toolbar,
} from '~/ds'
import { PARTICIPANT_STATE_LABEL } from '~/lib/labels'
import { SpeakerProfileDialog } from '~/components/speakers/SpeakerProfileDialog'
import { ImportCsvDialog } from '~/components/speakers/ImportCsvDialog'
import {
  matchesState,
  parseSpeakersSearch,
} from '~/components/speakers/search'

// The speaker roster (SPK-01): every publishable snapshot on the event, with
// session links and participation state, searchable, editable in place, and
// fed by a deterministic CSV import. Organizer-only, like Sessions.

export const Route = createFileRoute('/app/e/$eventSlug/speakers')({
  component: Speakers,
  // Search text and the participation filter live in the URL, so the control
  // center's "3 speakers have not answered" lands on exactly those three.
  validateSearch: parseSpeakersSearch,
})

type Row = RosterRow & { id: string }

function Speakers() {
  const { eventSlug } = Route.useParams()
  const event = useQuery(api.events.get, { eventSlug })
  const isOrganizer = event?.role === 'organizer'
  const params = Route.useSearch()
  const navigate = Route.useNavigate()
  const search = params.q ?? ''
  const stateFilter = params.state
  const setSearch = (next: string) => {
    void navigate({
      search: (prev) => ({ ...prev, q: next === '' ? undefined : next }),
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
  const library = useQuery(
    api.library.list,
    isOrganizer ? { eventSlug } : 'skip',
  )
  const [editing, setEditing] = useState<string | null>(null)
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

  if (roster === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading speakers…</p>
  }

  const speakerFields = (library?.customFields ?? [])
    .filter((field) => field.appliesTo === 'speaker')
    .sort((a, b) => a.order - b.order)

  const rows: Array<Row> = roster
    .filter((row) => matchesState(row.sessions, stateFilter))
    .map((row) => ({
      ...row,
      id: row.eventContactId,
    }))
  const editingRow = rows.find((row) => row.eventContactId === editing) ?? null
  const searching = search.trim() !== ''

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

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <Toolbar
        left={
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
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
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--text-tertiary)',
              }}
            >
              {rows.length} speaker{rows.length === 1 ? '' : 's'}
            </span>
            {/* Arriving here from a control-center count must not look like a
                roster that lost people. */}
            {stateFilter === undefined ? null : (
              <Button
                size="sm"
                variant="ghost"
                iconLeft="x"
                onClick={() => {
                  void navigate({ search: (prev) => ({ ...prev, state: undefined }) })
                }}
              >
                {PARTICIPANT_STATE_LABEL[stateFilter]} only — show all
              </Button>
            )}
          </span>
        }
        right={importButton}
      />

      {rows.length === 0 ? (
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
            onRowClick={(row: Row) => {
              setEditing(row.eventContactId)
            }}
            columns={[
              {
                key: 'name',
                header: 'Speaker',
                cell: (row: Row) => {
                  const name = `${row.firstName} ${row.lastName}`.trim()
                  return (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 'var(--space-3)',
                      }}
                    >
                      <Avatar
                        name={name}
                        src={row.headshotUrl ?? undefined}
                        size={28}
                      />
                      <span style={{ color: 'var(--text-primary)' }}>
                        {name === '' ? 'Unnamed contact' : name}
                      </span>
                    </span>
                  )
                },
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

      {editingRow === null ? null : (
        <SpeakerProfileDialog
          eventSlug={eventSlug}
          row={editingRow}
          customFields={speakerFields}
          archived={archived}
          onClose={() => {
            setEditing(null)
          }}
        />
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
