import {
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { Badge, Callout, PageHeader, SidebarNav } from '~/ds'
import { PageBody } from '~/components/PageBody'
import { errorCode, errorMessage } from '~/lib/errors'
import { formatDateRange } from '~/lib/datetime'

export const Route = createFileRoute('/app/e/$eventSlug')({
  component: EventLayout,
  errorComponent: EventError,
})

// Later milestones append to this list — CFP, Proposals, Reviews, Agenda,
// Speakers — without touching the shell.
const NAV_GROUPS = [
  {
    items: [
      { id: 'overview', label: 'Overview', icon: 'layout-grid' },
      { id: 'settings', label: 'Settings', icon: 'settings' },
      { id: 'team', label: 'Team', icon: 'users' },
    ],
  },
]

function EventLayout() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })
  const navigate = useNavigate()
  const pathname = useLocation({ select: (l) => l.pathname })

  const activeId = pathname.endsWith('/settings')
    ? 'settings'
    : pathname.endsWith('/team')
      ? 'team'
      : 'overview'

  const onSelect = (id: string) => {
    if (id === 'settings') {
      void navigate({ to: '/app/e/$eventSlug/settings', params: { eventSlug } })
    } else if (id === 'team') {
      void navigate({ to: '/app/e/$eventSlug/team', params: { eventSlug } })
    } else {
      void navigate({ to: '/app/e/$eventSlug', params: { eventSlug } })
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'stretch' }}>
      <div
        style={{
          position: 'sticky',
          top: 'var(--topbar-height)',
          alignSelf: 'flex-start',
          height: 'calc(100dvh - var(--topbar-height))',
        }}
      >
        <SidebarNav
          header={
            <span
              style={{
                font: 'var(--type-label)',
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {data === undefined ? 'Loading…' : data.event.name}
            </span>
          }
          groups={NAV_GROUPS}
          activeId={activeId}
          onSelect={onSelect}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <PageBody>
          {data === undefined ? (
            <p style={{ color: 'var(--text-tertiary)' }}>Loading event…</p>
          ) : (
            <>
              <PageHeader
                title={data.event.name}
                breadcrumbs={[
                  { label: 'My StageStack', href: '/app' },
                  { label: data.org.name, href: `/app/org/${data.org.slug}` },
                  { label: data.event.name },
                ]}
                description={formatDateRange(
                  data.event.startsAt,
                  data.event.endsAt,
                  data.event.timezone,
                )}
                meta={
                  <span style={{ marginLeft: 'var(--space-3)' }}>
                    <Badge tone={data.role === 'organizer' ? 'info' : 'neutral'}>
                      {data.role === 'organizer' ? 'Organizer' : 'Reviewer'}
                    </Badge>
                  </span>
                }
              />
              {data.event.archivedAt !== undefined ? (
                <Callout tone="attention" title="This event is archived">
                  Archived events are read-only in spirit — nothing is deleted, and
                  you can unarchive it from Overview.
                </Callout>
              ) : null}
              <Outlet />
            </>
          )}
        </PageBody>
      </div>
    </div>
  )
}

function EventError({ error }: { error: Error }) {
  const code = errorCode(error)
  return (
    <PageBody narrow>
      <Callout
        tone="blocked"
        title={
          code === 'not_found' ? 'No such event' : 'You cannot open this event'
        }
      >
        {errorMessage(error)}
      </Callout>
    </PageBody>
  )
}
