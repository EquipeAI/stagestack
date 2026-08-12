import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import type * as React from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Dialog,
  Field,
  IconButton,
  Input,
  Select,
  Switch,
  Tag,
} from '~/ds'
import { formatDateTime, fromInputValue, toInputValue } from '~/lib/datetime'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'

// The organizer's evaluation plan: every review round, its window, its
// scorecard and its reviewer pool — plus the editor that creates and reshapes
// them. All times are stated in the event timezone, like everywhere else.

type Round = FunctionReturnType<typeof api.reviews.listRounds>[number]
type ScorecardField = Round['scorecard'][number]
type TeamMember = FunctionReturnType<
  typeof api.team.listForEvent
>['members'][number]

// ── Criterion drafts ──────────────────────────────────────────────────────
// The editor holds every numeric field as a string, so a half-typed value
// never fights the input; conversion (and complaint) happens on save.

type CriterionDraft = {
  id: string
  label: string
  kind: 'numeric' | 'dropdown' | 'text'
  required: boolean
  min: string
  max: string
  weight: string
  options: string
}

function criterionId(label: string) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const suffix = Math.random().toString(36).slice(2, 7)
  return slug === '' ? suffix : `${slug}-${suffix}`
}

function draftFromField(field: ScorecardField): CriterionDraft {
  return {
    id: field.id,
    label: field.label,
    kind: field.kind,
    required: field.required === true,
    min: field.min === undefined ? '1' : String(field.min),
    max: field.max === undefined ? '5' : String(field.max),
    weight: field.weight === undefined ? '1' : String(field.weight),
    options: (field.options ?? []).join(', '),
  }
}

function blankDraft(): CriterionDraft {
  return {
    id: '',
    label: '',
    kind: 'numeric',
    required: false,
    min: '1',
    max: '5',
    weight: '1',
    options: '',
  }
}

/** The scorecard a brand-new round starts from. */
function defaultDrafts(): Array<CriterionDraft> {
  return [
    { ...blankDraft(), id: 'score', label: 'Score', required: true },
    {
      ...blankDraft(),
      id: 'recommendation',
      label: 'Recommendation',
      kind: 'dropdown',
      required: true,
      options: 'Accept, Maybe, Reject',
    },
    { ...blankDraft(), id: 'comments', label: 'Comments', kind: 'text' },
  ]
}

/** Draft → stored field, or the complaint that stops the save. */
function fieldFromDraft(
  draft: CriterionDraft,
): { field: ScorecardField } | { problem: string } {
  const label = draft.label.trim()
  if (label === '') return { problem: 'Every criterion needs a label.' }
  const field: ScorecardField = {
    id: draft.id === '' ? criterionId(label) : draft.id,
    label,
    kind: draft.kind,
    required: draft.required ? true : undefined,
  }
  if (draft.kind === 'numeric') {
    const min = Number(draft.min.trim())
    const max = Number(draft.max.trim())
    const weight = Number(draft.weight.trim())
    if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min) {
      return {
        problem: `"${label}" needs whole-number bounds with max above min.`,
      }
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      return { problem: `"${label}" needs a weight above zero.` }
    }
    field.min = min
    field.max = max
    field.weight = weight
  }
  if (draft.kind === 'dropdown') {
    const options = draft.options
      .split(',')
      .map((option) => option.trim())
      .filter((option) => option !== '')
    if (options.length === 0) {
      return { problem: `"${label}" needs at least one dropdown option.` }
    }
    field.options = options
  }
  return { field }
}

/** One compact line per criterion, e.g. "Score · 1–5 · ×2 · required". */
function criterionSummary(field: ScorecardField) {
  const parts: Array<string> = []
  if (field.kind === 'numeric') {
    parts.push(`${field.min ?? 1}–${field.max ?? 5}`)
    const weight = field.weight ?? 1
    if (weight !== 1) parts.push(`×${weight}`)
  }
  if (field.kind === 'dropdown') parts.push((field.options ?? []).join(' / '))
  if (field.kind === 'text') parts.push('text')
  if (field.required === true) parts.push('required')
  return parts.join(' · ')
}

// ── Panel ─────────────────────────────────────────────────────────────────

