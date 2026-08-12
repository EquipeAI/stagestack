import { useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Doc, Id } from '@convex/_generated/dataModel'
import {
  ActionResult,
  Button,
  Callout,
  Card,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
} from '~/ds'
import { FileButton } from '~/components/FileButton'
import { pushToast } from '~/components/toast'
import { usePending } from '~/lib/usePending'

type Contact = Doc<'contacts'>
type Stage = NonNullable<Contact['pipelineStage']>

export function contactMatchesSearch(contact: Contact, search?: string) {
  const needle = search?.trim().toLowerCase()
  if (!needle) return true
  return [
    contact.firstName,
    contact.lastName,
    contact.email,
    contact.tagline,
    contact.jobTitle,
    contact.company,
    ...(contact.tags ?? []),
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ')
    .toLowerCase()
    .includes(needle)
}

const STAGES: Array<{ value: Stage; label: string }> = [
  { value: 'sourced', label: 'Sourced' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'shortlisted', label: 'Shortlisted' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'declined', label: 'Declined' },
]

export function CrmTools({
  orgSlug,
  contacts,
  selected,
  search,
  tag,
  company,
  onSearch,
  onTag,
  onCompany,
  onClearSelection,
  onOpenContact,
}: {
  orgSlug: string
  contacts: Array<Contact>
  selected: Array<Id<'contacts'>>
  search: string
  tag: string
  company: string
  onSearch: (value: string) => void
  onTag: (value: string) => void
  onCompany: (value: string) => void
  onClearSelection: () => void
  onOpenContact: (contact: Contact) => void
}) {
  const overview = useQuery(api.contacts.overview, { orgSlug })
  const duplicates = useQuery(api.contacts.nearDuplicates, { orgSlug })
  const segments = useQuery(api.contacts.segments, { orgSlug })
  const saveSegment = useMutation(api.contacts.saveSegment)
  const merge = useMutation(api.contacts.merge)
  const [importing, setImporting] = useState(false)
  const [composing, setComposing] = useState(false)
  // The outreach dialog closes on send, so its outcome belongs to the page —
  // otherwise "3 failed" would leave with the dialog (W5).
  const [outreachResult, setOutreachResult] = useState<{
    status: 'success' | 'partial'
    title: string
    lines: Array<string>
  } | null>(null)
  const [segmentName, setSegmentName] = useState('')
  const [mergePair, setMergePair] = useState<
    { primary: Contact; secondary: Contact } | undefined
  >()
  const segmentState = usePending()
  const mergeState = usePending()

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      {outreachResult === null ? null : (
        <ActionResult
          status={outreachResult.status}
          title={outreachResult.title}
          details={outreachResult.lines}
          onDismiss={() => setOutreachResult(null)}
        />
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
          gap: 'var(--space-3)',
        }}
      >
        <Card title="Contacts">
          <strong style={{ font: 'var(--type-heading-2)' }}>
            {overview === undefined
              ? '…'
              : `${overview.totalContacts}${overview.capped ? '+' : ''}`}
          </strong>
          {overview?.capped ? (
            <p>Metrics scan is capped at 1,000 contacts.</p>
          ) : null}
        </Card>
        <Card title="Reachable">
          <strong style={{ font: 'var(--type-heading-2)' }}>
            {overview?.withEmail ?? '…'}
          </strong>
          <p>Contacts with an email address</p>
        </Card>
        <Card title="In pipeline">
          <strong style={{ font: 'var(--type-heading-2)' }}>
            {overview?.enrolled ?? '…'}
          </strong>
          <p>Currently enrolled contacts</p>
        </Card>
        <Card title="Top companies">
          {overview === undefined ? (
            <p>Loading…</p>
          ) : overview.topCompanies.length === 0 ? (
            <p>No company data yet.</p>
          ) : (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--space-2)',
              }}
            >
              {overview.topCompanies.map((row) => (
                <Button
                  key={row.company}
                  size="sm"
                  onClick={() => onCompany(row.company)}
                >
                  {row.company} · {row.count}
                </Button>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Saved dynamic segments"
        subtitle="Save the current search, tag and company filters, then reopen them at any time."
      >
        {segmentState.error ? (
          <Callout tone="blocked">{segmentState.error}</Callout>
        ) : null}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
            alignItems: 'end',
          }}
        >
          <Field label="Segment name" htmlFor="crm-segment-name">
            <Input
              id="crm-segment-name"
              value={segmentName}
              onChange={(event) => setSegmentName(event.target.value)}
            />
          </Field>
          <Button
            disabled={segmentState.pending || segmentName.trim() === ''}
            onClick={() => {
              const name = segmentName.trim()
              void segmentState.run(async () => {
                await saveSegment({
                  orgSlug,
                  name,
                  filters: {
                    search: search.trim() || undefined,
                    tag: tag.trim() || undefined,
                    company: company.trim() || undefined,
                  },
                })
                setSegmentName('')
                pushToast('Segment saved', name)
              })
            }}
          >
            Save current filters
          </Button>
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
            marginTop: 'var(--space-3)',
          }}
        >
          {(segments ?? []).map((segment) => {
            const members = contacts.filter((contact) =>
              matchesFilters(contact, segment.filters),
            ).length
            return (
              <Button
                key={segment._id}
                size="sm"
                onClick={() => {
                  onSearch(segment.filters.search ?? '')
                  onTag(segment.filters.tag ?? '')
                  onCompany(segment.filters.company ?? '')
                }}
              >
                {segment.name} · {members}
              </Button>
            )
          })}
        </div>
      </Card>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        <Button iconLeft="upload" onClick={() => setImporting(true)}>
          Import CSV
        </Button>
        <Button
          disabled={selected.length < 2}
          iconLeft="mail"
          onClick={() => setComposing(true)}
        >
          Email selected ({selected.length})
        </Button>
      </div>

      {duplicates !== undefined && duplicates.pairs.length > 0 ? (
        <Card
          title={`Possible duplicates (${duplicates.pairs.length})`}
          subtitle={`Same normalized name with different email addresses. Scanned ${duplicates.scanned}${duplicates.capped ? '+' : ''} contacts.`}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
            }}
          >
            {duplicates.pairs.map((pair) => (
              <div
                key={`${pair.primary._id}-${pair.secondary._id}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 'var(--space-3)',
                  alignItems: 'center',
                }}
              >
                <span>
                  {pair.primary.firstName} {pair.primary.lastName}:{' '}
                  {pair.primary.email ?? 'no email'} /{' '}
                  {pair.secondary.email ?? 'no email'}
                </span>
                <Button size="sm" onClick={() => setMergePair(pair)}>
                  Review merge
                </Button>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <PipelineBoard
        orgSlug={orgSlug}
        contacts={contacts}
        onOpenContact={onOpenContact}
      />

      {importing ? (
        <CsvImportDialog
          orgSlug={orgSlug}
          onClose={() => setImporting(false)}
        />
      ) : null}
      {composing ? (
        <BulkOutreachDialog
          orgSlug={orgSlug}
          contacts={contacts.filter((contact) =>
            selected.includes(contact._id),
          )}
          onClose={() => setComposing(false)}
          onResult={setOutreachResult}
          onSent={onClearSelection}
        />
      ) : null}
      {mergePair ? (
        <Dialog
          open
          width={560}
          title="Merge duplicate contacts"
          description="Choose which profile survives. Missing profile fields, tags, notes, event links, messages and pipeline history move to it."
          onClose={
            mergeState.pending ? undefined : () => setMergePair(undefined)
          }
          footer={
            <Button onClick={() => setMergePair(undefined)}>Cancel</Button>
          }
        >
          {mergeState.error ? (
            <Callout tone="blocked">{mergeState.error}</Callout>
          ) : null}
          {[mergePair.primary, mergePair.secondary].map((primary) => {
            const secondary =
              primary._id === mergePair.primary._id
                ? mergePair.secondary
                : mergePair.primary
            return (
              <Button
                key={primary._id}
                disabled={mergeState.pending}
                onClick={() =>
                  void mergeState.run(async () => {
                    const result = await merge({
                      orgSlug,
                      primaryId: primary._id,
                      secondaryId: secondary._id,
                    })
                    pushToast(
                      'Contacts merged',
                      `${result.rewired} related records moved.`,
                    )
                    setMergePair(undefined)
                  })
                }
              >
                Keep{' '}
                {primary.email ?? `${primary.firstName} ${primary.lastName}`}
              </Button>
            )
          })}
        </Dialog>
      ) : null}
    </div>
  )
}

function matchesFilters(
  contact: Contact,
  filters: { search?: string; tag?: string; company?: string },
) {
  if (filters.tag && !(contact.tags ?? []).includes(filters.tag)) return false
  if (filters.company && contact.company !== filters.company) return false
  return contactMatchesSearch(contact, filters.search)
}

function PipelineBoard({
  orgSlug,
  contacts,
  onOpenContact,
}: {
  orgSlug: string
  contacts: Array<Contact>
  onOpenContact: (contact: Contact) => void
}) {
  const setStage = useMutation(api.contacts.setPipelineStage)
  const [pendingId, setPendingId] = useState<Id<'contacts'> | null>(null)
  const enrolled = contacts.filter(
    (contact) => contact.pipelineStage !== undefined,
  )
  const unenrolled = contacts.filter(
    (contact) => contact.pipelineStage === undefined,
  )
  return (
    <Card
      title="Speaker pipeline"
      subtitle="Five-stage optional pipeline. Moves persist immediately."
    >
      {unenrolled.length > 0 ? (
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            alignItems: 'center',
            marginBottom: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          <span>Add to pipeline:</span>
          {unenrolled.slice(0, 10).map((contact) => (
            <Button
              key={contact._id}
              size="sm"
              disabled={pendingId !== null}
              onClick={() => {
                setPendingId(contact._id)
                void setStage({
                  orgSlug,
                  contactId: contact._id,
                  stage: 'sourced',
                }).finally(() => setPendingId(null))
              }}
            >
              {contact.firstName} {contact.lastName}
            </Button>
          ))}
        </div>
      ) : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(12rem, 1fr))',
          gap: 'var(--space-3)',
          overflowX: 'auto',
        }}
      >
        {STAGES.map((stage) => (
          <div
            key={stage.value}
            style={{
              minWidth: '12rem',
              padding: 'var(--space-3)',
              border: 'var(--space-px) solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <strong>
              {stage.label} ·{' '}
              {
                enrolled.filter(
                  (contact) => contact.pipelineStage === stage.value,
                ).length
              }
            </strong>
            {enrolled
              .filter((contact) => contact.pipelineStage === stage.value)
              .map((contact) => (
                <div
                  key={contact._id}
                  style={{
                    marginTop: 'var(--space-3)',
                    padding: 'var(--space-2)',
                    background: 'var(--surface-raised)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <div>
                    {contact.firstName} {contact.lastName}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpenContact(contact)}
                  >
                    Details &amp; history
                  </Button>
                  <Field label="Stage" htmlFor={`crm-stage-${contact._id}`}>
                    <Select
                      id={`crm-stage-${contact._id}`}
                      value={contact.pipelineStage}
                      disabled={pendingId !== null}
                      options={[
                        ...STAGES,
                        { value: '', label: 'Remove from pipeline' },
                      ]}
                      onChange={(event) => {
                        setPendingId(contact._id)
                        void setStage({
                          orgSlug,
                          contactId: contact._id,
                          stage: (event.target.value || null) as Stage | null,
                        }).finally(() => setPendingId(null))
                      }}
                    />
                  </Field>
                </div>
              ))}
          </div>
        ))}
      </div>
    </Card>
  )
}

type ParsedRow = {
  rowNumber: number
  firstName: string
  lastName: string
  email: string
  company?: string
  jobTitle?: string
  bio?: string
  tags?: Array<string>
}

function splitContactName(value: string): {
  firstName: string
  lastName: string
} {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) {
    return { firstName: parts[0] ?? '', lastName: '' }
  }
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts.at(-1) ?? '',
  }
}

export function parseContactsCsv(source: string): {
  rows: Array<ParsedRow>
  errors: Array<string>
} {
  const records: Array<Array<string>> = []
  let row: Array<string> = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '"' && quoted && source[index + 1] === '"') {
      cell += '"'
      index += 1
    } else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      row.push(cell)
      cell = ''
      if (row.some((value) => value.trim() !== '')) records.push(row)
      row = []
    } else cell += char
  }
  row.push(cell)
  if (row.some((value) => value.trim() !== '')) records.push(row)
  if (quoted)
    return { rows: [], errors: ['CSV contains an unclosed quoted field.'] }
  if (records.length === 0)
    return { rows: [], errors: ['Paste a CSV with a header row.'] }
  const headers = records[0].map((value) =>
    value.trim().toLowerCase().replace(/[ _-]/g, ''),
  )
  const column = (...names: Array<string>) =>
    headers.findIndex((header) => names.includes(header))
  const first = column('firstname', 'first')
  const last = column('lastname', 'last')
  const fullName = column('name', 'fullname', 'speakername')
  const email = column('email', 'emailaddress')
  if ((first < 0 && fullName < 0) || email < 0)
    return {
      rows: [],
      errors: [
        'Headers must include email plus either name or firstName/lastName.',
      ],
    }
  const company = column('company', 'organization')
  const jobTitle = column('jobtitle', 'title')
  const bio = column('bio', 'biography', 'about')
  const tags = column('tags', 'tag')
  const rows = records.slice(1).map((values, index) => {
    const split =
      fullName < 0
        ? { firstName: '', lastName: '' }
        : splitContactName(values[fullName] ?? '')
    return {
      rowNumber: index + 2,
      firstName: first < 0 ? split.firstName : (values[first] ?? '').trim(),
      lastName: last < 0 ? split.lastName : (values[last] ?? '').trim(),
      email: (values[email] ?? '').trim(),
      company:
        company < 0 || !(values[company] ?? '').trim()
          ? undefined
          : values[company].trim(),
      jobTitle:
        jobTitle < 0 || !(values[jobTitle] ?? '').trim()
          ? undefined
          : values[jobTitle].trim(),
      bio:
        bio < 0 || !(values[bio] ?? '').trim() ? undefined : values[bio].trim(),
      tags:
        tags < 0
          ? undefined
          : values[tags]
              .split(/[;|]/)
              .map((value) => value.trim())
              .filter(Boolean),
    }
  })
  const errors = rows.flatMap((item) =>
    !item.firstName || !item.email
      ? [`Row ${item.rowNumber}: firstName and email are required.`]
      : [],
  )
  return { rows, errors }
}

function CsvImportDialog({
  orgSlug,
  onClose,
}: {
  orgSlug: string
  onClose: () => void
}) {
  const importRows = useMutation(api.contacts.importCsvBatch)
  const state = usePending()
  const [source, setSource] = useState('firstName,lastName,email,company\n')
  const [result, setResult] = useState<{
    imported: number
    skipped: number
    errors: Array<{ rowNumber: number; message: string }>
  }>()
  const parsed = useMemo(() => parseContactsCsv(source), [source])
  return (
    <Dialog
      open
      width={760}
      title="Import contacts from CSV"
      description="Upload a CSV or paste its contents. Preview up to 100 rows before importing."
      onClose={state.pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={
              state.pending ||
              parsed.rows.length === 0 ||
              parsed.rows.length > 100 ||
              parsed.errors.length > 0
            }
            onClick={() =>
              void state.run(async () => {
                const next = await importRows({ orgSlug, rows: parsed.rows })
                setResult(next)
              })
            }
          >
            {state.pending ? 'Importing…' : `Import ${parsed.rows.length} rows`}
          </Button>
        </>
      }
    >
      {state.error ? <Callout tone="blocked">{state.error}</Callout> : null}
      <Field label="CSV file" htmlFor="crm-csv-file">
        <FileButton
          id="crm-csv-file"
          size="sm"
          accept=".csv,text/csv"
          onFile={(file) => {
            void file.text().then(setSource)
          }}
        >
          Choose CSV file
        </FileButton>
      </Field>
      <Field label="CSV contents" htmlFor="crm-csv-source">
        <Textarea
          id="crm-csv-source"
          rows={8}
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
      </Field>
      {parsed.errors.map((error) => (
        <Callout key={error} tone="blocked">
          {error}
        </Callout>
      ))}
      <p>
        <strong>Preview:</strong> {parsed.rows.length} rows detected
        {parsed.rows.length > 100 ? ' — split into batches of 100.' : ''}
      </p>
      <div style={{ maxHeight: 220, overflow: 'auto' }}>
        {parsed.rows.slice(0, 20).map((row) => (
          <div key={row.rowNumber}>
            Row {row.rowNumber}: {row.firstName} {row.lastName} · {row.email} ·{' '}
            {row.company ?? '—'}
          </div>
        ))}
      </div>
      {result ? (
        <ActionResult
          status={result.skipped ? 'partial' : 'success'}
          title={`${result.imported} contact${result.imported === 1 ? '' : 's'} imported`}
          details={[
            `${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} submitted · ${result.imported} imported · ${result.skipped} skipped.`,
            ...result.errors.map(
              (error) => `Row ${error.rowNumber}: ${error.message}`,
            ),
          ]}
        />
      ) : null}
    </Dialog>
  )
}

function BulkOutreachDialog({
  orgSlug,
  contacts,
  onClose,
  onResult,
  onSent,
}: {
  orgSlug: string
  contacts: Array<Contact>
  onClose: () => void
  onResult: (result: {
    status: 'success' | 'partial'
    title: string
    lines: Array<string>
  }) => void
  onSent: () => void
}) {
  const send = useMutation(api.contacts.sendBulkOutreach)
  const state = usePending()
  const [subject, setSubject] = useState('An invitation for {{firstName}}')
  const [body, setBody] = useState(
    'Hi {{firstName}},\n\nWe would love to talk with you about speaking at our event.',
  )
  const resolve = (value: string, contact: Contact) =>
    value
      .replaceAll('{{firstName}}', contact.firstName)
      .replaceAll(
        '{{speakerName}}',
        `${contact.firstName} ${contact.lastName}`.trim(),
      )
      .replaceAll('{{company}}', contact.company ?? '')
      .replaceAll('{{speaker.firstName}}', contact.firstName)
      .replaceAll(
        '{{speaker.fullName}}',
        `${contact.firstName} ${contact.lastName}`.trim(),
      )
      .replaceAll('{{speaker.company}}', contact.company ?? '')
  return (
    <Dialog
      open
      width={700}
      title={`Email ${contacts.length} contacts`}
      description="Merge tags: {{firstName}} or {{speaker.firstName}}, {{speakerName}} or {{speaker.fullName}}, and {{company}} or {{speaker.company}}. Contacts without email are reported as skipped."
      onClose={state.pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={state.pending || !subject.trim() || !body.trim()}
            onClick={() =>
              void state.run(async () => {
                const result = await send({
                  orgSlug,
                  contactIds: contacts.map((contact) => contact._id),
                  subject,
                  body,
                })
                // Every count comes from the mutation, which is where
                // eligibility (an address on file) is decided.
                onResult({
                  status:
                    result.failed + result.skipped === 0
                      ? 'success'
                      : 'partial',
                  title: `${result.queued} email${result.queued === 1 ? '' : 's'} queued`,
                  lines: [
                    `${contacts.length} contact${contacts.length === 1 ? '' : 's'} selected · ${result.queued} queued.`,
                    ...(result.failed > 0
                      ? [`${result.failed} could not be sent.`]
                      : []),
                    ...(result.skipped > 0
                      ? [
                          `${result.skipped} skipped — no email address on file.`,
                        ]
                      : []),
                  ],
                })
                onSent()
                onClose()
              })
            }
          >
            {state.pending ? 'Sending…' : 'Send and log'}
          </Button>
        </>
      }
    >
      {state.error ? <Callout tone="blocked">{state.error}</Callout> : null}
      <Field label="Subject" htmlFor="crm-email-subject">
        <Input
          id="crm-email-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </Field>
      <Field label="Body" htmlFor="crm-email-body">
        <Textarea
          id="crm-email-body"
          rows={7}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </Field>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          maxHeight: 300,
          overflow: 'auto',
        }}
      >
        {contacts.map((contact) => (
          <Card
            key={contact._id}
            variant="flat"
            title={`Resolved preview for ${contact.firstName} ${contact.lastName}`}
          >
            <strong>{resolve(subject, contact)}</strong>
            <p style={{ whiteSpace: 'pre-wrap' }}>{resolve(body, contact)}</p>
          </Card>
        ))}
      </div>
    </Dialog>
  )
}
