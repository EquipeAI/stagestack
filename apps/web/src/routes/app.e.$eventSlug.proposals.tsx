import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Doc, Id } from '@convex/_generated/dataModel'
import type { AnswerValue, FormDef } from '@convex/shared/formDef'
import type * as React from 'react'
import {
  Button,
  Callout,
  Card,
  DataTable,
  DescriptionList,
  Dialog,
  EmptyState,
  Field,
  Input,
  StatusPill,
  Tabs,
  Toolbar,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { formatDateTime, fromInputValue, toInputValue } from '~/lib/datetime'

export const Route = createFileRoute('/app/e/$eventSlug/proposals')({
  component: ProposalsRoute,
})

type Row = { proposal: Doc<'proposals'>; speakerCount: number }

// The stored status ids mapped onto the product's own vocabulary. `pending`
// is a proposal that has been sent and is waiting on a decision.
const STATUS_LABEL: Record<Doc<'proposals'>['status'], string> = {
  draft: 'Draft',
  pending: 'Submitted',
  acceptQueue: 'Accept queue',
  declineQueue: 'Decline queue',
  accepted: 'Accepted',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Submitted' },
  { id: 'draft', label: 'Draft' },
  { id: 'withdrawn', label: 'Withdrawn' },
] as const

type FilterId = (typeof FILTERS)[number]['id']

/** Default reopen window: a week from now, in the event's own zone. */
const A_WEEK = 7 * 24 * 60 * 60 * 1000

function ProposalsRoute() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })

  if (data === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading proposals…</p>
  }
  if (data.role !== 'organizer') {
    return (
      <Callout tone="blocked" title="Proposals are organizer-only">
        You have reviewer access to this event. Reviewing arrives with M2.
      </Callout>
    )
  }
  return <Proposals eventSlug={eventSlug} event={data.event} />
}

function Proposals({
  eventSlug,
  event,
}: {
  eventSlug: string
  event: Doc<'events'>
}) {
  const rows = useQuery(api.cfp.listProposals, { eventSlug })
  const form = useQuery(api.cfp.getForm, { eventSlug })
  const [filter, setFilter] = useState<FilterId>('all')
  const [openId, setOpenId] = useState<Id<'proposals'> | null>(null)
  const [copied, setCopied] = useState(false)

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: rows?.length ?? 0 }
    for (const row of rows ?? []) {
      out[row.proposal.status] = (out[row.proposal.status] ?? 0) + 1
    }
    return out
  }, [rows])

  if (rows === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading proposals…</p>
  }

  const visible =
    filter === 'all' ? rows : rows.filter((r) => r.proposal.status === filter)
  const open = rows.find((r) => r.proposal._id === openId) ?? null

  const copyLink = () => {
    if (typeof window === 'undefined') return
    void navigator.clipboard
      .writeText(`${window.location.origin}/cfp/${eventSlug}`)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <Toolbar
        left={
          <Tabs
            variant="pill"
            value={filter}
            tabs={FILTERS.map((f) => ({
              id: f.id,
              label: f.label,
              count: f.id === 'all' ? counts.all : (counts[f.id] ?? 0),
            }))}
            onChange={(id) => setFilter(id as FilterId)}
          />
        }
        right={
          <Button size="sm" iconLeft="copy" onClick={copyLink}>
            {copied ? 'Copied' : 'Copy CFP link'}
          </Button>
        }
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="inbox"
            title="No proposals yet"
            description={`Proposals arrive through the public CFP page at /cfp/${eventSlug}. Publish the form and turn on "CFP published" in Settings, then share the link.`}
            action={
              <Button iconLeft="copy" onClick={copyLink}>
                {copied ? 'Copied' : 'Copy CFP link'}
              </Button>
            }
          />
        </Card>
      ) : (
        <Card padded={false}>
          <DataTable
            rowKey="_id"
            rows={visible.map((r) => ({ ...r, _id: r.proposal._id }))}
            onRowClick={(row: Row) => setOpenId(row.proposal._id)}
            columns={[
              {
                key: 'title',
                header: 'Title',
                cell: (row: Row) =>
                  row.proposal.title.trim() === '' ? (
                    <span style={{ color: 'var(--text-tertiary)' }}>Untitled</span>
                  ) : (
                    row.proposal.title
                  ),
              },
              {
                key: 'submitter',
                header: 'Submitter',
                cell: (row: Row) => <Submitter proposal={row.proposal} />,
              },
              {
                key: 'speakers',
                header: 'Speakers',
                align: 'right',
                width: '6rem',
                cell: (row: Row) => (
                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {row.speakerCount}
                  </span>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                width: '9rem',
                cell: (row: Row) => (
                  <StatusPill status={STATUS_LABEL[row.proposal.status]} />
                ),
              },
              {
                key: 'submittedAt',
                header: 'Submitted',
                width: '13rem',
                cell: (row: Row) => (
                  <Mono>
                    {row.proposal.submittedAt === undefined
                      ? '—'
                      : formatDateTime(row.proposal.submittedAt, event.timezone)}
                  </Mono>
                ),
              },
              {
                key: 'updatedAt',
                header: 'Updated',
                width: '13rem',
                cell: (row: Row) => (
                  <Mono>{formatDateTime(row.proposal.updatedAt, event.timezone)}</Mono>
                ),
              },
            ]}
          />
        </Card>
      )}

      {visible.length === 0 && rows.length > 0 ? (
        <p style={{ color: 'var(--text-tertiary)' }}>
          No proposals with that status.
        </p>
      ) : null}

      {open !== null ? (
        <ProposalDialog
          eventSlug={eventSlug}
          event={event}
          row={open}
          def={form === undefined ? null : (form.published ?? form.working)}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  )
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        color: 'var(--text-tertiary)',
      }}
    >
      {children}
    </span>
  )
}

