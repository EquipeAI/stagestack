# StageStack — Product Milestones

Product-led decomposition of what StageStack needs, in build order. Each milestone is independently demoable and maps to a business capability, not a technical layer. PLAN.md pulls its current tasks from exactly one milestone at a time.

Dependency spine: **M0 → M1 → M2 → M3 → M4/M5 (parallel) → M6 → M7**. M3 (portal) unlocks both speaker ops (M4) and comms (M5).

## M0 — Foundation: event & library

An organizer can create an event and define its vocabulary.

- Event: name, slug, type, location, timezone, start/end dates, images.
- Library shared across the event: **tracks, tags, rooms, custom fields**.
- Team members with admin access. (Multi-org/multi-event from day one in the data model; single org in the UI is fine initially.)

## M1 — CFP: forms & public submission

A speaker can submit a proposal; the organizer controls the form.

- Form builder: sections, shown field types (text, wysiwyg, dropdown, email, phone, file), required toggles, locked system fields, **conditional logic / category routing**.
- Public multi-step wizard: Welcome → Account → Submission → Participant(s) → Review. Mobile-friendly, fast.
- Form settings: open/close dates, per-user submission limits, drafts, custom success page.
- Confirmation email to submitter; admin notification on new/updated submission.
- Multiple concurrent forms per event (e.g. keynotes vs. workshops).

## M2 — Review: evaluation & decisions

The team can go from a pile of submissions to accept/decline decisions.

- Abstracts admin table: search, filter, sort, saved views, column preferences, export CSV/XLSX, manual add, import.
- Status pipeline: Draft → Pending → Accept/Decline Queue → Accepted/Declined; Withdrawn. Queues let decisions batch before notifications go out (wave-based acceptance).
- Evaluation plans: assign reviewers, score submissions, aggregate ratings.
- Decision → notification (templated accept/decline emails) → portal state change.

## M3 — Speaker portal

A speaker can self-serve everything the organizer would otherwise chase.

- Auth for speakers (magic link — speakers should never manage passwords).
- My submissions + statuses; edit profile (bio, headshot, social links).
- Tasks assigned to me (see M4); portal forms; file uploads (slides, contracts).
- Admin impersonation ("view as speaker").

## M4 — Speaker ops: tasks & readiness

The organizer always knows who owes what. (The anti-"5 spreadsheets" milestone.)

- Task definitions assignable to contacts, groups, or submissions (e.g. "Upload slides", "Confirm travel").
- Auto-assignment on acceptance; due dates.
- File requests with stored uploads.
- **Speaker-tracking dashboard**: accepted speakers, outstanding tasks per speaker, missing bio/headshot, overdue list.

## M5 — Communications

Nobody misses their talk because of a lost email.

- Email templates with variables ({{speaker.name}}, {{session.title}}, …) and event branding/themes.
- Transactional sends on lifecycle events (submitted, accepted, declined, task assigned).
- Scheduled reminders for incomplete tasks / unconfirmed speakers.
- **Calendar invites (.ics METHOD:REQUEST)** for session slots, landing natively in Gmail/Outlook/Apple; updates on reschedule.
- Comms log per contact (what was sent, when).

## M6 — Agenda builder

Accepted content becomes a conflict-free schedule.

- Rooms & time slots; drag-and-drop placement of accepted sessions.
- **Conflict detection**: same speaker double-booked, room overlap, track collisions.
- Views: list, day, week, track, room. Unscheduled-sessions tray.
- Schedule change → speaker notification/calendar update (via M5).

## M7 — Content out: API & embeds

Event content flows outward without re-entry.

- Public read API (sessions, speakers, agenda) — API-first; the UI already eats it.
- Embeddable speaker gallery + schedule for external sites.
- Airtable one-way sync/export.
- Full data export (no lock-in — it's open source, act like it).

## Explicit non-goals

Registration/ticketing, attendee-facing apps, payments on submissions, exhibitor/sponsor management, AI review, venue sourcing. Integrations beyond export/API are post-v1.
