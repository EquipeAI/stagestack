import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Doc } from '@convex/_generated/dataModel'
import {
  Avatar,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  SearchInput,
  Select,
  Tabs,
  Tag,
  Textarea,
  Toolbar,
} from '~/ds'
import { ContactDetailDialog } from '~/components/contacts/ContactDetailDialog'
import { CrmTools, contactMatchesSearch } from '~/components/contacts/CrmTools'
import { PageBody } from '~/components/PageBody'
import { EventCard, EventGrid } from '~/components/EventCard'
import { QueryBoundary } from '~/components/QueryBoundary'
import { pushToast } from '~/components/toast'
import { usePending } from '~/lib/usePending'
import { useLastLoaded, useNow } from '~/components/tasks/useNow'
import { errorMessage } from '~/lib/errors'
import {
  browserTimezone,
  fromInputValue,
  timezoneOptions,
} from '~/lib/datetime'
import { ROLE_LABEL } from '~/lib/roles'

export const Route = createFileRoute('/app/org/$orgSlug')({
  component: OrgPage,
  errorComponent: ({ error }) => (
    <PageBody narrow>
      <Callout tone="blocked" title="This organization is not available">
        {errorMessage(error)}
      </Callout>
    </PageBody>
  ),
})

type TabId = 'events' | 'contacts' | 'team'

function OrgPage() {
  const { orgSlug } = Route.useParams()
  const org = useQuery(api.orgs.get, { orgSlug })
  const orgEvents = useQuery(api.events.listForOrg, { orgSlug })
  const [tab, setTab] = useState<TabId>('events')

  if (org === undefined) {
    return (
      <PageBody>
        <p style={{ color: 'var(--text-tertiary)' }}>Loading organization…</p>
      </PageBody>
    )
  }

  const events = orgEvents ?? []
  // Org owners and admins. A null role means the person reached this page
  // through an event membership: they can look, but every org-wide mutation
  // the backend offers here would refuse them.
  const isAdmin = org.role !== null

  const tabs = [
    {
      id: 'events',
      label: 'Events',
      icon: 'calendar-days',
      count: events.length,
    },
    { id: 'contacts', label: 'Contacts', icon: 'users' },
    ...(isAdmin ? [{ id: 'team', label: 'Team', icon: 'user-round' }] : []),
  ]

  return (
    <PageBody>
      <PageHeader
        title={org.org.name}
        breadcrumbs={[
          { label: 'My StageStack', href: '/app/home' },
          { label: org.org.name },
        ]}
        description={
          org.role === null
            ? 'You have access through event membership.'
            : `You are an ${org.role} of this organization.`
        }
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-6)',
        }}
      >
        <Tabs tabs={tabs} value={tab} onChange={(id) => setTab(id as TabId)} />
        {tab === 'events' ? (
          <EventsTab
            orgSlug={orgSlug}
            events={events}
            loading={orgEvents === undefined}
            canCreate={isAdmin}
          />
        ) : null}
        {tab === 'contacts' ? (
          // The directory is open to event organizers too, which is not
          // knowable from `org.role` — so the tab stays, and a refusal is
          // reported here instead of taking the page down.
          <QueryBoundary
            resetKey={orgSlug}
            title="The contact directory is not available to you"
          >
            <ContactsTab orgSlug={orgSlug} canManageCrm={isAdmin} />
          </QueryBoundary>
        ) : null}
        {tab === 'team' && isAdmin ? (
          <OrgTeamTab orgSlug={orgSlug} canGrantOwner={org.role === 'owner'} />
        ) : null}
      </div>
    </PageBody>
  )
}

// ── Events ────────────────────────────────────────────────────────────────

