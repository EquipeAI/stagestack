# StageStack — Product Milestones

Product-led decomposition of what StageStack needs, in build order. Each milestone is independently demoable and maps to a business capability, not a technical layer. PLAN.md pulls its current tasks from exactly one milestone at a time.

Dependency spine: **M0 → M1 → M2 → M3 → M4/M5 (parallel) → M6 → M7**. M3 (portal) unlocks both speaker ops (M4) and comms (M5).

## M0 — Foundation: event & library

An organizer can create an event and define its vocabulary.

- Organization workspace with owner/admin access across the workspace and event-organizer access scoped to assigned events. Clerk provides identity, sessions, and internal organization membership; StageStack owns its organization record and all event/domain authorization.
- Build invariant: every meaningful product read and action is one reusable, authorized domain capability used by the UI and callable by agents. APIs and integrations adapt those same capabilities rather than duplicating workflow logic or bypassing permissions; the Import agent is the first bulk orchestration consumer.
- Agent trust boundary: an agent acts only with its initiating user's organization, event, and action permissions. Routine reversible private work may execute from a clear instruction; ambiguous bulk plans and any publish, send, decision release, cancellation, withdrawal, or deletion require explicit confirmation. Audit the initiating user, agent-assisted action, and result.
- Self-service onboarding: an uninvited verified user can create an organization and becomes owner/admin. Users arriving through CFP or role invitations land directly in that context without being prompted to create a workspace.
- **My StageStack** home starts with the organizations and events the user organizes and grows with their other responsibilities in later milestones. Event links and invitations deep-link to the relevant context.
- Reusable organization contact directory. Adding a contact to an event copies their current profile into an event-specific publishable snapshot; existing event snapshots never change automatically.
- Fast event creation requires only name, start/end date-times, and authoritative timezone. Generate a unique editable slug and an editable starter CFP in private draft state; creation exposes nothing publicly.
- Post-create Event Settings: optional type, location, website/description, images/branding, plus independent CFP open/close dates and settings. Event dates and CFP dates are distinct.
- CFP publication and public-agenda publication are independent controls. Opening or closing one never publishes, unpublishes, opens, or reopens the other.
- No global Draft/Live event state. Events are immediately usable internally; Archive is the only overall v1 lifecycle action, removing an event from active work and stopping automations without deleting data or silently changing published output.
- Library configured when needed and shared across the event: **tracks, tags, rooms, custom fields**.
- Event organizers can invite co-organizers and reviewers scoped to their event. Only organization owner/admins grant organization-wide admin access or manage ownership. (Multi-org/multi-event from day one in the product model; single org in the challenge UI is fine initially.)

## M1 — CFP: forms & public submission

A speaker can submit a proposal; the organizer controls the form.

- Form builder: sections, shown field types (text, wysiwyg, single-/multi-select, dropdown, email, phone, file), required toggles, locked system fields, and **conditional show/hide routing based on organizer-defined answers**. Categories are ordinary organizer-defined choices when wanted, not a mandatory StageStack taxonomy.
- Every new event starts with a usable, editable CFP containing the required identity/session fields plus common title, abstract, and speaker information. It can be published immediately or customized; no template marketplace or setup wizard in v1.
- Simple working/published form boundary: organizer edits remain private until previewed and explicitly published. Existing submitted proposals do not change; saved drafts retain entered answers but must pass the current published form before submission. No form-version management UI in v1.
- Public multi-step wizard: Welcome → Account → Submission → Participant(s) → Review. The Account step uses Clerk verified-email authentication and returns the user to the same draft. Mobile-friendly, fast.
- The authenticated submitter is the proposal's primary manager and may or may not be one of its speakers. They can add participants who do not yet have accounts.
- Before acceptance, the primary manager is the submission's only external editor; co-speakers are not required or invited to create accounts during the CFP.
- The primary manager may edit and resubmit after initial submission until the CFP close date. Updates notify organizers; close locks proposals automatically. An organizer may explicitly reopen one with actor/time audited.
- Before a decision is externally released, the primary manager may explicitly withdraw the proposal. Notify organizers, remove it from active review/decision queues, and preserve it as Withdrawn. After acceptance, use participant/session withdrawal instead.
- My StageStack adds drafts and submitted proposals across events.
- Form settings: open/close dates, per-user submission limits, drafts, custom success page.
- Fixed transactional emails through Resend (Convex Resend component): automatic confirmation to the submitter and admin notification on new/updated submission. Each message, its context, and its delivery state are recorded by StageStack.
- One active CFP form per event in v1. Organizer-defined choices and conditional sections can cover different submission types inside it; multiple independently active forms with separate URLs/deadlines are post-v1.