export function RoundsPanel({
  eventSlug,
  timezone,
}: {
  eventSlug: string
  timezone: string
}) {
  const rounds = useQuery(api.reviews.listRounds, { eventSlug })
  // Invitation expiry is time-derived, so team reads take the clock as an
  // argument (see settings/team screens). One snapshot is enough here.
  const [now] = useState(() => Date.now())
  const team = useQuery(api.team.listForEvent, { eventSlug, now })
  const [editing, setEditing] = useState<Round | 'new' | null>(null)

  if (rounds === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading rounds…</p>
  }

  const members = (team?.members ?? []).filter(
    (member) => member.role === 'organizer' || member.role === 'reviewer',
  )

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          iconLeft="plus"
          onClick={() => setEditing('new')}
        >
          New round
        </Button>
      </div>

      {rounds.length === 0 ? (
        <Callout tone="info" title="No review rounds yet">
          A round bundles a scorecard, a reviewing window and a reviewer pool.
          Create one to start assigning proposals.
        </Callout>
      ) : (
        rounds.map((round) => (
          <RoundCard
            key={round.roundId}
            eventSlug={eventSlug}
            round={round}
            timezone={timezone}
            members={members}
            onEdit={() => setEditing(round)}
          />
        ))
      )}

      {editing !== null ? (
        <RoundDialog
          eventSlug={eventSlug}
          timezone={timezone}
          round={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  )
}

// ── One round ─────────────────────────────────────────────────────────────

function RoundCard({
  eventSlug,
  round,
  timezone,
  members,
  onEdit,
}: {
  eventSlug: string
  round: Round
  timezone: string
  members: Array<TeamMember>
  onEdit: () => void
}) {
  const deleteRound = useMutation(api.reviews.deleteRound)
  const removal = usePending()
  const [confirming, setConfirming] = useState(false)

  const window =
    round.opensAt === undefined && round.closesAt === undefined
      ? 'Always open'
      : `${round.opensAt === undefined ? 'Open' : formatDateTime(round.opensAt, timezone)} → ${
          round.closesAt === undefined
            ? 'no close date'
            : formatDateTime(round.closesAt, timezone)
        }`

  return (
    <Card
      title={round.name}
      subtitle={window}
      actions={
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
        >
          {round.anonymized ? <Badge tone="info">Blind review</Badge> : null}
          {round.reviewerCap !== undefined ? (
            <Badge tone="neutral">Cap {round.reviewerCap} / reviewer</Badge>
          ) : null}
          <IconButton icon="pencil" label="Edit round" size="sm" onClick={onEdit} />
          <IconButton
            icon="trash-2"
            label="Delete round"
            size="sm"
            disabled={removal.pending}
            onClick={() => setConfirming(true)}
          />
        </div>
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {removal.error !== null ? (
          <Callout tone="blocked">{removal.error}</Callout>
        ) : null}

        <Field label="Scorecard">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {round.scorecard.map((field) => (
              <li
                key={field.id}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 'var(--space-2)',
                  minHeight: 'var(--row-height-sm)',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ font: 'var(--type-body)' }}>{field.label}</span>
                <span
                  style={{
                    color: 'var(--text-tertiary)',
                    font: 'var(--type-caption)',
                  }}
                >
                  {criterionSummary(field)}
                </span>
              </li>
            ))}
          </ul>
        </Field>

        <PoolEditor eventSlug={eventSlug} round={round} members={members} />
      </div>

      {confirming ? (
        <Dialog
          title={`Delete "${round.name}"?`}
          description="The round, its scorecard and its reviewer pool go away. Deleting cannot be undone."
          width={480}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={removal.pending}
                onClick={() => {
                  setConfirming(false)
                  void removal.run(async () => {
                    await deleteRound({ eventSlug, roundId: round.roundId })
                    pushToast('Round deleted', round.name)
                  })
                }}
              >
                Delete round
              </Button>
            </>
          }
        />
      ) : null}
    </Card>
  )
}

// ── Reviewer pool ─────────────────────────────────────────────────────────

