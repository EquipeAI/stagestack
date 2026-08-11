import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import {
  Button,
  Callout,
  Dialog,
  Field,
  Input,
  StatusPill,
  Textarea,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { formatDateTime } from '~/lib/datetime'
import { pushToast } from '~/components/toast'

// Session content management (W5: CNT-09/11/12): the organizer's editorial
// controls over what the public program will print. Editing records a
// revision, history restores one, and the Draft/Approved pill decides whether
// the public program may show the session's content at all.

type SessionDoc = FunctionReturnType<
  typeof api.sessions.list
>[number]['session']
type RevisionRow = FunctionReturnType<typeof api.sessions.listRevisions>[number]

type DialogKind = 'edit' | 'history'

export function SessionContentCell({
  eventSlug,
  session,
  timezone,
  archived,
}: {
  eventSlug: string
  session: SessionDoc
  timezone: string
  archived: boolean
}) {
  const setContentStatus = useMutation(api.sessions.setContentStatus)
  const { pending, run } = usePending()
  const [open, setOpen] = useState<DialogKind | null>(null)

  // Sessions created before content approval existed carry no status; they
  // were never held back, so absence reads as Approved.
  const draft = session.contentStatus === 'draft'

  const toggle = () => {
    const to = draft ? 'approved' : 'draft'
    void run(async () => {
      await setContentStatus({ eventSlug, sessionId: session._id, to })
      pushToast(
        to === 'approved' ? 'Content approved' : 'Content set to draft',
        to === 'approved'
          ? `"${session.title}" can appear on the public program.`
          : `"${session.title}" is held back from the public program until approved.`,
        to === 'approved' ? 'circle-check' : 'eye-off',
      )
    })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 'var(--space-2)',
      }}
    >
      <StatusPill
        status={draft ? 'Draft' : 'Approved'}
        tone={draft ? 'attention' : 'success'}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={pending || archived}
        onClick={toggle}
      >
        {draft ? 'Approve' : 'Set draft'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        iconLeft="pencil"
        disabled={archived}
        onClick={() => {
          setOpen('edit')
        }}
      >
        Edit
      </Button>
      <Button
        size="sm"
        variant="ghost"
        iconLeft="clock"
        onClick={() => {
          setOpen('history')
        }}
      >
        History
      </Button>

      {open === 'edit' ? (
        <EditContentDialog
          eventSlug={eventSlug}
          session={session}
          onClose={() => {
            setOpen(null)
          }}
        />
      ) : null}

      {open === 'history' ? (
        <RevisionHistoryDialog
          eventSlug={eventSlug}
          session={session}
          timezone={timezone}
          archived={archived}
          onClose={() => {
            setOpen(null)
          }}
        />
      ) : null}
    </div>
  )
}

// ── Edit content (CNT-09) ────────────────────────────────────────────────

