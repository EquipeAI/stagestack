---
name: stagestack
description: Run a conference or event through StageStack's MCP server — check what blocks the programme from being published, chase speakers who owe bios, headshots or slides, track review-round progress, place sessions on the agenda, and edit session content. Use whenever the user asks about their event's proposals, reviews, speakers, speaker tasks, schedule, agenda conflicts, or public programme, or when StageStack tools (list_events, task_dashboard, agenda_board, publish_state, …) are connected.
---

# Running an event with StageStack

StageStack runs events end to end: a call for papers collects proposals from
speakers, review rounds score them, accepted proposals become sessions, speakers
owe tasks (bio, headshot, slides), the agenda board places sessions into rooms
and time slots, and a publish step pushes the public programme.

The MCP tool schemas carry the syntax. This skill carries the workflows and the
rules that keep you from doing damage.

## Before anything else

1. Call `list_events` to get the `eventSlug` almost every other tool needs. An
   event-scoped key returns exactly one event.
2. Call `get_event` when the answer is time-sensitive. Every date any tool
   returns is epoch milliseconds; `get_event` gives you the event's timezone to
   render them in, and the call-for-papers window in the same units. It also
   reports `yourRole` on that event — read it before planning anything, because
   most tools are organizer-only (see below).
3. Have a name but no slug or id? Use `search` first.

## Operating rules

- **`capped: true` means your answer is incomplete.** Any list that can stop
  short says so. Never report a capped list as "the sessions" or "the
  outstanding tasks" — say it is a sample, and narrow the question (filter by
  status, ask about one session) rather than guessing at the remainder.
- **Most tools need the organizer role, and the writes need an
  organizer-ceiling key too.** Four tools write: `update_session_content`,
  `schedule_session`, `approve_task`, `request_task_changes`. Every one of them
  and most of the reads refuse a key whose holder is only a reviewer on the
  event. A read-ceiling key is refused on all four writes. All of those
  refusals arrive as the same sentence — "This API key does not have access to
  that." — so read `yourRole` from `get_event` and the key's ceiling from
  whoever gave it to you rather than probing. These are minting and membership
  decisions, not something to work around.
- **Every write is live the moment it returns.** There is no draft, no
  confirmation step and no undo call. Each is reversible by making the opposite
  change: content edits keep a revision history, a placement can be moved or
  cleared, a review decision can be re-made.
- **`request_task_changes` emails a real person.** It mails whoever owes the
  work — or their manager, or the event's organizers — with your note included.
  Draft the note as a message to the speaker, get the user's agreement to the
  wording before you send it, and remember the mail cannot be recalled.
- **`update_session_content` on an already-published event changes the public
  page at once.** Check `publish_state` first if you are unsure whether the
  programme is live. It never publishes an event that was not already published.
- **Nothing here can send campaigns, publish, or touch membership.** No tool
  sends outreach email, publishes or unpublishes the public programme, invites
  anybody, adds or removes team members, or deletes anything. Those stay with a
  signed-in human in the web app. Say so plainly rather than half-doing them.

## Workflow: morning readiness sweep

The daily "where does this event stand" answer.

1. `list_events` — pick the event.
2. `task_dashboard` — per-speaker and per-session readiness, headline totals,
   and the current blockers (draft content, unscheduled sessions, schedule
   conflicts). This is the spine of the report.
3. `list_task_reviews` — with no status it returns `provided`: work speakers
   have submitted that is waiting on an organizer's decision. That queue is
   usually the fastest thing the user can clear.
4. `publish_state` — whether the public programme is stale, and what publishing
   would change.

Report the blockers first, then the review queue, then what publishing would
change. Do not chase anybody before this sweep — the dashboard usually shows the
chase is already answered.

## Workflow: review round check

`review_progress` is the entry point, and it is the one tool that answers
differently for the two roles. Check `scope` in its reply.

**Organizer key** (`scope: "whole event"`):

