import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import type { InstanceRow } from '~/components/tasks/model'
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  StatusPill,
  Tag,
} from '~/ds'
import { PARTICIPANT_STATE_LABEL } from '~/lib/labels'
import { formatDateTime } from '~/lib/datetime'
import { WorkspacePanel, WorkspaceShell } from '~/components/workspace/WorkspaceShell'
import {
  SPEAKER_TABS,
  activeWorkspaceTab,
  parseSpeakerWorkspaceSearch,
} from '~/components/workspace/tabs'
import {
  SpeakerProfileFields,
  SpeakerSaveButton,
  useSpeakerProfileForm,
} from '~/components/speakers/SpeakerProfileForm'
import { InstanceActions } from '~/components/tasks/InstanceActions'
import { TaskCommentThread } from '~/components/tasks/TaskCommentThread'
import { UploadVersionList } from '~/components/tasks/UploadVersionList'
import { TASK_STATUS_LABEL, speakerLabel } from '~/components/tasks/model'
import { useNow } from '~/components/tasks/useNow'
import { DeliveryPill } from '~/components/comms/DeliveryLifecycle'
import { messageKindLabel } from '~/components/comms/model'

// The speaker workspace (W9) — one person, everything about them, at a URL.
//
// It is a ROUTE rather than a drawer over the roster. A drawer at 375px is a
// scroll-locked overlay competing with the table underneath, with hand-built
// back-button and focus behaviour; a route is what a phone already does
// (list → full-screen detail → Back) and it gives every other surface
// somewhere to link to.
//
// Composition, not duplication: the profile fields are the promoted
// `SpeakerProfileDialog` body, the tasks come off `tasks.listInstances`, the
// files and comments off the same instances, and the communication history off
// `comms.contactLog`. Only the spine — the snapshot, the participations and
// the profile gaps — needed a query of its own.

export const Route = createFileRoute('/app/e/$eventSlug/speakers/$eventContactId')({
  component: SpeakerWorkspaceRoute,
  validateSearch: parseSpeakerWorkspaceSearch,
})

function SpeakerWorkspaceRoute() {
  const { eventSlug, eventContactId } = Route.useParams()
  const event = useQuery(api.events.get, { eventSlug })
  const isOrganizer = event?.role === 'organizer'

  if (event === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading speaker…</p>
  }
  if (!isOrganizer) {
    return (
      <Callout tone="blocked" title="The speaker roster is organizer-only">
        Reviewers see the proposals assigned to them under Reviews. Ask an
        organizer if you need access to the roster.
      </Callout>
    )
  }
  return (
    <SpeakerWorkspace
      eventSlug={eventSlug}
      eventContactId={eventContactId as Id<'eventContacts'>}
      timezone={event.event.timezone}
      archived={event.event.archivedAt !== undefined}
    />
  )
}

type SpeakerData = FunctionReturnType<typeof api.workspaces.speaker>

/**
 * The loading gate.
 *
 * It exists so the profile form is never MOUNTED against a placeholder. The
 * form seeds its draft from the record once, on mount (that is what makes it
 * an editable draft rather than a field that fights the subscription), so a
 * form mounted while the query was still in flight would hold empty strings
 * for every field — and Save would write those blanks over a real profile.
 * Splitting the component is the fix: no placeholder record exists at all, and
 * the `key` guarantees a remount if the route ever swaps to another speaker
 * without unmounting.
 */
function SpeakerWorkspace({
  eventSlug,
  eventContactId,
  timezone,
  archived,
}: {
  eventSlug: string
  eventContactId: Id<'eventContacts'>
  timezone: string
  archived: boolean
}) {
  const speaker = useQuery(api.workspaces.speaker, { eventSlug, eventContactId })
  const library = useQuery(api.library.list, { eventSlug })

  // Both are gates, not preferences: the custom-field definitions decide which
  // values the form's Save is allowed to send, so mounting before they arrive
  // would seed an empty custom-value draft just as surely as an empty profile.
  if (speaker === undefined || library === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading speaker…</p>
  }

  return (
    <LoadedSpeakerWorkspace
      key={eventContactId}
      eventSlug={eventSlug}
      eventContactId={eventContactId}
      timezone={timezone}
      archived={archived}
      speaker={speaker}
      customFields={library.customFields
        .filter((field) => field.appliesTo === 'speaker')
        .sort((a, b) => a.order - b.order)}
    />
  )
}