## M2 — Review: evaluation & decisions

The team can turn CFP submissions or direct invitations into private, planned sessions.

- Abstracts admin table: search, filter, sort, saved views, column preferences, export CSV/XLSX, file-bundle download, and manual add.
- Focused **Import with AI** action, not a global assistant UI: upload a CSV, spreadsheet, or document, optionally describe it, and let the agent plan calls to the same authorized tools used by StageStack for contacts, proposals, sessions, participants, tracks/tags, and field values. Show intended creations/safe reuse, uncertainties, suspected duplicates, and skipped rows; require organizer confirmation before bulk writes; validate every call and return exact per-record results. The agent may look up and reuse existing records but cannot bulk-update or delete them in v1; ambiguous matches are surfaced rather than guessed. Imported records remain private and never send communications or publish automatically. No generic column-mapping wizard; the underlying tools can support a broader agent later.
- Status pipeline: Draft → Pending → Accept/Decline Queue → Accepted/Declined; Withdrawn. Queue placement is an internal staged decision: it does not notify the submitter or reveal the outcome. An organizer explicitly releases queued decisions individually or in a batch, moving them to Accepted/Declined and enabling wave-based acceptance.
- A released decision may be reversed only through an explicit corrected release. Send a clearly identified correction communication and preserve both decisions with actor and time in the audit history. If an acceptance is corrected to declined, move its session to Cancelled, retain it as restorable history, remove it from active scheduling and public views, and send calendar cancellations if invitations were already distributed; never hard-delete it. If a decline is corrected to accepted, restore that session without duplication—or create it if none existed—preserve prior work, and reset every participant to Awaiting Response for fresh confirmation.
- One simple event-level review setup: assign reviewers to specific submissions; each reviewer records a score, recommendation, and comments; organizers see completion, individual reviews, and a simple aggregate, then make the decision. Reviewers have no access to unassigned submissions unless they also hold an organizer role. For assigned submissions, they can see evaluation content and speaker professional identity, but not contact details or post-acceptance operational data. Reviewers see only their own scores/comments before and after submission.
- Fast single-screen review: required score and recommendation, optional comments, autosave, and Submit & Next. No multi-step rubric/review wizard.
- Manual reviewer assignment with individual and bulk actions for selected submissions. No automatic balancing, category routing, or assignment engine in v1.
- Review lifecycle: Draft (organizers see progress status, not unfinished content) → Submitted (counts in aggregates and remains revisable with version history until round close) → Locked. An organizer may reopen a locked review with an audited reason.
- My StageStack adds assigned review work.
- Accepting a CFP proposal creates its session, but each speaker's participation remains separately Awaiting Response until confirmed or declined.
- Direct invitation: an organizer creates a private planned session and invites a speaker or representative, starting at Awaiting Response and bypassing CFP/review.
- Explicit decision release or formal invitation send → fixed transactional accept/decline/invitation email → safe deep link into the relevant portal state. Nothing is published to the public agenda automatically.

## M3 — Speaker portal

A speaker or their representative can self-serve everything the organizer would otherwise chase.