function EditContentDialog({
  eventSlug,
  session,
  onClose,
}: {
  eventSlug: string
  session: SessionDoc
  onClose: () => void
}) {
  const updateContent = useMutation(api.sessions.updateContent)
  const { pending, error, setError, run } = usePending()
  const [title, setTitle] = useState(session.title)
  const [description, setDescription] = useState(session.description ?? '')
  const [format, setFormat] = useState(session.format ?? '')

  const save = () => {
    if (title.trim() === '') return setError('The session needs a title.')
    void run(async () => {
      // Empty description/format is the backend's explicit "clear this field".
      await updateContent({
        eventSlug,
        sessionId: session._id,
        title: title.trim(),
        description: description.trim(),
        format: format.trim(),
      })
      pushToast(
        'Content saved',
        `"${title.trim()}" was updated. The previous version is kept in History.`,
        'circle-check',
      )
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={640}
      title="Edit session content"
      description="Every save is recorded as a revision, so any earlier version can be restored from History."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending} onClick={save}>
            {pending ? 'Saving…' : 'Save content'}
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

        <Field label="Title" htmlFor="content-title" required>
          <Input
            id="content-title"
            value={title}
            autoFocus
            disabled={pending}
            onChange={(e) => {
              setTitle(e.target.value)
            }}
          />
        </Field>

        <Field
          label="Description"
          htmlFor="content-description"
          optional
          hint="Shown on the public program once the schedule is published."
        >
          <Textarea
            id="content-description"
            rows={5}
            value={description}
            disabled={pending}
            onChange={(e) => {
              setDescription(e.target.value)
            }}
          />
        </Field>

        <Field
          label="Format"
          htmlFor="content-format"
          optional
          hint="Talk, Workshop, Panel — whatever your programme calls it."
        >
          <Input
            id="content-format"
            value={format}
            disabled={pending}
            onChange={(e) => {
              setFormat(e.target.value)
            }}
          />
        </Field>
      </div>
    </Dialog>
  )
}

// ── Revision history (CNT-11) ────────────────────────────────────────────

const CONTENT_FIELDS = ['title', 'description', 'format'] as const
type ContentField = (typeof CONTENT_FIELDS)[number]

const FIELD_LABEL: Record<ContentField, string> = {
  title: 'Title',
  description: 'Description',
  format: 'Format',
}

function fieldValue(
  fields: RevisionRow['before'],
  field: ContentField,
): string {
  return fields[field] ?? ''
}

function changedFields(revision: RevisionRow): Array<ContentField> {
  return CONTENT_FIELDS.filter(
    (field) =>
      fieldValue(revision.before, field) !== fieldValue(revision.after, field),
  )
}

function clip(value: string): string {
  if (value === '') return '(empty)'
  return value.length > 80 ? `${value.slice(0, 80)}…` : value
}

function RevisionHistoryDialog({
  eventSlug,
  session,
  timezone,
  archived,
  onClose,
}: {
  eventSlug: string
  session: SessionDoc
  timezone: string
  archived: boolean
  onClose: () => void
}) {
  const revisions = useQuery(api.sessions.listRevisions, {
    eventSlug,
    sessionId: session._id,
  })
  const restoreRevision = useMutation(api.sessions.restoreRevision)
  const { pending, error, run } = usePending()
  const [confirming, setConfirming] = useState<string | null>(null)
  const [restored, setRestored] = useState<RevisionRow['before'] | null>(null)

  const restore = (revision: RevisionRow) => {
    void run(async () => {
      await restoreRevision({ eventSlug, revisionId: revision.revisionId })
      setRestored(revision.before)
      pushToast(
        'Version restored',
        `"${session.title}" is back to how it was before ${formatDateTime(revision.editedAt, timezone)}. The restore itself is recorded as a new revision.`,
        'circle-check',
      )
      setConfirming(null)
    })
  }

  return (
    <Dialog
      open
      width={640}
      title="Content history"
      description={`Every edit ever made to "${session.title}", newest first. Restoring brings back the content as it was before that edit.`}
      onClose={pending ? undefined : onClose}
      footer={
        <Button variant="primary" disabled={pending} onClick={onClose}>
          Close
        </Button>
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
        {restored === null ? null : (
          <Callout tone="info">
            <div
              role="status"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
              }}
            >
              <strong>
                Restored snapshot is now the current session content.
              </strong>
              <span>Title: {fieldValue(restored, 'title')}</span>
              <span>
                Description: {clip(fieldValue(restored, 'description'))}
              </span>
              <span>Format: {fieldValue(restored, 'format') || '(empty)'}</span>
            </div>
          </Callout>
        )}

        {revisions === undefined ? (
          <p style={{ color: 'var(--text-tertiary)' }}>Loading history…</p>
        ) : revisions.length === 0 ? (
          <p style={{ color: 'var(--text-tertiary)' }}>
            No edits yet — this is still the content as it was first created.
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 'var(--space-0)',
              padding: 'var(--space-0)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
            }}
          >
            {revisions.map((revision) => (
              <li
                key={revision.revisionId}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-2)',
                  paddingBottom: 'var(--space-3)',
                  borderBottom: 'var(--space-px) solid var(--border-subtle)',
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'baseline',
                    gap: 'var(--space-2)',
                    font: 'var(--type-caption)',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  <span
                    style={{
                      fontWeight: 'var(--weight-medium)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {revision.editorName ?? revision.editorEmail ?? 'Someone'}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatDateTime(revision.editedAt, timezone)}
                  </span>
                </span>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-1)',
                  }}
                >
                  {changedFields(revision).map((field) => (
                    <span
                      key={field}
                      style={{
                        font: 'var(--type-caption)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <span style={{ fontWeight: 'var(--weight-medium)' }}>
                        {FIELD_LABEL[field]}:
                      </span>{' '}
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        {clip(fieldValue(revision.before, field))}
                      </span>{' '}
                      → {clip(fieldValue(revision.after, field))}
                    </span>
                  ))}
                </div>

                {archived ? null : confirming === revision.revisionId ? (
                  <div
                    style={{
                      display: 'flex',
                      gap: 'var(--space-2)',
                      alignItems: 'center',
                    }}
                  >
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={pending}
                      onClick={() => {
                        restore(revision)
                      }}
                    >
                      {pending ? 'Restoring…' : 'Yes, restore'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        setConfirming(null)
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconLeft="refresh-cw"
                      disabled={pending}
                      onClick={() => {
                        setConfirming(revision.revisionId)
                      }}
                    >
                      Restore this version
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
