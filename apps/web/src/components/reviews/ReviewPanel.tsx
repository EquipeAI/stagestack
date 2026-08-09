import { useEffect, useRef, useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import {
  RECOMMENDATIONS,
  RECOMMENDATION_LABEL,
  REVIEW_STATUS_LABEL,
  SCORES,
} from './model'
import { Segmented } from './Segmented'
import type { Assignment, Recommendation } from './model'
import { Button, Callout, Card, Field, StatusPill, Textarea } from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { saveStatusLabel, useAutosave } from '~/components/cfp/useAutosave'
import { SaveIndicator } from '~/components/cfp/CfpChrome'

// The review itself: score, recommendation, comments, one commit button. The
// panel is mounted with the review id as its key, so its state always starts
// from what the server holds for the proposal on screen.
//
// Speed is the point (M2: "Submit & Next"). Drafts autosave, the whole panel
// is reachable from the keyboard — 1–5 sets the score, A/N/D the
// recommendation, Cmd/Ctrl+Enter commits — and committing moves on by itself.

type Draft = {
  score?: number
  recommendation?: Recommendation
  comments?: string
}

const RECOMMENDATION_KEY: Record<string, Recommendation | undefined> = {
  a: 'accept',
  n: 'neutral',
  d: 'decline',
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
  const commit = usePending()

  const [score, setScore] = useState<number | null>(assignment.score ?? null)
  const [recommendation, setRecommendation] = useState<Recommendation | null>(
    assignment.recommendation ?? null,
  )
  const [comments, setComments] = useState(assignment.comments ?? '')

  const locked = assignment.status === 'locked'
  const submitted = assignment.status === 'submitted'
  const readOnly = locked || archived
  // The backend refuses a draft write on a submitted review — it is revised by
  // submitting again — so autosave only runs while the review is unfinished.
  const autosaveOn = !readOnly && !submitted

  // A queued draft must not land after the review is submitted.
  const committed = useRef(false)
  const autosave = useAutosave<Draft>(async (value) => {
    if (committed.current) return
    await saveDraft({ eventSlug, reviewId: assignment.reviewId, ...value })
  })

  const queue = (next: Draft) => {
    if (!autosaveOn) return
    autosave.schedule({
      score: next.score,
      recommendation: next.recommendation,
      comments: next.comments,
    })
  }

  const applyScore = (value: number) => {
    if (readOnly) return
    setScore(value)
    queue({
      score: value,
      recommendation: recommendation ?? undefined,
      comments,
    })
  }

  const applyRecommendation = (value: Recommendation) => {
    if (readOnly) return
    setRecommendation(value)
    queue({
      score: score ?? undefined,
      recommendation: value,
      comments,
    })
  }

  const applyComments = (value: string) => {
    if (readOnly) return
    setComments(value)
    queue({
      score: score ?? undefined,
      recommendation: recommendation ?? undefined,
      comments: value,
    })
  }

  const ready = score !== null && recommendation !== null
  const doCommit = () => {
    if (readOnly || commit.pending) return
    if (!ready) {
      commit.setError('A score and a recommendation are required to submit.')
      return
    }
    committed.current = true
    void commit
      .run(async () => {
        await submitReview({
          eventSlug,
          reviewId: assignment.reviewId,
          score,
          recommendation,
          comments,
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

  // The shortcuts read the current render's handlers rather than closing over
  // the first ones; one window listener is cheaper than focus plumbing.
  const latest = useRef({ applyScore, applyRecommendation, doCommit, readOnly })
  latest.current = { applyScore, applyRecommendation, doCommit, readOnly }

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
      if (/^[1-5]$/.test(event.key)) {
        event.preventDefault()
        now.applyScore(Number(event.key))
        return
      }
      const mapped = RECOMMENDATION_KEY[event.key.toLowerCase()]
      if (mapped !== undefined) {
        event.preventDefault()
        now.applyRecommendation(mapped)
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
          : 'Only you see your score and comments until you submit.'
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
        {autosave.error !== null ? (
          <Callout tone="blocked" title="Your last change was not saved">
            {autosave.error}
          </Callout>
        ) : null}

        <Field label="Score" required>
          <div>
            <Segmented
              name="Score"
              value={score === null ? null : String(score)}
              disabled={readOnly}
              options={SCORES.map((value) => ({
                value: String(value),
                label: String(value),
                hint:
                  value === 1
                    ? 'weak'
                    : value === SCORES.length
                      ? 'strong'
                      : undefined,
              }))}
              onChange={(value) => {
                applyScore(Number(value))
              }}
            />
          </div>
        </Field>

        <Field label="Recommendation" required>
          <div>
            <Segmented
              name="Recommendation"
              value={recommendation}
              disabled={readOnly}
              options={RECOMMENDATIONS.map((value) => ({
                value,
                label: RECOMMENDATION_LABEL[value],
              }))}
              onChange={(value) => {
                applyRecommendation(value as Recommendation)
              }}
            />
          </div>
        </Field>

        <Field
          label="Comments"
          htmlFor="review-comments"
          optional
          hint={
            submitted
              ? 'Changes to a submitted review are saved when you update it.'
              : undefined
          }
        >
          <Textarea
            id="review-comments"
            rows={5}
            value={comments}
            disabled={readOnly}
            placeholder="What would help the organizers decide?"
            onChange={(e) => {
              applyComments(e.target.value)
            }}
          />
        </Field>

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
          <Button
            variant="primary"
            disabled={readOnly || commit.pending || !ready}
            onClick={doCommit}
          >
            {commit.pending ? 'Submitting…' : commitLabel}
          </Button>
        </div>

        {readOnly ? null : (
          <p
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-tertiary)',
              margin: 'var(--space-0)',
            }}
          >
            <kbd>1</kbd>–<kbd>5</kbd> score · <kbd>A</kbd> <kbd>N</kbd>{' '}
            <kbd>D</kbd> recommendation · <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> +{' '}
            <kbd>Enter</kbd> {commitLabel.toLowerCase()}
          </p>
        )}
      </div>
    </Card>
  )
}