function PoolEditor({
  eventSlug,
  round,
  members,
}: {
  eventSlug: string
  round: Round
  members: Array<TeamMember>
}) {
  const addReviewer = useMutation(api.reviews.addRoundReviewer)
  const removeReviewer = useMutation(api.reviews.removeRoundReviewer)
  const { pending, error, run } = usePending({ announce: false })

  const inPool = new Set<string>(round.pool.map((member) => member.userId))
  const addable = members.filter((member) => !inPool.has(member.userId))

  return (
    <Field
      label="Reviewer pool"
      htmlFor={`pool-${round.roundId}`}
      hint="Auto-distribution assigns proposals across this pool."
      error={error}
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
      >
        {round.pool.length === 0 ? (
          <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
            Nobody yet — add reviewers below.
          </p>
        ) : (
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}
          >
            {round.pool.map((member) => (
              <Tag
                key={member.userId}
                onRemove={() => {
                  void run(async () => {
                    await removeReviewer({
                      eventSlug,
                      roundId: round.roundId,
                      userId: member.userId,
                    })
                  })
                }}
              >
                {member.name ?? member.email ?? 'Unknown'}
              </Tag>
            ))}
          </div>
        )}
        <div style={{ maxWidth: '20rem' }}>
          <Select
            id={`pool-${round.roundId}`}
            size="sm"
            value=""
            disabled={pending || addable.length === 0}
            options={[
              {
                value: '',
                label:
                  addable.length === 0
                    ? 'Everyone on the team is in the pool'
                    : 'Add a team member…',
              },
              ...addable.map((member) => ({
                value: member.userId,
                label: member.name ?? member.email ?? 'Unknown',
              })),
            ]}
            onChange={(e) => {
              const userId = e.target.value
              if (userId === '') return
              void run(async () => {
                await addReviewer({
                  eventSlug,
                  roundId: round.roundId,
                  userId: userId as Id<'users'>,
                })
              })
            }}
          />
        </div>
      </div>
    </Field>
  )
}

// ── Create / edit dialog ──────────────────────────────────────────────────