/** The submitter as the form itself captured them (the locked system fields). */
function Submitter({ proposal }: { proposal: Doc<'proposals'> }) {
  const name = [proposal.answers.firstName, proposal.answers.lastName]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v !== '')
    .join(' ')
  const email = proposal.answers.email
  return (
    <span style={{ display: 'flex', flexDirection: 'column' }}>
      <span>{name === '' ? '—' : name}</span>
      {typeof email === 'string' && email !== '' ? (
        <span style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
          {email}
        </span>
      ) : null}
    </span>
  )
}

// ── Detail ────────────────────────────────────────────────────────────────

function ProposalDialog({
  eventSlug,
  event,
  row,
  def,
  onClose,
}: {
  eventSlug: string
  event: Doc<'events'>
  row: Row
  def: FormDef | null
  onClose: () => void
}) {
  const { proposal } = row
  const items = useMemo(() => answerItems(proposal.answers, def), [proposal, def])

  return (
    <Dialog
      title={proposal.title.trim() === '' ? 'Untitled proposal' : proposal.title}
      description={`${STATUS_LABEL[proposal.status]} · ${row.speakerCount} speaker${row.speakerCount === 1 ? '' : 's'} · updated ${formatDateTime(proposal.updatedAt, event.timezone)}`}
      width={860}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <DescriptionList
          items={[
            {
              term: 'Status',
              value: <StatusPill status={STATUS_LABEL[proposal.status]} />,
            },
            {
              term: 'Submitted',
              value:
                proposal.submittedAt === undefined
                  ? 'Not submitted'
                  : formatDateTime(proposal.submittedAt, event.timezone),
            },
            { term: 'Speakers', value: String(row.speakerCount) },
            { term: 'Form version', value: `v${proposal.formVersion}` },
          ]}
        />
        {items.length === 0 ? (
          <p style={{ color: 'var(--text-tertiary)' }}>
            No answers have been entered yet.
          </p>
        ) : (
          <DescriptionList items={items} stacked />
        )}
        {proposal.status === 'pending' ? (
          <ReopenPanel
            eventSlug={eventSlug}
            event={event}
            proposal={proposal}
          />
        ) : null}
      </div>
    </Dialog>
  )
}

/** Answers in form order, with anything no longer on the form listed after. */
function answerItems(
  answers: Record<string, AnswerValue>,
  def: FormDef | null,
): Array<{ term: string; value: React.ReactNode }> {
  const ordered: Array<{ term: string; value: React.ReactNode }> = []
  const used = new Set<string>()
  for (const section of def?.sections ?? []) {
    for (const field of section.fields) {
      if (!(field.id in answers)) continue
      used.add(field.id)
      ordered.push({
        term: field.label.trim() === '' ? field.id : field.label,
        value: renderAnswer(answers[field.id], field.kind === 'file'),
      })
    }
  }
  for (const [key, value] of Object.entries(answers)) {
    if (used.has(key)) continue
    ordered.push({ term: key, value: renderAnswer(value, false) })
  }
  return ordered
}

function renderAnswer(value: AnswerValue, isFile: boolean): React.ReactNode {
  if (value === null || value === '') {
    return <span style={{ color: 'var(--text-tertiary)' }}>—</span>
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? (
      <span style={{ color: 'var(--text-tertiary)' }}>—</span>
    ) : (
      value.join(', ')
    )
  }
  if (isFile) {
    return <Mono>attached file {String(value)}</Mono>
  }
  return <span style={{ whiteSpace: 'pre-wrap' }}>{String(value)}</span>
}

function ReopenPanel({
  eventSlug,
  event,
  proposal,
}: {
  eventSlug: string
  event: Doc<'events'>
  proposal: Doc<'proposals'>
}) {
  const reopen = useMutation(api.cfp.reopenProposal)
  const { pending, error, setError, run } = usePending()
  const [until, setUntil] = useState(
    toInputValue(proposal.reopenedUntil ?? Date.now() + A_WEEK, event.timezone),
  )

  const closed =
    event.cfpCloseAt !== undefined && event.cfpCloseAt < Date.now()

  const submit = () => {
    const at = fromInputValue(until, event.timezone)
    if (at === null) return setError('Set the date the window closes again.')
    if (at < Date.now()) return setError('That moment has already passed.')
    void run(async () => {
      await reopen({ eventSlug, proposalId: proposal._id, until: at })
      pushToast(
        'Editing reopened',
        `The submitter can edit until ${formatDateTime(at, event.timezone)}.`,
      )
    })
  }

  return (
    <Card
      variant="flat"
      title="Reopen editing"
      subtitle={
        closed
          ? 'The CFP has closed. Grant this submitter a window to edit their proposal.'
          : 'The CFP is still open — a grant only matters once it closes.'
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {proposal.reopenedUntil !== undefined ? (
          <p style={{ color: 'var(--text-secondary)', font: 'var(--type-caption)' }}>
            Currently editable until{' '}
            {formatDateTime(proposal.reopenedUntil, event.timezone)}.
          </p>
        ) : null}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          <Field
            label="Editable until"
            htmlFor="reopen-until"
            hint={`Stated in ${event.timezone}.`}
          >
            <Input
              id="reopen-until"
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </Field>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Reopening…' : 'Reopen editing'}
          </Button>
        </div>
        {error !== null ? (
          <span style={{ color: 'var(--text-danger)', font: 'var(--type-caption)' }}>
            {error}
          </span>
        ) : null}
      </div>
    </Card>
  )
}
