import { useEffect, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { CriterionEditor } from './CriterionEditor'
import { PoolEditor } from './PoolEditor'
import { ProposalReadout } from './ProposalReadout'
import {
  LAUNCH_STEPS,
  PERSIST_AFTER,
  blankDraft,
  criterionSummary,
  draftFromField,
  emptyDraft,
  scorecardFromDrafts,
  stepProblem,
  stepProgressLabel,
} from './launchFlow'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import type { Assignment } from './model'
import type { CriterionDraft, Round, RoundDraft, StepFacts } from './launchFlow'
import {
  ActionResult,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  Switch,
} from '~/ds'
import { formatDateTime, fromInputValue, toInputValue } from '~/lib/datetime'
import { usePending } from '~/lib/usePending'

// The guided launch flow (W11): basics → scorecard → reviewers and pools →
// eligible proposals → assignment policy → blind preview → launch summary.
//
// Three rules hold this together:
//   • every step validates before Next, against the SAME rules the backend
//     enforces (launchFlow.ts) — the backend still refuses on its own;
//   • the summary is composed on the server, over the same planner input the
//     launch will act on, and printed here verbatim. This file states no
//     consequence of its own;
//   • the round row is materialized once the scorecard is settled, because a
//     pool, a reviewer preview and a plan all need something real to hang on
//     — as a DRAFT round, which reaches no reviewer and counts toward no
//     readiness number until the launch clears the marker. Leaving after that
//     point says so, and offers to delete it.

type TeamMember = FunctionReturnType<
  typeof api.team.listForEvent
>['members'][number]

type Outcome = FunctionReturnType<typeof api.reviews.launchRound>

function draftFromRound(round: Round, timezone: string): RoundDraft {
  return {
    name: round.name,
    opensAt: toInputValue(round.opensAt, timezone),
    closesAt: toInputValue(round.closesAt, timezone),
    anonymized: round.anonymized,
    reviewerCap:
      round.reviewerCap === undefined ? '' : String(round.reviewerCap),
    criteria: round.scorecard.map(draftFromField),
  }
}

export function RoundLaunchFlow({
  eventSlug,
  timezone,
  round,
  members,
  onClose,
  onOpenProgress,
  registerLeaveGuard,
}: {
  eventSlug: string
  timezone: string
  /** null = a brand-new round. */
  round: Round | null
  members: Array<TeamMember>
  onClose: () => void
  onOpenProgress: () => void
  /**
   * The route owns the tab, so leaving by tab would unmount this flow without
   * asking. The flow registers an interceptor: it returns true when it has
   * taken the navigation over, and runs `proceed` once the organizer has
   * answered.
   */
  registerLeaveGuard?: (
    guard: ((proceed: () => void) => boolean) | null,
  ) => void
}) {
  const createRound = useMutation(api.reviews.createRound)
  const updateRound = useMutation(api.reviews.updateRound)
  const deleteRound = useMutation(api.reviews.deleteRound)
  const launch = useMutation(api.reviews.launchRound)
  const { pending, error, run } = usePending()

  const [index, setIndex] = useState(0)
  // The draft lives here, above the steps, so stepping back and forth never
  // loses a keystroke.
  const [draft, setDraft] = useState<RoundDraft>(() =>
    round === null ? emptyDraft() : draftFromRound(round, timezone),
  )
  const [roundId, setRoundId] = useState<Id<'reviewRounds'> | null>(
    round?.roundId ?? null,
  )
  const [createdHere, setCreatedHere] = useState(false)
  const [touched, setTouched] = useState(false)
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [perProposal, setPerProposal] = useState('1')
  const [sampleId, setSampleId] = useState<string>('')
  const [problem, setProblem] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const step = LAUNCH_STEPS[index]

  const rounds = useQuery(api.reviews.listRounds, { eventSlug })
  const live = (rounds ?? []).find((row) => row.roundId === roundId) ?? null

  const eligible = useQuery(
    api.reviews.eligibleProposals,
    roundId === null ? 'skip' : { eventSlug, roundId },
  )

  // "All eligible" becomes an explicit selection the moment we know the set,
  // so the summary can count it and the launch can name it.
  useEffect(() => {
    if (eligible === undefined || selected !== null) return
    setSelected(new Set(eligible.map((row) => row.proposalId)))
  }, [eligible, selected])

  const selectionIds =
    selected === null ? undefined : ([...selected] as Array<Id<'proposals'>>)

  const reviewerView = useQuery(
    api.reviews.reviewerPreview,
    roundId === null || step.id !== 'preview'
      ? 'skip'
      : {
          eventSlug,
          roundId,
          ...(sampleId === ''
            ? {}
            : { proposalId: sampleId as Id<'proposals'> }),
        },
  )

  const plan = useQuery(
    api.reviews.launchPreview,
    roundId === null || step.id !== 'summary' || selectionIds === undefined
      ? 'skip'
      : {
          eventSlug,
          roundId,
          proposalIds: selectionIds,
          perProposal: Number(perProposal.trim()),
        },
  )

  const facts: StepFacts = {
    opens:
      draft.opensAt === ''
        ? null
        : (fromInputValue(draft.opensAt, timezone) ?? 'unreadable'),
    closes:
      draft.closesAt === ''
        ? null
        : (fromInputValue(draft.closesAt, timezone) ?? 'unreadable'),
    poolSize: live?.pool.length ?? 0,
    selectedCount: selected?.size ?? 0,
    perProposal,
  }

  const patch = (next: Partial<RoundDraft>) => {
    setTouched(true)
    setDraft((prev) => ({ ...prev, ...next }))
  }

  const persist = async () => {
    const converted = scorecardFromDrafts(draft.criteria)
    if ('problem' in converted) throw new Error(converted.problem)
    const cap = draft.reviewerCap.trim()
    const input = {
      eventSlug,
      name: draft.name.trim(),
      opensAt: typeof facts.opens === 'number' ? facts.opens : undefined,
      closesAt: typeof facts.closes === 'number' ? facts.closes : undefined,
      anonymized: draft.anonymized,
      reviewerCap: cap === '' ? undefined : Number(cap),
      scorecard: converted.scorecard,
    }
    if (roundId === null) {
      // Created as a draft: nothing about this round governs review work
      // until the organizer reaches the end of the flow and launches it.
      const created = await createRound({ ...input, draft: true })
      setRoundId(created)
      setCreatedHere(true)
    } else {
      await updateRound({ ...input, roundId })
    }
  }

  const next = () => {
    const found = stepProblem(step.id, draft, facts)
    if (found !== null) {
      setProblem(found)
      return
    }
    setProblem(null)
    if (step.id === PERSIST_AFTER) {
      void run(async () => {
        await persist()
        setIndex((i) => i + 1)
      })
      return
    }
    setIndex((i) => Math.min(i + 1, LAUNCH_STEPS.length - 1))
  }

  const back = () => {
    setProblem(null)
    setIndex((i) => Math.max(i - 1, 0))
  }

  const dirty = touched || createdHere

  /** Ask before losing work, whether the organizer pressed Cancel or reached
   * for another tab. `proceed` is where they were going. */
  const leave = (proceed: () => void): boolean => {
    if (!dirty || outcome !== null) return false
    setPendingLeave(() => proceed)
    setLeaving(true)
    return true
  }

  const cancel = () => {
    if (!leave(onClose)) onClose()
  }

  const confirmLeave = () => {
    setLeaving(false)
    const proceed = pendingLeave ?? onClose
    setPendingLeave(null)
    proceed()
  }

  // The route calls this before it changes the tab out from under the flow.
  useEffect(() => {
    if (registerLeaveGuard === undefined) return
    registerLeaveGuard(leave)
    return () => registerLeaveGuard(null)
  })

  const doLaunch = () => {
    if (plan === undefined || roundId === null) return
    void run(async () => {
      const result = await launch({
        eventSlug,
        roundId,
        proposalIds: selectionIds,
        perProposal: Number(perProposal.trim()),
        fingerprint: plan.fingerprint,
      })
      setOutcome(result)
    })
  }

  if (outcome !== null) {
    return (
      <div className="ss-launch">
        <ActionResult
          // Everything asked for happened unless a slot could NOT be filled.
          // A re-launch that assigns nothing because everything eligible is
          // already assigned is exactly what was asked for.
          status={outcome.unplaced > 0 ? 'partial' : 'success'}
          title={`"${draft.name.trim()}" launched`}
          // Every sentence is the mutation's own — this screen adds no
          // arithmetic of its own (W5).
          details={outcome.sentences}
          actions={
            <Button variant="primary" onClick={onOpenProgress}>
              Open reviewer progress
            </Button>
          }
          onDismiss={onClose}
          dismissLabel="Back to the evaluation plan"
        />
      </div>
    )
  }

  return (
    <div className="ss-launch">
      <Card
        title={round === null ? 'Launch a review round' : `Launch "${round.name}"`}
        subtitle={stepProgressLabel(index)}
        actions={
          <Button size="sm" onClick={cancel}>
            Cancel
          </Button>
        }
      >
        <ol className="ss-launch__steps">
          {LAUNCH_STEPS.map((entry, i) => (
            <li
              key={entry.id}
              className="ss-launch__step"
              aria-current={i === index ? 'step' : undefined}
            >
              {i + 1}. {entry.label}
            </li>
          ))}
        </ol>
      </Card>

      {/* One step per screen. The marker is on the wrapper rather than the
          card so the DS component keeps its declared prop surface. */}
      <div data-step={step.id}>
      <Card title={step.question}>
        {step.id === 'basics' ? (
          <BasicsStep draft={draft} timezone={timezone} onPatch={patch} />
        ) : null}
        {step.id === 'scorecard' ? (
          <ScorecardStep draft={draft} onPatch={patch} />
        ) : null}
        {step.id === 'reviewers' ? (
          live === null ? (
            <p style={{ color: 'var(--text-tertiary)' }}>Loading the pool…</p>
          ) : (
            <PoolEditor eventSlug={eventSlug} round={live} members={members} />
          )
        ) : null}
        {step.id === 'proposals' ? (
          <ProposalsStep
            eligible={eligible}
            selected={selected}
            onToggle={(id) => {
              setTouched(true)
              setSelected((prev) => {
                const nextSet = new Set(prev ?? [])
                if (nextSet.has(id)) nextSet.delete(id)
                else nextSet.add(id)
                return nextSet
              })
            }}
            onAll={() => {
              setTouched(true)
              setSelected(new Set((eligible ?? []).map((r) => r.proposalId)))
            }}
            onNone={() => {
              setTouched(true)
              setSelected(new Set())
            }}
          />
        ) : null}
        {step.id === 'policy' ? (
          <PolicyStep
            draft={draft}
            perProposal={perProposal}
            poolSize={facts.poolSize}
            selectedCount={facts.selectedCount}
            onChange={(value) => {
              setTouched(true)
              setPerProposal(value)
            }}
          />
        ) : null}
        {step.id === 'preview' ? (
          <ReviewerPreviewStep
            preview={reviewerView}
            eligible={eligible}
            sampleId={sampleId}
            onSample={setSampleId}
          />
        ) : null}
        {step.id === 'summary' ? (
          <SummaryStep plan={plan} timezone={timezone} draft={draft} />
        ) : null}
      </Card>
      </div>

      {problem === null ? null : <Callout tone="blocked">{problem}</Callout>}
      {error === null ? null : <Callout tone="blocked">{error}</Callout>}

      <div className="ss-launch__nav">
        <Button onClick={back} disabled={index === 0 || pending}>
          Back
        </Button>
        {step.id === 'summary' ? (
          <Button
            variant="primary"
            onClick={doLaunch}
            disabled={pending || plan === undefined}
          >
            {pending ? 'Launching…' : 'Launch round'}
          </Button>
        ) : (
          <Button variant="primary" onClick={next} disabled={pending}>
            {pending ? 'Saving…' : 'Next'}
          </Button>
        )}
      </div>

      {leaving ? (
        <Dialog
          title="Leave the launch flow?"
          description={
            createdHere
              ? `"${draft.name.trim()}" exists as a DRAFT round: it assigns nothing, no reviewer can see it, and it counts toward nothing until you launch it. Leaving keeps it on the plan, marked as a draft.`
              : 'The answers you have entered here are not saved yet, and leaving discards them.'
          }
          width={480}
          onClose={() => {
            setLeaving(false)
            setPendingLeave(null)
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setLeaving(false)
                  setPendingLeave(null)
                }}
              >
                Keep editing
              </Button>
              {createdHere && roundId !== null ? (
                <Button
                  variant="danger"
                  onClick={() => {
                    const proceed = pendingLeave ?? onClose
                    setLeaving(false)
                    setPendingLeave(null)
                    void run(async () => {
                      await deleteRound({ eventSlug, roundId })
                      proceed()
                    })
                  }}
                >
                  Delete the round
                </Button>
              ) : null}
              <Button
                variant={createdHere ? 'primary' : 'danger'}
                onClick={confirmLeave}
              >
                {createdHere ? 'Leave, keep as a draft' : 'Leave, discard'}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  )
}

// ── Steps ─────────────────────────────────────────────────────────────────

function BasicsStep({
  draft,
  timezone,
  onPatch,
}: {
  draft: RoundDraft
  timezone: string
  onPatch: (patch: Partial<RoundDraft>) => void
}) {
  return (
    <div style={column}>
      <Field label="Name" htmlFor="round-name">
        <Input
          id="round-name"
          value={draft.name}
          placeholder="First pass"
          onChange={(e) => onPatch({ name: e.target.value })}
        />
      </Field>
      <div style={twoCol}>
        <Field
          label="Opens"
          htmlFor="round-opens"
          optional
          hint={`Stated in ${timezone}.`}
        >
          <Input
            id="round-opens"
            type="datetime-local"
            value={draft.opensAt}
            onChange={(e) => onPatch({ opensAt: e.target.value })}
          />
        </Field>
        <Field
          label="Closes"
          htmlFor="round-closes"
          optional
          hint={`Stated in ${timezone}.`}
        >
          <Input
            id="round-closes"
            type="datetime-local"
            value={draft.closesAt}
            onChange={(e) => onPatch({ closesAt: e.target.value })}
          />
        </Field>
      </div>
      <div style={twoCol}>
        <Switch
          label="Blind review — hide speaker identities"
          checked={draft.anonymized}
          onChange={(e) => onPatch({ anonymized: e.target.checked })}
        />
        <Field
          label="Per-reviewer cap"
          htmlFor="round-cap"
          optional
          hint="Assignment never goes past this."
        >
          <Input
            id="round-cap"
            type="number"
            value={draft.reviewerCap}
            placeholder="No cap"
            onChange={(e) => onPatch({ reviewerCap: e.target.value })}
          />
        </Field>
      </div>
    </div>
  )
}

function ScorecardStep({
  draft,
  onPatch,
}: {
  draft: RoundDraft
  onPatch: (patch: Partial<RoundDraft>) => void
}) {
  const setCriterion = (index: number, patch: Partial<CriterionDraft>) => {
    onPatch({
      criteria: draft.criteria.map((entry, i) =>
        i === index ? { ...entry, ...patch } : entry,
      ),
    })
  }
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= draft.criteria.length) return
    const next = [...draft.criteria]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    onPatch({ criteria: next })
  }

  return (
    <Field label="Scorecard" hint="Reviewers answer these, in this order.">
      <div style={column}>
        {draft.criteria.map((entry, index) => (
          <CriterionEditor
            key={entry.id === '' ? `new-${index}` : entry.id}
            draft={entry}
            index={index}
            count={draft.criteria.length}
            onChange={(patch) => setCriterion(index, patch)}
            onMove={(delta) => move(index, delta)}
            onRemove={() =>
              onPatch({ criteria: draft.criteria.filter((_, i) => i !== index) })
            }
          />
        ))}
        <div>
          <Button
            size="sm"
            iconLeft="plus"
            onClick={() =>
              onPatch({ criteria: [...draft.criteria, blankDraft()] })
            }
          >
            Add criterion
          </Button>
        </div>
      </div>
    </Field>
  )
}

type Eligible = FunctionReturnType<typeof api.reviews.eligibleProposals>

function ProposalsStep({
  eligible,
  selected,
  onToggle,
  onAll,
  onNone,
}: {
  eligible: Eligible | undefined
  selected: Set<string> | null
  onToggle: (proposalId: string) => void
  onAll: () => void
  onNone: () => void
}) {
  if (eligible === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading proposals…</p>
  }
  if (eligible.length === 0) {
    return (
      <Callout tone="attention" title="Nothing to review yet">
        Only submitted proposals can enter a round. Drafts and withdrawn
        proposals are never assigned.
      </Callout>
    )
  }
  return (
    <div style={column}>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Button size="sm" onClick={onAll}>
          Select all
        </Button>
        <Button size="sm" onClick={onNone}>
          Clear
        </Button>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {eligible.map((row) => (
          <li
            key={row.proposalId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              minHeight: 'var(--row-height-sm)',
              flexWrap: 'wrap',
            }}
          >
            <Checkbox
              label={row.title}
              checked={selected?.has(row.proposalId) ?? false}
              onChange={() => onToggle(row.proposalId)}
            />
            {row.decisionReleased ? (
              <Badge tone="neutral">Decision released</Badge>
            ) : null}
            {row.assigned > 0 ? (
              <Badge tone="info">
                {row.assigned} review{row.assigned === 1 ? '' : 's'} already
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function PolicyStep({
  draft,
  perProposal,
  poolSize,
  selectedCount,
  onChange,
}: {
  draft: RoundDraft
  perProposal: string
  poolSize: number
  selectedCount: number
  onChange: (value: string) => void
}) {
  return (
    <div style={column}>
      <Field
        label="Reviews per proposal"
        htmlFor="per-proposal"
        hint="Proposals that already hold this many reviews are left alone."
      >
        <Input
          id="per-proposal"
          type="number"
          value={perProposal}
          style={{ width: '6rem' }}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
      <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
        {selectedCount} proposal{selectedCount === 1 ? '' : 's'} spread across{' '}
        {poolSize} reviewer{poolSize === 1 ? '' : 's'}, least-loaded first
        {draft.reviewerCap.trim() === ''
          ? '.'
          : `, never past ${draft.reviewerCap.trim()} per reviewer.`}
      </p>
    </div>
  )
}

type ReviewerPreviewData = FunctionReturnType<
  typeof api.reviews.reviewerPreview
>

function ReviewerPreviewStep({
  preview,
  eligible,
  sampleId,
  onSample,
}: {
  preview: ReviewerPreviewData | undefined
  eligible: Eligible | undefined
  sampleId: string
  onSample: (value: string) => void
}) {
  if (preview === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading the preview…</p>
  }
  if (preview === null) {
    return (
      <Callout tone="attention" title="No proposal to preview">
        There is no submitted proposal in this round's eligible set yet.
      </Callout>
    )
  }

  // The reviewer's own payload, rendered by the reviewer's own component. The
  // blinding was applied on the server — nothing here decides what to hide.
  const assignment: Assignment = {
    reviewId: 'preview' as Id<'reviews'>,
    contentVersion: 0,
    status: 'assigned',
    answers: {},
    round: {
      roundId: preview.roundId,
      name: preview.roundName,
      anonymized: preview.anonymized,
      scorecard: preview.scorecard,
    },
    proposal: preview.proposal,
  }

  return (
    <div style={column}>
      <Callout
        tone={preview.anonymized ? 'info' : 'neutral'}
        title={
          preview.anonymized
            ? 'This is exactly what a reviewer sees in this blind round'
            : 'This is exactly what a reviewer sees in this round'
        }
      >
        {preview.anonymized
          ? `${preview.hiddenSpeakerCount} speaker${preview.hiddenSpeakerCount === 1 ? '' : 's'} and ${preview.hiddenFieldLabels.length} identity answer${preview.hiddenFieldLabels.length === 1 ? '' : 's'} are removed by the server before a reviewer can read them${preview.hiddenFieldLabels.length === 0 ? '.' : `: ${preview.hiddenFieldLabels.join(', ')}.`}`
          : 'Speaker professional identity is shown; contact details never are.'}
      </Callout>
      {eligible === undefined || eligible.length < 2 ? null : (
        <Field label="Sample proposal" htmlFor="preview-sample">
          <Select
            id="preview-sample"
            size="sm"
            value={sampleId}
            options={[
              { value: '', label: 'First eligible proposal' },
              ...eligible.map((row) => ({
                value: row.proposalId,
                label: row.title,
              })),
            ]}
            onChange={(e) => onSample(e.target.value)}
          />
        </Field>
      )}
      <ProposalReadout assignment={assignment} />
    </div>
  )
}

type Plan = FunctionReturnType<typeof api.reviews.launchPreview>

function SummaryStep({
  plan,
  timezone,
  draft,
}: {
  plan: Plan | undefined
  timezone: string
  draft: RoundDraft
}) {
  if (plan === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Composing summary…</p>
  }
  const opens =
    draft.opensAt === '' ? null : fromInputValue(draft.opensAt, timezone)
  const closes =
    draft.closesAt === '' ? null : fromInputValue(draft.closesAt, timezone)

  return (
    <div style={column}>
      <ul className="ss-launch__sentences">
        {plan.sentences.map((sentence) => (
          <li key={sentence}>{sentence}</li>
        ))}
      </ul>
      <p
        style={{
          color: 'var(--text-tertiary)',
          font: 'var(--type-caption)',
          margin: 0,
        }}
      >
        {opens === null && closes === null
          ? 'The round is open as soon as it launches.'
          : `Reviewing window: ${opens === null ? 'open now' : formatDateTime(opens, timezone)} → ${closes === null ? 'no close date' : formatDateTime(closes, timezone)}.`}
      </p>
      <Field label="Scorecard">
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {draft.criteria.map((entry, index) => {
            const converted = scorecardFromDrafts([entry])
            return (
              <li key={`${entry.id}-${index}`}>
                {entry.label}
                {'scorecard' in converted
                  ? ` · ${criterionSummary(converted.scorecard[0])}`
                  : ''}
              </li>
            )
          })}
        </ul>
      </Field>
    </div>
  )
}

const column = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 'var(--space-4)',
}

const twoCol = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
  gap: 'var(--space-4)',
  alignItems: 'end' as const,
}
