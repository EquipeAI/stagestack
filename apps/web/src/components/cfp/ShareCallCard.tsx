import { Link } from '@tanstack/react-router'
import type { Doc } from '@convex/_generated/dataModel'
import { Button, Callout, Card, StatusPill } from '~/ds'
import { CopyLinkRow } from '~/components/CopyLinkRow'
import { siteOrigin } from '~/lib/origin'
import { formatDateTime } from '~/lib/datetime'
import { cfpWindowState } from '~/components/cfp/model'
import { useNow } from '~/components/cfp/CfpChrome'

/** The public URL of a call, as an organizer would paste it into an email. */
export function cfpUrl(eventSlug: string, origin: string = siteOrigin()): string {
  return `${origin}/cfp/${eventSlug}`
}

/**
 * Two independent switches gate the public CFP page — the form version
 * (published here in the builder) and `cfpPublished` (Settings) — so the link
 * is only handed over once both are on, and the card names the missing one
 * otherwise. Whoever holds the link is the audience: this is the surface an
 * organizer sends to candidate speakers.
 */
export function ShareCallCard({
  eventSlug,
  event,
  formPublished,
}: {
  eventSlug: string
  event: Doc<'events'>
  formPublished: boolean
}) {
  const now = useNow()
  const live = formPublished && event.cfpPublished
  const url = cfpUrl(eventSlug)
  const zone = event.timezone
  const state = cfpWindowState({
    openAt: event.cfpOpenAt,
    closeAt: event.cfpCloseAt,
    now,
  })

  return (
    <Card
      title="Share the call"
      subtitle="The link candidate speakers open to read the call and submit a proposal."
      actions={<StatusPill status={live ? 'Published' : 'Unpublished'} />}
      footer={
        live ? (
          <a href={url} target="_blank" rel="noreferrer">
            <Button variant="secondary" size="sm" iconRight="external-link">
              Open the public page
            </Button>
          </a>
        ) : undefined
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <CopyLinkRow label="CFP link" value={url} toast="CFP link copied" />
        {live ? (
          <p
            style={{
              margin: 'var(--space-0)',
              color: 'var(--text-tertiary)',
              font: 'var(--type-caption)',
            }}
          >
            {state === 'open'
              ? event.cfpCloseAt === undefined
                ? 'The page is reachable and accepting submissions — no closing date is set.'
                : `The page is reachable and accepting submissions until ${formatDateTime(event.cfpCloseAt, zone)}.`
              : state === 'before'
                ? `The page is reachable. Submissions open ${formatDateTime(event.cfpOpenAt ?? 0, zone)} — until then the submit button is off.`
                : `The call closed ${formatDateTime(event.cfpCloseAt ?? 0, zone)}. The page still loads, with the submit button off.`}
          </p>
        ) : (
          <Callout
            tone="attention"
            title="The link is not live yet"
            actions={
              event.cfpPublished ? undefined : (
                <Link to="/app/e/$eventSlug/settings" params={{ eventSlug }}>
                  <Button size="sm">Open settings</Button>
                </Link>
              )
            }
          >
            {!formPublished && !event.cfpPublished
              ? 'Publish the form, then switch "CFP published" on in Settings. Anyone opening the link before that is told the call is not open.'
              : !formPublished
                ? 'Publish the form so submitters have a version to answer. Until then the link says the call is not open.'
                : 'Switch "CFP published" on in Settings to make the page reachable.'}
          </Callout>
        )}
      </div>
    </Card>
  )
}