function RoundDialog({
  eventSlug,
  timezone,
  round,
  onClose,
}: {
  eventSlug: string
  timezone: string
  /** null = creating a new round. */
  round: Round | null
  onClose: () => void
}) {
  const createRound = useMutation(api.reviews.createRound)
  const updateRound = useMutation(api.reviews.updateRound)
  const { pending, error, setError, run } = usePending()

  const [name, setName] = useState(round?.name ?? '')
  const [opensAt, setOpensAt] = useState(toInputValue(round?.opensAt, timezone))
  const [closesAt, setClosesAt] = useState(
    toInputValue(round?.closesAt, timezone),
  )
  const [anonymized, setAnonymized] = useState(round?.anonymized ?? false)
  const [reviewerCap, setReviewerCap] = useState(
    round?.reviewerCap === undefined ? '' : String(round.reviewerCap),
  )
  const [criteria, setCriteria] = useState<Array<CriterionDraft>>(() =>
    round === null ? defaultDrafts() : round.scorecard.map(draftFromField),
  )

  const setCriterion = (index: number, patch: Partial<CriterionDraft>) => {
    setCriteria((prev) =>
      prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)),
    )
  }

  const moveCriterion = (index: number, delta: -1 | 1) => {
    setCriteria((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
  }

  const save = () => {
    if (name.trim() === '') return setError('The round needs a name.')
    const opens = opensAt === '' ? null : fromInputValue(opensAt, timezone)
    const closes = closesAt === '' ? null : fromInputValue(closesAt, timezone)
    if (opensAt !== '' && opens === null) {
      return setError('The open date is unreadable.')
    }
    if (closesAt !== '' && closes === null) {
      return setError('The close date is unreadable.')
    }
    if (opens !== null && closes !== null && closes < opens) {
      return setError('The round cannot close before it opens.')
    }
    const capTrimmed = reviewerCap.trim()
    const cap = capTrimmed === '' ? undefined : Number(capTrimmed)
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
      return setError('The per-reviewer cap must be a whole number, at least 1.')
    }
    if (criteria.length === 0) {
      return setError('The scorecard needs at least one criterion.')
    }
    const scorecard: Array<ScorecardField> = []
    for (const draft of criteria) {
      const converted = fieldFromDraft(draft)
      if ('problem' in converted) return setError(converted.problem)
      scorecard.push(converted.field)
    }

    const input = {
      eventSlug,
      name: name.trim(),
      opensAt: opens ?? undefined,
      closesAt: closes ?? undefined,
      anonymized,
      reviewerCap: cap,
      scorecard,
    }

    void run(async () => {
      if (round === null) {
        await createRound(input)
        pushToast('Round created', input.name)
      } else {
        await updateRound({ ...input, roundId: round.roundId })
        pushToast('Round saved', input.name)
      }
      onClose()
    })
  }

  return (
    <Dialog
      title={round === null ? 'New review round' : `Edit "${round.name}"`}
      description="A round carries its own scorecard, window and reviewer pool."
      width={640}
      onClose={onClose}
      footer={
        <>
          {error !== null ? (
            <span
              style={{ color: 'var(--text-danger)', font: 'var(--type-caption)' }}
            >
              {error}
            </span>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={pending}>
            {pending
              ? 'Saving…'
              : round === null
                ? 'Create round'
                : 'Save round'}
          </Button>
        </>
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        <Field label="Name" htmlFor="round-name">
          <Input
            id="round-name"
            value={name}
            placeholder="First pass"
            onChange={(e) => setName(e.target.value)}
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
              value={opensAt}
              onChange={(e) => setOpensAt(e.target.value)}
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
              value={closesAt}
              onChange={(e) => setClosesAt(e.target.value)}
            />
          </Field>
        </div>

        <div style={twoCol}>
          <Switch
            label="Blind review — hide speaker identities"
            checked={anonymized}
            onChange={(e) => setAnonymized(e.target.checked)}
          />
          <Field
            label="Per-reviewer cap"
            htmlFor="round-cap"
            optional
            hint="Auto-distribution never assigns past this."
          >
            <Input
              id="round-cap"
              type="number"
              value={reviewerCap}
              placeholder="No cap"
              onChange={(e) => setReviewerCap(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Scorecard" hint="Reviewers answer these, in this order.">
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
            }}
          >
            {criteria.map((draft, index) => (
              <CriterionEditor
                key={draft.id === '' ? `new-${index}` : draft.id}
                draft={draft}
                index={index}
                count={criteria.length}
                onChange={(patch) => setCriterion(index, patch)}
                onMove={(delta) => moveCriterion(index, delta)}
                onRemove={() =>
                  setCriteria((prev) => prev.filter((_, i) => i !== index))
                }
              />
            ))}
            <div>
              <Button
                size="sm"
                iconLeft="plus"
                onClick={() => setCriteria((prev) => [...prev, blankDraft()])}
              >
                Add criterion
              </Button>
            </div>
          </div>
        </Field>
      </div>
    </Dialog>
  )
}

function CriterionEditor({
  draft,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  draft: CriterionDraft
  index: number
  count: number
  onChange: (patch: Partial<CriterionDraft>) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-3)',
        border: 'var(--space-px) solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-3)' }}
      >
        <div style={{ flex: 2, minWidth: 0 }}>
          <Field label="Criterion" htmlFor={`crit-label-${index}`}>
            <Input
              id={`crit-label-${index}`}
              size="sm"
              value={draft.label}
              placeholder="Relevance"
              onChange={(e) => onChange({ label: e.target.value })}
            />
          </Field>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Field label="Kind" htmlFor={`crit-kind-${index}`}>
            <Select
              id={`crit-kind-${index}`}
              size="sm"
              value={draft.kind}
              options={[
                { value: 'numeric', label: 'Numeric' },
                { value: 'dropdown', label: 'Dropdown' },
                { value: 'text', label: 'Text' },
              ]}
              onChange={(e) =>
                onChange({
                  kind: e.target.value as CriterionDraft['kind'],
                })
              }
            />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          <IconButton
            icon="arrow-up"
            label="Move up"
            size="sm"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            icon="arrow-down"
            label="Move down"
            size="sm"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          />
          <IconButton
            icon="trash-2"
            label="Remove criterion"
            size="sm"
            onClick={onRemove}
          />
        </div>
      </div>

      {draft.kind === 'numeric' ? (
        <div style={threeCol}>
          <Field label="Min" htmlFor={`crit-min-${index}`}>
            <Input
              id={`crit-min-${index}`}
              size="sm"
              type="number"
              value={draft.min}
              onChange={(e) => onChange({ min: e.target.value })}
            />
          </Field>
          <Field label="Max" htmlFor={`crit-max-${index}`}>
            <Input
              id={`crit-max-${index}`}
              size="sm"
              type="number"
              value={draft.max}
              onChange={(e) => onChange({ max: e.target.value })}
            />
          </Field>
          <Field label="Weight" htmlFor={`crit-weight-${index}`}>
            <Input
              id={`crit-weight-${index}`}
              size="sm"
              type="number"
              value={draft.weight}
              onChange={(e) => onChange({ weight: e.target.value })}
            />
          </Field>
        </div>
      ) : null}

      {draft.kind === 'dropdown' ? (
        <Field
          label="Options"
          htmlFor={`crit-options-${index}`}
          hint="Comma separated, e.g. Accept, Maybe, Reject."
        >
          <Input
            id={`crit-options-${index}`}
            size="sm"
            value={draft.options}
            onChange={(e) => onChange({ options: e.target.value })}
          />
        </Field>
      ) : null}

      <Checkbox
        label="Required"
        checked={draft.required}
        onChange={(e) => onChange({ required: e.target.checked })}
      />
    </div>
  )
}

const twoCol: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
  gap: 'var(--space-4)',
  alignItems: 'end',
}

const threeCol: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 'var(--space-3)',
}
