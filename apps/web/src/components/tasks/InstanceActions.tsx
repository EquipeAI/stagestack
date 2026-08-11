import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { TASK_STATUS_LABEL, isOverdue } from './model'
import type { InstanceRow } from './model'
import type { Id } from '@convex/_generated/dataModel'
import { Button, Callout, Dialog, Field, Input, Textarea } from '~/ds'
import { TaskCommentThread } from '~/components/tasks/TaskCommentThread'
import { UploadVersionList } from '~/components/tasks/UploadVersionList'
import { usePending } from '~/lib/usePending'
import { errorMessage } from '~/lib/errors'
import { pushToast } from '~/components/toast'
import { formatDateTime, fromInputValue, toInputValue } from '~/lib/datetime'

// Every organizer-side move on one obligation, in one place, so the tasks
// table and the dashboard drill-down cannot drift apart.
//
// The rules are the backend's (convex/model/tasks.ts) and are mirrored here
// only to decide which buttons to render: approve needs work awaiting review,
// a change request needs something submitted to send back, and a waiver or a
// reopen is always the organizer's to make.

type DialogKind = 'changes' | 'notApplicable' | 'due' | 'uploads'

export function InstanceActions({
  eventSlug,
  instance,
  timezone,
  now,
}: {
  eventSlug: string
  instance: InstanceRow
  timezone: string
  now: number
}) {
  const approve = useMutation(api.tasks.approve)
  const reopen = useMutation(api.tasks.reopen)
  const markProvided = useMutation(api.tasks.markProvided)
  const { pending, error, setError, run } = usePending()
  const [open, setOpen] = useState<DialogKind | null>(null)

  const { status, evidence } = instance
  const canApprove = status === 'provided'
  const canRequestChanges =
    status === 'provided' || status === 'approved' || status === 'complete'
  const canMarkProvided =
    evidence === 'manual' &&
    (status === 'pending' || status === 'changesRequested')
  const canWaive = status !== 'notApplicable'
  const canReopen = status !== 'pending'

  const close = () => {
    setOpen(null)
    setError(null)
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        alignItems: 'flex-start',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-2)',
          alignItems: 'center',
        }}
      >
        {canApprove ? (
          <Button
            size="sm"
            iconLeft="circle-check"
            disabled={pending}
            onClick={() => {
              void run(async () => {
                await approve({ eventSlug, instanceId: instance.instanceId })
                pushToast(
                  'Task approved',
                  `"${instance.requirementTitle}" is approved for ${instance.speakerName ?? instance.sessionTitle}.`,
                  'circle-check',
                )
              })
            }}
          >
            Approve
          </Button>
        ) : null}

        {canMarkProvided ? (
          <Button
            size="sm"
            iconLeft="check"
            disabled={pending}
            onClick={() => {
              void run(async () => {
                await markProvided({
                  eventSlug,
                  instanceId: instance.instanceId,
                })
                pushToast(
                  'Marked as provided',
                  `You completed "${instance.requirementTitle}" on their behalf — it stays owed by ${instance.speakerName ?? 'this session'}.`,
                )
              })
            }}
          >
            Mark provided
          </Button>
        ) : null}

        {canRequestChanges ? (
          <Button
            size="sm"
            variant="ghost"
            iconLeft="refresh-cw"
            disabled={pending}
            onClick={() => {
              setOpen('changes')
            }}
          >
            Request changes
          </Button>
        ) : null}

        {evidence === 'file' ? (
          <Button
            size="sm"
            variant="ghost"
            iconLeft="paperclip"
            disabled={pending}
            onClick={() => {
              setOpen('uploads')
            }}
          >
            {instance.uploadCount === 0
              ? 'Files'
              : `Files (${instance.uploadCount})`}
          </Button>
        ) : null}

        {canWaive ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setOpen('notApplicable')
            }}
          >
            Mark N/A
          </Button>
        ) : null}

        {canReopen ? (
          <Button
            size="sm"
            variant="ghost"
            iconLeft="refresh-cw"
            disabled={pending}
            onClick={() => {
              void run(async () => {
                await reopen({ eventSlug, instanceId: instance.instanceId })
                pushToast(
                  'Task reopened',
                  `"${instance.requirementTitle}" is Outstanding again. Uploaded files are untouched.`,
                )
              })
            }}
          >
            Reopen
          </Button>
        ) : null}

        <Button
          size="sm"
          variant="ghost"
          iconLeft="calendar-days"
          disabled={pending}
          onClick={() => {
            setOpen('due')
          }}
        >
          Due date
        </Button>
      </div>

      {error !== null && open === null ? (
        <span
          style={{ font: 'var(--type-caption)', color: 'var(--text-danger)' }}
        >
          {error}
        </span>
      ) : null}

      {open === 'changes' ? (
        <RequestChangesDialog
          eventSlug={eventSlug}
          instance={instance}
          onClose={close}
        />
      ) : null}

      {open === 'notApplicable' ? (
        <NotApplicableDialog
          eventSlug={eventSlug}
          instance={instance}
          onClose={close}
        />
      ) : null}

      {open === 'due' ? (
        <DueDateDialog
          eventSlug={eventSlug}
          instance={instance}
          timezone={timezone}
          now={now}
          onClose={close}
        />
      ) : null}

      {open === 'uploads' ? (
        <UploadsDialog
          eventSlug={eventSlug}
          instance={instance}
          timezone={timezone}
          onClose={close}
        />
      ) : null}
    </div>
  )
}

