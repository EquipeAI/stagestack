import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { DiffPreview } from './DiffPreview'
import { ChannelBlockers } from './ChannelBlockers'
import type { ChannelDiff, ChannelId, PublicationRow } from './model'
import {
  ActionResult,
  Badge,
  Button,
  Card,
  Dialog,
  StatusPill,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { errorMessage } from '~/lib/errors'

// One channel, one decision (W10).
//
// The lineup and the schedule publish independently (decision log #13), and
// this card is that independence made visible: its own state sentence, its own
// blockers, its own diff, its own publish and unpublish. Nothing on it is
// derived here — the sentence comes from the control center's producer
// (`readiness.upNext`), the blockers from W4, the diff and the eligibility
// arithmetic from the model functions the mutation itself enforces.
//
// The confirmation is a Dialog, which is already a bottom sheet below 640px
// (ds/components/feedback/feedback.css), so the phone case needs no second
// component.

type Result = {
  status: 'success' | 'failed'
  title: string
  lines: Array<string>
  retry: () => void
}

export function ChannelCard({
  eventSlug,
  channel,
  label,
  subtitle,
  published,
  stateSentence,
  version,
  stale,
  diff,
  rows,
  children,
}: {
  eventSlug: string
  channel: ChannelId
  label: string
  subtitle: string
  published: boolean
  /** Composed by convex/model/controlCenter.ts — attribution included. */
  stateSentence: string
  version: number | null
  stale: boolean
  diff: ChannelDiff
  rows: Array<PublicationRow>
  /** The per-entry toggles for this channel. */
  children: React.ReactNode
}) {
  const bulkPublish = useMutation(api.publish.bulkPublish)
  const setLineup = useMutation(api.publish.setLineup)
  const setAgenda = useMutation(api.publish.setAgenda)
  // Silent: the ActionResult below is already a polite live region.
  const action = usePending({ announce: false })
  const [result, setResult] = useState<Result | null>(null)
  const [confirming, setConfirming] = useState<'publish' | 'unpublish' | null>(
    null,
  )
  // Subscribed only while the confirmation is open (the W1 send-panel
  // pattern). The arithmetic is a whole-event scan per channel, and this page
  // is not where an organizer sits — paying for two of them on every render of
  // every visit, to fill a dialog that is usually never opened, is a cost with
  // no reader. The dialog shows a loading line rather than stale numbers.
  const plan = useQuery(
    api.publish.bulkPlan,
    confirming === 'publish' ? { eventSlug, channel } : 'skip',
  )

  const name = channel === 'lineup' ? 'the lineup' : 'the schedule'
  // Without the article, for the disclosure labels ("Show the lineup changes").
  const bare = channel === 'lineup' ? 'lineup' : 'schedule'

  const publish = () => {
    setConfirming(null)
    setResult(null)
    void action.run(async () => {
      try {
        const outcome = await bulkPublish({ eventSlug, channel })
        setResult({
          status: 'success',
          title: outcome.title,
          lines: outcome.lines,
          retry: publish,
        })
      } catch (error) {
        setResult({
          status: 'failed',
          title: `Publishing ${name} failed`,
          lines: [
            'Nothing changed for the public page.',
            // Carries the 1MiB guard's own refusal (`program_too_large`),
            // which names the largest sessions — the fix is in the sentence.
            errorMessage(error, 'The call did not run.'),
          ],
          retry: publish,
        })
        throw error
      }
    })
  }

  const unpublish = () => {
    setConfirming(null)
    setResult(null)
    void action.run(async () => {
      try {
        if (channel === 'lineup') {
          await setLineup({ eventSlug, enabled: false })
        } else {
          await setAgenda({ eventSlug, enabled: false })
        }
        setResult({
          status: 'success',
          title: `${label} unpublished`,
          lines: [
            diff.unpublishSentence,
            'The public page, the read API and every embed serve the same projection, so all three stop together.',
          ],
          retry: unpublish,
        })
      } catch (error) {
        setResult({
          status: 'failed',
          title: `Unpublishing ${name} failed`,
          lines: [
            'Nothing changed for the public page.',
            errorMessage(error, 'The call did not run.'),
          ],
          retry: unpublish,
        })
        throw error
      }
    })
  }

  return (
    <Card
      title={label}
      subtitle={subtitle}
      actions={
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          <StatusPill status={published ? 'Published' : 'Unpublished'} />
          {version === null ? (
            <Badge tone="neutral">Never published</Badge>
          ) : (
            // One row, one version per event: the served program is a single
            // document covering both channels, so the number is labelled as
            // the PROGRAM's rather than dressed up as a per-channel history.
            <Badge tone="neutral">Program version {version}</Badge>
          )}
        </span>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {/* VERBATIM: the state sentence and its attribution have exactly one
            composer (convex/model/controlCenter.ts), shared with the control
            center's "what happens next" panel. */}
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          {stateSentence}
        </p>

        {result === null ? null : (
          <ActionResult
            status={result.status}
            title={result.title}
            details={result.lines}
            onRetry={result.status === 'failed' ? result.retry : undefined}
            onDismiss={() => setResult(null)}
          />
        )}

        <DiffPreview diff={diff} label={bare} />

        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <Button
            variant="primary"
            iconLeft="globe"
            // Disabled only when the action would do NOTHING. An empty diff
            // on a channel that is still off still turns the channel on, and
            // `doesNothing` (composed in the model) is the fact that knows the
            // difference.
            disabled={action.pending || diff.doesNothing}
            onClick={() => setConfirming('publish')}
          >
            {published ? `Republish ${name}` : `Publish ${name}`}
          </Button>
          {published ? (
            <Button
              variant="secondary"
              disabled={action.pending}
              onClick={() => setConfirming('unpublish')}
            >
              Unpublish
            </Button>
          ) : null}
          {stale && !diff.empty ? (
            <Badge tone="attention">Public copy is behind</Badge>
          ) : null}
        </div>

        <ChannelBlockers eventSlug={eventSlug} channel={channel} rows={rows} />

        {children}
      </div>

      {confirming === 'publish' ? (
        <Dialog
          title={published ? `Republish ${name}?` : `Publish ${name}?`}
          description="Everything currently eligible, in one go. Sessions held back by a blocker are not touched."
          width={560}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button onClick={() => setConfirming(null)}>Cancel</Button>
              <Button
                variant="primary"
                // Never confirm against numbers that have not arrived.
                disabled={action.pending || diff.doesNothing || plan === undefined}
                onClick={publish}
              >
                {published ? 'Republish' : 'Publish'}
              </Button>
            </>
          }
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
            }}
          >
            {/* The arithmetic BEFORE (W5) and the diff, both composed by the
                same model code the mutation runs. */}
            {plan === undefined ? (
              <p style={{ margin: 0, color: 'var(--text-tertiary)' }}>
                Counting what is eligible…
              </p>
            ) : (
              <p style={{ margin: 0 }}>{plan.sentence}</p>
            )}
            <DiffPreview diff={diff} label={bare} />
            {plan === undefined || plan.excluded.length === 0 ? null : (
              <ul style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
                {plan.excluded.map((row) => (
                  <li key={row.sessionId}>
                    {row.title} — {row.sentence}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog>
      ) : null}

      {confirming === 'unpublish' ? (
        <Dialog
          title={`Unpublish ${name}?`}
          description="The per-session toggles are remembered; publishing again restores them."
          width={480}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button onClick={() => setConfirming(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={action.pending}
                onClick={unpublish}
              >
                Unpublish
              </Button>
            </>
          }
        >
          <p style={{ margin: 0 }}>{diff.unpublishSentence}</p>
        </Dialog>
      ) : null}
    </Card>
  )
}