function EventsTab({
  orgSlug,
  events,
  loading,
  canCreate,
}: {
  orgSlug: string
  events: Array<Doc<'events'>>
  loading: boolean
  canCreate: boolean
}) {
  const [creating, setCreating] = useState(false)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      {canCreate ? (
        <Toolbar
          right={
            <Button
              variant="primary"
              iconLeft="plus"
              onClick={() => setCreating(true)}
            >
              New event
            </Button>
          }
        />
      ) : null}
      {loading ? (
        <p style={{ color: 'var(--text-tertiary)' }}>Loading events…</p>
      ) : events.length === 0 ? (
        <Card>
          <EmptyState
            icon="calendar-days"
            title="No events yet"
            description={
              canCreate
                ? 'Create an event to open a CFP, build a team and run your program.'
                : 'Nothing here yet. Only organization owners and admins can create events.'
            }
            action={
              canCreate ? (
                <Button
                  variant="primary"
                  iconLeft="plus"
                  onClick={() => setCreating(true)}
                >
                  New event
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <EventGrid>
          {events.map((event) => (
            <EventCard key={event._id} event={event} />
          ))}
        </EventGrid>
      )}
      {creating ? (
        <NewEventDialog orgSlug={orgSlug} onClose={() => setCreating(false)} />
      ) : null}
    </div>
  )
}

function NewEventDialog({
  orgSlug,
  onClose,
}: {
  orgSlug: string
  onClose: () => void
}) {
  const createEvent = useMutation(api.events.create)
  const navigate = useNavigate()
  const { pending, error, setError, run } = usePending()
  const [name, setName] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [timezone, setTimezone] = useState(browserTimezone())
  const zones = useMemo(() => timezoneOptions(timezone), [timezone])

  const submit = () => {
    const start = fromInputValue(startsAt, timezone)
    const end = fromInputValue(endsAt, timezone)
    if (name.trim().length === 0) return setError('Name the event.')
    if (start === null) return setError('Set a start date and time.')
    if (end === null) return setError('Set an end date and time.')
    if (end < start) return setError('The event cannot end before it starts.')
    void run(async () => {
      const { slug } = await createEvent({
        orgSlug,
        name: name.trim(),
        startsAt: start,
        endsAt: end,
        timezone,
      })
      pushToast('Event created', name.trim())
      await navigate({ to: '/app/e/$eventSlug', params: { eventSlug: slug } })
    })
  }

  return (
    <Dialog
      open
      width={640}
      title="New event"
      description="Dates are stored in the timezone you pick — that is the event's authoritative time."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Creating…' : 'Create event'}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        <Field label="Event name" htmlFor="event-name">
          <Input
            id="event-name"
            value={name}
            autoFocus
            placeholder="AI Engineer World's Fair 2026"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
            gap: 'var(--space-4)',
          }}
        >
          <Field label="Starts" htmlFor="event-starts">
            <Input
              id="event-starts"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </Field>
          <Field label="Ends" htmlFor="event-ends">
            <Input
              id="event-ends"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Timezone"
          htmlFor="event-tz"
          hint="Every date on the event is shown in this zone."
        >
          <Select
            id="event-tz"
            options={zones}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  )
}

// ── Contacts ──────────────────────────────────────────────────────────────

type ContactDoc = Doc<'contacts'>

