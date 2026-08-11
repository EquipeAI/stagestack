import { useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import {
  ABSTRACT_STATUS_LABEL,
  ABSTRACT_STATUS_TONE,
  bulkErrorMessage,
  displayTitle,
  isStaged,
} from './model'
import { Modal } from './Modal'
import type { FunctionReturnType } from 'convex/server'
import type { Doc, Id } from '@convex/_generated/dataModel'
import type { AnswerValue, FormDef } from '@convex/shared/formDef'
import type * as React from 'react'
import type { ProposalId } from './model'
import {
  Badge,
  Button,
  Callout,
  Card,
  DescriptionList,
  Field,
  Input,
  StatusPill,
  Tag,
  Textarea,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { errorMessage } from '~/lib/errors'
import { pushToast } from '~/components/toast'
import { formatDateTime, fromInputValue, toInputValue } from '~/lib/datetime'

// One proposal, everything about it. Both queries mount with the dialog — the
// table itself never subscribes to per-proposal detail or review content, so
// opening a row is the only thing that costs anything.

const A_WEEK = 7 * 24 * 60 * 60 * 1000

export function ProposalDetailDialog({
  eventSlug,
  event,
  proposalId,
  def,
  onClose,
}: {
  eventSlug: string
  event: Doc<'events'>
  proposalId: ProposalId
  def: FormDef | null
  onClose: () => void
}) {
  const detail = useQuery(api.cfp.getProposalDetail, { eventSlug, proposalId })

  if (detail === undefined) {
    return (
      <Modal title="Loading proposal…" width={860} onClose={onClose}>
        <p style={{ color: 'var(--text-tertiary)' }}>Reading answers and reviews…</p>
      </Modal>
    )
  }

  const { proposal } = detail
  const speakerCount = detail.speakers.length

  return (
    <Modal
      title={displayTitle(proposal)}
      description={`${ABSTRACT_STATUS_LABEL[proposal.status]} · ${speakerCount} ${speakerCount === 1 ? 'speaker' : 'speakers'} · updated ${formatDateTime(proposal.updatedAt, event.timezone)}`}
      width={860}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <DescriptionList
          items={[
            {
              term: 'Status',
              value: (
                <StatusPill
                  status={ABSTRACT_STATUS_LABEL[proposal.status]}
                  tone={ABSTRACT_STATUS_TONE[proposal.status]}
                />
              ),
            },
            {
              term: 'Submitter',
              value: (
                <span>
                  {detail.submitter.name ?? '—'}
                  {detail.submitter.email !== null ? (
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      {' · '}
                      {detail.submitter.email}
                    </span>
                  ) : null}
                </span>
              ),
            },
            {
              term: 'Submitted',
              value:
                proposal.submittedAt === undefined
                  ? 'Not submitted'
                  : formatDateTime(proposal.submittedAt, event.timezone),
            },
            { term: 'Form version', value: `v${proposal.formVersion}` },
          ]}
        />

        <DecisionPanel
          eventSlug={eventSlug}
          proposal={proposal}
          onReleased={onClose}
        />

        <ReviewPanel
          eventSlug={eventSlug}
          proposalId={proposalId}
          timezone={event.timezone}
        />

        <AnswersPanel
          answers={proposal.answers}
          def={def}
          fileUrls={detail.fileUrls}
        />

        <SpeakersPanel speakers={detail.speakers} />

        {proposal.status === 'draft' || proposal.status === 'pending' ? (
          <ReopenPanel eventSlug={eventSlug} event={event} proposal={proposal} />
        ) : null}
      </div>
    </Modal>
  )
}

// ── Decisions ────────────────────────────────────────────────────────────

function DecisionPanel({
  eventSlug,
  proposal,
  onReleased,
}: {
  eventSlug: string
  proposal: Doc<'proposals'>
  onReleased: () => void
}) {
  const setStatus = useMutation(api.sessions.setStatus)
  const release = useMutation(api.sessions.release)
  const correct = useMutation(api.sessions.correct)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<'release' | 'correct' | null>(null)
  const [note, setNote] = useState('')
  const released = proposal.status === 'accepted' || proposal.status === 'declined'
  const correctTo = proposal.status === 'accepted' ? 'declined' : 'accepted'

  const move = (to: 'pending' | 'acceptQueue' | 'declineQueue', verb: string) => {
    setBusy(to)
    setProblem(null)
    void setStatus({ eventSlug, proposalIds: [proposal._id], to })
      .then((results) => {
        const failed = results.find((r) => !r.ok)
        if (failed === undefined) {
          pushToast(`Proposal ${verb}`, displayTitle(proposal))
        } else {
          setProblem(bulkErrorMessage(failed.error))
        }
      })
      .catch((err: unknown) =>
        setProblem(errorMessage(err, 'The change did not run.')),
      )
      .finally(() => setBusy(null))
  }

  if (proposal.status === 'draft' || proposal.status === 'withdrawn') {
    return (
      <Card variant="flat" title="Decision">
        <p style={{ color: 'var(--text-secondary)' }}>
          {proposal.status === 'draft'
            ? 'This proposal has not been submitted yet, so there is nothing to decide.'
            : 'The submitter withdrew this proposal. Decisions no longer apply.'}
        </p>
      </Card>
    )
  }

  return (
    <>
      <Card
        variant="flat"
        title="Decision"
        subtitle={
          released
            ? 'Released. The submitter has already been told — a change from here is a correction, and it is emailed as one.'
            : 'Staged decisions stay inside this event until you release them.'
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {problem !== null ? <Callout tone="blocked">{problem}</Callout> : null}
          {released ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <Field
                label="Correction note"
                htmlFor="correct-note"
                hint={`Recorded in the audit trail and sent with the corrected ${correctTo === 'accepted' ? 'acceptance' : 'decline'}.`}
              >
                <Textarea
                  id="correct-note"
                  rows={3}
                  value={note}
                  placeholder="We reopened the shortlist after a withdrawal."
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
              <div>
                <Button
                  variant="danger"
                  disabled={busy !== null || note.trim() === ''}
                  onClick={() => setConfirming('correct')}
                >
                  Correct to {correctTo === 'accepted' ? 'Accepted' : 'Declined'}
                </Button>
              </div>
            </div>
          ) : (
            <div
              style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}
            >
              <Button
                size="sm"
                disabled={busy !== null || proposal.status === 'acceptQueue'}
                onClick={() => move('acceptQueue', 'moved to the accept queue')}
              >
                {busy === 'acceptQueue' ? 'Moving…' : 'Accept queue'}
              </Button>
              <Button
                size="sm"
                disabled={busy !== null || proposal.status === 'declineQueue'}
                onClick={() => move('declineQueue', 'moved to the decline queue')}
              >
                {busy === 'declineQueue' ? 'Moving…' : 'Decline queue'}
              </Button>
              <Button
                size="sm"
                disabled={busy !== null || proposal.status === 'pending'}
                onClick={() => move('pending', 'moved back to Submitted')}
              >
                {busy === 'pending' ? 'Moving…' : 'Back to Submitted'}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy !== null || !isStaged(proposal.status)}
                onClick={() => setConfirming('release')}
              >
                Release this decision
              </Button>
            </div>
          )}
        </div>
      </Card>

      {confirming === 'release' ? (
        <Modal
          title="Release this decision?"
          description={
            proposal.status === 'acceptQueue'
              ? 'The proposal becomes a session and its speakers are emailed an invitation. This is the moment the submitter finds out.'
              : 'The submitter is emailed the decline. This is the moment they find out.'
          }
          width={480}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button onClick={() => setConfirming(null)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={busy !== null}
                onClick={() => {
                  setConfirming(null)
                  setBusy('release')
                  setProblem(null)
                  void release({ eventSlug, proposalIds: [proposal._id] })
                    .then((results) => {
                      const failed = results.find((r) => !r.ok)
                      if (failed === undefined) {
                        pushToast('1 decision released', displayTitle(proposal))
                        onReleased()
                      } else {
                        setProblem(bulkErrorMessage(failed.error))
                      }
                    })
                    .catch((err: unknown) =>
                      setProblem(errorMessage(err, 'The release did not run.')),
                    )
                    .finally(() => setBusy(null))
                }}
              >
                Release decision
              </Button>
            </>
          }
        >
          <p style={{ font: 'var(--type-body)' }}>{displayTitle(proposal)}</p>
        </Modal>
      ) : null}

      {confirming === 'correct' ? (
        <Modal
          title={`Correct to ${correctTo === 'accepted' ? 'Accepted' : 'Declined'}?`}
          description={
            correctTo === 'accepted'
              ? 'The submitter was already told this was declined. Correcting it creates the session and emails them the acceptance.'
              : 'The submitter was already told this was accepted. Correcting it cancels the session and emails them the decline.'
          }
          width={480}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button onClick={() => setConfirming(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={busy !== null}
                onClick={() => {
                  setConfirming(null)
                  setBusy('correct')
                  setProblem(null)
                  void correct({
                    eventSlug,
                    proposalId: proposal._id,
                    to: correctTo,
                    note: note.trim(),
                  })
                    .then(() => {
                      pushToast('Decision corrected', displayTitle(proposal))
                      setNote('')
                    })
                    .catch((err: unknown) =>
                      setProblem(
                        errorMessage(err, 'The correction did not run.'),
                      ),
                    )
                    .finally(() => setBusy(null))
                }}
              >
                Correct decision
              </Button>
            </>
          }
        >
          <p style={{ font: 'var(--type-body)', whiteSpace: 'pre-wrap' }}>
            {note.trim()}
          </p>
        </Modal>
      ) : null}
    </>
  )
}

// ── Reviews ──────────────────────────────────────────────────────────────

const REVIEW_STATUS_LABEL: Record<string, string> = {
  assigned: 'Awaiting Review',
  draft: 'Draft',
  submitted: 'Complete',
  locked: 'Complete',
  conflict: 'Conflict',
}

function ReviewPanel({
  eventSlug,
  proposalId,
  timezone,
}: {
  eventSlug: string
  proposalId: Id<'proposals'>
  timezone: string
}) {
  const summary = useQuery(api.reviews.summary, { eventSlug, proposalId })

  if (summary === undefined) {
    return (
      <Card variant="flat" title="Reviews">
        <p style={{ color: 'var(--text-tertiary)' }}>Reading reviews…</p>
      </Card>
    )
  }

  const { aggregate } = summary
  const recommendation = `${aggregate.recommendations.accept} accept · ${aggregate.recommendations.decline} decline · ${aggregate.recommendations.neutral} neutral`
  const conflicts =
    aggregate.conflictCount === 0
      ? ''
      : ` · ${aggregate.conflictCount} conflict${aggregate.conflictCount === 1 ? '' : 's'} excluded`

  return (
    <Card
      variant="flat"
      title="Reviews"
      subtitle={
        aggregate.count === 0 && aggregate.conflictCount === 0
          ? 'Nobody is assigned to this proposal yet.'
          : `${aggregate.submittedCount}/${aggregate.count} submitted${aggregate.avgScore === null ? '' : ` · avg ${aggregate.avgScore.toFixed(1)}`} · ${recommendation}${conflicts}`
      }
    >
      {summary.reviews.length === 0 ? (
        <p style={{ color: 'var(--text-tertiary)' }}>
          Assign reviewers from the table to start collecting scores.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          {summary.reviews.map((review) => (
            <li
              key={review.reviewId}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
                paddingBottom: 'var(--space-3)',
                borderBottom: 'var(--space-px) solid var(--border-subtle)',
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  flexWrap: 'wrap',
                }}
              >
                <strong>{review.reviewerName ?? review.reviewerEmail ?? 'Reviewer'}</strong>
                <StatusPill
                  status={REVIEW_STATUS_LABEL[review.status] ?? review.status}
                />
                <Tag>{review.roundName}</Tag>
                {review.weightedScore !== undefined ? (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Weighted {review.weightedScore.toFixed(2)}
                  </span>
                ) : review.score !== undefined ? (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {review.score.toFixed(1)}
                  </span>
                ) : null}
                {review.recommendation !== undefined ? (
                  <Badge
                    tone={
                      review.recommendation === 'accept'
                        ? 'success'
                        : review.recommendation === 'decline'
                          ? 'blocked'
                          : 'neutral'
                    }
                  >
                    {review.recommendation}
                  </Badge>
                ) : null}
                {review.submittedAt !== undefined ? (
                  <span style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
                    {formatDateTime(review.submittedAt, timezone)}
                  </span>
                ) : null}
              </span>
              <ReviewBody review={review} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

type ReviewRow = FunctionReturnType<
  typeof api.reviews.summary
>['reviews'][number]

/** One review's content: scorecard answers when the review carries them,
 * the legacy comments column otherwise, and conflicts called out as such. */
function ReviewBody({ review }: { review: ReviewRow }) {
  if (review.status === 'conflict') {
    return (
      <span style={{ color: 'var(--text-danger)' }}>
        <strong>Conflict declared</strong>
        {review.conflictNote !== undefined && review.conflictNote !== '' ? (
          <span style={{ whiteSpace: 'pre-wrap' }}>
            {' — '}
            {review.conflictNote}
          </span>
        ) : null}
      </span>
    )
  }

  if (review.answers === undefined) {
    // Legacy review row — comments is the only body it ever had.
    return review.comments !== undefined && review.comments !== '' ? (
      <span style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
        {review.comments}
      </span>
    ) : null
  }

  const answered = review.scorecard.filter((field) => {
    const value = review.answers?.[field.id]
    return value !== undefined && value !== ''
  })
  if (answered.length === 0) return null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
      }}
    >
      {answered.map((field) => {
        const value = review.answers?.[field.id]
        return (
          <span key={field.id} style={{ color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--text-tertiary)' }}>
              {field.label}:
            </span>{' '}
            {typeof value === 'number' ? (
              <span style={{ fontFamily: 'var(--font-mono)' }}>{value}</span>
            ) : (
              <span style={{ whiteSpace: 'pre-wrap' }}>{value}</span>
            )}
          </span>
        )
      })}
    </div>
  )
}

// ── Answers & speakers ───────────────────────────────────────────────────

function AnswersPanel({
  answers,
  def,
  fileUrls,
}: {
  answers: Record<string, AnswerValue>
  def: FormDef | null
  fileUrls: Record<string, string | null>
}) {
  const items = useMemo(
    () => answerItems(answers, def, fileUrls),
    [answers, def, fileUrls],
  )
  return (
    <Card variant="flat" title="Answers">
      {items.length === 0 ? (
        <p style={{ color: 'var(--text-tertiary)' }}>
          No answers have been entered yet.
        </p>
      ) : (
        <DescriptionList items={items} stacked />
      )}
    </Card>
  )
}

/** Answers in form order, with anything no longer on the form listed after. */
function answerItems(
  answers: Record<string, AnswerValue>,
  def: FormDef | null,
  fileUrls: Record<string, string | null>,
): Array<{ term: React.ReactNode; value: React.ReactNode }> {
  const ordered: Array<{ term: React.ReactNode; value: React.ReactNode }> = []
  const used = new Set<string>()
  for (const section of def?.sections ?? []) {
    for (const field of section.fields) {
      if (!(field.id in answers)) continue
      used.add(field.id)
      ordered.push({
        term: field.label.trim() === '' ? field.id : field.label,
        value: renderAnswer(answers[field.id], field.kind === 'file', fileUrls),
      })
    }
  }
  for (const [key, value] of Object.entries(answers)) {
    if (used.has(key)) continue
    ordered.push({ term: key, value: renderAnswer(value, false, fileUrls) })
  }
  return ordered
}

function renderAnswer(
  value: AnswerValue,
  isFile: boolean,
  fileUrls: Record<string, string | null>,
): React.ReactNode {
  if (value === null || value === '') return <Dash />
  if (Array.isArray(value)) {
    return value.length === 0 ? <Dash /> : value.join(', ')
  }
  if (isFile) {
    const url = fileUrls[String(value)]
    if (typeof url !== 'string') {
      return (
        <span style={{ color: 'var(--text-tertiary)' }}>
          Attached file (link expired)
        </span>
      )
    }
    return (
      <a href={url} download style={{ color: 'var(--text-link)' }}>
        Download attachment
      </a>
    )
  }
  return <span style={{ whiteSpace: 'pre-wrap' }}>{String(value)}</span>
}

function Dash() {
  return <span style={{ color: 'var(--text-tertiary)' }}>—</span>
}

function SpeakersPanel({
  speakers,
}: {
  speakers: Array<Doc<'proposalSpeakers'>>
}) {
  return (
    <Card variant="flat" title="Speakers">
      {speakers.length === 0 ? (
        <p style={{ color: 'var(--text-tertiary)' }}>
          No speakers were entered on this proposal.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          {speakers.map((speaker) => (
            <li
              key={speaker._id}
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-half)' }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  flexWrap: 'wrap',
                }}
              >
                <strong>{`${speaker.firstName} ${speaker.lastName}`.trim()}</strong>
                {speaker.isPrimary ? <Badge tone="info">Primary</Badge> : null}
                {speaker.role !== undefined && speaker.role !== '' ? (
                  <Tag>{speaker.role}</Tag>
                ) : null}
              </span>
              {speaker.email !== undefined ? (
                <span style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
                  {speaker.email}
                </span>
              ) : null}
              {speaker.tagline !== undefined ? (
                <span style={{ color: 'var(--text-secondary)' }}>{speaker.tagline}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ── Reopen editing ───────────────────────────────────────────────────────

function ReopenPanel({
  eventSlug,
  event,
  proposal,
}: {
  eventSlug: string
  event: Doc<'events'>
  proposal: Doc<'proposals'>
}) {
  const reopen = useMutation(api.cfp.reopenProposal)
  const { pending, error, setError, run } = usePending()
  const [until, setUntil] = useState(
    toInputValue(proposal.reopenedUntil ?? Date.now() + A_WEEK, event.timezone),
  )

  const closed = event.cfpCloseAt !== undefined && event.cfpCloseAt < Date.now()

  const submit = () => {
    const at = fromInputValue(until, event.timezone)
    if (at === null) return setError('Set the date the window closes again.')
    if (at < Date.now()) return setError('That moment has already passed.')
    void run(async () => {
      await reopen({ eventSlug, proposalId: proposal._id, until: at })
      pushToast(
        'Editing reopened',
        `The submitter can edit until ${formatDateTime(at, event.timezone)}.`,
      )
    })
  }

  return (
    <Card
      variant="flat"
      title="Reopen editing"
      subtitle={
        closed
          ? 'The CFP has closed. Grant this submitter a window to edit their proposal.'
          : 'The CFP is still open — a grant only matters once it closes.'
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {proposal.reopenedUntil !== undefined ? (
          <p style={{ color: 'var(--text-secondary)', font: 'var(--type-caption)' }}>
            Currently editable until{' '}
            {formatDateTime(proposal.reopenedUntil, event.timezone)}.
          </p>
        ) : null}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          <Field
            label="Editable until"
            htmlFor="reopen-until"
            hint={`Stated in ${event.timezone}.`}
          >
            <Input
              id="reopen-until"
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </Field>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Reopening…' : 'Reopen editing'}
          </Button>
        </div>
        {error !== null ? (
          <span style={{ color: 'var(--text-danger)', font: 'var(--type-caption)' }}>
            {error}
          </span>
        ) : null}
      </div>
    </Card>
  )
}
