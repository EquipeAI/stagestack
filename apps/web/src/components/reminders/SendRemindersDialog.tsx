import { REMINDER_MANUAL_COPY } from './copy'
import type { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import { Button, Callout, DescriptionList, Dialog } from '~/ds'

type ReminderPreview = FunctionReturnType<
  typeof api.reminders.outstandingReminderPreview
>

/**
 * The audience statement a manual reminder needs BEFORE it fires: who
 * qualifies, who is excluded and why, and what sending changes. Every number
 * comes from `outstandingReminderPreview`, which shares its collector with the
 * mutation — so this cannot describe a different audience from the one that
 * receives the mail.
 */
export function SendRemindersDialog({
  preview,
  pending,
  onCancel,
  onConfirm,
}: {
  preview: ReminderPreview | undefined
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const refusal =
    preview === undefined
      ? null
      : preview.blocked === 'archived'
        ? 'Archived events cannot send reminders.'
        : preview.overCap
          ? `This send will be refused: it would reach more than ${preview.cap} recipients. Narrow the outstanding set first.`
          : preview.recipients === 0
            ? 'Nobody has an outstanding, reminder-enabled task with a reachable address right now.'
            : null

  return (
    <Dialog
      open
      width={480}
      title="Send reminders now?"
      onClose={pending ? undefined : onCancel}
      footer={
        <>
          <Button disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending || preview === undefined || refusal !== null}
            onClick={onConfirm}
          >
            {pending ? 'Sending…' : 'Send reminders'}
          </Button>
        </>
      }
    >
      {preview === undefined ? (
        <p style={{ color: 'var(--text-tertiary)' }}>
          Working out who this would reach…
        </p>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          {refusal === null ? null : (
            <Callout tone="blocked">{refusal}</Callout>
          )}
          <DescriptionList
            stacked
            items={[
              {
                term: 'Who qualifies',
                value: `${preview.recipients} ${preview.recipients === 1 ? 'recipient' : 'recipients'} with ${preview.tasks} outstanding ${preview.tasks === 1 ? 'task' : 'tasks'} — one consolidated message each. Routine chasing goes to a speaker's primary manager where they have one.`,
              },
              {
                term: 'Who is excluded',
                value:
                  preview.unreachableSpeakers === 0
                    ? 'Nobody with a reminder-enabled outstanding task is left out. Completed, not-applicable and reminder-disabled work is never included.'
                    : `${preview.unreachableSpeakers} ${preview.unreachableSpeakers === 1 ? 'speaker has' : 'speakers have'} an outstanding task and no reachable address — neither their own nor a primary manager's. They are skipped.`,
              },
              { term: 'What it changes', value: REMINDER_MANUAL_COPY },
            ]}
          />
        </div>
      )}
    </Dialog>
  )
}