- Event-scoped portal access for the primary manager; after acceptance, speakers can be invited to claim their own access, but an account is not required merely to be listed as a speaker.
- My StageStack adds speaking engagements, confirmations, and tasks across events.
- Clerk verified-email authentication for portal users, using the same account as every other StageStack responsibility — never a separate portal or event-specific password.
- Portal and primary-manager invitations arrive through transactional email and deep-link to the intended event responsibility after Clerk verification.
- The primary manager can view status and edit shared session content such as title, description, and format.
- Each speaker can update only their own active event profile snapshot (bio, headshot, social links), participation confirmation (Awaiting Response → Confirmed/Declined), uploads, portal forms, and assigned tasks (see M4). Profile edits also refresh the organization's current reusable contact profile for future events; other event snapshots remain unchanged.
- Edits by a speaker or primary manager to already-public profile or session content become pending public updates. Organizers can preview them, while the last published version remains live until explicitly republished.
- A speaker's confirmation can be recorded by that speaker, the primary manager, or an organizer without requiring the speaker to create an account; show the actor and timestamp.
- Only Confirmed participants are eligible to appear by name or profile in public output. Awaiting Response and Declined participants remain private; a session may still publish with confirmed participants and a “speaker to be announced” placeholder. The confirmation experience previews the exact publishable event-profile fields and makes that profile eligible for organizer-controlled publication; no separate public-profile approval state exists in v1.
- Withdrawal immediately suppresses an announced speaker's public name/profile, cancels only that person's calendar participation, and alerts the organizer. Keep the session visible with other confirmed speakers or a “speaker to be announced” placeholder and flag it for attention rather than cancelling it automatically.
- Organizer-controlled primary-manager handoff: invite a replacement, retain the current manager until acceptance, then revoke the old management access unless they also participate as a speaker. Record the actor and timestamp.
- Organizers can edit all speaker and session information.
- Read-only "Preview speaker portal" mode with a persistent preview banner. Organizers cannot submit, upload, or confirm from the preview; admin-side changes remain attributed to the organizer.

## M4 — Speaker ops: tasks & readiness

The organizer always knows who owes what. (The anti-"5 spreadsheets" milestone.)

- Task definitions declare either participant scope or session scope. Participant tasks create one obligation per applicable speaker (for example, bio, headshot, travel details, personal release); a session task creates one shared obligation (for example, final slide deck) with one accountable assignee, defaulting to the primary manager.
- A participant task remains owed by its speaker even when the speaker's primary manager or an organizer completes it on their behalf. Record the completing actor and time; a primary-manager handoff never moves or duplicates the task.
- Create and assign applicable requirements when an acceptance or direct invitation is formally released and expose readiness immediately to organizers and primary managers. Each event requirement has one concrete default due date with optional per-participant or per-session organizer overrides; relative-date rules are post-v1 template convenience and must resolve to the same concrete task deadlines.
- Event requirement definitions are independent snapshots. A post-v1 organization template library may copy reusable starting points into events, but event customization and later library edits never mutate one another or rewrite active/historical work.
- Do not send task-specific reminders to an unconfirmed speaker. Until confirmation, send only invitation/participation reminders; begin that speaker's task reminders after they confirm, while still allowing managers and organizers to complete work early.
- Task reminders inherit an event-wide default cadence, with per-requirement organizer override or disable. Send only for outstanding, actionable work and stop immediately after completion, participant withdrawal, or session cancellation.
- Consolidate each scheduled reminder run into one message per recipient and event, grouped by speaker/session with direct action links. Do not send one email per outstanding task.
- For represented speakers, send routine task reminders to the primary manager by default. Send personal-action messages, schedule notices, and calendar invitations directly to the speaker; organizers may deliberately include both. Claiming portal access never silently changes that routing.
- Overdue status raises dashboard urgency but never increases email frequency automatically. Continue the configured cadence unless an organizer deliberately changes it or sends a targeted manual reminder.
- Evidence-linked requirements observe only objective submission state: required field present, file uploaded, form submitted, or participation confirmed. Report the content as Provided without claiming it is acceptable.
- Optional organizer review per content requirement, off by default in v1. Without review, Provided counts as complete; with review enabled, the organizer marks the submission Approved or Changes Requested. Support manual completion for work StageStack cannot observe.
- Only event organizers may approve or request changes. Speakers and primary managers may submit/resubmit; change requests require an explanatory note and notify the responsible people. Audit every submission and review action. No separate approver role or second-organizer requirement in v1.
- Fixed transactional notices for task assignment and other required speaker actions.
- File requests with versioned stored uploads as evidence for the related requirement, not automatic proof of content quality. Resubmission makes the newest version current internally without erasing prior files, feedback, actors, or timestamps. Approval is version-specific: replacing an approved item returns it to Provided / Awaiting Review, while public output remains on the prior approved/published version until the replacement is approved and published.
- Derive session readiness rather than allowing a manual status: Ready when required work is complete/approved, participants are confirmed, and no known conflicts remain; Needs Attention for missing/overdue work or pending participation/schedule responses; Blocked for reported availability conflicts, unresolved withdrawal, or impossible schedule collisions. Always expose the contributing reasons.
- An event organizer may mark one participant/session task instance Not Applicable with a required reason and audit history. It counts as satisfied and stops reminders only for that instance. Participation, availability conflicts, and hard schedule collisions are not waivable task exceptions.
- **Speaker-tracking dashboard**: per-speaker confirmation state, accepted speakers, outstanding tasks per speaker, missing bio/headshot, overdue list, and session readiness with drill-down reasons.
- A declined or awaiting speaker flags the session for attention without automatically cancelling the session or changing other participants' states.

