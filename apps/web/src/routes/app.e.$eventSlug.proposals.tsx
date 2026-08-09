import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Doc } from '@convex/_generated/dataModel'
import type {
  AbstractsSearch,
  ColumnId,
  ProposalId,
  ProposalStatus,
  SortKey,
  ViewDef,
} from '~/components/abstracts/model'
import { Button, Callout, Card, EmptyState, SearchInput, Toolbar } from '~/ds'
import { copyToClipboard } from '~/lib/clipboard'
import { AbstractsTable } from '~/components/abstracts/AbstractsTable'
import { AddProposalDialog } from '~/components/abstracts/AddProposalDialog'
import { BulkBar } from '~/components/abstracts/BulkBar'
import { ProposalDetailDialog } from '~/components/abstracts/ProposalDetailDialog'
import {
  ColumnsMenu,
  ExportMenu,
  StatusChips,
  ViewsMenu,
} from '~/components/abstracts/TableMenus'
import {
  ALL_COLUMN_IDS,
  filterRows,
  loadSavedViews,
  loadStoredColumns,
  parseSearch,
  searchFromState,
  searchIndex,
  sortRows,
  stateFromSearch,
  storeColumns,
  storeSavedViews,
  systemFieldIds,
} from '~/components/abstracts/model'

// The abstracts table — the surface an organizer lives in during a CFP. Every
// piece of table state is a URL search param, so a view is a link, a saved
// view is a stored link, and the back button works. Filtering, sorting and
// export all run over the same in-memory rows: the list query is bounded, and
// nothing here makes a round trip to change what is on screen.

export const Route = createFileRoute('/app/e/$eventSlug/proposals')({
  component: ProposalsRoute,
  validateSearch: parseSearch,
})

/** Text sorts ascending first; counts and dates read newest/most first. */
const ASCENDING_FIRST: ReadonlySet<SortKey> = new Set(['title', 'submitter', 'status'])

function ProposalsRoute() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })

  if (data === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading proposals…</p>
  }
  if (data.role !== 'organizer') {
    return (
      <Callout tone="blocked" title="Proposals are organizer-only">
        You have reviewer access to this event. Your assignments live under
        Reviews.
      </Callout>
    )
  }
  return <Abstracts eventSlug={eventSlug} event={data.event} />
}

