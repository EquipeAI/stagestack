import { useEffect, useRef, useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { REVIEW_STATUS_LABEL } from './model'
import { Segmented } from './Segmented'
import type { Assignment, ReviewAnswers, ScorecardField } from './model'
import {
  Button,
  Callout,
  Card,
  Field,
  Select,
  StatusPill,
  Textarea,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { saveStatusLabel, useAutosave } from '~/components/cfp/useAutosave'
import { SaveIndicator } from '~/components/cfp/CfpChrome'

// The review itself: the round's scorecard rendered dynamically (numeric
// steppers, dropdowns, text), one commit button. The panel is mounted with
// the review id as its key, so its state always starts from what the server
// holds for the proposal on screen.
//
// Speed is still the point (M2: "Submit & Next"). Drafts autosave, and when
// the scorecard has a single numeric criterion the 1–9 keys set it;
// Cmd/Ctrl+Enter commits.

function numericOptions(field: ScorecardField): number[] {
  const min = field.min ?? 1
  const max = field.max ?? 5
  const out: number[] = []
  for (let value = min; value <= max && out.length <= 20; value += 1) {
    out.push(value)
  }
  return out
}

export function ReviewPanel({
  eventSlug,
  assignment,
  archived,
  isLastUnfinished,
  onCommitted,
}: {
  eventSlug: string
  assignment: Assignment
  archived: boolean
  /** Nothing else is waiting, so the button says what it does. */
  isLastUnfinished: boolean
  onCommitted: (result: { revised: boolean }) => void
}) {
  const saveDraft = useMutation(api.reviews.saveDraft)
  const submitReview = useMutation(api.reviews.submit)
  const declareConflict = useMutation(api.reviews.declareConflict)
  const commit = usePending()
  const conflictAction = usePending()

  const scorecard = assignment.round.scorecard
  const [answers, setAnswers] = useState<ReviewAnswers>(assignment.answers)
  const [confirmConflict, setConfirmConflict] = useState(false)

  const locked = assignment.status === 'locked'
  const submitted = assignment.status === 'submitted'
  const conflicted = assignment.status === 'conflict'
  const readOnly = locked || archived || conflicted
  // The backend refuses a draft write on a submitted review — it is revised by
  // submitting again — so autosave only runs while the review is unfinished.
  const autosaveOn = !readOnly && !submitted

  // A queued draft must not land after the review is submitted.
  const committed = useRef(false)
  const autosave = useAutosave<ReviewAnswers>(async (value) => {
    if (committed.current) return
    await saveDraft({ eventSlug, reviewId: assignment.reviewId, answers: value })
  })

  const applyAnswer = (fieldId: string, value: number | string) => {
    if (readOnly) return
    const next = { ...answers, [fieldId]: value }
    setAnswers(next)
    if (autosaveOn) autosave.schedule(next)
  }

  const missing = scorecard.filter(
    (field) =>
      field.required === true &&
      (answers[field.id] === undefined || answers[field.id] === ''),
  )
  const ready = missing.length === 0

  const doCommit = () => {
    if (readOnly || commit.pending) return
    if (!ready) {
      commit.setError(
        `Still needed: ${missing.map((f) => `"${f.label}"`).join(', ')}.`,
      )
      return
    }
    committed.current = true
    void commit
      .run(async () => {
        await submitReview({
          eventSlug,
          reviewId: assignment.reviewId,
          answers,
        })
        pushToast(
          submitted ? 'Review updated' : 'Review submitted',
          assignment.proposal.title,
        )
        // Revising a review you opened on purpose keeps you on it; finishing a
        // new one moves to the next thing waiting.
        onCommitted({ revised: submitted })
      })
      .then((ok) => {
        // The write was refused (archived event, locked round): let autosave
        // keep the draft alive.
        if (!ok) committed.current = false
      })
  }

  const doDeclareConflict = () => {
    void conflictAction.run(async () => {
      await declareConflict({ eventSlug, reviewId: assignment.reviewId })
      setConfirmConflict(false)
      pushToast('Conflict declared', assignment.proposal.title)
    })
  }

  // Keyboard: when exactly one numeric criterion exists, digits set it.
  const soloNumeric =
    scorecard.filter((f) => f.kind === 'numeric').length === 1
      ? scorecard.find((f) => f.kind === 'numeric')
      : undefined
  const latest = useRef({ applyAnswer, doCommit, readOnly, soloNumeric })
  latest.current = { applyAnswer, doCommit, readOnly, soloNumeric }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const now = latest.current
      if (now.readOnly) return
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        now.doCommit()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName.toLowerCase()
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        target?.isContentEditable === true
      ) {
        return
      }
      if (now.soloNumeric !== undefined && /^[1-9]$/.test(event.key)) {
        const value = Number(event.key)
        const min = now.soloNumeric.min ?? 1
        const max = now.soloNumeric.max ?? 5
        if (value >= min && value <= max) {
          event.preventDefault()
          now.applyAnswer(now.soloNumeric.id, value)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const commitLabel = submitted
    ? 'Update review'
    : isLastUnfinished
      ? 'Submit review'
      : 'Submit & Next'

  return (
    <Card
      title="Your review"
      subtitle={
        submitted
          ? 'Submitted reviews stay revisable until the round closes.'
          : `${assignment.round.name} · only you see your answers until you submit.`
      }
      actions={<StatusPill status={REVIEW_STATUS_LABEL[assignment.status]} />}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)',
        }}
      >
        {conflicted ? (
          <Callout tone="attention" title="You declared a conflict of interest">
            This item is out of your queue. An organizer will reassign it.
          </Callout>
        ) : null}
        {locked ? (
          <Callout tone="neutral" title="This review is locked">
            The round is closed. Ask an organizer to reopen it if something
            needs to change.
          </Callout>
        ) : null}
        {archived && !locked ? (
          <Callout tone="attention" title="This event is archived">
            Archived events stop accepting work, so reviews can no longer be
            changed.
          </Callout>
        ) : null}
        {commit.error !== null ? (
          <Callout tone="blocked" title="This review was not submitted">
            {commit.error}
          </Callout>
        ) : null}
        {conflictAction.error !== null ? (
          <Callout tone="blocked" title="Conflict was not recorded">
            {conflictAction.error}
          </Callout>
        ) : null}
        {autosave.error !== null ? (
          <Callout tone="blocked" title="Your last change was not saved">
            {autosave.error}
          </Callout>
        ) : null}

        {scorecard.map((field) => {
          const value = answers[field.id]
          if (field.kind === 'numeric') {
            const options = numericOptions(field)
            return (
              <Field key={field.id} label={field.label} required={field.required}>
                <div>
                  <Segmented
                    name={field.label}
                    value={typeof value === 'number' ? String(value) : null}
                    disabled={readOnly}
                    options={options.map((n) => ({
                      value: String(n),
                      label: String(n),
                      hint:
                        n === options[0]
                          ? 'weak'
                          : n === options[options.length - 1]
                            ? 'strong'
                            : undefined,
                    }))}
                    onChange={(next) => {
                      applyAnswer(field.id, Number(next))
                    }}
                  />
                </div>
              </Field>
            )
          }
          if (field.kind === 'dropdown') {
            return (
              <Field key={field.id} label={field.label} required={field.required}>
                <Select
                  value={typeof value === 'string' ? value : ''}
                  disabled={readOnly}
                  onChange={(e) => {
                    applyAnswer(field.id, e.target.value)
                  }}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          }
          return (
            <Field
              key={field.id}
              label={field.label}
              htmlFor={`review-${field.id}`}
              optional={field.required !== true}
              hint={
                submitted && field.id === scorecard[scorecard.length - 1]?.id
                  ? 'Changes to a submitted review are saved when you update it.'
                  : undefined
              }
            >
              <Textarea
                id={`review-${field.id}`}
                rows={5}
                value={typeof value === 'string' ? value : ''}
                disabled={readOnly}
                placeholder="What would help the organizers decide?"
                onChange={(e) => {
                  applyAnswer(field.id, e.target.value)
                }}
              />
            </Field>
          )
        })}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          <SaveIndicator
            label={autosaveOn ? saveStatusLabel(autosave.status) : null}
            tone={autosave.status === 'error' ? 'danger' : 'muted'}
          />
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            {!readOnly && !submitted ? (
              confirmConflict ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      setConfirmConflict(false)
                    }}
                  >
                    Keep reviewing
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={conflictAction.pending}
                    onClick={doDeclareConflict}
                  >
                    {conflictAction.pending
                      ? 'Recording…'
                      : 'Confirm conflict — remove from my queue'}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirmConflict(true)
                  }}
                >
                  Declare conflict
                </Button>
              )
            ) : null}
            <Button
              variant="primary"
              disabled={readOnly || commit.pending || !ready}
              onClick={doCommit}
            >
              {commit.pending ? 'Submitting…' : commitLabel}
            </Button>
          </div>
        </div>

        {readOnly ? null : (
          <p
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-tertiary)',
              margin: 'var(--space-0)',
            }}
          >
            {soloNumeric !== undefined ? (
              <>
                <kbd>{soloNumeric.min ?? 1}</kbd>–
                <kbd>{soloNumeric.max ?? 5}</kbd> {soloNumeric.label.toLowerCase()}{' '}
                ·{' '}
              </>
            ) : null}
            <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd>{' '}
            {commitLabel.toLowerCase()}
          </p>
        )}
      </div>
    </Card>
  )
}
