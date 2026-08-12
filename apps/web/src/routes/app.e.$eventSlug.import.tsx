import { useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Id } from '@convex/_generated/dataModel'
// The plan's shape is the same contract the executor re-validates against, so
// the review UI reads it from convex/shared/importPlan.ts instead of restating
// it — a field added to vImportRecord must not silently become invisible here.
import type { ImportPlan, PlannedRecord } from '@convex/shared/importPlan'
import { ActionResult, Badge, Button, Callout, Card, Checkbox, DescriptionList, EmptyState, Tag, Textarea } from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { errorMessage } from '~/lib/errors'

export const Route = createFileRoute('/app/e/$eventSlug/import')({
  component: ImportPage,
})

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
  const rec = r.record
  switch (rec.kind) {
    case 'proposal':
    case 'session':
      return rec.title.trim() === '' ? '(untitled)' : rec.title
    case 'track':
    case 'tag':
      return rec.name.trim() === '' ? '(unnamed)' : rec.name
    case 'contact':
      return `${rec.firstName} ${rec.lastName}`.trim() || '(unnamed)'
  }
}

const FIELD_LABEL: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  tagline: 'Tagline',
  bio: 'Bio',
  name: 'Name',
  title: 'Title',
  abstract: 'Abstract',
  trackName: 'Track',
  description: 'Description',
  speakers: 'Speakers',
  speaker: 'Speaker',
}

function personText(value: unknown): string {
  const p = value as { firstName?: string; lastName?: string; email?: string }
  const name = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()
  const parts = [name === '' ? '(unnamed)' : name]
  if (p.email !== undefined && p.email !== '') parts.push(`<${p.email}>`)
  return parts.join(' ')
}

function fieldText(key: string, value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (key === 'speakers' && Array.isArray(value)) {
    return value.map(personText).join(' · ')
  }
  if (key === 'speaker') return personText(value)
  // Never expected from a validated plan — shown as JSON rather than dropped,
  // because the rule here is "nothing gets written that wasn't reviewed".
  return JSON.stringify(value)
}

/**
 * Every field of a planned record that the executor will write, enumerated from
 * the record itself rather than from a hand-written list. The plan is authored
 * by an LLM reading an attacker-supplied spreadsheet and then written under the
 * approving organizer's authority (MILESTONES M1), so a field the UI forgets to
 * render is a field an injected value can hide in.
 */
function writeableFields(
  r: PlannedRecord,
): Array<{ key: string; label: string; text: string }> {
  return Object.entries(r.record as Record<string, unknown>)
    .filter(([key, value]) => key !== 'kind' && value !== undefined)
    .map(([key, value]) => ({
      key,
      label: FIELD_LABEL[key] ?? key,
      text: fieldText(key, value),
    }))
}

// Long enough that clamping earns its keep; short enough that a bio or an
// abstract still shows its opening sentence at a glance.
const CLAMP_AT = 160

/** One field value: clamped to two lines by default, expandable in place. The
 * value is always on screen — hiding it behind a click is what created the
 * blind spot in the first place. */
function FieldValue({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const clamp = text.length > CLAMP_AT && !expanded
  return (
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
      <span
        style={{
          minWidth: 0,
          // pre-wrap so a smuggled newline or run of spaces is visible.
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          ...(clamp
            ? {
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical' as const,
                overflow: 'hidden',
              }
            : {}),
        }}
      >
        {text === '' ? '(empty)' : text}
      </span>
      {text.length > CLAMP_AT ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : `Show all ${text.length} characters`}
        </Button>
      ) : null}
    </span>
  )
}

function PlannedFields({ record }: { record: PlannedRecord }) {
  const fields = writeableFields(record)
  if (fields.length === 0) return null
  return (
    <DescriptionList
      items={fields.map((f) => ({
        term: f.label,
        value: <FieldValue key={f.key} text={f.text} />,
      }))}
    />
  )
}

type ViewSelection = {
  planJobId: Id<'jobs'> | null
  executeJobId: Id<'jobs'> | null
}

