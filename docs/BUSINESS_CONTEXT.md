# StageStack — Business Context

## What StageStack is

StageStack is an open source **event content, speaker & abstract management** platform. It covers the workflow between "we're running an event" and "attendees show up": sourcing, evaluating, selecting, and operationalizing an event's content and speakers.

It is a direct alternative to Sessionboard, and competes in the same niche as Sessionize, Lineup Ninja, Oxford Abstracts, Ex Ordo, and the abstract-management modules of suites like Cvent, Bizzabo, and Whova.

## The workflow territory

1. **Call for Speakers / CFP** — public submission forms, collecting session proposals and speaker info.
2. **Review & evaluation** — scoring, statuses, accept/decline queues, decisions.
3. **Speaker operations (post-acceptance)** — the neglected grind: chasing bios, headshots, slides, confirmations via a self-service speaker portal, tasks, and automated communications.
4. **Agenda building** — turning accepted sessions into a conflict-free schedule across rooms, tracks, and time slots.
5. **Content afterlife** — session/speaker data feeding websites, embeds, and post-event publishing.

Creating an event is one fast action requiring only its name, start/end date-times, and authoritative timezone. StageStack generates a unique editable slug and an editable starter CFP in a private draft state; creation exposes nothing publicly. Event type, location, website/description, branding, tags, tracks, rooms, custom fields, CFP dates, limits, and communication settings are configured afterward when needed. Event dates and CFP open/close dates remain separate concepts. The CFP and public agenda have independent publication controls: organizers can open the CFP while the agenda remains private, close the CFP later, and publish or update the agenda without reopening submissions. There is no global Draft/Live event switch: the event is usable internally immediately. **Archive** is the only overall lifecycle action in v1; it removes the event from active work and stops its automations without deleting data or silently changing its published history.

## Two content-entry paths

Every event can acquire program content through two paths:

1. **Public CFP** — an external speaker or representative submits a proposal to an existing event. The proposal goes through review and becomes a session only if the organizer accepts it.
2. **Direct invitation** — the organizer creates a private planned session and invites a speaker or their representative. It starts internally as awaiting response, bypasses the public CFP and review, and remains unpublished until the organizer chooses to publish it.

V1 gives each event one active public CFP form. A new event starts with a usable, editable default containing required identity/session fields and common title, abstract, and speaker information, so an organizer can publish quickly rather than build from an empty canvas. The organizer defines any additional questions, choices, and conditional sections, including whether a choice is single- or multi-select; StageStack does not impose a primary category or submission taxonomy. If an event distinguishes keynotes, workshops, or other submission types, the organizer expresses that through its own fields and routing. V1 has no template marketplace or form-setup wizard. Multiple independently active CFP forms with separate URLs and deadlines are post-v1.

The CFP has only a private working state and a published state, not a version-management interface. Organizer edits become public only after preview and an explicit **Publish changes** action. Already-submitted proposals remain unchanged. Saved drafts retain entered answers when the form changes, but must satisfy the currently published form before submission.

After initial submission, the primary manager may edit and resubmit the proposal until the CFP closes; each update notifies the organizer and the latest submission remains current. The close date locks proposals automatically. An organizer may explicitly reopen one as an exception, with the actor and time recorded.

The primary manager may withdraw a proposal at any time before an acceptance or decline is externally released. Withdrawal requires explicit confirmation, notifies organizers, removes the proposal from active review and decision queues, and preserves it with **Withdrawn** status. Once accepted, cancellation or departure is handled through the session and participant withdrawal workflows instead of rewriting proposal history.

V1 data import is a focused **Import with AI** experience built on StageStack's normal authorized domain tools, not a separate column-mapping product or a global assistant UI. An organizer opens Import, uploads a CSV, spreadsheet, or document, and may explain what it contains; the agent inspects it and plans calls such as finding or creating contacts, proposals, sessions, participants, tracks, tags, and field values. Before bulk writes, it presents what it understood, the exact records it intends to create or safely reuse, uncertainties, suspected duplicates, and skipped rows for organizer confirmation. The same validated tools then execute and return an exact per-record result report. The agent may look up and reuse existing records but cannot bulk-update or delete them in v1; ambiguous matches are surfaced rather than guessed. Import-created records remain private and send no invitations, communications, or publication without a separate explicit action. Manual add remains the fallback. The underlying tools may support a broader agent later without requiring an omnipresent chatbot in the challenge build.