function Abstracts({
  eventSlug,
  event,
}: {
  eventSlug: string
  event: Doc<'events'>
}) {
  const list = useQuery(api.cfp.listProposals, { eventSlug })
  const form = useQuery(api.cfp.getForm, { eventSlug })
  const progress = useQuery(api.reviews.progress, { eventSlug })
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  // Preferences live in this browser, so they are read after mount — the
  // server render always uses the defaults and never mismatches.
  const [storedCols, setStoredCols] = useState<Array<ColumnId> | null>(null)
  const [savedViews, setSavedViews] = useState<Array<ViewDef>>([])
  useEffect(() => {
    setStoredCols(loadStoredColumns(eventSlug))
    setSavedViews(loadSavedViews(eventSlug))
  }, [eventSlug])

  const state = useMemo(
    () => stateFromSearch(search, storedCols),
    [search, storedCols],
  )

  // The search box is local and instant; the URL catches up a beat later so
  // typing never queues a navigation per keystroke.
  const [q, setQ] = useState(search.q ?? '')
  const pushedQ = useRef(search.q ?? '')
  useEffect(() => {
    const fromUrl = search.q ?? ''
    if (fromUrl !== pushedQ.current) {
      pushedQ.current = fromUrl
      setQ(fromUrl)
    }
  }, [search.q])
  useEffect(() => {
    const next = q.trim()
    if (next === pushedQ.current) return
    const timer = window.setTimeout(() => {
      pushedQ.current = next
      void navigate({
        search: (prev: AbstractsSearch) => ({
          ...prev,
          q: next === '' ? undefined : next,
        }),
        replace: true,
      })
    }, 200)
    return () => window.clearTimeout(timer)
  }, [q, navigate])

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map())
  const [openId, setOpenId] = useState<ProposalId | null>(null)
  const [adding, setAdding] = useState(false)
  const [copied, setCopied] = useState(false)
  // The shift-select anchor is a row, not a position: filtering and sorting
  // move rows around between clicks, and a remembered index would then select
  // a range nobody pointed at.
  const anchorId = useRef<ProposalId | null>(null)

  const ids = useMemo(
    () => systemFieldIds(form === undefined ? null : (form.published ?? form.working)),
    [form],
  )
  const def = form === undefined ? null : (form.published ?? form.working)

  // Reaching PAST the read cap (H5): when the organizer has narrowed to ONE
  // status, re-read the CFP on that status's own index. Each status is capped
  // separately, so a 700-proposal event can still work a whole queue — and the
  // callout below can honestly tell them narrowing helps. The unfiltered page
  // stays subscribed so the chips keep counting the event, not the queue.
  const queueStatus = state.statuses.length === 1 ? state.statuses[0] : undefined
  const queue = useQuery(
    api.cfp.listProposals,
    queueStatus === undefined ? 'skip' : { eventSlug, status: queueStatus },
  )

  // The unfiltered page: what the status chips count, and what the table shows
  // unless a single-status queue is loaded below.
  const page = useMemo(() => list?.rows ?? [], [list])
  const all = useMemo(() => (queue === undefined ? page : queue.rows), [page, queue])
  // Two different truths, both worth telling (H5). `capped` is about the rows
  // ON SCREEN — it is what makes the counter read "N+" instead of the flat
  // "500 of 500" that hid 200 proposals. `pageCapped` is about the unfiltered
  // read the status counts are computed from, which stays partial even when a
  // narrowed queue is complete.
  const capped = queue === undefined ? (list?.capped ?? false) : queue.capped
  const pageCapped = list?.capped ?? false
  const index = useMemo(() => searchIndex(all, ids), [all, ids])
  const visible = useMemo(() => {
    const live = { ...state, q }
    return sortRows(filterRows(all, live, index), live, ids, progress)
  }, [all, state, q, index, ids, progress])

  // Counted on the unfiltered page, so narrowing to one status never makes the
  // other chips read zero.
  const counts = useMemo(() => {
    const out: Record<string, number> = { all: page.length }
    for (const row of page) {
      out[row.proposal.status] = (out[row.proposal.status] ?? 0) + 1
    }
    return out
  }, [page])

  const selection = useMemo(
    () => all.filter((r) => selected.has(r.proposal._id)),
    [all, selected],
  )

  const apply = useCallback(
    (next: AbstractsSearch) => {
      pushedQ.current = next.q ?? ''
      setQ(next.q ?? '')
      void navigate({ search: () => next, replace: true })
    },
    [navigate],
  )

  const patch = useCallback(
    (part: AbstractsSearch) => {
      void navigate({
        search: (prev: AbstractsSearch) => ({ ...prev, ...part }),
        replace: true,
      })
    },
    [navigate],
  )

  const onSort = (key: SortKey) => {
    if (state.sort === key) {
      patch({ sort: key, dir: state.dir === 'asc' ? 'desc' : 'asc' })
    } else {
      patch({ sort: key, dir: ASCENDING_FIRST.has(key) ? 'asc' : 'desc' })
    }
  }

  const onToggleStatus = (status: ProposalStatus) => {
    const next = state.statuses.includes(status)
      ? state.statuses.filter((s) => s !== status)
      : [...state.statuses, status]
    patch({ status: next.length === 0 ? undefined : next.join(',') })
  }

  const onColumns = (cols: Array<ColumnId>) => {
    const ordered = ALL_COLUMN_IDS.filter((c) => c === 'title' || cols.includes(c))
    setStoredCols(ordered)
    storeColumns(eventSlug, ordered)
    patch({
      cols:
        ordered.length === ALL_COLUMN_IDS.length ? undefined : ordered.join(','),
    })
  }

  const onToggleRow = (id: ProposalId, shiftKey: boolean) => {
    const position = visible.findIndex((r) => r.proposal._id === id)
    const anchor =
      anchorId.current === null
        ? -1
        : visible.findIndex((r) => r.proposal._id === anchorId.current)
    setSelected((prev) => {
      const next = new Set(prev)
      if (shiftKey && anchor >= 0 && position >= 0) {
        const [from, to] = [anchor, position].sort((a, b) => a - b)
        for (const row of visible.slice(from, to + 1)) next.add(row.proposal._id)
      } else if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
    anchorId.current = id
  }

  const onToggleAll = () => {
    setSelected((prev) => {
      const everything = visible.every((r) => prev.has(r.proposal._id))
      return everything ? new Set() : new Set(visible.map((r) => r.proposal._id))
    })
  }

  const clearSelection = () => {
    setSelected(new Set())
    anchorId.current = null
  }

  const copyLink = () => {
    if (typeof window === 'undefined') return
    void copyToClipboard(
      `${window.location.origin}/cfp/${eventSlug}`,
      'CFP link copied',
    ).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }

  if (list === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading proposals…</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <Toolbar
        left={
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              flexWrap: 'wrap',
            }}
          >
            <SearchInput
              value={q}
              placeholder="Search titles, submitters, answers"
              onChange={(e) => setQ(e.target.value)}
            />
            <ViewsMenu
              search={searchFromState({ ...state, q })}
              saved={savedViews}
              onApply={apply}
              onSave={(name) => {
                const next = [
                  ...savedViews.filter((v) => v.name !== name),
                  { name, search: searchFromState({ ...state, q }) },
                ]
                setSavedViews(next)
                storeSavedViews(eventSlug, next)
              }}
              onDelete={(name) => {
                const next = savedViews.filter((v) => v.name !== name)
                setSavedViews(next)
                storeSavedViews(eventSlug, next)
              }}
            />
          </div>
        }
        right={
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              flexWrap: 'wrap',
            }}
          >
            <ColumnsMenu cols={state.cols} onChange={onColumns} />
            <ExportMenu
              eventSlug={eventSlug}
              eventName={event.name}
              visibleCount={visible.length}
              buildInput={() => ({
                rows: visible,
                state: { ...state, q },
                ids,
                def,
                progress,
                timezone: event.timezone,
              })}
            />
            <Button size="sm" iconLeft="copy" onClick={copyLink}>
              {copied ? 'Copied' : 'Copy CFP link'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              iconLeft="plus"
              onClick={() => setAdding(true)}
            >
              Add proposal
            </Button>
          </div>
        }
      />

      {capped ? (
        <Callout tone="attention" title="This list is not the whole CFP">
          This event has more proposals than one page loads, so only the{' '}
          {all.length} newest are on screen — search, sorting and export cover
          just those. Narrow to a single status above and StageStack reloads
          that queue on its own, so you can work {queueStatus ?? 'each status'}{' '}
          to the end; nothing here affects reviews or decisions.
        </Callout>
      ) : pageCapped ? (
        <Callout tone="info" title="Status counts are partial">
          This {queueStatus ?? 'status'} queue is complete, but the counts on
          the chips above are taken from the newest {page.length} proposals
          across every status — narrow to one status to see that queue in full,
          as you are now.
        </Callout>
      ) : null}

      {page.length === 0 ? (
        <Card>
          <EmptyState
            icon="inbox"
            title="No proposals yet"
            description={`Proposals arrive through the public CFP page at /cfp/${eventSlug}. Publish the form and turn on "CFP published" in Settings, then share the link.`}
            action={
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button iconLeft="copy" onClick={copyLink}>
                  {copied ? 'Copied' : 'Copy CFP link'}
                </Button>
                <Button variant="primary" iconLeft="plus" onClick={() => setAdding(true)}>
                  Add proposal
                </Button>
              </div>
            }
          />
        </Card>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}
          >
            <StatusChips
              counts={counts}
              active={state.statuses}
              onToggle={onToggleStatus}
              onClear={() => patch({ status: undefined })}
            />
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                color: 'var(--text-tertiary)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {/* The "+" is the honest total when the page is capped: this
                  span used to read "500 of 500" on a 700-proposal event. */}
              Showing {visible.length} of {all.length}
              {capped ? '+' : ''}
            </span>
          </div>

          <Card padded={false}>
            {visible.length === 0 ? (
              <EmptyState
                icon="search"
                title="Nothing matches"
                description="No proposal matches this search and filter combination. Clear the filters to see the whole event again."
                action={<Button onClick={() => apply({})}>Clear filters</Button>}
              />
            ) : (
              <AbstractsTable
                rows={visible}
                state={state}
                ids={ids}
                progress={progress}
                timezone={event.timezone}
                selected={selected}
                failures={failures}
                onSort={onSort}
                onToggle={onToggleRow}
                onToggleAll={onToggleAll}
                onOpen={setOpenId}
              />
            )}
          </Card>
        </>
      )}

      {selection.length > 0 ? (
        <BulkBar
          eventSlug={eventSlug}
          selection={selection}
          onFailures={setFailures}
          onClear={() => {
            clearSelection()
            setFailures(new Map())
          }}
        />
      ) : null}

      {openId !== null ? (
        <ProposalDetailDialog
          eventSlug={eventSlug}
          event={event}
          proposalId={openId}
          def={def}
          onClose={() => setOpenId(null)}
        />
      ) : null}

      {adding ? (
        <AddProposalDialog eventSlug={eventSlug} onClose={() => setAdding(false)} />
      ) : null}
    </div>
  )
}