## M5 — Communications

Nobody misses their talk because of a lost email.

- Resend (via the Convex Resend component) is the replaceable transactional delivery provider; Clerk continues to own authentication messages. StageStack owns communication intent, rendered content, event context, business history, and delivery state (fed by Resend delivery webhooks).
- Email templates with variables ({{speaker.name}}, {{session.title}}, …) and event branding/themes.
- Organizer-managed templates and settings for lifecycle sends already introduced by earlier workflows (submitted, accepted, declined, invited, task assigned).
- Operational audiences derived only from event relationships and state (for example, unconfirmed speakers, overdue tasks, assigned reviewers, or people affected by a schedule change).
- Manual one-off operational sends to either one event contact or an event-scoped, state-derived audience, with the sender, recipients, rendered content, time, and delivery state recorded in communication history.
- Scheduled reminders for incomplete tasks and unconfirmed speakers, respecting the event default/per-requirement override and the rule that unconfirmed speakers receive participation reminders rather than task-specific chasing. Consolidate scheduled task reminders per recipient/event; send urgent change requests, cancellations, and released schedule changes separately.
- Communication routing respects representation: primary managers receive routine operational chasing, while speakers receive personal-action and schedule/calendar messages directly; organizers can intentionally include both.
- Becoming overdue changes dashboard urgency, not reminder frequency; escalation beyond the configured cadence is an explicit organizer action.
- **Calendar invites (.ics METHOD:REQUEST)** for session slots, landing natively in Gmail/Outlook/Apple; updates on reschedule, participant-specific cancellation on withdrawal, and session-wide cancellation when a distributed session is cancelled.
- Comms log per contact (what was sent, when).
- Configurable event reply-to address inheriting an organization default; Cloudflare routes replies to the team's existing inbox. No inbound mailbox or reply threading in StageStack v1.
- Email links open the relevant workflow; no state-changing action executes on the initial `GET`. Identity/access verification and explicit confirmation happen inside StageStack.

## M6 — Agenda builder

Accepted content becomes a conflict-free schedule.

- Rooms & time slots; drag-and-drop placement of accepted sessions.
- Lightweight agenda items for registration, breaks, meals, ceremonies, and similar non-session blocks: title, start/end time, optional room and description. They share schedule drafting, room-overlap checks, and explicit publication, but bypass CFP, review, speakers, participation, tasks, readiness, reminders, and calendar invitations.
- Manually entered virtual/hybrid links with explicit audiences: attendee, speaker/backstage, and organizer/host. Only attendee links may be deliberately published; confirmed participants and their primary managers can access backstage links; event organizers can access all links. V1 does not provision or synchronize conferencing/streaming providers.
- One authoritative event timezone. Organizer scheduling, emails, and public views use and explicitly label event time; speaker portals additionally show the viewer's local equivalent when it differs, and calendar invitations preserve the same timezone-aware moment.
- **Conflict detection**: same speaker double-booked, room overlap, track overlap. Speaker and room collisions may exist during drafting, but are non-overridable blockers for releasing or publicly publishing the affected sessions. Same-track overlap is a visible warning that the organizer may accept in v1.
- Views: list, day, week, track, room. Unscheduled-sessions tray.
- Schedule placement and edits are internal drafts and never trigger communication merely because an organizer changes the board.
- An organizer explicitly releases initial slots or later schedule changes to speakers, individually or in a batch; release triggers the speaker notification and calendar invitation/update via M5.
- Track schedule acknowledgement separately for each speaker from participation confirmation as Awaiting Acknowledgement, Acknowledged, or Conflict. The first released slot and any change to its date or start time reset acknowledgement to Awaiting Acknowledgement; room, track, or wording changes notify/update without resetting it. A Conflict flags the speaker and session for organizer action but does not decline participation; withdrawal remains a separate explicit action. The speaker, their primary manager, or an organizer may respond on their behalf, with actor and time audited.
- Public readiness is per session: Awaiting Acknowledgement warns but does not block; a reported Conflict blocks only that session unless an organizer explicitly overrides it with a recorded reason. Other ready sessions remain publishable.
- Public agenda publication is a separate action from speaker release.
- Explicit unpublish removes a session or agenda item from all public output without cancelling it, changing its internal schedule, or notifying speakers automatically. Preserve publication history.
- After initial publication, edits remain in a private working version with a change preview. The live agenda changes only when an organizer explicitly publishes the update.
- Speaker and primary-manager edits follow the same publication boundary: they update the working version and appear as pending public changes, never silently altering the live agenda.

