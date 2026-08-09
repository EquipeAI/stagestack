import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { EVIDENCE_LABEL, SCOPE_LABEL, countLabel } from './model'
import type { RequirementRow } from './model'
import {
  Badge,
  Button,
  Callout,
  Card,
  DescriptionList,
  Dialog,
  Field,
  Input,
  Switch,
  Textarea,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { formatDateTime, fromInputValue, toInputValue } from '~/lib/datetime'

// One requirement: the organizer's definition, not the work. Deactivating it
// stops instantiation for future acceptances and deliberately leaves existing
// tasks alone — the card says so, because the opposite is the intuitive guess.

export function RequirementCard({
  eventSlug,
  requirement,
  timezone,
}: {
  eventSlug: string
  requirement: RequirementRow
  timezone: string
}) {
  const update = useMutation(api.tasks.updateRequirement)
  const { pending, error, run } = usePending()
  const [editing, setEditing] = useState(false)
  const reminders = reminderOverride(requirement)

  const toggleActive = (active: boolean) => {
    void run(async () => {
      await update({
        eventSlug,
        requirementId: requirement.requirementId,
        patch: { active },
      })
      pushToast(
        active ? 'Requirement reactivated' : 'Requirement deactivated',
        active
          ? 'New acceptances get this task again.'
          : `Future acceptances skip it. The ${countLabel(requirement.instanceCount, 'task', 'tasks')} already created stay exactly as they are.`,
      )
    })
  }

  return (
    <Card
      title={requirement.title}
      subtitle={requirement.description}
      actions={
        <Switch
          label={requirement.active ? 'Active' : 'Inactive'}
          checked={requirement.active}
          disabled={pending}
          onChange={(e) => {
            toggleActive(e.target.checked)
          }}
        />
      }
      footer={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            width: '100%',
          }}
        >
          <span
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-tertiary)',
              marginRight: 'auto',
            }}
          >
            {reminders.disabled
              ? 'Reminders off for this requirement.'
              : reminders.cadence === null
                ? 'Reminders follow the event cadence.'
                : `Reminders every ${reminders.cadence} ${reminders.cadence === 1 ? 'day' : 'days'}.`}
          </span>
          {error === null ? null : (
            <span
              style={{ font: 'var(--type-caption)', color: 'var(--text-danger)' }}
            >
              {error}
            </span>
          )}
          <Button
            size="sm"
            iconLeft="pencil"
            disabled={pending}
            onClick={() => {
              setEditing(true)
            }}
          >
            Edit
          </Button>
        </div>
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
            alignItems: 'center',
          }}
        >
          <Badge tone="info">{SCOPE_LABEL[requirement.scope]}</Badge>
          <Badge tone="neutral">
            {EVIDENCE_LABEL[requirement.evidence]}
            {requirement.fieldKey === undefined
              ? ''
              : ` · ${requirement.fieldKey}`}
          </Badge>
          <Badge tone={requirement.reviewRequired ? 'attention' : 'neutral'}>
            {requirement.reviewRequired
              ? 'Review required'
              : 'No review — Provided counts as complete'}
          </Badge>
        </div>

        <DescriptionList
          items={[
            {
              term: 'Due',
              value: (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-xs)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatDateTime(requirement.dueAt, timezone)}
                </span>
              ),
            },
            {
              term: 'Tasks created',
              value: `${requirement.instanceCount}`,
            },
            {
              term: 'Outstanding',
              value: `${requirement.openCount} of ${requirement.instanceCount}`,
            },
          ]}
        />
      </div>

      {editing ? (
        <EditRequirementDialog
          eventSlug={eventSlug}
          requirement={requirement}
          timezone={timezone}
          onClose={() => {
            setEditing(false)
          }}
        />
      ) : null}
    </Card>
  )
}

/**
 * The per-requirement reminder override (M5).
 *
 * `tasks.updateRequirement` accepts `reminderCadenceDays` and
 * `remindersDisabled`, but `tasks.listRequirements` does not carry them in its
 * `returns` validator yet, so `RequirementRow` has no such properties. Reading
 * them defensively means the controls below show the stored value the moment
 * the query starts returning it — no change needed here.
 */
function reminderOverride(requirement: RequirementRow): {
  cadence: number | null
  disabled: boolean
} {
  const row = requirement as RequirementRow & {
    reminderCadenceDays?: number | null
    remindersDisabled?: boolean
  }
  return {
    cadence: row.reminderCadenceDays ?? null,
    disabled: row.remindersDisabled ?? false,
  }
}

