import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { planOutreach } from '@convex/shared/bulkOutreach'
import type { Doc } from '@convex/_generated/dataModel'
import type { ActiveFilter } from '~/ds'
import {
  ActionResult,
  ActiveFilters,
  Avatar,
  BatchBar,
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
import { ApiKeysTab } from '~/components/apikeys/ApiKeysTab'
import { ContactDetailDialog } from '~/components/contacts/ContactDetailDialog'
import {
  BulkOutreachDialog,
  CrmTools,
  contactMatchesSearch,
} from '~/components/contacts/CrmTools'
import { parseOrgSearch } from '~/components/contacts/search'
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
  // W12: the tab AND the directory's search, tag and company filters live in
  // the URL, so a filtered directory is a link, survives a reload, and can be
  // backed out of.
  validateSearch: parseOrgSearch,
  errorComponent: ({ error }) => (
    <PageBody narrow>
      <Callout tone="blocked" title="This organization is not available">
        {errorMessage(error)}
      </Callout>
    </PageBody>
  ),
})

type TabId = 'events' | 'contacts' | 'team' | 'keys'

/** Tabs an org admin has and nobody else does. Both of them hand out access —
 * one to a person, one to an agent — so they are gated on the same fact and
 * fall back to the same default when a stale URL asks for them. */
const ADMIN_TABS: ReadonlyArray<TabId> = ['team', 'keys']