// ── Request changes ───────────────────────────────────────────────────────

/** The note is required by the backend and is what actually reaches the
 * speaker, so the dialog says who receives it before the button. */
function RequestChangesDialog({
  eventSlug,
  instance,
  onClose,
}: {
  eventSlug: string
  instance: InstanceRow
  onClose: () => void
}) {
  const requestChanges = useMutation(api.tasks.requestChanges)
  const { pending, error, setError, run } = usePending()
  const [note, setNote] = useState('')

  const submit = () => {
    if (note.trim() === '') {
      return setError('Say what needs to change — the note is sent to them.')
    }
    void run(async () => {
      await requestChanges({
        eventSlug,
        instanceId: instance.instanceId,
        note: note.trim(),
      })
      pushToast(
        'Changes requested',
        `${instance.speakerName ?? 'The session manager'} was emailed your note.`,
      )
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={480}
      title="Request changes?"
      description={`An email goes out immediately to whoever owes "${instance.requirementTitle}", with your note in it.`}
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending} onClick={submit}>
            {pending ? 'Sending…' : 'Request changes'}
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
        {error === null ? null : <Callout tone="blocked">{error}</Callout>}
        <Field
          label="What needs to change"
          htmlFor="task-change-note"
          required
          hint="They see this exactly as written."
        >
          <Textarea
            id="task-change-note"
            rows={4}
            value={note}
            disabled={pending}
            placeholder="This headshot is too small for print — please send the original, not a website crop."
            onChange={(e) => {
              setNote(e.target.value)
            }}
          />
        </Field>
      </div>
    </Dialog>
  )
}

// ── Not applicable ────────────────────────────────────────────────────────

function NotApplicableDialog({
  eventSlug,
  instance,
  onClose,
}: {
  eventSlug: string
  instance: InstanceRow
  onClose: () => void
}) {
  const markNotApplicable = useMutation(api.tasks.markNotApplicable)
  const { pending, error, setError, run } = usePending()
  const [reason, setReason] = useState('')

  const submit = () => {
    if (reason.trim() === '') {
      return setError('A waiver needs a reason — it is kept on the record.')
    }
    void run(async () => {
      await markNotApplicable({
        eventSlug,
        instanceId: instance.instanceId,
        reason: reason.trim(),
      })
      pushToast(
        'Marked Not Applicable',
        `"${instance.requirementTitle}" no longer counts as outstanding, and reminders for it stop.`,
      )
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={480}
      title="Mark this task Not Applicable?"
      description="It counts as satisfied for readiness and reminders stop — for this one task only, not for the requirement."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending} onClick={submit}>
            {pending ? 'Saving…' : 'Mark Not Applicable'}
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
        {error === null ? null : <Callout tone="blocked">{error}</Callout>}
        <Field
          label="Reason"
          htmlFor="task-na-reason"
          required
          hint="Kept on the task so the next organizer knows why."
        >
          <Textarea
            id="task-na-reason"
            rows={3}
            value={reason}
            disabled={pending}
            placeholder="Keynote is pre-recorded — no slide deck needed."
            onChange={(e) => {
              setReason(e.target.value)
            }}
          />
        </Field>
      </div>
    </Dialog>
  )
}

// ── Due date override ─────────────────────────────────────────────────────

/** Moving one instance's date takes it off the requirement's date for good —
 * a later requirement-wide change will skip it. */
function DueDateDialog({
  eventSlug,
  instance,
  timezone,
  now,
  onClose,
}: {
  eventSlug: string
  instance: InstanceRow
  timezone: string
  now: number
  onClose: () => void
}) {
  const setInstanceDue = useMutation(api.tasks.setInstanceDue)
  const { pending, error, setError, run } = usePending()
  const [value, setValue] = useState(() =>
    toInputValue(instance.dueAt, timezone),
  )

  const submit = () => {
    const dueAt = fromInputValue(value, timezone)
    if (dueAt === null) return setError('Set a date and time.')
    void run(async () => {
      await setInstanceDue({
        eventSlug,
        instanceId: instance.instanceId,
        dueAt,
      })
      pushToast(
        'Due date changed',
        `"${instance.requirementTitle}" is now due ${formatDateTime(dueAt, timezone)}.`,
      )
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={480}
      title="Change this task's due date"
      description="Only this one task moves. It stops following the requirement's date from now on."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending} onClick={submit}>
            {pending ? 'Saving…' : 'Change due date'}
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
        {error === null ? null : <Callout tone="blocked">{error}</Callout>}
        <Field
          label="Due"
          htmlFor="task-due"
          hint={`Stated in ${timezone}. Currently ${formatDateTime(instance.dueAt, timezone)}${
            isOverdue(instance, now) ? ' — overdue.' : '.'
          }`}
        >
          <Input
            id="task-due"
            type="datetime-local"
            value={value}
            disabled={pending}
            onChange={(e) => {
              setValue(e.target.value)
            }}
          />
        </Field>
      </div>
    </Dialog>
  )
}

// ── Uploads ───────────────────────────────────────────────────────────────

/** Every stored version, newest first — prior files are never erased, and the
 * approved one is stamped so it is obvious which version was reviewed. */
function UploadsDialog({
  eventSlug,
  instance,
  timezone,
  onClose,
}: {
  eventSlug: string
  instance: InstanceRow
  timezone: string
  onClose: () => void
}) {
  const uploads = useQuery(api.tasks.listUploads, {
    eventSlug,
    instanceId: instance.instanceId,
  })
  const generateUploadUrl = useMutation(api.tasks.generateUploadUrl)
  const attachUpload = useMutation(api.tasks.attachUpload)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      const url = await generateUploadUrl({ eventSlug })
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!res.ok) throw new Error('The file could not be stored.')
      const { storageId } = (await res.json()) as { storageId: Id<'_storage'> }
      await attachUpload({
        eventSlug,
        instanceId: instance.instanceId,
        storageId,
        filename: file.name,
      })
      pushToast(
        'File attached',
        `You uploaded "${file.name}" on their behalf — the task still belongs to ${instance.speakerName ?? 'this session'}.`,
      )
    } catch (err) {
      setError(errorMessage(err, 'That file could not be uploaded.'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog
      open
      width={640}
      title={instance.requirementTitle}
      description={`Every version submitted for ${instance.speakerName ?? instance.sessionTitle}. Nothing is ever replaced — a new file becomes a new version.`}
      onClose={uploading ? undefined : onClose}
      footer={
        <>
          {uploading ? (
            <Button disabled iconLeft="upload">
              Uploading…
            </Button>
          ) : (
            <Button as="label" iconLeft="upload">
              <input
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file !== undefined) void upload(file)
                }}
              />
              Upload on their behalf
            </Button>
          )}
          <Button variant="primary" disabled={uploading} onClick={onClose}>
            Close
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
        {error === null ? null : <Callout tone="blocked">{error}</Callout>}
        {uploads === undefined ? (
          <p style={{ color: 'var(--text-tertiary)' }}>Loading files…</p>
        ) : uploads.length === 0 ? (
          <p style={{ color: 'var(--text-tertiary)' }}>
            Nothing submitted yet. The speaker uploads this from their portal,
            or you can attach it here on their behalf.
          </p>
        ) : (
          <UploadVersionList
            uploads={uploads}
            timezone={timezone}
            rowSize="md"
          />
        )}
        <p
          style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}
        >
          Current status: {TASK_STATUS_LABEL[instance.status]}. PDF, images, or
          ZIP · up to 50 MB per file.
        </p>

        <TaskCommentThread
          eventSlug={eventSlug}
          instanceId={instance.instanceId}
          source="organizer"
          timezone={timezone}
        />
      </div>
    </Dialog>
  )
}