1. `review_progress` — per-proposal counts (assigned, submitted, conflicts,
   average score) plus a per-reviewer completion board, which is how you answer
   "who has not finished reviewing".
2. `list_proposals` with a `status` filter for the shape of the pipeline:
   `draft` → `pending` → `acceptQueue` / `declineQueue` → `accepted` /
   `declined` → `withdrawn`. "Still waiting on a decision" is `pending`.
3. `get_proposal` on anything that looks stuck or contested — it returns the
   call-for-papers answers, the speakers, and links to uploaded files.

**Reviewer key** (`scope: "your assignments only"`): you get that reviewer's own
assignments — proposal title, status and round — and that is the whole review
surface available to you. `list_proposals`, `get_proposal`, `list_sessions`,
`task_dashboard`, `agenda_board`, `publish_state` and `list_task_reviews` are
organizer-only and will refuse. Answer from the assignments list, say plainly
that a reviewer key cannot see the rest, and do not retry the organizer tools
hoping for a different answer. `list_events`, `get_event` and `search` still
work.

Releasing decisions to speakers is a human step in the web app for either role.
Prepare the list; do not imply you can send it.

## Workflow: chase missing speaker tasks

1. `task_dashboard` — who is missing a bio or headshot, whose tasks are
   outstanding or overdue.
2. `list_task_reviews` — the only tool that emits the `taskId` the two task
   write tools need. It is ordered by due date, soonest first; when it comes
   back `capped: true`, the tasks you did not get are the ones due latest.
3. Decide per task:
   - work submitted and good → `approve_task` (sends nothing);
   - work submitted but wrong → `request_task_changes` with a note.

`request_task_changes` is the one tool in this server that notifies a person.
Write the note as a message to the speaker: name the task, say precisely what
has to change, and keep it to something you would be happy to have sent under
the organizer's name. Show it to the user first. It is stored on the task and
shown to the speaker, up to 2000 characters — a longer note is refused rather
than trimmed.

## Workflow: prep, then schedule

1. `agenda_board` — rooms, tracks, what is already placed, the tray of
   unscheduled sessions, and any derived conflicts.
2. `schedule_session` — place a session in a slot (epoch milliseconds, room by
   name exactly as `agenda_board` reports it), or pass `slot: null` to send it
   back to the tray. A placement is internal: it emails no one, publishes
   nothing, and re-issues no calendar invitation. Telling speakers about a slot
   is a separate, deliberate act by an organizer in the web app.
3. `agenda_board` again — the write does **not** check for clashes, so this
   second read is how you find the speaker double-booking or room clash your
   placement just created. Fix it before you report success.

## Workflow: what would publishing change

`publish_state` answers both halves: `state` gives the published-lineup and
published-agenda flags, the version currently served, and whether it is stale;
`diff` lists exactly what publishing would add, change and remove per channel.

Use it before any content edit on a live event, and to answer "is the public
page up to date". You cannot publish — present the diff and let the organizer
press the button.

## When a call is refused

The refusals are short sentences by design. The useful ones:

- "This API key does not have access to that." — the one sentence for every
  authorization refusal: a read-ceiling key attempting a write, an
  organizer-only tool called with a reviewer's key, wrong organization, or the
  wrong event for an event-scoped key. Key permissions are re-derived from the
  minter's live membership on every call, so this can also mean their role
  changed. Report which of these it is only if you know; otherwise say the key
  is not permitted that call.
- "That API key was revoked." / "That API key has expired." — stop and tell the
  user; nothing you retry will work.
- "Too many API calls — slow down." — the key's bucket is empty. It refills at
  300 calls a minute and holds a burst of 600, so pause and continue rather
  than retrying immediately.
- "This event has more records than one read can return, so no complete answer
  is available." — the tool refuses rather than answer partially. Ask a
  narrower question.
- "That request could not be completed." — the generic sentence. Report it as
  is; do not invent a cause.