function LoadedSpeakerWorkspace({
  eventSlug,
  eventContactId,
  timezone,
  archived,
  speaker,
  customFields,
}: {
  eventSlug: string
  eventContactId: Id<'eventContacts'>
  timezone: string
  archived: boolean
  speaker: SpeakerData
  customFields: FunctionReturnType<typeof api.library.list>['customFields']
}) {
  const navigate = Route.useNavigate()
  const search = Route.useSearch()
  const tab = activeWorkspaceTab(SPEAKER_TABS, search)
  const instances = useQuery(api.tasks.listInstances, { eventSlug })
  const now = useNow()

  // Real values, from the first render: this component does not exist until
  // the record and the field definitions have both arrived.
  const form = useSpeakerProfileForm({
    eventSlug,
    row: speaker,
    customFields,
    archived,
  })

  const name = `${speaker.firstName} ${speaker.lastName}`.trim()
  const title = name === '' ? 'Unnamed contact' : name
  const mine = (instances ?? []).filter(
    (row) => row.eventContactId === eventContactId,
  )
  const withFiles = mine.filter((row) => row.uploadCount > 0)

  return (
    <WorkspaceShell
      title={title}
      description={
        // The tagline is the line the program prints; job title and company
        // are what it falls back to, and an empty join is no description at
        // all rather than an empty one.
        speaker.tagline ??
        ([speaker.jobTitle, speaker.company].filter(Boolean).join(', ') ||
          undefined)
      }
      crumbs={[
        { label: 'Speakers', href: `/app/e/${eventSlug}/speakers` },
        { label: title },
      ]}
      tabs={SPEAKER_TABS}
      activeTab={tab}
      tabsLabel="Speaker workspace"
      onTabChange={(next) => {
        void navigate({
          search: next === SPEAKER_TABS[0].id ? {} : { tab: next as never },
        })
      }}
      primaryAction={tab === 'identity' ? <SpeakerSaveButton form={form} /> : null}
    >
      {tab === 'identity' ? (
        <WorkspacePanel label="Identity and contact details">
          <Card>
            <SpeakerProfileFields form={form} />
          </Card>
        </WorkspacePanel>
      ) : null}

      {tab === 'sessions' ? (
        <WorkspacePanel label="Sessions and participations">
          {speaker.sessions.length === 0 ? (
            <Card>
              <EmptyState
                icon="presentation"
                title="Not on any session yet"
                description="A participation appears here when a proposal they are on is accepted, or when they are invited to a session directly."
              />
            </Card>
          ) : (
            <Card padded={false}>
              {speaker.sessionsTruncated ? (
                <p style={{ padding: 'var(--space-4)', margin: 0, ...caption }}>
                  Showing the most recent {speaker.sessions.length}{' '}
                  participations — this speaker is on more sessions than this
                  list shows. Everything else on this page is complete.
                </p>
              ) : null}
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {speaker.sessions.map((row) => (
                  <li key={row.participantId} style={listRow}>
                    <span style={{ flex: 1, minWidth: '10rem' }}>
                      {/* Each participation is a hop to that session's own
                          workspace — the two record types link both ways. */}
                      <Link
                        to="/app/e/$eventSlug/sessions/$sessionId"
                        params={{ eventSlug, sessionId: row.sessionId }}
                      >
                        {row.title}
                      </Link>
                      {row.format === undefined ? null : (
                        <span style={caption}> · {row.format}</span>
                      )}
                    </span>
                    <StatusPill status={PARTICIPANT_STATE_LABEL[row.state]} />
                    {row.contentStatus === 'draft' ? (
                      <Badge tone="attention">Draft content</Badge>
                    ) : null}
                    {row.released ? (
                      <Badge tone="info">Slot released</Badge>
                    ) : null}
                    {row.status === 'cancelled' ? (
                      <Badge tone="neutral">Cancelled</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </WorkspacePanel>
      ) : null}

      {tab === 'readiness' ? (
        <WorkspacePanel label="Readiness">
          <Card
            title="Profile"
            subtitle="Derived, never stored — every gap names what the public program would print."
          >
            {speaker.readiness.reasons.length === 0 ? (
              <Callout tone="success" title="Nothing is missing">
                Their snapshot has everything the published program needs.
              </Callout>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
                {speaker.readiness.reasons.map((reason) => (
                  <li key={reason} style={{ color: 'var(--text-secondary)' }}>
                    {reason}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card
            title="Tasks"
            subtitle="The counts are the list on the Tasks tab, not a second tally."
          >
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              {instances === undefined
                ? 'Loading tasks…'
                : `${mine.length} task${mine.length === 1 ? '' : 's'} assigned across their sessions.`}
            </p>
          </Card>
        </WorkspacePanel>
      ) : null}

      {tab === 'tasks' ? (
        <WorkspacePanel label="Tasks">
          {instances === undefined ? (
            <p style={{ color: 'var(--text-tertiary)' }}>Loading tasks…</p>
          ) : mine.length === 0 ? (
            <Card>
              <EmptyState
                icon="list-checks"
                title="No tasks for this speaker"
                description="Requirements create a task per confirmed participation. Define them under Tasks."
              />
            </Card>
          ) : (
            mine.map((instance) => (
              <Card
                key={instance.instanceId}
                title={instance.requirementTitle}
                subtitle={`${instance.sessionTitle} · due ${formatDateTime(instance.dueAt, timezone)}`}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  <span>
                    <StatusPill status={TASK_STATUS_LABEL[instance.status]} />
                  </span>
                  <InstanceActions
                    eventSlug={eventSlug}
                    instance={instance}
                    timezone={timezone}
                    now={now}
                  />
                </div>
              </Card>
            ))
          )}
        </WorkspacePanel>
      ) : null}

      {tab === 'files' ? (
        <WorkspacePanel label="Files">
          {instances === undefined ? (
            <p style={{ color: 'var(--text-tertiary)' }}>Loading files…</p>
          ) : withFiles.length === 0 ? (
            <Card>
              <EmptyState
                icon="paperclip"
                title="Nothing uploaded yet"
                description="Files this speaker (or an organizer on their behalf) uploads against a task appear here, newest version first."
              />
            </Card>
          ) : (
            withFiles.map((instance) => (
              <InstanceFiles
                key={instance.instanceId}
                eventSlug={eventSlug}
                instance={instance}
                timezone={timezone}
              />
            ))
          )}
        </WorkspacePanel>
      ) : null}

      {tab === 'comments' ? (
        <WorkspacePanel label="Comments">
          {instances === undefined ? (
            <p style={{ color: 'var(--text-tertiary)' }}>Loading comments…</p>
          ) : mine.length === 0 ? (
            <Card>
              <EmptyState
                icon="message-square"
                title="No task to comment on yet"
                description="Comments hang off a task, so the speaker and the organizer are always talking about the same thing."
              />
            </Card>
          ) : (
            mine.map((instance) => (
              <Card
                key={instance.instanceId}
                title={instance.requirementTitle}
                subtitle={`${instance.sessionTitle} · ${speakerLabel(instance)}`}
              >
                <TaskCommentThread
                  eventSlug={eventSlug}
                  instanceId={instance.instanceId}
                  source="organizer"
                  timezone={timezone}
                />
              </Card>
            ))
          )}
        </WorkspacePanel>
      ) : null}

      {tab === 'comms' ? (
        <WorkspacePanel label="Communication history">
          <ContactMessages
            eventSlug={eventSlug}
            eventContactId={eventContactId}
            timezone={timezone}
          />
        </WorkspacePanel>
      ) : null}
    </WorkspaceShell>
  )
}

function InstanceFiles({
  eventSlug,
  instance,
  timezone,
}: {
  eventSlug: string
  instance: InstanceRow
  timezone: string
}) {
  const uploads = useQuery(api.tasks.listUploads, {
    eventSlug,
    instanceId: instance.instanceId,
  })
  return (
    <Card
      title={instance.requirementTitle}
      subtitle={instance.sessionTitle}
      padded={false}
    >
      {uploads === undefined ? (
        <p style={{ padding: 'var(--space-4)', color: 'var(--text-tertiary)' }}>
          Loading files…
        </p>
      ) : (
        <UploadVersionList uploads={uploads} timezone={timezone} />
      )}
    </Card>
  )
}

/**
 * Everything StageStack has sent this person for this event.
 *
 * The comms module keeps the same log behind a person picker; here the person
 * is already chosen, so the picker is exactly the step the workspace removes.
 */
function ContactMessages({
  eventSlug,
  eventContactId,
  timezone,
}: {
  eventSlug: string
  eventContactId: Id<'eventContacts'>
  timezone: string
}) {
  const messages = useQuery(api.comms.contactLog, { eventSlug, eventContactId })
  const templates = useQuery(api.templates.list, { eventSlug })
  const nameFor = (kind: string) =>
    templates?.find((row) => row.key === kind)?.name ?? messageKindLabel(kind)

  if (messages === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading the log…</p>
  }
  if (messages.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="mail"
          title="Nothing sent yet"
          description="Every lifecycle email, reminder and one-off message StageStack sends this speaker is recorded here the moment it goes out."
        />
      </Card>
    )
  }
  return (
    <Card title="Messages" subtitle={`${messages.length} recorded`} padded={false}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {messages.map((message) => (
          <li key={message.messageId} style={listRow}>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
              }}
            >
              <span
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                <Tag>{nameFor(message.kind)}</Tag>
                <DeliveryPill status={message.deliveryStatus} />
              </span>
              <span style={{ font: 'var(--type-label)', overflowWrap: 'anywhere' }}>
                {message.subject}
              </span>
              <span style={caption}>{message.toEmail}</span>
            </span>
            <span style={caption}>
              {formatDateTime(message.sentAt, timezone)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

const listRow = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--space-3)',
  padding: 'var(--space-3) var(--space-5)',
  borderTop: 'var(--space-px) solid var(--border-subtle)',
} as const

const caption = {
  font: 'var(--type-caption)',
  color: 'var(--text-tertiary)',
} as const
