import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { activeParticipants, hasBlocker } from './model'
import type { BoardSession } from './model'
import { Button, Callout, Dialog } from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'

// Release is the one external step (M6): it emails speakers and sends calendar
// invitations. Speaker/room clashes are non-overridable, so a blocked session
// is skipped, never forced — the dialog says so before the button, and the
// per-id results say what happened after.

const SKIP_REASON: Record<string, string> = {
  conflict: 'a speaker or room clash',
  unchanged: 'already up to date',
  not_scheduled: 'not placed on the board',
  invalid_status: 'not a planned session',
  not_found: 'no longer on the board',
}

export function ReleaseDialog({
  eventSlug,
  sessions,
  onClose,
}: {
  eventSlug: string
  /** The sessions the organizer chose to release. */
  sessions: Array<BoardSession>
  onClose: () => void
}) {
  const release = useMutation(api.agenda.release)
  const { pending, error, run } = usePending()

  const releasable = sessions.filter((s) => !hasBlocker(s.conflicts))
  const blocked = sessions.filter((s) => hasBlocker(s.conflicts))
  const notifyCount = releasable.reduce(
    (sum, s) => sum + activeParticipants(s).length,
    0,
  )

  const confirm = () => {
    void run(async () => {
      const results = await release({
        eventSlug,
        sessionIds: sessions.map((s) => s.sessionId),
      })
      const released = results.filter((r) => r.ok)
      const skipped = results.filter((r) => !r.ok)
      const skipReasons = summarizeSkips(skipped)
      pushToast(
        released.length === 1
          ? '1 slot released'
          : `${released.length} slots released`,
        skipped.length === 0
          ? 'Speakers were emailed their slot with a calendar invitation.'
          : `${skipped.length} skipped — ${skipReasons}.`,
        'mail',
      )
      onClose()
    })
  }

  const total = sessions.length

  return (
    <Dialog
      open
      width={480}
      title={total === 1 ? 'Release this slot?' : `Release ${total} slots?`}
      description={`Notifies ${notifyCount} speaker${notifyCount === 1 ? '' : 's'} and sends calendar invitations. Blocked sessions (speaker or room clash) are skipped.`}
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            iconLeft="mail"
            disabled={pending || releasable.length === 0}
            onClick={confirm}
          >
            {pending
              ? 'Releasing…'
              : releasable.length === 1
                ? 'Release slot'
                : `Release ${releasable.length} slots`}
          </Button>
        </>
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        <p style={{ font: 'var(--type-body)', color: 'var(--text-secondary)', margin: 'var(--space-0)' }}>
          A first release, or any change to a slot&rsquo;s date or start time,
          resets every speaker on the session to Awaiting Acknowledgement. A room
          or end-time change updates their calendar without resetting it.
        </p>
        {blocked.length > 0 ? (
          <Callout
            tone="attention"
            title={`${blocked.length} session${blocked.length === 1 ? '' : 's'} will be skipped`}
          >
            {blocked.map((s) => s.title).join(', ')} — resolve the speaker or room
            clash first. Same-track warnings do not block a release.
          </Callout>
        ) : null}
      </div>
    </Dialog>
  )
}

function summarizeSkips(
  skipped: Array<{ error?: string }>,
): string {
  const counts = new Map<string, number>()
  for (const s of skipped) {
    const reason = SKIP_REASON[s.error ?? ''] ?? 'an unexpected reason'
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ')
}
