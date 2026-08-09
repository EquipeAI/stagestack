import { useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { Popover } from './Popover'
import { bulkChunks, bulkErrorMessage, isStaged } from './model'
import { Modal } from './Modal'
import type { Id } from '@convex/_generated/dataModel'
import type { AbstractRow, BulkResult, ProposalId } from './model'
import { Button, Field, Select } from '~/ds'
import { pushToast } from '~/components/toast'
import { usePending } from '~/lib/usePending'
import { useLastLoaded, useNow } from '~/components/tasks/useNow'
import { ROLE_LABEL } from '~/lib/roles'

// The bar that appears the moment a row is selected. Every action here is a
// bulk mutation that returns PER-ID results: the bar reports how many rows
// moved, and hands the failures back so the table can say which ones did not.

export type Failures = Map<string, string>

export function BulkBar({
  eventSlug,
  selection,
  onFailures,
  onClear,
}: {
  eventSlug: string
  selection: ReadonlyArray<AbstractRow>
  onFailures: (failures: Failures) => void
  onClear: () => void
}) {
  const setStatus = useMutation(api.sessions.setStatus)
  const release = useMutation(api.sessions.release)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const ids = selection.map((r) => r.proposal._id)
  const staged = selection.filter((r) => isStaged(r.proposal.status))
  const acceptCount = staged.filter(
    (r) => r.proposal.status === 'acceptQueue',
  ).length
  const declineCount = staged.length - acceptCount

  // The backend takes at most 100 ids per call, so a wider selection becomes
  // several calls in sequence and the per-id results are merged before the
  // organizer is told anything.
  const apply = async (
    key: string,
    verb: string,
    targets: Array<ProposalId>,
    call: (batch: Array<ProposalId>) => Promise<Array<BulkResult>>,
  ) => {
    setBusy(key)
    setError(null)
    try {
      const results: Array<BulkResult> = []
      for (const batch of bulkChunks(targets)) {
        results.push(...(await call(batch)))
      }
      const failed = results.filter((r) => !r.ok)
      const failures: Failures = new Map(
        failed.map((r) => [r.proposalId as string, bulkErrorMessage(r.error)]),
      )
      onFailures(failures)
      const ok = results.length - failed.length
      pushToast(
        `${ok} ${ok === 1 ? 'proposal' : 'proposals'} ${verb}`,
        failed.length === 0
          ? undefined
          : `${failed.length} unchanged — listed under the affected rows.`,
      )
      if (failed.length === 0) onClear()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The action did not run.')
    } finally {
      setBusy(null)
    }
  }

  const move = (to: 'pending' | 'acceptQueue' | 'declineQueue', verb: string) => {
    void apply(to, verb, ids, (proposalIds) =>
      setStatus({ eventSlug, proposalIds, to }),
    )
  }

  return (
    <>
      {/* Held out of flow so the bar never pushes the table, plus a spacer
          that keeps the last row reachable underneath it. */}
      <div style={{ height: 'var(--space-16)' }} aria-hidden="true" />
      <div
        style={{
          position: 'fixed',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: 'var(--space-6)',
          maxWidth: 'calc(100vw - var(--page-gutter) * 2)',
          zIndex: 'var(--z-overlay)',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          background: 'var(--surface-card)',
          border: 'var(--space-px) solid var(--border-strong)',
          borderRadius: 'var(--radius-card)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            paddingInline: 'var(--space-2)',
          }}
        >
          {selection.length} selected
        </span>

        <Popover label="Assign reviewer" icon="user-round" width="22rem">
          {(close) => (
            <AssignPanel
              eventSlug={eventSlug}
              proposalIds={ids}
              onDone={() => {
                close()
                onClear()
              }}
            />
          )}
        </Popover>

        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => move('acceptQueue', 'moved to the accept queue')}
        >
          {busy === 'acceptQueue' ? 'Moving…' : 'Accept queue'}
        </Button>
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => move('declineQueue', 'moved to the decline queue')}
        >
          {busy === 'declineQueue' ? 'Moving…' : 'Decline queue'}
        </Button>
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => move('pending', 'moved back to Submitted')}
        >
          {busy === 'pending' ? 'Moving…' : 'Back to Submitted'}
        </Button>

        <Button
          size="sm"
          variant="primary"
          disabled={busy !== null || staged.length === 0}
          onClick={() => setConfirming(true)}
        >
          Release decisions
        </Button>

        <span style={{ flex: 1 }} />
        {error !== null ? (
          <span style={{ color: 'var(--text-danger)', font: 'var(--type-caption)' }}>
            {error}
          </span>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>

      {confirming ? (
        <Modal
          title="Release decisions?"
          description={`Releases ${staged.length} staged ${staged.length === 1 ? 'decision' : 'decisions'}. Accepted proposals become sessions and speakers are emailed. This is the moment submitters find out.`}
          width={480}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={busy !== null}
                onClick={() => {
                  setConfirming(false)
                  void apply(
                    'release',
                    'released',
                    staged.map((r) => r.proposal._id),
                    (proposalIds) => release({ eventSlug, proposalIds }),
                  )
                }}
              >
                {busy === 'release' ? 'Releasing…' : 'Release decisions'}
              </Button>
            </>
          }
        >
          <ul
            style={{
              margin: 0,
              paddingLeft: 'var(--space-5)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
              font: 'var(--type-body)',
            }}
          >
            <li>
              <strong>{acceptCount}</strong> in the accept queue — each becomes a
              session and its speakers are emailed an invitation.
            </li>
            <li>
              <strong>{declineCount}</strong> in the decline queue — each submitter
              is emailed the decline.
            </li>
            {selection.length > staged.length ? (
              <li style={{ color: 'var(--text-tertiary)' }}>
                {selection.length - staged.length} selected{' '}
                {selection.length - staged.length === 1 ? 'proposal is' : 'proposals are'}{' '}
                not staged and will be left alone.
              </li>
            ) : null}
          </ul>
        </Modal>
      ) : null}
    </>
  )
}