## M7 — Public content out: API & embeds

Event content flows outward without re-entry.

- StageStack remains authoritative for event workflow state. Public pages, API, embeds, and exports are read-only copies; external systems cannot update records or synchronize changes back. The organizer-reviewed Import flow in M2 is v1's deliberate general inbound path.
- One responsive public event page with a shareable URL and sections for the published speaker/session lineup and agenda. Empty sections remain hidden; this is not a microsite builder.
- The public page, public API, public export, and any optional embed consume one shared published program. Their presentation may differ, but their approved fields, content versions, and visibility decisions do not; v1 has no per-channel content overrides.
- Public lineup publication is independent from timetable publication: accepted sessions and Confirmed event-speaker profiles may be explicitly published before slots exist. Unscheduled sessions appear in session/speaker lists but never in the agenda grid.
- Sessions, agenda items, speaker profiles, and post-event resources may be explicitly unpublished without deleting or cancelling their internal records. Public pages, embeds, exports, and API output must all stop exposing the unpublished content; a still-public session uses “speaker to be announced” when only its speaker profile is unpublished.
- Public read API (sessions, speakers, agenda) ships as a direct projection of the same published program used by the public event page. It serves the last explicitly published version rather than the organizer's working state. Published speaker data comes only from Confirmed participants' event snapshots, preserving privacy and historical output; private backstage and host links are never returned. This is not yet a public mutation API or developer-platform commitment.
- Winning stretch after the core workflow is complete: a minimal snippet embeds the same public lineup or agenda section in an external site. It is not a separately configured embed product; the lineup still does not depend on schedule completion, while the agenda contains only explicitly published slotted sessions and agenda items.
- Post-event content remains attached to its original session: organizers may add a recording URL, select an approved slide deck, attach resources, and explicitly publish each item. Task evidence stays private unless deliberately selected for publication. V1 stores approved files and external links but does not host/transcode video or push to YouTube or a CMS.
- The private Abstracts CSV/XLSX export in M2 is the challenge slice's only non-public export. Broad operational export packs, full-organization backups, Airtable/Sheets synchronization, and other destination connectors are post-v1.

## Explicit non-goals

Registration/ticketing, attendee-facing apps, payments on submissions, exhibitor/sponsor management, CRM/prospect messaging, imported mailing lists, newsletters, promotional campaigns, drip marketing, marketing analytics, in-product inbox/reply threading, multiple concurrent CFP forms, a generic import column-mapping wizard, AI review, multiple/category-specific review rubrics, weighted scoring formulas, automated acceptance recommendations, anonymous/blind review, venue sourcing, speculative speaker sourcing/longlist CRM, agency workspaces, multi-level external delegation, global speaker discovery, cross-tenant profile merging, custom permission builders, agent superuser access, fully local authentication, public microsite builders, custom public domains/layouts, separate embed configuration, broad operational export packs, full-organization backups, live or bidirectional synchronization, external write access, a public mutation API, developer portal/API-key management, webhooks, and SDKs. Integrations beyond the public read API, optional minimal embeds, and the narrow Abstracts export are post-v1.
