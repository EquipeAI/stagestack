import { useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import {
  outcomeLines,
  planBulk,
  planLines,
  summarizeBulk,
} from '@convex/shared/bulkDecisions'
import { Popover } from './Popover'
import { bulkChunks, bulkErrorMessage, isStaged } from './model'
import { Modal } from './Modal'
import type { BulkAction } from '@convex/shared/bulkDecisions'
import type { Id } from '@convex/_generated/dataModel'
import type { AbstractRow, BulkResult, ProposalId } from './model'
import { Button, Field, Input, Select } from '~/ds'
import { usePending } from '~/lib/usePending'
import { useLastLoaded, useNow } from '~/components/tasks/useNow'
import { ROLE_LABEL } from '~/lib/roles'

// The bar that appears the moment a row is selected. Every action here is a
// bulk mutation that returns PER-ID results: the bar reports how many rows
// moved, and hands the failures back so the table can say which ones did not.

export type Failures = Map<string, string>

/** The persistent outcome the PAGE renders (W5). It deliberately outlives this
 * component: a successful bulk action clears the selection, which unmounts the
 * bar — the result has to survive that. */
export type BulkOutcomeView = {
  status: 'success' | 'partial' | 'failed'
  title: string
  lines: Array<string>
  retry?: () => void
  retryLabel?: string
}

const RELEASE: BulkAction = { kind: 'release' }

export function BulkBar({
  eventSlug,
  selection,
  onFailures,
  onResult,
  onClear,
}: {
  eventSlug: string
  selection: ReadonlyArray<AbstractRow>
  onFailures: (failures: Failures) => void
  onResult: (result: BulkOutcomeView | null) => void
  onClear: () => void
}) {
  const setStatus = useMutation(api.sessions.setStatus)
  const release = useMutation(api.sessions.release)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const ids = selection.map((r) => r.proposal._id)
  const statuses = selection.map((r) => r.proposal.status)
  const staged = selection.filter((r) => isStaged(r.proposal.status))
  const releasePlan = planBulk(statuses, RELEASE)
  // The three queue buttons share one eligibility rule, so the bar states it
  // once, before anything is clicked. Rendered as text, not a tooltip: a phone
  // has no hover.
  const stagePlan = planBulk(statuses, { kind: 'stage', to: 'acceptQueue' })

  // The backend takes at most 100 ids per call, so a wider selection becomes
  // several calls in sequence and the per-id results are merged before the
  // organizer is told anything.
  const apply = async (
    key: string,
    verb: string,
    action: BulkAction,
    targets: Array<ProposalId>,
    call: (batch: Array<ProposalId>) => Promise<Array<BulkResult>>,
  ) => {
    setBusy(key)
    setError(null)
    onResult(null)
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
      // The AFTER arithmetic is derived from the mutation's own per-id
      // results, and the excluded rows are the same ones the BEFORE statement
      // named — both come out of convex/shared/bulkDecisions.ts.
      const outcome = summarizeBulk(results)
      // The exclusions belong to what THIS run attempted, not to the whole
      // selection — a retry of three failed ids must not re-report the
      // withdrawn proposal it never touched.
      const attempted = new Set<string>(targets as ReadonlyArray<string>)
      const plan = planBulk(
        selection
          .filter((row) => attempted.has(row.proposal._id as string))
          .map((row) => row.proposal.status),
        action,
      )
      // Retry re-attempts ONLY what failed. Re-running the whole selection
      // would be individually harmless — an id that already moved reports ok
      // with no second write, and an already-released one reports
      // invalid_status rather than emailing anyone twice — but an outcome that
      // counts successes it never re-ran is a lie about what just happened.
      const failedIds = failed.map((r) => r.proposalId)
      onResult({
        status:
          outcome.failed === 0
            ? 'success'
            : outcome.succeeded === 0
              ? 'failed'
              : 'partial',
        title: `${outcome.succeeded} ${outcome.succeeded === 1 ? 'proposal' : 'proposals'} ${verb}`,
        lines: [
          ...outcomeLines(outcome),
          ...plan.excluded.map(
            (item) =>
              `${item.count} selected ${item.count === 1 ? 'proposal was' : 'proposals were'} ${item.reason} — not attempted.`,
          ),
          ...(outcome.failed === 0
            ? []
            : ['The rows that did not move are listed under the table.']),
        ],
        retry:
          outcome.failed === 0
            ? undefined
            : () => {
                void apply(key, verb, action, failedIds, call)
              },
        retryLabel: `Retry the ${outcome.failed} that failed`,
      })
      if (failed.length === 0) onClear()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The action did not run.')
    } finally {
      setBusy(null)
    }
  }

  const move = (to: 'pending' | 'acceptQueue' | 'declineQueue', verb: string) => {
    void apply(to, verb, { kind: 'stage', to }, ids, (proposalIds) =>
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
            display: 'flex',
            flexDirection: 'column',
            paddingInline: 'var(--space-2)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            {stagePlan.selected} selected · {stagePlan.eligible} eligible
          </span>
          {stagePlan.excluded.length > 0 ? (
            <span
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
              }}
            >
              {stagePlan.excluded
                .map((item) => `${item.count} ${item.reason}`)
                .join(' · ')}
            </span>
          ) : null}
        </span>

        <Popover label="Assign reviewer" icon="user-round" width="22rem">
          {(close) => (
            <AssignPanel
              eventSlug={eventSlug}
              proposalIds={ids}
              onResult={onResult}
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
                    RELEASE,
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
            {planLines(releasePlan, RELEASE).map((line) => (
              <li key={line}>{line}</li>
            ))}
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
  onResult,
  onDone,
}: {
  eventSlug: string
  proposalIds: Array<ProposalId>
  onResult: (result: BulkOutcomeView | null) => void
  onDone: () => void
}) {
  // Team reads take `now` (invitation expiry is time-derived); hold the last
  // result across the once-a-minute re-subscribe so options don't blink away.
  const now = useNow()
  const team = useLastLoaded(useQuery(api.team.listForEvent, { eventSlug, now }))
  const rounds = useQuery(api.reviews.listRounds, { eventSlug })
  const assign = useMutation(api.reviews.assign)
  const autoDistribute = useMutation(api.reviews.autoDistribute)
  const { pending, error, setError, run } = usePending()
  const auto = usePending()
  const [userId, setUserId] = useState('')
  const [roundChoice, setRoundChoice] = useState('')
  const [perProposal, setPerProposal] = useState('1')

  // The chosen round, defaulting to the first one — assignments carry a round
  // from the moment rounds exist, so a review lands under the right scorecard.
  const round = useMemo(() => {
    if (rounds === undefined || rounds.length === 0) return undefined
    return rounds.find((r) => r.roundId === roundChoice) ?? rounds[0]
  }, [rounds, roundChoice])

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
        roundId: round?.roundId,
      })
      onResult({
        status: result.skipped === 0 ? 'success' : 'partial',
        title: `${result.assigned} ${result.assigned === 1 ? 'assignment' : 'assignments'} created`,
        lines: [
          `${proposalIds.length} ${proposalIds.length === 1 ? 'proposal was' : 'proposals were'} selected.`,
          ...(result.skipped === 0
            ? []
            : [
                `${result.skipped} already assigned to that reviewer — left alone.`,
              ]),
        ],
      })
      onDone()
    })
  }

  const distribute = () => {
    if (round === undefined) return
    const per = Math.max(1, Math.floor(Number(perProposal) || 1))
    void auto.run(async () => {
      const result = await autoDistribute({
        eventSlug,
        roundId: round.roundId,
        proposalIds,
        perProposal: per,
      })
      onResult({
        status: result.unplaced === 0 ? 'success' : 'partial',
        title: `${result.assigned} ${result.assigned === 1 ? 'assignment' : 'assignments'} created`,
        lines: [
          `${proposalIds.length} selected × ${per} review${per === 1 ? '' : 's'} per proposal requested.`,
          ...(result.unplaced === 0
            ? []
            : [
                `${result.unplaced} slot${result.unplaced === 1 ? '' : 's'} unfilled — the round ran out of eligible reviewers.`,
              ]),
        ],
      })
      onDone()
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {rounds !== undefined && rounds.length > 0 ? (
        <Field
          label="Round"
          htmlFor="bulk-round"
          hint={
            round === undefined
              ? undefined
              : `Pool of ${round.pool.length} · ${
                  round.reviewerCap === undefined
                    ? 'no cap'
                    : `cap ${round.reviewerCap} each`
                }`
          }
        >
          <Select
            id="bulk-round"
            value={round?.roundId ?? ''}
            options={rounds.map((r) => ({ value: r.roundId, label: r.name }))}
            onChange={(e) => setRoundChoice(e.target.value)}
          />
        </Field>
      ) : null}
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
      {round !== undefined ? (
        <div
          style={{
            paddingTop: 'var(--space-3)',
            borderTop: 'var(--space-px) solid var(--border-subtle)',
          }}
        >
          <Field
            label="Auto-distribute"
            htmlFor="bulk-per-proposal"
            hint={`Spreads the ${proposalIds.length} selected across the ${round.name} pool, evening out reviewer load.`}
            error={auto.error ?? undefined}
          >
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <span style={{ width: '5rem', flex: 'none' }}>
                <Input
                  id="bulk-per-proposal"
                  type="number"
                  size="sm"
                  value={perProposal}
                  onChange={(e) => setPerProposal(e.target.value)}
                />
              </span>
              <Button
                size="sm"
                disabled={auto.pending || round.pool.length === 0}
                onClick={distribute}
              >
                {auto.pending ? 'Distributing…' : 'Auto-distribute'}
              </Button>
            </div>
          </Field>
          {round.pool.length === 0 ? (
            <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
              This round has no reviewer pool yet. Add reviewers to it first.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