/** The reviewer picker. Mounted only while the popover is open, so the team
 * query is never subscribed by a table nobody is assigning from. */
function AssignPanel({
  eventSlug,
  proposalIds,
  onDone,
}: {
  eventSlug: string
  proposalIds: Array<ProposalId>
  onDone: () => void
}) {
  // Team reads take `now` (invitation expiry is time-derived); hold the last
  // result across the once-a-minute re-subscribe so options don't blink away.
  const now = useNow()
  const team = useLastLoaded(useQuery(api.team.listForEvent, { eventSlug, now }))
  const assign = useMutation(api.reviews.assign)
  const { pending, error, setError, run } = usePending()
  const [userId, setUserId] = useState('')

  const options = useMemo(() => {
    const members = team?.members ?? []
    return members
      // Anyone who can review: event reviewers/organizers, plus org
      // owners/admins (their listForEvent role is owner/admin but they act
      // as organizers on every event).
      .filter(
        (m) =>
          m.role === 'reviewer' ||
          m.role === 'organizer' ||
          m.scope === 'organization',
      )
      .map((m) => ({
        value: m.userId,
        label: `${m.name ?? m.email ?? 'Unnamed'} · ${ROLE_LABEL[m.role]}`,
      }))
  }, [team])

  const submit = () => {
    if (userId === '') return setError('Choose who reviews these.')
    void run(async () => {
      const result = await assign({
        eventSlug,
        proposalIds,
        reviewerUserId: userId as Id<'users'>,
      })
      pushToast(
        `${result.assigned} ${result.assigned === 1 ? 'assignment' : 'assignments'} created`,
        result.skipped === 0
          ? undefined
          : `${result.skipped} already assigned to that reviewer.`,
      )
      onDone()
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <Field
        label="Reviewer"
        htmlFor="bulk-reviewer"
        hint={`${proposalIds.length} ${proposalIds.length === 1 ? 'proposal' : 'proposals'} — reviewers already assigned are skipped.`}
        error={error ?? undefined}
      >
        <Select
          id="bulk-reviewer"
          value={userId}
          disabled={team === undefined}
          options={[
            { value: '', label: team === undefined ? 'Loading team…' : 'Choose…' },
            ...options,
          ]}
          onChange={(e) => setUserId(e.target.value)}
        />
      </Field>
      {team !== undefined && options.length === 0 ? (
        <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
          No reviewers on this event yet. Invite them from Team.
        </p>
      ) : null}
      <Button
        variant="primary"
        size="sm"
        disabled={pending || options.length === 0}
        onClick={submit}
      >
        {pending ? 'Assigning…' : 'Assign reviewer'}
      </Button>
    </div>
  )
}