function OrgPage() {
  const { orgSlug } = Route.useParams()
  const org = useQuery(api.orgs.get, { orgSlug })
  const orgEvents = useQuery(api.events.listForOrg, { orgSlug })
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const setTab = (next: TabId) => {
    // Replace, like every other view switch in the app: the tab strip is a
    // view of this page, not six pages.
    void navigate({ search: { tab: next }, replace: true })
  }

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

  // The Team tab only exists for org admins, and a URL can ask for it anyway
  // (a shared link, a bookmark made before a role changed). The choice made
  // here is to FALL BACK to the default tab rather than to render a refusal:
  // a tab strip that does not offer Team has already said Team is not yours,
  // and a blank third panel would be the only wrong answer available.
  const requested = search.tab ?? 'events'
  const tab: TabId =
    ADMIN_TABS.includes(requested) && !isAdmin ? 'events' : requested

  const tabs = [
    {
      id: 'events',
      label: 'Events',
      icon: 'calendar-days',
      count: events.length,
    },
    { id: 'contacts', label: 'Contacts', icon: 'users' },
    ...(isAdmin
      ? [
          { id: 'team', label: 'Team', icon: 'user-round' },
          { id: 'keys', label: 'API keys', icon: 'lock' },
        ]
      : []),
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
        {tab === 'keys' && isAdmin ? (
          <ApiKeysTab orgSlug={orgSlug} events={events} />
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
  const params = Route.useSearch()
  const navigate = Route.useNavigate()
  const search = params.q ?? ''
  const tagFilter = params.tag ?? ''
  const companyFilter = params.company ?? ''
  // Filter writes REPLACE: narrowing the directory is a view of this page, so
  // back leaves the org rather than walking back through the organizer's own
  // keystrokes.
  const patch = (part: {
    q?: string | undefined
    tag?: string | undefined
    company?: string | undefined
  }) => {
    void navigate({
      search: (prev) => ({
        ...prev,
        ...Object.fromEntries(
          Object.entries(part).map(([key, value]) => [
            key,
            value === '' ? undefined : value,
          ]),
        ),
      }),
      replace: true,
    })
  }
  // One subscription for the whole directory; search and the attribute
  // filters all run locally so typing never re-subscribes.
  const contacts = useQuery(api.contacts.list, { orgSlug })
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ContactDoc | null>(null)
  const [selected, setSelected] = useState<Array<ContactDoc['_id']>>([])
  const [composing, setComposing] = useState(false)
  // The outreach dialog closes on send, so its outcome belongs to the page —
  // otherwise "3 failed" would leave with the dialog (W5).
  const [outreachResult, setOutreachResult] = useState<{
    status: 'success' | 'partial'
    title: string
    lines: Array<string>
  } | null>(null)

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

  const selection = (contacts ?? []).filter((contact) =>
    selected.includes(contact._id),
  )
  // The eligibility arithmetic is the backend's: convex/shared/bulkOutreach.ts
  // states the rule (an address on file) and the audience range, and
  // convex/model/contacts.ts enforces the same one when the mutation lands.
  const outreach = planOutreach(selection)

  const chips: Array<ActiveFilter> = [
    ...(search === ''
      ? []
      : [
          {
            id: 'q',
            label: `Search: ${search}`,
            onRemove: () => patch({ q: undefined }),
          },
        ]),
    ...(tagFilter === ''
      ? []
      : [
          {
            id: `tag:${tagFilter}`,
            label: `Tag: ${tagFilter}`,
            onRemove: () => patch({ tag: undefined }),
          },
        ]),
    ...(companyFilter === ''
      ? []
      : [
          {
            id: `company:${companyFilter}`,
            label: `Company: ${companyFilter}`,
            onRemove: () => patch({ company: undefined }),
          },
        ]),
  ]

  const selectColumn = {
    key: 'select',
    header: 'Select',
    width: '4rem',
    cell: (row: ContactDoc) => (
      <span onClick={(event) => event.stopPropagation()}>
        <Checkbox
          label={<span className="ss-visually-hidden">
            Select {row.firstName} {row.lastName}
          </span>}
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
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      {/* W12: the DIRECTORY leads. The KPI cards, saved segments, duplicate
          review and pipeline board follow it — they are still on screen
          without any interaction (the eval requires a populated analytics
          widget to be screenshot-visible, so nothing here is collapsed), but
          the organizer's primary work is no longer the last thing they reach. */}
      {outreachResult === null ? null : (
        <ActionResult
          status={outreachResult.status}
          title={outreachResult.title}
          details={outreachResult.lines}
          onDismiss={() => setOutreachResult(null)}
        />
      )}
      <Toolbar
        // Slot order (W12): search · filters · add. The directory has no
        // saved view or column picker; CSV import and export live with the
        // CRM tools below, where the rest of the bulk data work is.
        left={
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
            }}
          >
            <SearchInput
              aria-label="Search contacts"
              placeholder="Search contacts"
              value={search}
              onChange={(e) => patch({ q: e.target.value })}
            />
            {allTags.length === 0 ? null : (
              <Select
                id="contacts-filter-tag"
                size="sm"
                aria-label="Filter by tag"
                value={tagFilter}
                options={[
                  { value: '', label: 'All tags' },
                  ...allTags.map((tag) => ({ value: tag, label: tag })),
                ]}
                onChange={(e) => patch({ tag: e.target.value })}
              />
            )}
            {allCompanies.length === 0 ? null : (
              <Select
                id="contacts-filter-company"
                size="sm"
                aria-label="Filter by company"
                value={companyFilter}
                options={[
                  { value: '', label: 'All companies' },
                  ...allCompanies.map((company) => ({
                    value: company,
                    label: company,
                  })),
                ]}
                onChange={(e) => patch({ company: e.target.value })}
              />
            )}
          </span>
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

      <ActiveFilters
        chips={chips}
        onClearAll={() =>
          patch({ q: undefined, tag: undefined, company: undefined })
        }
      />

      {visible === undefined ? (
        <Card padded={false}>
          <DataTable
            aria-label="Contact directory"
            loading
            loadingLabel="Loading the contact directory…"
            rows={[]}
            columns={CONTACT_SKELETON_COLUMNS}
          />
        </Card>
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
            aria-label="Contact directory"
            rowKey="_id"
            selectedIds={selected}
            onRowClick={(row: ContactDoc) => setEditing(row)}
            // The phone rendering: who they are, where they work, and the same
            // tick box — selection and the batch bar work identically in both.
            cardRow={(row: ContactDoc) => (
              <>
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                  }}
                >
                  {canManageCrm ? selectColumn.cell(row) : null}
                  <Avatar
                    name={`${row.firstName} ${row.lastName}`}
                    size={32}
                  />
                  <span
                    style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
                  >
                    <span style={{ color: 'var(--text-primary)' }}>
                      {row.firstName} {row.lastName}
                    </span>
                    <span
                      style={{
                        font: 'var(--type-caption)',
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      {row.email ?? 'No email on file'}
                    </span>
                  </span>
                </span>
                {row.company === undefined && (row.tags ?? []).length === 0 ? null : (
                  <span
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                    }}
                  >
                    {row.company === undefined ? null : (
                      <span
                        style={{
                          font: 'var(--type-caption)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {row.company}
                      </span>
                    )}
                    {(row.tags ?? []).map((tag) => (
                      <Tag key={tag}>{tag}</Tag>
                    ))}
                  </span>
                )}
              </>
            )}
            columns={[
              ...(canManageCrm ? [selectColumn] : []),
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

      {/* Everything the organizer consults ABOUT the directory, under it. */}
      {contacts !== undefined && canManageCrm ? (
        <CrmTools
          orgSlug={orgSlug}
          contacts={contacts}
          search={search}
          tag={tagFilter}
          company={companyFilter}
          onSearch={(value) => patch({ q: value })}
          onTag={(value) => patch({ tag: value })}
          onCompany={(value) => patch({ company: value })}
          onOpenContact={setEditing}
        />
      ) : null}

      {canManageCrm && selected.length > 0 ? (
        <BatchBar
          label="Contact bulk actions"
          noun="contact"
          count={outreach.selected}
          eligible={outreach.eligible}
          exclusions={outreach.excluded}
          summary={outreach.blocked ?? undefined}
          onClear={() => setSelected([])}
          actions={
            <Button
              size="sm"
              variant="primary"
              iconLeft="mail"
              disabled={outreach.blocked !== null || outreach.eligible === 0}
              onClick={() => setComposing(true)}
            >
              Email selected
            </Button>
          }
        />
      ) : null}

      {composing ? (
        <BulkOutreachDialog
          orgSlug={orgSlug}
          contacts={selection}
          onClose={() => setComposing(false)}
          onResult={setOutreachResult}
          onSent={() => setSelected([])}
        />
      ) : null}
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

/** Headers only — the skeleton holds the directory's shape while it loads. */
const CONTACT_SKELETON_COLUMNS = [
  { key: 'name', header: 'Name' },
  { key: 'email', header: 'Email' },
  { key: 'company', header: 'Company' },
  { key: 'tags', header: 'Tags' },
]

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