Every agent action is delegated by, and authorized exactly as, the signed-in user; an agent never gains hidden organization-wide or cross-tenant access. A clear instruction may execute routine, reversible private work without an additional confirmation ceremony. Ambiguous bulk interpretation always receives a preview, while actions that cross an external or consequential boundary—publishing, sending communications, releasing decisions, cancelling, withdrawing, or deleting—require an explicit confirmation immediately before execution. StageStack audits the initiating person, the agent-assisted action, and its result.

The paths converge after selection: sessions, participants, portal access, tasks, readiness, communications, and scheduling use the same downstream workflow. Accepting a CFP proposal and confirming that each speaker will participate are separate decisions; an accepted proposal can still have unconfirmed speakers. Participation confirmation is tracked independently for every speaker as **Awaiting Response**, **Confirmed**, or **Declined**. One speaker declining flags the session for organizer attention but does not automatically cancel it or alter the other speakers' confirmations.

For CFP decisions, an organizer may stage a proposal in an accept or decline queue without notifying the submitter or exposing that internal decision. The organizer explicitly releases decisions individually or in a batch; only that release makes the outcome visible and sends the appropriate communication. Submission receipts remain automatic and are not held for release.

A released decision can be reversed, but never silently. The organizer must explicitly release the correction, StageStack sends a clearly identified correction message, and the original and corrected decisions remain in the audit history with their actors and times. If an accepted proposal is corrected to declined, its session moves to **Cancelled** rather than being deleted: StageStack preserves its data and history, removes it from active scheduling and public views, and sends calendar cancellations if invitations were already distributed. If a decline is later corrected to accepted, StageStack restores that same cancelled session—or creates one if none existed—while preserving prior work and history. Every participant returns to **Awaiting Response** and must confirm again; a confirmation made before cancellation is not treated as current consent.

V1 begins the invited path when an organizer decides to send a real invitation. Maintaining speculative speaker longlists and sourcing prospects is not part of StageStack v1.

Schedule placement and edits remain internal drafts until an organizer explicitly releases them to speakers. Releasing a slot or change sends the operational notification and calendar invitation/update; merely editing the schedule does neither. Publishing the agenda to attendees and external sites is a separate organizer action, so speakers can receive their logistics before the program becomes public.

Once an agenda is public, organizer edits continue in a private working version. Organizers can preview what changed and must explicitly publish the update; until then, attendees, embeds, and the public API continue to receive the last published agenda rather than partially completed edits.

Public lineup publication is independent from timetable publication. An organizer may explicitly publish an accepted session and its Confirmed participants to a speaker/session lineup before assigning the session a slot. Unscheduled sessions never appear in the agenda grid; once scheduled and explicitly published there, the same published session and participant identities appear without re-entry.

An organizer may explicitly unpublish a session, agenda item, speaker profile, or post-event resource without cancelling or deleting its internal record. Unpublishing removes that content from public pages, embeds, and API output while preserving its schedule placement, participation confirmations, tasks, and publication history. It does not send speaker communication unless the organizer separately chooses to notify affected people. If a speaker alone is unpublished while the session remains public, the public session uses a “speaker to be announced” placeholder.

The same rule applies when a speaker or primary manager edits an already-public bio, headshot, or shared session content: the change is immediately visible internally as a pending public update, but the last published version remains live until an organizer previews and publishes the change.

Every event has one authoritative timezone, and organizers schedule in that timezone. Emails and public agenda views always label the event timezone explicitly. When a speaker's local timezone differs, their portal also shows the local equivalent while keeping event time primary; calendar invitations represent the same timezone-aware moment so the speaker's calendar can render it locally.

The schedule also supports lightweight **agenda items** for non-session blocks such as registration, breaks, meals, and ceremonies. An organizer supplies a title, start/end time, and optional room and description. Agenda items participate in the same private-working and explicit-publication flow as the rest of the schedule, including room-overlap checks, but they are not proposals or sessions and never acquire speakers, reviews, participation states, speaker tasks, readiness requirements, or calendar/reminder workflows.

For virtual and hybrid sessions, organizers may enter separate access links for three audiences: a public attendee link, a private speaker/backstage link, and an organizer/host link. Only the attendee link is eligible for explicitly published public output. Confirmed participants and their primary managers may access the backstage link, while event organizers may access all three; the host link is never exposed to speakers or the public. V1 stores and delivers these links through the relevant schedule and portal experiences but does not create, configure, or synchronize Zoom, Teams, or streaming rooms.

