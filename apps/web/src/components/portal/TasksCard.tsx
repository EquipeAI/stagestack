import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { personName } from './model'
import type { Id } from '@convex/_generated/dataModel'
import type { PortalTask } from '~/components/tasks/model'
import { PORTAL_TASK_STATUS, isOpen, isOverdue } from '~/components/tasks/model'
import { Button, Callout, Card, EmptyState, StatusPill } from '~/ds'
import { TaskCommentThread } from '~/components/tasks/TaskCommentThread'
import { UploadVersionList } from '~/components/tasks/UploadVersionList'
import { usePending } from '~/lib/usePending'
import { errorMessage } from '~/lib/errors'
import { formatDateTime } from '~/lib/datetime'
import { pushToast } from '~/components/toast'
import { FileButton } from '~/components/FileButton'
import {
  ActionError,
  ButtonRow,
  PortalSection,
} from '~/components/portal/PortalChrome'

// The speaker's half of speaker ops (M4). The organizer's state names do not
// appear here: a speaker needs to know what to do, not which review gate a row
// is parked at.
//
// Tasks split by who owes them, because a session manager answering for three
// speakers has to be able to tell whose is whose.

export function openTaskCount(tasks: Array<PortalTask>): number {
  return tasks.filter((task) => isOpen(task.status)).length
}

export function PortalTasks({
  eventSlug,
  timezone,
  tasks,
  loading,
  readOnly,
}: {
  eventSlug: string
  timezone: string
  tasks: Array<PortalTask>
  loading: boolean
  readOnly: boolean
}) {
  // In preview the organizer is signed in as themself, so `myTasks` would
  // answer with THEIR tasks. Showing nothing is the only honest option.
  if (readOnly) {
    return (
      <PortalSection
        title="Your tasks"
        description="What the organizers still need from you."
      >
        <Card>
          <EmptyState
            icon="list-checks"
            title="Tasks are not shown in preview"
            description="This list is built from the signed-in speaker's own obligations, so it cannot be rendered as someone else. Open Speaker tasks in the organizer app to see what they owe."
          />
        </Card>
      </PortalSection>
    )
  }

  if (loading) {
    return (
      <PortalSection title="Your tasks">
        <p style={{ color: 'var(--text-tertiary)' }}>Loading your tasks…</p>
      </PortalSection>
    )
  }

  if (tasks.length === 0) return null

  const mine = tasks.filter((task) => task.forSpeaker === null)
  const managed = tasks.filter((task) => task.forSpeaker !== null)

  return (
    <>
      {mine.length === 0 ? null : (
        <PortalSection
          title="Your tasks"
          description="What the organizers still need from you."
          meta={`${openTaskCount(mine)} open`}
        >
          {mine.map((task) => (
            <TaskCard
              key={task.instanceId}
              eventSlug={eventSlug}
              timezone={timezone}
              task={task}
            />
          ))}
        </PortalSection>
      )}

      {managed.length === 0 ? null : (
        <PortalSection
          title="For speakers you manage"
          description="You are the primary manager for these sessions, so you can submit this work on their behalf. It stays owed by them."
          meta={`${openTaskCount(managed)} open`}
        >
          {managed.map((task) => (
            <TaskCard
              key={task.instanceId}
              eventSlug={eventSlug}
              timezone={timezone}
              task={task}
            />
          ))}
        </PortalSection>
      )}
    </>
  )
}