function ImportPage() {
  const { eventSlug } = Route.useParams()
  const event = useQuery(api.events.get, { eventSlug })
  const isOrganizer = event?.role === 'organizer'
  // Server state is the resume source ("the plan will be waiting on your
  // return"); local state only overrides it after an explicit action here
  // (started an upload, confirmed a plan, chose "start over").
  const jobs = useQuery(api.imports.listJobs, isOrganizer ? { eventSlug } : 'skip')
  const [override, setOverride] = useState<ViewSelection | null>(null)

  // Hold the gate until the role is known, so reviewers never see the
  // organizer-only UI flash during load.
  if (event === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
  }
  if (event.role !== 'organizer') {
    return (
      <Callout tone="blocked" title="Organizers only">
        Importing creates records in this event.
      </Callout>
    )
  }
  if (jobs === undefined && override === null) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
  }

  let selection: ViewSelection = { planJobId: null, executeJobId: null }
  if (override !== null) {
    selection = override
  } else {
    // Resume the most recent import: an execution (finished or not) wins over
    // its plan; an unconfirmed plan (even failed — the error is actionable)
    // comes back for review.
    const latest = jobs?.[0]
    if (latest?.type === 'import-execute') {
      selection = { planJobId: null, executeJobId: latest._id }
    } else if (latest?.type === 'import-plan') {
      selection = { planJobId: latest._id, executeJobId: null }
    }
  }
  const { planJobId, executeJobId } = selection
  const restart = () => setOverride({ planJobId: null, executeJobId: null })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {executeJobId !== null ? (
        <ExecutionView eventSlug={eventSlug} jobId={executeJobId} onRestart={restart} />
      ) : planJobId !== null ? (
        <PlanView
          eventSlug={eventSlug}
          jobId={planJobId}
          onConfirmed={(id) => setOverride({ planJobId, executeJobId: id })}
          onRestart={restart}
        />
      ) : (
        <UploadView
          eventSlug={eventSlug}
          onStarted={(id) => setOverride({ planJobId: id, executeJobId: null })}
        />
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
          aria-label="What this file is"
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
  // Silent here: this run()'s catch feeds the ActionResult below, which
  // announces the refusal itself.
  const { pending, error, run } = usePending({ announce: false })
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())
  // W5: a refused import is a persistent result with a retry — it used to be a
  // toast that took the reason with it when it faded.
  const [startFailure, setStartFailure] = useState<string | null>(null)

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
                    alignItems: 'flex-start',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-3) 0',
                    borderBottom: 'var(--space-px) solid var(--border-subtle)',
                  }}
                >
                  <Checkbox
                    checked={!excluded.has(r.id)}
                    onChange={() => toggle(r.id)}
                    name={`include-${r.id}`}
                    aria-label={`Import ${recordTitle(r)}`}
                  />
                  <div
                    style={{
                      flex: '1 1 auto',
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-2)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-3)',
                        flexWrap: 'wrap',
                      }}
                    >
                      <Tag>{KIND_LABEL[r.record.kind] ?? r.record.kind}</Tag>
                      <strong style={{ minWidth: 0 }}>{recordTitle(r)}</strong>
                      {r.sourceRow !== undefined ? (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 'var(--text-sm)',
                            color: 'var(--text-tertiary)',
                          }}
                        >
                          row {r.sourceRow}
                        </span>
                      ) : null}
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
                    </div>
                    {/* Approval means "write exactly this", so every field the
                        executor will write is on screen under its own label. */}
                    <PlannedFields record={r} />
                  </div>
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
          {startFailure === null ? null : (
            <ActionResult
              status="failed"
              title="The import was not started"
              details={[
                startFailure,
                `Nothing was written. ${included.length} record${included.length === 1 ? '' : 's'} ${included.length === 1 ? 'is' : 'are'} still selected.`,
              ]}
              onDismiss={() => setStartFailure(null)}
            />
          )}
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <Button
              variant="primary"
              disabled={pending || included.length === 0}
              onClick={() => {
                void run(async () => {
                  setStartFailure(null)
                  try {
                    const executeJobId = await confirm({
                      eventSlug,
                      planJobId: jobId,
                      // Typed by the shared contract; the server still
                      // re-validates against vPlannedRecord.
                      records: included,
                    })
                    onConfirmed(executeJobId)
                  } catch (err) {
                    setStartFailure(errorMessage(err))
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Callout tone="blocked" title="Import failed">
          {job?.error ?? 'The import job disappeared.'}
        </Callout>
        <div>
          <Button onClick={onRestart}>Start a new import</Button>
        </div>
      </div>
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