After the event, the original session remains the home for its content. An organizer may attach a recording URL, select an approved slide deck, add resource links or files, and explicitly publish any of them on the session's public page. Speaker-task submissions remain private operational evidence by default and never become public merely because they were provided or approved. V1 stores approved files and external links; it does not host or transcode video or push content into YouTube, a CMS, or another publishing service.

V1 integrations expose public program content only: the published lineup, speaker profiles, agenda, attendee links, and explicitly published post-event resources. The one narrow non-public export retained for the challenge is CSV/XLSX from the organizer's Abstracts table, as shown in the walkthrough. Broad operational export packs, full-organization backups, Airtable/Sheets synchronization, and other data-destination connectors are later work rather than challenge scope.

StageStack remains the source of truth for all event workflow state. Public APIs, pages, embeds, and exports are read-only copies of explicitly published data; an external website, registration platform, spreadsheet, or content system never becomes authoritative. V1's only general inbound bridge is the organizer-reviewed Import flow, which writes through StageStack's normal authorized actions. There is no live bidirectional synchronization or external write access.

All public channels consume one shared published version of that program. V1 presents it through one responsive public event page with sections for the published lineup, sessions, and agenda; sections with no published content remain absent. The page has one shareable URL rather than becoming a configurable event microsite. If challenge-critical work is complete, the same sections may also be offered through a minimal embed snippet. The public page, optional embeds, public API, and public export expose the same approved fields, content versions, and visibility decisions. Publishing or unpublishing changes the shared public truth rather than creating a channel-specific copy; custom domains, page builders, channel-specific layouts, field visibility, and content overrides are outside v1.

Each speaker's acknowledgement of the released schedule slot is tracked separately from their participation confirmation as **Awaiting Acknowledgement**, **Acknowledged**, or **Conflict**. The first released slot, or a later change to its date or start time, returns that speaker's schedule acknowledgement to Awaiting Acknowledgement. Changes such as room, track, or wording still notify the speaker and update the calendar where relevant, but do not reset acknowledgement of their availability. Reporting a Conflict flags the speaker and session for organizer action without changing the speaker's participation confirmation; withdrawing from the event is a separate explicit action. The speaker, their primary manager, or an organizer may acknowledge the slot or report a conflict on the speaker's behalf, and StageStack records the actor and time.

Public agenda readiness is evaluated per session rather than as an all-or-nothing event gate. Awaiting Acknowledgement produces a prominent warning but does not block publication. A reported Conflict prevents only the affected session from being published unless an organizer explicitly overrides it with a recorded reason; other ready sessions can still be published.

A participant whose participation is **Awaiting Response** or **Declined** is never named or profiled in public output. The organizer may still publish the session with its confirmed participants and use “speaker to be announced” for the remaining slot. Participation confirmation shows exactly which event-profile fields may become public and makes that profile eligible for publication; v1 does not add a separate public-profile approval state. Confirmation does not publish anything automatically—the organizer decides when to include the confirmed participant in a public update.

Withdrawal is a safety exception to the normal pending-publication boundary. If an announced speaker withdraws, StageStack immediately suppresses that person's name and event profile from public output, cancels only their calendar participation, and alerts the organizer. The session remains visible with its other confirmed participants or a “speaker to be announced” placeholder and is flagged for attention rather than automatically cancelled.

Impossible structural collisions may exist temporarily while the schedule is being drafted, but they cannot be overridden at release time. StageStack blocks releasing or publicly publishing affected sessions when the same speaker is scheduled simultaneously or when sessions overlap in the same room; the organizer must resolve the collision first. Overlapping sessions in the same thematic track produce a warning rather than a blocker because a track may be a category rather than an exclusive sequential program; the organizer decides whether that overlap is intentional in v1.

Post-acceptance tasks have two scopes. A **participant task** is independently owed by each applicable speaker, such as providing a bio, headshot, travel details, or personal release. A **session task** represents one shared deliverable, such as the final slide deck, and has one accountable assignee—by default the session's primary manager—so co-speakers do not receive duplicate requests for the same work.

A participant task remains attached to the speaker it is for, independently of which account performs the work. The speaker, their primary manager, or an organizer may complete it on the speaker's behalf; StageStack records the completing actor and time. Reassigning the primary-manager responsibility therefore does not move, duplicate, or recreate the speaker's task.