function TaskCard({
  eventSlug,
  timezone,
  task,
}: {
  eventSlug: string
  timezone: string
  task: PortalTask
}) {
  const completeTask = useMutation(api.portal.completeTask)
  const generateUploadUrl = useMutation(api.portal.generateTaskUploadUrl)
  const uploadForTask = useMutation(api.portal.uploadForTask)
  const { pending, error, setError, run } = usePending({ announce: false })
  const [uploading, setUploading] = useState(false)

  const state = PORTAL_TASK_STATUS[task.status]
  const now = Date.now()
  const overdue = isOverdue(task, now)
  const settled = !isOpen(task.status)

  const markDone = () => {
    void run(async () => {
      await completeTask({ eventSlug, instanceId: task.instanceId })
      pushToast(
        'Marked as done',
        `The organizers can see that "${task.requirementTitle}" is done.`,
        'check',
      )
    })
  }

  const upload = async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      const url = await generateUploadUrl({
        eventSlug,
        instanceId: task.instanceId,
      })
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!res.ok) throw new Error('The file could not be stored.')
      const { storageId } = (await res.json()) as { storageId: Id<'_storage'> }
      await uploadForTask({
        eventSlug,
        instanceId: task.instanceId,
        storageId,
        filename: file.name,
      })
      pushToast(
        'File submitted',
        `The organizers have "${file.name}". Your earlier versions are kept.`,
        'check',
      )
    } catch (err) {
      setError(errorMessage(err, 'That file could not be uploaded.'))
    } finally {
      setUploading(false)
    }
  }

  const busy = pending || uploading
  const hasUploads = task.uploads.length > 0

  return (
    <Card
      title={task.requirementTitle}
      subtitle={task.description}
      actions={<StatusPill status={state.label} tone={state.tone} />}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-3)',
            alignItems: 'baseline',
            font: 'var(--type-caption)',
            color: 'var(--text-tertiary)',
          }}
        >
          <span>
            {task.scope === 'session' ? 'Session task' : 'Your task'} ·{' '}
            {task.sessionTitle}
          </span>
          {task.forSpeaker === null ? null : (
            <span>For {personName(task.forSpeaker)}</span>
          )}
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--font-mono)',
              fontVariantNumeric: 'tabular-nums',
              color: overdue ? 'var(--text-danger)' : 'var(--text-tertiary)',
            }}
          >
            {overdue ? 'Overdue — due ' : 'Due '}
            {formatDateTime(task.dueAt, timezone)}
          </span>
        </div>

        {task.status === 'changesRequested' && task.reviewNote !== undefined ? (
          <Callout tone="attention" title="The organizers asked for changes">
            {task.reviewNote}
          </Callout>
        ) : null}

        <ActionError error={error} />

        {hasUploads ? (
          <UploadVersionList uploads={task.uploads} timezone={timezone} />
        ) : null}

        {task.evidence === 'profileField' ? (
          <p
            style={{
              font: 'var(--type-body)',
              color: 'var(--text-secondary)',
              margin: 'var(--space-0)',
            }}
          >
            Complete this by filling in your profile above —{' '}
            <a href="#your-profile">go to your profile</a>. It is ticked off the
            moment the field has something in it.
          </p>
        ) : null}

        {task.evidence === 'manual' ? (
          <ButtonRow>
            <Button
              variant="primary"
              iconLeft="check"
              disabled={busy || settled}
              onClick={markDone}
            >
              {pending
                ? 'Saving…'
                : settled
                  ? 'Done'
                  : task.status === 'changesRequested'
                    ? 'Mark as done again'
                    : 'Mark as done'}
            </Button>
          </ButtonRow>
        ) : null}

        {task.evidence === 'file' ? (
          <ButtonRow>
            {busy ? (
              <Button variant="primary" iconLeft="upload" disabled>
                {uploading ? 'Uploading…' : 'Working…'}
              </Button>
            ) : (
              <FileButton
                variant="primary"
                iconLeft="upload"
                onFile={(file) => {
                  void upload(file)
                }}
              >
                {hasUploads ? 'Replace file' : 'Upload file'}
              </FileButton>
            )}
            <span
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
              }}
            >
              PDF, images, or ZIP · up to 50 MB per file.
              {hasUploads
                ? ' A replacement is added as a new version — nothing you sent before is lost.'
                : ''}
            </span>
          </ButtonRow>
        ) : null}

        {task.evidence === 'file' ? (
          <TaskCommentThread
            eventSlug={eventSlug}
            instanceId={task.instanceId}
            source="portal"
            timezone={timezone}
          />
        ) : null}
      </div>
    </Card>
  )
}
