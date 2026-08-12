import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import type { Round } from './launchFlow'
import { Field, Select, Tag } from '~/ds'
import { usePending } from '~/lib/usePending'

// The round's reviewer pool. One editor, used by the plan's round card and by
// the launch flow's Reviewers step — the pool is the source of truth for
// auto-distribution and for the progress board, so there is one way to edit it.

type TeamMember = FunctionReturnType<
  typeof api.team.listForEvent
>['members'][number]

export function PoolEditor({
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
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        {round.pool.length === 0 ? (
          <p
            style={{
              color: 'var(--text-tertiary)',
              font: 'var(--type-caption)',
            }}
          >
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