/**
 * Scope, evidence and field key are fixed at creation — the backend does not
 * take them in a patch, because changing them would silently invalidate every
 * task already created from this definition.
 */
function EditRequirementDialog({
  eventSlug,
  requirement,
  timezone,
  onClose,
}: {
  eventSlug: string
  requirement: RequirementRow
  timezone: string
  onClose: () => void
}) {
  const update = useMutation(api.tasks.updateRequirement)
  const { pending, error, setError, run } = usePending()
  const [title, setTitle] = useState(requirement.title)
  const [description, setDescription] = useState(requirement.description ?? '')
  const [reviewRequired, setReviewRequired] = useState(requirement.reviewRequired)
  const [dueAt, setDueAt] = useState(() =>
    toInputValue(requirement.dueAt, timezone),
  )
  const stored = reminderOverride(requirement)
  const [cadence, setCadence] = useState(
    stored.cadence === null ? '' : String(stored.cadence),
  )
  const [remindersDisabled, setRemindersDisabled] = useState(stored.disabled)

  const submit = () => {
    if (title.trim() === '') return setError('The requirement needs a title.')
    const due = fromInputValue(dueAt, timezone)
    if (due === null) return setError('Set a due date and time.')
    const trimmedCadence = cadence.trim()
    const cadenceDays = trimmedCadence === '' ? null : Number(trimmedCadence)
    if (
      cadenceDays !== null &&
      (!Number.isInteger(cadenceDays) || cadenceDays < 1)
    ) {
      return setError('Cadence must be a whole number of days, at least 1.')
    }
    void run(async () => {
      const result = await update({
        eventSlug,
        requirementId: requirement.requirementId,
        patch: {
          title: title.trim(),
          description: description.trim(),
          reviewRequired,
          dueAt: due,
          reminderCadenceDays: cadenceDays,
          remindersDisabled,
        },
      })
      pushToast(
        'Requirement saved',
        result.repropagated === 0
          ? 'No task due dates moved.'
          : `${countLabel(result.repropagated, 'task', 'tasks')} moved to the new date. Tasks with their own date were left alone.`,
      )
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={640}
      title="Edit requirement"
      description="Changing the date moves every task still sitting on the old one. Tasks with a per-speaker override keep theirs."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pending} onClick={submit}>
            {pending ? 'Saving…' : 'Save requirement'}
          </Button>
        </>
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {error === null ? null : <Callout tone="blocked">{error}</Callout>}
        <Field label="Title" htmlFor="req-edit-title" required>
          <Input
            id="req-edit-title"
            value={title}
            disabled={pending}
            onChange={(e) => {
              setTitle(e.target.value)
            }}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="req-edit-description"
          optional
          hint="Speakers read this in their portal."
        >
          <Textarea
            id="req-edit-description"
            rows={3}
            value={description}
            disabled={pending}
            onChange={(e) => {
              setDescription(e.target.value)
            }}
          />
        </Field>
        <Field
          label="Due"
          htmlFor="req-edit-due"
          hint={`Stated in ${timezone}.`}
        >
          <Input
            id="req-edit-due"
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
        <Field
          label="Reminder cadence"
          htmlFor="req-edit-cadence"
          optional
          hint="Days between reminders for this requirement. Empty follows the event cadence set in Settings."
        >
          <Input
            id="req-edit-cadence"
            type="number"
            value={cadence}
            placeholder="Inherit"
            disabled={pending || remindersDisabled}
            onChange={(e) => {
              setCadence(e.target.value)
            }}
          />
        </Field>
        <Switch
          label="Reminders off"
          checked={remindersDisabled}
          disabled={pending}
          onChange={(e) => {
            setRemindersDisabled(e.target.checked)
          }}
        />
        <p style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
          {remindersDisabled
            ? 'This requirement is left out of every reminder. The task still exists and still counts as outstanding.'
            : 'Outstanding items are consolidated into one reminder per speaker, never one email per task.'}
        </p>
        <p style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
          Scope ({SCOPE_LABEL[requirement.scope]}) and evidence (
          {EVIDENCE_LABEL[requirement.evidence]}) are fixed once tasks exist.
        </p>
      </div>
    </Dialog>
  )
}
