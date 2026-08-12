import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { AgendaSearch } from '~/components/agenda/search'
import { AgendaBoard } from '~/components/agenda/AgendaBoard'
import { parseAgendaSearch } from '~/components/agenda/search'
import { Callout } from '~/ds'

// The agenda builder (M6, challenge requirement #5). One `api.agenda.board`
// subscription drives all five views; the chosen view and day live in the URL
// so a particular grid is a shareable link and the back button works. The board
// query is organizer-only on the backend, so reviewers get the shared forbidden
// treatment and never subscribe.

export const Route = createFileRoute('/app/e/$eventSlug/agenda')({
  component: Agenda,
  validateSearch: parseAgendaSearch,
})

function Agenda() {
  const { eventSlug } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const event = useQuery(api.events.get, { eventSlug })
  const isOrganizer = event?.role === 'organizer'
  const board = useQuery(
    api.agenda.board,
    isOrganizer ? { eventSlug } : 'skip',
  )

  if (event === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading agenda…</p>
  }

  if (!isOrganizer) {
    return (
      <Callout tone="blocked" title="The agenda builder is organizer-only">
        Reviewers score proposals under Reviews. Ask an organizer if you need to
        see or edit the schedule.
      </Callout>
    )
  }

  if (board === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading agenda…</p>
  }

  return (
    <AgendaBoard
      eventSlug={eventSlug}
      board={board}
      view={search.view}
      day={search.day}
      room={search.room}
      onView={(view) => {
        // A room/track scope belongs to the axis it was chosen on: keeping it
        // across a view switch would silently hide most of the new grid.
        void navigate({
          search: (prev: AgendaSearch) => ({ ...prev, view, room: undefined }),
          replace: true,
        })
      }}
      onDay={(day) => {
        void navigate({ search: (prev: AgendaSearch) => ({ ...prev, day }), replace: true })
      }}
      onRoom={(room) => {
        void navigate({ search: (prev: AgendaSearch) => ({ ...prev, room }), replace: true })
      }}
    />
  )
}
