import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { FIELD_KEYS, countLabel } from './model'
import type { Evidence, Scope } from './model'
import {
  Button,
  Callout,
  Dialog,
  Field,
  Input,
  Select,
  Switch,
  Textarea,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { fromInputValue } from '~/lib/datetime'

// Creating a requirement is not a quiet definition — it instantiates work for
// everyone who already qualifies. The dialog states that before the button,
// and the toast reports the exact number it created.

export function NewRequirementDialog({
  eventSlug,
  timezone,
  onClose,
}: {
  eventSlug: string
  timezone: string
  onClose: () => void
}) {
  const create = useMutation(api.tasks.createRequirement)
  const { pending, error, setError, run } = usePending()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<Scope>('participant')
  const [evidence, setEvidence] = useState<Evidence>('manual')
  const [fieldKey, setFieldKey] = useState<string>('bio')
  const [reviewRequired, setReviewRequired] = useState(false)
  const [dueAt, setDueAt] = useState('')

  const submit = () => {
    if (title.trim() === '') return setError('The requirement needs a title.')
    const due = fromInputValue(dueAt, timezone)
    if (due === null) return setError('Set a due date and time.')
    void run(async () => {
      const result = await create({
        eventSlug,
        title: title.trim(),
        description: description.trim() === '' ? undefined : description.trim(),
        scope,
        evidence,
        fieldKey: evidence === 'profileField' ? fieldKey : undefined,
        reviewRequired,
        dueAt: due,
      })
      pushToast(
        'Requirement created',
        result.instances === 0
          ? 'Nothing qualified yet — tasks appear as speakers are accepted.'
          : `${countLabel(result.instances, 'task', 'tasks')} created now, and every future acceptance gets one.`,
      )
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={640}
      title="New requirement"
      description="Creates a task for every current accepted speaker or session, and for every future acceptance."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending} onClick={submit}>
            {pending ? 'Creating…' : 'Create requirement'}
          </Button>
        </>
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {error === null ? null : <Callout tone="blocked">{error}</Callout>}

        <Field label="Title" htmlFor="req-title" required>
          <Input
            id="req-title"
            value={title}
            disabled={pending}
            placeholder="Headshot for the program"
            onChange={(e) => {
              setTitle(e.target.value)
            }}
          />
        </Field>

        <Field
          label="Description"
          htmlFor="req-description"
          optional
          hint="Speakers read this in their portal — say what good looks like."
        >
          <Textarea
            id="req-description"
            rows={3}
            value={description}
            disabled={pending}
            placeholder="At least 1200 pixels on the short edge, square crop, no logo."
            onChange={(e) => {
              setDescription(e.target.value)
            }}
          />
        </Field>

        <div style={twoCol}>
          <Field
            label="Scope"
            htmlFor="req-scope"
            hint={
              scope === 'participant'
                ? 'One task per accepted speaker.'
                : 'One shared task per session.'
            }
          >
            <Select
              id="req-scope"
              value={scope}
              disabled={pending}
              options={[
                { value: 'participant', label: 'Per speaker' },
                { value: 'session', label: 'Per session' },
              ]}
              onChange={(e) => {
                setScope(e.target.value === 'session' ? 'session' : 'participant')
              }}
            />
          </Field>

          <Field
            label="Evidence"
            htmlFor="req-evidence"
            hint={EVIDENCE_HINT[evidence]}
          >
            <Select
              id="req-evidence"
              value={evidence}
              disabled={pending}
              options={[
                { value: 'manual', label: 'Manual — someone ticks it' },
                { value: 'file', label: 'File upload' },
                { value: 'profileField', label: 'Profile field' },
              ]}
              onChange={(e) => {
                setEvidence(e.target.value as Evidence)
              }}
            />
          </Field>
        </div>

        {evidence === 'profileField' ? (
          <Field
            label="Profile field"
            htmlFor="req-field-key"
            hint="Filling this field in the portal satisfies the task by itself; clearing it puts the task back."
          >
            <Select
              id="req-field-key"
              value={fieldKey}
              disabled={pending}
              options={[...FIELD_KEYS]}
              onChange={(e) => {
                setFieldKey(e.target.value)
              }}
            />
          </Field>
        ) : null}

        <Field label="Due" htmlFor="req-due" required hint={`Stated in ${timezone}.`}>
          <Input
            id="req-due"
            required
            type="datetime-local"
            value={dueAt}
            disabled={pending}
            onChange={(e) => {
              setDueAt(e.target.value)
            }}
          />
        </Field>

        <Switch
          label="Require organizer review"
          checked={reviewRequired}
          disabled={pending}
          onChange={(e) => {
            setReviewRequired(e.target.checked)
          }}
        />
        <p style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
          {reviewRequired
            ? 'Submitted work parks at Awaiting Review until an organizer approves it.'
            : 'Without review, Provided counts as complete the moment the evidence exists.'}
        </p>
      </div>
    </Dialog>
  )
}

const EVIDENCE_HINT: Record<Evidence, string> = {
  manual: 'For work StageStack cannot observe — a signed release, a rehearsal.',
  file: 'Satisfied by uploading a file. Every version is kept.',
  profileField: 'Satisfied by a field on their speaker profile being filled in.',
}

const twoCol = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
  gap: 'var(--space-4)',
} as const