Applicable task requirements are created when an acceptance or direct invitation is formally released, making readiness visible to organizers and primary managers immediately and allowing them to work ahead. An unconfirmed speaker receives only invitation or participation reminders; participant-task reminders begin only after that speaker confirms.

In v1, each event requirement has one concrete default deadline, which an organizer may override for an individual participant or session. Relative rules such as “30 days before the event” are a later template convenience; when introduced, they resolve to the same concrete per-task deadline rather than changing the task model.

Event requirements are independent definitions. A later organization-level library may provide reusable templates, but using one copies a snapshot into the event; organizers can customize it without affecting the library, and later library edits never rewrite an active or historical event. V1 can ship event-level definitions before exposing that reusable library.

Task reminders inherit one event-wide default cadence, while organizers may override or disable reminders for a particular requirement. Only outstanding, currently actionable work generates reminders; StageStack stops them immediately when the requirement is completed, the participant withdraws, or the session is cancelled.

StageStack avoids notification fatigue by consolidating scheduled task reminders into one message per recipient and event for each reminder run, grouped by speaker and session with direct links to the outstanding actions. Immediate operational notices such as a change request, cancellation, or released schedule change remain separate because they should not wait for a digest.

For a represented speaker, the primary manager receives routine operational task reminders by default. The speaker still receives messages requiring their personal action as well as schedule notices and calendar invitations delivered to their own calendar. An organizer may deliberately include both people, but StageStack does not duplicate every reminder automatically; a speaker claiming portal access does not displace the manager or silently opt the speaker into all routine email.

Crossing a deadline changes the requirement to **Overdue** and raises its visibility and urgency for organizers, but does not automatically increase email frequency. The configured cadence continues unless an organizer deliberately changes it or sends a targeted manual reminder.

StageStack distinguishes evidence being **Provided** from its quality being approved. It can observe objective facts such as a required field being present, a file being uploaded, a form being submitted, or participation being confirmed, but it does not claim that a bio, headshot, deck, or response is suitable. Each content requirement can optionally require organizer review, producing **Approved** or **Changes Requested** after submission; review is off by default in v1, so Provided counts as complete unless the organizer explicitly enables it. Manual work that StageStack cannot observe remains a manual task.

Only an event organizer can approve a review-required submission or request changes. Speakers and primary managers may submit and resubmit but cannot approve. A change request requires an explanatory note and notifies the responsible people; StageStack records every submission, approval, change request, actor, and time. V1 does not add a separate approver role or require a second organizer.

Resubmitting a file, form, or other reviewed artifact never overwrites its history. The newest submission becomes the current internal version, while organizers can inspect prior versions, feedback, actors, and times. Approval belongs to an exact version: replacing an approved item returns the requirement to **Provided / Awaiting Review**. The previously approved version remains live publicly until an organizer approves and publishes the replacement.

Session readiness is derived from its underlying facts rather than manually selected. **Ready** means required work is complete or approved, required participants are confirmed, and no known conflicts remain. **Needs Attention** identifies missing or overdue work and pending participation or schedule responses. **Blocked** identifies a reported availability conflict, a withdrawal that still requires resolution, or an impossible schedule collision. StageStack exposes the exact reasons; an organizer resolves or legitimately waives the underlying item rather than manually turning the session green.

An event organizer may mark one task requirement instance **Not Applicable** for a specific participant or session, with a required reason and audit history. That instance counts as satisfied and stops reminders without changing the requirement for anyone else. Participation confirmation, reported availability conflicts, and hard schedule collisions cannot be waived through this mechanism.

## Market structure (two axes)

- **Academic peer-review pole** (Oxford Abstracts, Ex Ordo, Fourwaves, Cadmium): rigorous multi-round review is the product; workflow largely ends at acceptance.
- **Modern speaker-ops pole** (Sessionboard, Lineup Ninja, Sessionize): the real pain is everything *after* acceptance.
- **Standalone best-of-breed** (Sessionize, Sessionboard) vs. **all-in-one suites** (Cvent, Bizzabo): best-of-breed content engines integrate into registration platforms rather than replacing them.

**StageStack's position: speaker-ops pole, standalone best-of-breed, open source.** We do not build registration, ticketing, or attendee apps.

## Design-partner customer: AI Engineer

