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
import { pushToast } from '~/components/toast'
import { FormatField } from '~/components/sessions/FormatField'
import { ContentHistoryDialog } from '~/components/sessions/ContentHistoryDialog'

// Session content management (W5: CNT-09/11/12): the organizer's editorial
// controls over what the public program will print. Editing records a
// revision, history restores one, and the Draft/Approved pill decides whether
// the public program may show the session's content at all.

type SessionDoc = FunctionReturnType<
  typeof api.sessions.list
>[number]['session']

type DialogKind = 'edit' | 'history'

export function SessionContentCell({
  eventSlug,
  session,
  archived,
}: {
  eventSlug: string
  session: SessionDoc
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
        <ContentHistoryDialog
          eventSlug={eventSlug}
          sessionId={session._id}
          sessionTitle={session.title}
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
  const library = useQuery(api.library.list, { eventSlug })
  const { pending, error, setError, run } = usePending()
  const [title, setTitle] = useState(session.title)
  const [description, setDescription] = useState(session.description ?? '')
  const [format, setFormat] = useState(session.format ?? '')
  const [minutes, setMinutes] = useState(
    session.durationMinutes === undefined
      ? ''
      : String(session.durationMinutes),
  )

  const save = () => {
    if (title.trim() === '') return setError('The session needs a title.')
    const trimmedMinutes = minutes.trim()
    let durationMinutes: number | null = null
    if (trimmedMinutes !== '') {
      const parsed = Number(trimmedMinutes)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1440) {
        return setError(
          'A length must be a whole number of minutes between 1 and 1440.',
        )
      }
      durationMinutes = parsed
    }
    void run(async () => {
      // Empty description/format is the backend's explicit "clear this field";
      // a null length clears the override and falls back to the format's.
      await updateContent({
        eventSlug,
        sessionId: session._id,
        title: title.trim(),
        description: description.trim(),
        format: format.trim(),
        durationMinutes,
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

        <FormatField
          id="content-format"
          value={format}
          formats={library?.formats ?? []}
          disabled={pending}
          onChange={setFormat}
        />

        <Field
          label="Length (minutes)"
          htmlFor="content-minutes"
          optional
          hint="Overrides the format’s default length for this session only. Blank uses the format’s."
        >
          <Input
            id="content-minutes"
            type="number"
            value={minutes}
            disabled={pending}
            onChange={(e) => {
              setMinutes(e.target.value)
            }}
          />
        </Field>
      </div>
    </Dialog>
  )
}
