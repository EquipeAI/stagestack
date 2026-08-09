import { useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Id } from '@convex/_generated/dataModel'
import { Badge, Button, Callout, Card, Checkbox, EmptyState, Tag, Textarea } from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { errorMessage } from '~/lib/errors'

export const Route = createFileRoute('/app/e/$eventSlug/import')({
  component: ImportPage,
})

type PlannedRecord = {
  id: string
  sourceRow?: number
  record: Record<string, unknown> & { kind: string }
  uncertainty?: string
  duplicateOf?: string
  reuse?: boolean
}

type ImportPlan = {
  summary: string
  columns?: Array<string>
  records: Array<PlannedRecord>
  skippedRows: Array<{ row: number; reason: string }>
}

type ExecutionReport = {
  total: number
  ok: number
  failed: number
  results: Array<{ id: string; ok: boolean; detail: string }>
}

const KIND_LABEL: Record<string, string> = {
  contact: 'Contact',
  track: 'Track',
  tag: 'Tag',
  proposal: 'Proposal',
  session: 'Session',
}

function recordTitle(r: PlannedRecord): string {
  const rec = r.record as {
    kind: string
    title?: string
    name?: string
    firstName?: string
    lastName?: string
  }
  switch (rec.kind) {
    case 'proposal':
    case 'session':
      return rec.title ?? '(untitled)'
    case 'track':
    case 'tag':
      return rec.name ?? '(unnamed)'
    case 'contact':
      return `${rec.firstName ?? ''} ${rec.lastName ?? ''}`.trim() || '(unnamed)'
    default:
      return '(unknown)'
  }
}

function recordDetail(r: PlannedRecord): string {
  const rec = r.record as {
    kind: string
    abstract?: string
    email?: string
    description?: string
    speakers?: Array<{ firstName: string; lastName: string }>
    speaker?: { firstName: string; lastName: string }
  }
  if (rec.kind === 'proposal' && rec.speakers?.length) {
    return rec.speakers.map((s) => `${s.firstName} ${s.lastName}`).join(', ')
  }
  if (rec.kind === 'session' && rec.speaker) {
    return `${rec.speaker.firstName} ${rec.speaker.lastName}`
  }
  if (rec.kind === 'contact' && rec.email) return rec.email
  return ''
}