AIE runs the World's Fair (~7,000 attendees, 9 tracks, 5 simultaneous stages), NY/London Summits, and partner conferences — organized by a very small team. They currently pay >$40k/yr for Sessionboard and are actively trying to replace it (see CHALLENGE.md).

Documented pains from swyx's 2024 organizing retro (swyx.io/aiewf-2024):

- **No single source of truth**: up to 5 spreadsheets tracking speakers, rooms, and time assignments.
- **Speaker logistics failures**: missing contact info caused a keynote speaker to miss their own talk.
- **Late confirmations**: speakers confirmed days before the event, cascading into scheduling chaos.
- **Dual pipeline**: ~500 CFP submissions (~6% accepted) *plus* invited outreach from per-track target lists; wave-based acceptances (deferred ≠ rejected). Tools only model the inbound half.
- **Content flywheel**: 10M+ YouTube views/yr of talks; session metadata → published content is a first-class need, not an afterthought.

## People, tenancy & access

StageStack must work both as a multi-tenant hosted product and as an independent self-hosted deployment. Within a deployment:

- An **account** is a login identity. The same account can participate in multiple organizations, but receives no organization or event access merely by existing.
- An **organization** is the customer workspace and owns its contacts and event data. There is no cross-tenant, searchable speaker registry.
- A **contact** is a person known to an organization and can be reused across that organization's events. A contact can exist without an account. Its current organization-level profile prefills new event participation, while each event retains its own publishable profile snapshot so later edits never silently rewrite historical events. Updating an active event profile also refreshes the current organization profile for future events, but never changes any other event snapshot.
- **Speaker, moderator, panelist, submitter, reviewer, and organizer describe scoped participation or responsibility**, not permanent account types. One person may hold different roles in different events.
- The person appearing on stage and the account managing their event work may be different. A submitter, executive assistant, marketing teammate, agent, or organizer can manage a proposal or invited speaker on someone else's behalf.

An authenticated user has one lightweight **My StageStack** home across organizations and events, grouped by responsibility: submissions, speaking engagements and tasks, review assignments, and events they organize. Invitations deep-link to the relevant item. The challenge UI may show only one event, but must not establish a separate account experience per event or tenant.

For v1, each submission or directly invited speaker has one primary manager, while organizers retain management access. Before a CFP submission is accepted, the primary manager is its only external editor; listed participants are not required or invited to create accounts. After acceptance, each speaker may be invited to access their portal, but claiming an account is optional and does not have to displace their representative. An invited speaker can update only their own profile, participation confirmation, uploads, and assigned tasks. The primary manager controls shared session content; organizers can edit everything. A speaker, their primary manager, or an organizer may record that speaker's confirmation or decline; StageStack records who changed it and when.

Only an organizer can reassign the primary-manager responsibility in v1. The existing manager retains access until the invited replacement accepts, preventing a lockout. Once accepted, the previous manager loses management access unless they independently participate as a speaker. StageStack records the actor and time of the handoff.

The v1 boundary is deliberately narrow: no agency workspaces, multi-level delegation, user impersonation, global speaker discovery, automatic cross-tenant profile merging, or custom permission builder. Organizers instead receive a clearly labeled, read-only preview of a speaker's portal; any correction is made through the admin interface under the organizer's own identity. The product model must leave room for multiple managers and richer delegation later without equating a speaker with a user account.

### Internal team access in v1

- **Organization owner/admin** — manages the workspace, organization-wide administrators, ownership, and every event.
- **Event organizer** — fully manages the events to which they are assigned and may invite co-organizers or reviewers scoped only to those events. They cannot grant organization-wide admin access or manage organization ownership.
- **Reviewer** — sees and scores only the submissions assigned to them. Review access includes proposal content, evaluation files, and the speaker's professional identity (name, role, company, and bio), but excludes private operational data such as email, phone, travel, contracts, tasks, and communication history. Reviewers evaluate independently and see only their own scores and comments, both before and after submission; organizers can see individual reviews and aggregates.

These responsibilities are scoped relationships rather than exclusive account types, so one account may be both an organizer and reviewer for the same event. Custom roles, granular permission configuration, and anonymous/blind review are post-v1.

An evaluation moves through **Draft**, **Submitted**, and **Locked**. A reviewer can save a Draft; organizers see whether work has started but not its unfinished scores or comments. Submitted work counts toward organizer aggregates and may be revised by its reviewer until the review round closes, with each version preserved. Closing the round locks reviews; an organizer may explicitly reopen one, with the action and reason audited.