function ContactsTab({
  orgSlug,
  canManageCrm,
}: {
  orgSlug: string
  canManageCrm: boolean
}) {
  const [search, setSearch] = useState('')
  // One subscription for the whole directory; search and the attribute
  // filters all run locally so typing never re-subscribes.
  const contacts = useQuery(api.contacts.list, { orgSlug })
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ContactDoc | null>(null)
  const [tagFilter, setTagFilter] = useState('')
  const [companyFilter, setCompanyFilter] = useState('')
  const [selected, setSelected] = useState<Array<ContactDoc['_id']>>([])

  const { allTags, allCompanies } = useMemo(() => {
    const tags = new Set<string>()
    const companies = new Set<string>()
    for (const contact of contacts ?? []) {
      for (const tag of contact.tags ?? []) tags.add(tag)
      if (contact.company !== undefined) companies.add(contact.company)
    }
    const sort = (values: Set<string>) =>
      [...values].sort((a, b) => a.localeCompare(b))
    return { allTags: sort(tags), allCompanies: sort(companies) }
  }, [contacts])

  const needle = search.trim().toLowerCase()
  const filtered = tagFilter !== '' || companyFilter !== ''
  const visible = useMemo(() => {
    if (contacts === undefined) return undefined
    return contacts.filter((contact) => {
      if (tagFilter !== '' && !(contact.tags ?? []).includes(tagFilter)) {
        return false
      }
      if (companyFilter !== '' && contact.company !== companyFilter) {
        return false
      }
      return contactMatchesSearch(contact, needle)
    })
  }, [contacts, needle, tagFilter, companyFilter])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      {contacts !== undefined && canManageCrm ? (
        <CrmTools
          orgSlug={orgSlug}
          contacts={contacts}
          selected={selected}
          search={search}
          tag={tagFilter}
          company={companyFilter}
          onSearch={setSearch}
          onTag={setTagFilter}
          onCompany={setCompanyFilter}
          onClearSelection={() => setSelected([])}
          onOpenContact={setEditing}
        />
      ) : null}
      <Toolbar
        left={
          <SearchInput
            placeholder="Search contacts"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
        right={
          <Button
            variant="primary"
            iconLeft="plus"
            onClick={() => setAdding(true)}
          >
            Add contact
          </Button>
        }
      />
      {allTags.length > 0 || allCompanies.length > 0 || filtered ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          <Select
            id="contacts-filter-tag"
            value={tagFilter}
            options={[
              { value: '', label: 'All tags' },
              ...allTags.map((tag) => ({ value: tag, label: tag })),
            ]}
            onChange={(e) => setTagFilter(e.target.value)}
          />
          <Select
            id="contacts-filter-company"
            value={companyFilter}
            options={[
              { value: '', label: 'All companies' },
              ...allCompanies.map((company) => ({
                value: company,
                label: company,
              })),
            ]}
            onChange={(e) => setCompanyFilter(e.target.value)}
          />
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              iconLeft="x"
              onClick={() => {
                setTagFilter('')
                setCompanyFilter('')
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}
      {visible === undefined ? (
        <p style={{ color: 'var(--text-tertiary)' }}>Loading contacts…</p>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="users"
            title={
              search === '' && !filtered
                ? 'No contacts yet'
                : 'No contacts match those filters'
            }
            description={
              search === '' && !filtered
                ? 'People you add here become available as speakers across every event in this organization.'
                : 'Clear the search and filters to see the whole directory.'
            }
            action={
              search === '' && !filtered ? (
                <Button
                  variant="primary"
                  iconLeft="plus"
                  onClick={() => setAdding(true)}
                >
                  Add contact
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card padded={false}>
          <DataTable
            rowKey="_id"
            onRowClick={(row: ContactDoc) => setEditing(row)}
            columns={[
              ...(canManageCrm
                ? [
                    {
                      key: 'select',
                      header: 'Select',
                      cell: (row: ContactDoc) => (
                        <span onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            label={
                              <span
                                style={{
                                  position: 'absolute',
                                  width: 'var(--space-px)',
                                  height: 'var(--space-px)',
                                  padding: 0,
                                  margin: 'calc(-1 * var(--space-px))',
                                  overflow: 'hidden',
                                  clip: 'rect(0, 0, 0, 0)',
                                  whiteSpace: 'nowrap',
                                  border: 0,
                                }}
                              >
                                Select {row.firstName} {row.lastName}
                              </span>
                            }
                            checked={selected.includes(row._id)}
                            onChange={(event) =>
                              setSelected((current) =>
                                event.target.checked
                                  ? [...new Set([...current, row._id])]
                                  : current.filter((id) => id !== row._id),
                              )
                            }
                          />
                        </span>
                      ),
                    },
                  ]
                : []),
              {
                key: 'name',
                header: 'Name',
                cell: (row: ContactDoc) => (
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                    }}
                  >
                    <Avatar
                      name={`${row.firstName} ${row.lastName}`}
                      size={24}
                    />
                    {row.firstName} {row.lastName}
                  </span>
                ),
              },
              {
                key: 'email',
                header: 'Email',
                cell: (row: ContactDoc) => row.email ?? '—',
              },
              {
                key: 'company',
                header: 'Company',
                cell: (row: ContactDoc) => row.company ?? '—',
              },
              {
                key: 'tags',
                header: 'Tags',
                cell: (row: ContactDoc) =>
                  row.tags !== undefined && row.tags.length > 0 ? (
                    <span
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 'var(--space-1)',
                      }}
                    >
                      {row.tags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </span>
                  ) : (
                    '—'
                  ),
              },
            ]}
            rows={visible}
          />
        </Card>
      )}
      {adding ? (
        <ContactDialog orgSlug={orgSlug} onClose={() => setAdding(false)} />
      ) : null}
      {editing !== null ? (
        <ContactDetailDialog
          orgSlug={orgSlug}
          contact={editing}
          showCrmActivity={canManageCrm}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  )
}

function ContactDialog({
  orgSlug,
  onClose,
}: {
  orgSlug: string
  onClose: () => void
}) {
  const create = useMutation(api.contacts.create)
  const { pending, error, setError, run } = usePending()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [company, setCompany] = useState('')
  const [tagline, setTagline] = useState('')
  const [bio, setBio] = useState('')

  const submit = () => {
    if (firstName.trim() === '' || lastName.trim() === '') {
      return setError('First and last name are both required.')
    }
    const profile = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim() === '' ? undefined : email.trim(),
      phone: phone.trim() === '' ? undefined : phone.trim(),
      jobTitle: jobTitle.trim() === '' ? undefined : jobTitle.trim(),
      company: company.trim() === '' ? undefined : company.trim(),
      tagline: tagline.trim() === '' ? undefined : tagline.trim(),
      bio: bio.trim() === '' ? undefined : bio.trim(),
    }
    void run(async () => {
      await create({ orgSlug, profile })
      pushToast('Contact added', `${profile.firstName} ${profile.lastName}`)
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={640}
      title="Add contact"
      description="Contacts are the org-wide directory of people you may invite to speak."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Add contact'}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))',
            gap: 'var(--space-4)',
          }}
        >
          <Field label="First name" htmlFor="c-first" required>
            <Input
              id="c-first"
              value={firstName}
              autoFocus
              onChange={(e) => setFirstName(e.target.value)}
            />
          </Field>
          <Field label="Last name" htmlFor="c-last" required>
            <Input
              id="c-last"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </Field>
          <Field label="Email" htmlFor="c-email" optional>
            <Input
              id="c-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Phone" htmlFor="c-phone" optional>
            <Input
              id="c-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <Field label="Job title" htmlFor="c-job" optional>
            <Input
              id="c-job"
              value={jobTitle}
              placeholder="CTO"
              onChange={(e) => setJobTitle(e.target.value)}
            />
          </Field>
          <Field label="Company" htmlFor="c-company" optional>
            <Input
              id="c-company"
              value={company}
              placeholder="Acme"
              onChange={(e) => setCompany(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Tagline"
          htmlFor="c-tagline"
          optional
          hint="Short role line, e.g. CTO, Acme."
        >
          <Input
            id="c-tagline"
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
          />
        </Field>
        <Field label="Bio" htmlFor="c-bio" optional>
          <Textarea
            id="c-bio"
            rows={4}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  )
}

// ── Team ──────────────────────────────────────────────────────────────────

// One @, no spaces, a dotted domain — the same shape the event's reply-to is
// held to. Delivery is the real validator; this only catches the typo before
// an invitation is sent to nobody.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type OrgTeamMember = {
  userId: Doc<'users'>['_id']
  name: string | null
  email: string | null
  imageUrl: string | null
  role: 'owner' | 'admin' | 'organizer' | 'reviewer'
}

function OrgTeamTab({
  orgSlug,
  canGrantOwner,
}: {
  orgSlug: string
  canGrantOwner: boolean
}) {
  // Team reads take `now` (invitation expiry is time-derived); hold the last
  // result across the once-a-minute re-subscribe so the tab doesn't blink.
  const now = useNow()
  const team = useLastLoaded(useQuery(api.team.listForOrg, { orgSlug, now }))
  const revoke = useMutation(api.team.revokeOrgInvitation)
  const revokeState = usePending()
  const invite = useMutation(api.team.inviteOrgAdmin)
  const { pending, error, setError, run } = usePending()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('admin')

  const submit = () => {
    const address = email.trim()
    if (address === '') return setError('Enter the email to invite.')
    if (!EMAIL_SHAPE.test(address)) {
      return setError('That does not look like an email address.')
    }
    void run(async () => {
      await invite({
        orgSlug,
        email: address,
        role: role === 'owner' && canGrantOwner ? 'owner' : 'admin',
      })
      pushToast('Invitation sent', `${address} was invited as ${role}.`, 'mail')
      setEmail('')
    })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <Card
        title="Members"
        subtitle="Org-wide owners and admins."
        padded={false}
      >
        {team === undefined ? (
          <p
            style={{ color: 'var(--text-tertiary)', padding: 'var(--space-4)' }}
          >
            Loading members…
          </p>
        ) : (
          <DataTable
            rowKey="userId"
            columns={[
              {
                key: 'name',
                header: 'Member',
                cell: (row: OrgTeamMember) => (
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                    }}
                  >
                    <Avatar
                      name={row.name ?? row.email ?? 'Unknown'}
                      src={row.imageUrl ?? undefined}
                      size={24}
                    />
                    {row.name ?? '—'}
                  </span>
                ),
              },
              {
                key: 'email',
                header: 'Email',
                cell: (row: OrgTeamMember) => row.email ?? '—',
              },
              {
                key: 'role',
                header: 'Role',
                cell: (row: OrgTeamMember) => ROLE_LABEL[row.role],
              },
            ]}
            rows={team.members}
          />
        )}
      </Card>
      {team !== undefined && team.invitations.length > 0 ? (
        <Card
          title="Pending invitations"
          subtitle="Org-wide invitations that have not been accepted yet."
        >
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {team.invitations.map((invitation) => (
              <li
                key={invitation._id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-2) 0',
                }}
              >
                <span>
                  {invitation.email}{' '}
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    ({ROLE_LABEL[invitation.role]})
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={revokeState.pending}
                  onClick={() => {
                    void revokeState.run(async () => {
                      await revoke({ orgSlug, invitationId: invitation._id })
                      pushToast('Invitation revoked', invitation.email)
                    })
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card
        title="Invite an organization admin"
        subtitle="Owners and admins can act on every event in this organization."
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
          }}
        >
          {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: '1 1 16rem' }}>
              <Field label="Email" htmlFor="org-invite-email">
                <Input
                  id="org-invite-email"
                  type="email"
                  value={email}
                  placeholder="person@example.com"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Role" htmlFor="org-invite-role">
              <Select
                id="org-invite-role"
                value={role}
                // Only an owner can make another owner — offering it to an admin
                // would be offering a refusal.
                options={
                  canGrantOwner
                    ? [
                        { value: 'admin', label: 'Admin' },
                        { value: 'owner', label: 'Owner' },
                      ]
                    : [{ value: 'admin', label: 'Admin' }]
                }
                onChange={(e) => setRole(e.target.value)}
              />
            </Field>
            <Button variant="primary" onClick={submit} disabled={pending}>
              {pending ? 'Sending…' : 'Send invitation'}
            </Button>
          </div>
          <p
            style={{
              color: 'var(--text-tertiary)',
              font: 'var(--type-caption)',
            }}
          >
            The invitation email carries a link that expires. Event-scoped
            invitations live on each event&rsquo;s Team page.
          </p>
        </div>
      </Card>
    </div>
  )
}
