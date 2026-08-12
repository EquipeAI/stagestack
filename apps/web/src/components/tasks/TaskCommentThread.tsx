import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Id } from '@convex/_generated/dataModel'
import { Button, Callout, Textarea } from '~/ds'
import { usePending } from '~/lib/usePending'
import { formatDateTime } from '~/lib/datetime'

// One comment thread per file task (CNT-05), shared verbatim between the
// organizer app and the speaker portal: both sides read the same rows, so the
// component only switches which public surface it talks to. Threads exist for
// file-evidence tasks only — the callers enforce that by where they mount it.

export function TaskCommentThread({
  eventSlug,
  instanceId,
  source,
  timezone,
}: {
  eventSlug: string
  instanceId: Id<'taskInstances'>
  source: 'organizer' | 'portal'
  timezone: string
}) {
  const organizerComments = useQuery(
    api.tasks.taskComments,
    source === 'organizer' ? { eventSlug, instanceId } : 'skip',
  )
  const portalComments = useQuery(
    api.portal.taskComments,
    source === 'portal' ? { eventSlug, instanceId } : 'skip',
  )
  const comments = source === 'organizer' ? organizerComments : portalComments

  const organizerComment = useMutation(api.tasks.commentOnTask)
  const portalComment = useMutation(api.portal.commentOnTask)
  const send = source === 'organizer' ? organizerComment : portalComment

  const { pending, error, setError, run } = usePending()
  const [body, setBody] = useState('')

  const submit = () => {
    if (body.trim() === '') {
      return setError('Write the comment first.')
    }
    void run(async () => {
      await send({ eventSlug, instanceId, body: body.trim() })
      setBody('')
    })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <span
        style={{
          font: 'var(--type-caption)',
          fontWeight: 'var(--weight-medium)',
          color: 'var(--text-secondary)',
        }}
      >
        Comments
      </span>

      {comments === undefined ? (
        <p
          style={{
            margin: 'var(--space-0)',
            font: 'var(--type-caption)',
            color: 'var(--text-tertiary)',
          }}
        >
          Loading comments…
        </p>
      ) : comments.length === 0 ? (
        <p
          style={{
            margin: 'var(--space-0)',
            font: 'var(--type-caption)',
            color: 'var(--text-tertiary)',
          }}
        >
          No comments yet. Anything written here is visible to both the
          organizers and the speaker.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 'var(--space-0)',
            padding: 'var(--space-0)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          {comments.map((comment) => (
            <li
              key={comment.commentId}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
              }}
            >
              <span
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'baseline',
                  gap: 'var(--space-2)',
                  font: 'var(--type-caption)',
                  color: 'var(--text-tertiary)',
                }}
              >
                <span
                  style={{
                    fontWeight: 'var(--weight-medium)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {comment.authorName ?? comment.authorEmail ?? 'Someone'}
                  {comment.mine ? ' (you)' : ''}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatDateTime(comment.createdAt, timezone)}
                </span>
              </span>
              <p
                style={{
                  margin: 'var(--space-0)',
                  font: 'var(--type-body)',
                  color: 'var(--text-primary)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {comment.body}
              </p>
            </li>
          ))}
        </ul>
      )}

      {error === null ? null : <Callout tone="blocked">{error}</Callout>}

      <Textarea
        id={`task-comment-${instanceId}`}
        // No visible label: the "Comments" span above heads the whole thread,
        // not this box, and a second label under it would read as a repeat.
        aria-label="Comment"
        rows={2}
        value={body}
        disabled={pending}
        placeholder="Write a comment about this file…"
        onChange={(e) => {
          setBody(e.target.value)
        }}
      />
      <div>
        <Button size="sm" disabled={pending} onClick={submit}>
          {pending ? 'Posting…' : 'Post comment'}
        </Button>
      </div>
    </div>
  )
}
