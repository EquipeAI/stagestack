# StageStack — Data model sketch (M1+)

Working design for tables that span milestones. M0 tables (users, organizations,
members, eventMembers, invitations, events, contacts, tracks/tags/rooms/
customFields, auditLog, jobs) are live in `convex/schema.ts`. This doc guides
M1–M7 schema work; update it when a milestone lands and reality diverges.

## M1 — CFP forms & proposals

- **cfpForms** — one per event (unique by eventId). Holds two bounded form
  definitions: `working` (organizer edits, private) and `published` (what the
  public wizard renders; absent until first publish). A FormDef is
  `{ sections: [{ id, title, description?, visibleIf?, fields: [FieldDef] }] }`;
  FieldDef `{ id, kind (text|wysiwyg|select|multiselect|dropdown|email|phone|file),
  label, help?, required, options?, systemKey?, visibleIf? }`. Locked system
  fields carry `systemKey` (talkTitle, firstName, lastName, email) and can't be
  removed. `visibleIf` = `{ fieldId, op (equals|notEquals|includes), value }`
  (conditional show/hide, M1 requirement). Settings: `maxSubmissionsPerUser?`,
  `successMessage?`. Form open/close dates live on the event (cfpOpenAt/CloseAt).
  Docs are bounded (≤ dozens of fields) so one doc per event is safe.
- **proposals** — `{ eventId, formVersion, title (denormalized from answers),
  answers: Record<fieldId, value>, status: draft|pending|acceptQueue|declineQueue|
  accepted|declined|withdrawn, submitterUserId, submittedAt?, updatedAt,
  lastDecisionAt?, withdrawnAt? }`. Index by_eventId_and_status, by_submitterUserId,
  by_eventId. Draft = wizard in progress (pre- or post-account-link).
  cfpDrafts (anon) merges into this at the account step.
- **proposalSpeakers** — participants entered in the wizard (no accounts needed):
  `{ proposalId, eventId, order, firstName, lastName, email?, tagline?, bio?,
  headshotId?, links?, isPrimary }`. On acceptance these become eventContacts
  snapshots + sessionParticipants.

## M2 — Review & sessions

- **reviews** — assignment + evaluation in one row: `{ eventId, proposalId,
  reviewerUserId, status: assigned|draft|submitted|locked, score?, recommendation?
  (accept|decline|neutral), comments?, submittedAt?, versions: bounded history }`.
  Index by_eventId_and_reviewerUserId, by_proposalId.
- **sessions** — created on acceptance or direct invitation: `{ eventId, title,
  description?, format?, trackId?, tagIds: Id[], proposalId?, source: cfp|direct,
  status: planned|cancelled, custom field values }`. Scheduling fields arrive
  in M6 (roomId?, startsAt?, endsAt?, released* fields).
- **eventContacts** — event-scoped publishable snapshot copied from contacts:
  `{ eventId, contactId, ...profile fields, userId? (claimed portal account) }`.
  Snapshots never change automatically (M0 rule).
- **sessionParticipants** — `{ sessionId, eventId, eventContactId, role,
  state: awaiting|confirmed|declined|withdrawn, confirmedBy?/At?,
  ack: awaitingAck|acknowledged|conflict (M6), managerUserId? }`.

## M3 — Portal

- Portal access = proposals.submitterUserId (primary manager) +
  eventContacts.userId (claimed speakers). portal invitations reuse the
  invitations table with a new role or a parallel portalInvites table.
- Pending public edits: store `pendingEdits` patch on eventContacts/sessions;
  organizers publish explicitly (M6/M7 publication boundary).

## M4 — Tasks & readiness

- **requirements** (definitions) — `{ eventId, title, description?, scope:
  participant|session, evidence: field|file|form|confirmation|manual,
  fieldKey?, reviewRequired: boolean, dueAt, reminderCadence?, active }`.
- **taskInstances** — `{ requirementId, eventId, sessionId?, eventContactId?,
  status: pending|provided|approved|changesRequested|notApplicable|complete,
  naReason?, completedBy?/At?, dueAt (resolved w/ overrides) }`.
- **uploads** — versioned files: `{ eventId, taskInstanceId?, sessionId?,
  storageId, filename, version, uploadedBy, approvedVersion? logic }`.
- Session readiness is DERIVED in queries (no stored status).

## M5 — Comms

- **emailTemplates** — `{ eventId, key (submitted|accepted|declined|invited|
  taskAssigned|reminder|custom), name, subject, html with {{vars}}, updatedAt }`.
- **messages** — comms log: `{ orgId, eventId, contactId?/email, kind, subject,
  renderedHtml?, resendEmailId?, deliveryStatus (fed by webhook), sentByUserId?,
  jobRef?, sentAt, context (sessionId?, taskId?) }`. handleEmailEvent updates
  deliveryStatus. Calendar invites ride the same log with ics metadata
  (uid, sequence, method).

## M6 — Agenda

- sessions gain `{ roomId?, startsAt?, endsAt?, releasedSlot?: { startsAt,
  endsAt, roomId?, releasedAt, sequence } }` (sequence drives .ics updates).
- **agendaItems** — non-session blocks: `{ eventId, title, startsAt, endsAt,
  roomId?, description? }`.
- Conflict detection is derived in queries (speaker double-book, room overlap
  → blockers; track overlap → warning).

## M7 — Publication

- **publishedPrograms** — one doc per event holding the last explicitly
  published projection: `{ eventId, version, publishedAt, sessions: [...],
  speakers: [...], agenda: [...] }` — the single shared program consumed by
  public page, API, embeds. Per-item unpublish rewrites the projection.
  If size becomes a concern, split per-session rows; start with one doc.

## M7 — Public program (settled design)

Live in schema: `publishedPrograms` (one row/event, holds the last published
`program` blob + version), `publicationFlags` (per-item published booleans),
`events.publicPageEnabled`.

- **`program` blob shape** (built at publish time, already privacy-filtered so
  the public read path does zero authorization): `{ event: {name, slug,
  startsAt, endsAt, timezone, location?, description?, website?, logoUrl?},
  lineup: [{ sessionId, title, description?, format?, trackName?, speakers:
  [{ name, tagline?, bio?, headshotUrl?, links? }] }], agenda: [{ kind:
  "session"|"break", title, startsAt, endsAt, roomName?, trackName?,
  speakers?: [name] }] }`. Only **Confirmed** participants appear by
  name/profile; unconfirmed → "speaker to be announced". Backstage/host links
  never enter the blob.
- **Two independent publish actions** (decision log #13, M6 rule): publish
  *lineup* (accepted sessions + confirmed speaker profiles, no slots needed)
  and publish *agenda* (only released+slotted sessions + agenda items).
  `publicationFlags` gate per session/item; `publishProgram` recomputes the
  whole blob from current flags + confirmed state and bumps version.
- **Public read path** (`convex/http.ts` + a public `publicProgram` query):
  serves `publishedPrograms.program` verbatim — never the working state, never
  a per-request join over private tables. Unpublish = flip a flag + republish
  (rewrites the blob); the API/page/embed all read the one blob so they can't
  disagree. HTTP actions on `.convex.site` with `corsRouter` for the API +
  the embed snippet; the TanStack public page SSRs from the same query.