V1 uses one simple event-level review setup: assigned reviewers provide a required score and recommendation with optional comments; organizers see completion, individual reviews, and a simple aggregate, then make the actual decision. The reviewer works on one fast, autosaving screen and can use **Submit & Next** to advance directly through assignments—there is no multi-step review wizard. Organizers assign reviewers manually to individual or selected groups of submissions through a bulk action. It does not include multiple or category-specific rubrics, weighting, custom formulas, automated acceptance recommendations, load balancing, or assignment routing.

### Authentication provider boundary in v1

Clerk provides authentication for the challenge and hosted v1: user identity, verified-email sign-in, sessions, account linking, and internal organization membership/invitations. StageStack remains authoritative for all product authorization and domain relationships, including contacts without accounts, events, submissions, participants, representatives, primary managers, event organizers, reviewers, portal claims, and audit history.

Clerk Organizations back internal workspace membership, but speakers, representatives, submitters, and external reviewers do not become Clerk Organization members merely because they participate in an event. StageStack roles and access are not stored as Clerk metadata or treated as permanent identity attributes.

A verified user who signs up without an invitation can create an organization and becomes its owner/admin. A user arriving through a CFP, speaker, representative, or reviewer invitation goes directly to that responsibility and is not prompted to create a workspace. The same account may create or join organizations later.

The StageStack application is open source and self-hostable in v1, but authentication has an explicit hosted dependency: self-hosters supply their own Clerk application and credentials. The identity boundary must remain provider-neutral so a fully local authentication provider can be supported later without rewriting the StageStack account or authorization model.

### Email channel boundary in v1

Clerk sends authentication and email-verification messages. Resend (via the Convex Resend component) sends StageStack's transactional product email for the challenge and hosted v1, including delivery-event tracking that feeds StageStack's communication history. Resend is a replaceable delivery provider, not the communication system of record; self-hosters must supply their own Resend account and verified sending domain.

StageStack owns why each communication was sent, its recipient and event context, rendered content, secure destination, send and delivery state, and the resulting business action. Required messages ship with the workflows that need them; the later communications milestone makes the channel configurable through templates, audiences, scheduling, reminders, and searchable history.

StageStack communications are strictly event-operational. Every recipient must already have an event relationship or responsibility, such as submitter, speaker, representative, reviewer, or organizer. StageStack is not a CRM or marketing platform: v1 has no imported mailing lists, prospect messaging, newsletters, promotional campaigns, drip marketing, or marketing analytics.

Organizers may also send a one-off operational message to one event contact or to an event-scoped audience derived from workflow state, such as accepted speakers who have not confirmed. Each send is recorded with its recipients, rendered content, event context, sender, time, and delivery state; this does not permit arbitrary lists or marketing audiences.

Each event has a reply-to address that inherits an organization default. Replies route to the team's existing inbox via that reply-to address; StageStack does not ingest, display, or thread inbound messages in v1. Its communication history covers outbound content and delivery state. An in-product operational inbox can be reconsidered later if real customer use justifies it.

An email link safely opens the relevant StageStack workflow. Merely following a `GET` link never accepts, declines, confirms, completes, or otherwise mutates business state: StageStack verifies identity and access, then requires an explicit confirmation for state-changing actions. This protects against email scanners and automatic link previews.

## Product principles

1. **Single source of truth** — speakers, submissions, sessions, rooms, and schedule live in one place; exports/embeds derive from it.
2. **Post-acceptance is half the product** — tasks, chasing, and readiness tracking get first-class treatment.
3. **Fast** — lean pages, no heavy-SPA sluggishness, minimal setup, sensible defaults, and bulk actions for repetitive work. This is a startup-focused product: speed to operate is as important as page performance.
4. **Open source & self-hostable application** — cheap to run forever; no per-event ransom pricing. V1 uses explicitly disclosed external dependencies (Clerk authentication, Convex backend, Resend email delivery); fully local replacements are post-v1.
5. **API- and tool-first** — every meaningful read or action in the UI is implemented once as an authorized domain capability that can also back APIs, integrations, embeds, and agent tools. Agents orchestrate those same validated product capabilities rather than bypassing business rules or writing directly to data. V1 ships the public read API and makes authorized actions agent-callable; it does not need to productize a public mutation API, developer portal, API-key management, webhooks, or SDKs yet.