function ImportPage() {
  const { eventSlug } = Route.useParams()
  const event = useQuery(api.events.get, { eventSlug })
  const [planJobId, setPlanJobId] = useState<Id<'jobs'> | null>(null)
  const [executeJobId, setExecuteJobId] = useState<Id<'jobs'> | null>(null)

  if (event !== undefined && event.role !== 'organizer') {
    return (
      <Callout tone="blocked" title="Organizers only">
        Importing creates records in this event.
      </Callout>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {executeJobId !== null ? (
        <ExecutionView eventSlug={eventSlug} jobId={executeJobId} onRestart={() => {
          setPlanJobId(null)
          setExecuteJobId(null)
        }} />
      ) : planJobId !== null ? (
        <PlanView
          eventSlug={eventSlug}
          jobId={planJobId}
          onConfirmed={(id) => setExecuteJobId(id)}
          onRestart={() => setPlanJobId(null)}
        />
      ) : (
        <UploadView eventSlug={eventSlug} onStarted={(id) => setPlanJobId(id)} />
      )}
    </div>
  )
}

function UploadView({
  eventSlug,
  onStarted,
}: {
  eventSlug: string
  onStarted: (jobId: Id<'jobs'>) => void
}) {
  const generateUploadUrl = useMutation(api.imports.generateUploadUrl)
  const start = useMutation(api.imports.start)
  const { pending, error, setError, run } = usePending()
  const [file, setFile] = useState<File | null>(null)
  const [description, setDescription] = useState('')
  const fileInput = useRef<HTMLInputElement | null>(null)

  const submit = () => {
    if (file === null) return setError('Choose a CSV or spreadsheet first.')
    void run(async () => {
      const url = await generateUploadUrl({ eventSlug })
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!res.ok) throw new Error(`Upload failed (${res.status})`)
      const { storageId } = (await res.json()) as { storageId: Id<'_storage'> }
      const jobId = await start({
        eventSlug,
        storageId,
        filename: file.name,
        description: description.trim() === '' ? undefined : description.trim(),
      })
      pushToast('Import started', 'The agent is reading your file.')
      onStarted(jobId)
    })
  }

  return (
    <Card
      title="Import with AI"
      subtitle="Upload a CSV or spreadsheet of talks, speakers or contacts. The agent proposes records; nothing is written until you approve the plan."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.xls,.ods"
          style={{ display: 'none' }}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <Button iconLeft="upload" onClick={() => fileInput.current?.click()}>
            {file === null ? 'Choose file' : 'Change file'}
          </Button>
          {file !== null ? (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
              }}
            >
              {file.name}
            </span>
          ) : (
            <span style={{ color: 'var(--text-tertiary)' }}>
              CSV, XLSX or ODS — first sheet, up to 300 rows.
            </span>
          )}
        </div>
        <Textarea
          value={description}
          rows={2}
          placeholder="Optional: tell the agent what this file is. e.g. “Talk submissions from our Google Form — one row per talk, columns C/D are the speaker.”"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div>
          <Button variant="primary" onClick={submit} disabled={pending || file === null}>
            {pending ? 'Uploading…' : 'Upload & plan import'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function PlanView({
  eventSlug,
  jobId,
  onConfirmed,
  onRestart,
}: {
  eventSlug: string
  jobId: Id<'jobs'>
  onConfirmed: (executeJobId: Id<'jobs'>) => void
  onRestart: () => void
}) {
  const job = useQuery(api.imports.getJob, { eventSlug, jobId })
  const confirm = useMutation(api.imports.confirm)
  const { pending, error, run } = usePending()
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())

  const plan = (job?.status === 'done' ? (job.result as ImportPlan) : null) ?? null
  const included = useMemo(
    () => plan?.records.filter((r) => !excluded.has(r.id)) ?? [],
    [plan, excluded],
  )

  if (job === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading import…</p>
  }
  if (job === null) {
    return (
      <Callout tone="blocked" title="Import not found">
        This import belongs to a different event or was removed.
      </Callout>
    )
  }
  if (job.status === 'failed') {
    return (
      <Card title="The agent could not read this file">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Callout tone="blocked">{job.error ?? 'Unknown error'}</Callout>
          <div>
            <Button onClick={onRestart}>Try another file</Button>
          </div>
        </div>
      </Card>
    )
  }
  if (plan === null) {
    return (
      <Card title="Planning your import…" subtitle="The agent is reading the file and matching it against this event.">
        <p style={{ color: 'var(--text-tertiary)' }}>
          This usually takes under a minute. You can leave this page; the plan
          will be waiting on your return.
        </p>
      </Card>
    )
  }

  const toggle = (id: string) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <>
      <Card title="Review the plan" subtitle={plan.summary}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
          {plan.records.length === 0 ? (
            <EmptyState
              icon="inbox"
              title="Nothing to import"
              description="The agent could not derive any records from this file."
              action={<Button onClick={onRestart}>Try another file</Button>}
            />
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {plan.records.map((r) => (
                <li
                  key={r.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-2) 0',
                    borderBottom: 'var(--space-px) solid var(--border-subtle)',
                  }}
                >
                  <Checkbox
                    checked={!excluded.has(r.id)}
                    onChange={() => toggle(r.id)}
                    name={`include-${r.id}`}
                  />
                  <Tag>{KIND_LABEL[r.record.kind] ?? r.record.kind}</Tag>
                  <span style={{ flex: '1 1 12rem', minWidth: 0 }}>
                    <strong>{recordTitle(r)}</strong>
                    {recordDetail(r) !== '' ? (
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        {' '}
                        — {recordDetail(r)}
                      </span>
                    ) : null}
                  </span>
                  {r.reuse === true ? (
                    <Badge tone="info">reuses existing</Badge>
                  ) : r.duplicateOf !== undefined ? (
                    <Badge tone="attention" dot>
                      possible duplicate
                    </Badge>
                  ) : null}
                  {r.uncertainty !== undefined ? (
                    <Badge tone="attention">{r.uncertainty}</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {plan.skippedRows.length > 0 ? (
            <Callout tone="attention" title={`${plan.skippedRows.length} rows skipped`}>
              {plan.skippedRows
                .slice(0, 8)
                .map((s) => (s.row >= 0 ? `Row ${s.row}: ${s.reason}` : s.reason))
                .join(' · ')}
              {plan.skippedRows.length > 8 ? ' · …' : ''}
            </Callout>
          ) : null}
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <Button
              variant="primary"
              disabled={pending || included.length === 0}
              onClick={() => {
                void run(async () => {
                  try {
                    const executeJobId = await confirm({
                      eventSlug,
                      planJobId: jobId,
                      // The route types the plan loosely (job.result is any);
                      // the server re-validates against vPlannedRecord.
                      records: included as never,
                    })
                    pushToast('Import approved', `${included.length} records queued.`)
                    onConfirmed(executeJobId)
                  } catch (err) {
                    pushToast('Could not start import', errorMessage(err), 'octagon-alert')
                    throw err
                  }
                })
              }}
            >
              {pending
                ? 'Starting…'
                : `Approve & import ${included.length} record${included.length === 1 ? '' : 's'}`}
            </Button>
            <Button onClick={onRestart} disabled={pending}>
              Start over
            </Button>
          </div>
        </div>
      </Card>
    </>
  )
}

function ExecutionView({
  eventSlug,
  jobId,
  onRestart,
}: {
  eventSlug: string
  jobId: Id<'jobs'>
  onRestart: () => void
}) {
  const job = useQuery(api.imports.getJob, { eventSlug, jobId })
  const report =
    job?.status === 'done' ? (job.result as ExecutionReport) : null

  if (job === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
  }
  if (job === null || job.status === 'failed') {
    return (
      <Callout tone="blocked" title="Import failed">
        {job?.error ?? 'The import job disappeared.'}
      </Callout>
    )
  }
  if (report === null) {
    return (
      <Card title="Importing…" subtitle="Records are being written with your permissions.">
        <p style={{ color: 'var(--text-tertiary)' }}>
          Each record is validated individually — anything rejected is reported
          here rather than imported half-way.
        </p>
      </Card>
    )
  }
  return (
    <Card
      title={`Import finished — ${report.ok} of ${report.total} records created`}
      subtitle={
        report.failed > 0
          ? `${report.failed} records were rejected; details below.`
          : 'Everything the agent planned was written successfully.'
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {report.results.map((r) => (
            <li
              key={r.id}
              style={{
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'center',
                padding: 'var(--space-1) 0',
              }}
            >
              <Badge tone={r.ok ? 'success' : 'blocked'} dot>
                {r.ok ? 'ok' : 'failed'}
              </Badge>
              <span style={{ color: r.ok ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                {r.detail}
              </span>
            </li>
          ))}
        </ul>
        <div>
          <Button onClick={onRestart}>Import another file</Button>
        </div>
      </div>
    </Card>
  )
}
