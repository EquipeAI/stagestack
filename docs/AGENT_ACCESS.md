# StageStack — Agent access

Mint an API key in org settings, run one command, and your own agent operates
your events through the same authorized capabilities the web UI uses. StageStack
serves a hosted [MCP](https://modelcontextprotocol.io) endpoint straight from
its Convex deployment; the key travels as a bearer token.

## 1. Mint a key

**Org settings → API keys** (org admins only). You choose three things:

| Choice | What it means |
|---|---|
| Name | A label in the key list. Nothing depends on it. |
| Scope | The whole organization, or one event. |
| Ceiling | **Read** — everything you can see, and no changes. **Organizer** — can also make reversible changes, never more than your own live role allows. |

Optionally an expiry. The full key is shown **once**, at mint; StageStack keeps
only its SHA-256, so a lost key is replaced, never recovered.

## 2. Connect your agent

The endpoint is your deployment's Convex **site** origin plus `/mcp` — the
`.convex.site` twin of your `VITE_CONVEX_URL`, e.g.
`https://scintillating-heron-597.convex.site/mcp`. The connect panel next to the
key list fills your deployment's URL into the commands below; copy from there
rather than guessing the origin.

Export the key first:

```bash
export STAGESTACK_MCP_KEY=ssk_…
```

**Claude Code**

```bash
claude mcp add --transport http stagestack https://<your-deployment>.convex.site/mcp --header 'Authorization: Bearer ${STAGESTACK_MCP_KEY}'
```

The **single quotes are load-bearing**. They stop the shell expanding `${…}` at
add time, so what is written to Claude Code's config file is the literal
reference; Claude Code resolves the variable from the environment each time it
connects. Double quotes would expand in the shell and store the secret on disk.

**Codex**

```bash
codex mcp add stagestack --url https://<your-deployment>.convex.site/mcp --bearer-token-env-var STAGESTACK_MCP_KEY
```

Same variable, same reason: Codex reads `STAGESTACK_MCP_KEY` from the
environment at connect time, so the key is not written into its config either.

Codex approves MCP tool calls using the annotations each tool declares.
StageStack's read tools are marked `readOnlyHint: true` and its reversible
writes `destructiveHint: false`, so `codex exec` runs them without prompting.
The one exception is `request_task_changes`, which sends email: it is marked
`openWorldHint: true`, and non-interactive Codex will refuse it ("user
cancelled MCP tool call") — run Codex interactively to approve it, exactly as
intended.

**Anything else.** Any client that speaks streamable-HTTP MCP: point it at the
URL and send the key as a bearer token.

```
https://<your-deployment>.convex.site/mcp
Authorization: Bearer YOUR_KEY
```

Prefer a client that reads the token from the environment. A pasted secret lands
in shell history _and_ in the client's config on disk, where it outlives every
decision the minting screen just made.

**claude.ai — when OAuth lands.** claude.ai custom connectors require OAuth, not
bearer keys, so the browser product cannot use this endpoint yet. OAuth 2.1 is a
deliberate deferral, not a design gap: authentication is one function in front of
the MCP handler, and the same `/mcp` URL takes OAuth in front of the API-key path
without touching a single tool.

**The skill.** `skills/stagestack/SKILL.md` in this repo teaches an agent the
workflows over these tools — the morning readiness sweep, chasing speaker tasks,
scheduling and checking for conflicts. Install it alongside the server; the tool
schemas carry the syntax, the skill carries the judgement.

## The key model

- **A key acts as the person who created it, and never above them.** Membership
  and role are re-resolved from the live record on every call. Demote that
  person and their keys narrow; remove them from the org and their keys stop
  working. (Org-owned service identities are a later answer.)
- **The ceiling is write authority.** `read` grants the minter's live _read_
  access and refuses every write. `organizer` allows the four write tools —
  still clamped to the minter's live role, so an organizer-ceiling key minted by
  someone since demoted to reviewer is refused by the capability layer.
- **Event-scoped keys stay in their event.** A key bound to one event refuses
  every other event outright — the key's own scope is checked before the
  event's membership is resolved, though the minter's org membership has
  already been re-derived by then, as it is on every call. `list_events`
  through such a key returns exactly that one event.
- **Revocation is immediate.** The key row is read on every call, so an agent
  mid-session stops at its next tool call. Expiry works the same way.
- **50 active keys per organization.** Revoking always frees a slot: revoked
  keys are history and never counted. Expiry frees a slot too, but only while
  the org holds 50 or fewer unrevoked rows — past that the mint is refused
  whatever the expiries say, so revoke the dead keys rather than letting them
  expire in place. A credential that exists but does not appear in the
  management list would be a credential nobody can revoke, which is what the
  ceiling exists to prevent.
- **Last used** is recorded at five-minute granularity, deliberately: the field
  answers "is this key still in use?", and writing it per tool call would turn
  every read into a write.

## Rate limits

- **A token bucket per key: refills at 300 calls per minute, holds up to 600.**
  So a rested key can burst 600 calls, and sustained traffic settles at 300 a
  minute. An empty bucket answers `Too many API calls — slow down.` (HTTP 429)
  until it refills.
- The budget is spent **once per HTTP request**, before the request reaches a
  tool — so a write costs exactly what a read costs.
- **JSON-RPC batch arrays are refused**: `Send one JSON-RPC message per request
  — batched arrays are not supported.` Batching was removed from MCP in
  2025-06-18; one batched body would let a single token buy N tool calls, and
  with the write tools, N writes. Every client we serve sends one message per
  request.

## The tools

Fifteen curated tools, not a mirror of the ~150-function backend. Every one is a
thin call into the same `convex/model/*` capability the web UI calls, returning
an explicit projection — never a raw document. Lists that can stop short carry a
`capped` flag, and a capped list is a sample, not an answer.

**Timestamps come in pairs.** Every epoch-milliseconds field a tool emits
(`startsAt`, `endsAt`, `dueAt`, `publishedAt`, `submittedAt`, `updatedAt`,
`withdrawnAt`, `cfpOpenAt`, `cfpCloseAt`, `asOf`, ...) travels with an
`<field>Iso` sibling — the same instant rendered as an ISO-8601 string in the
event's own timezone, UTC offset included, e.g. `2026-10-13T09:00:00-03:00`.
The Iso field exists because a model reading a raw epoch number next to a
separate timezone string has to do calendar arithmetic in its head, and at
least one misread a demo event's month doing so. Agents should read dates from
the Iso form and keep the numeric form for sorting and arithmetic; the numeric
fields are unchanged and remain authoritative. `schedule_session`'s *input*
still takes epoch milliseconds.

| Tool | What it answers or does | Ceiling |
|---|---|---|
| `search` | Finds events by name; with an `eventSlug`, also that event's sessions, speakers and proposals. Start here when you have a name but no id. Minimum two characters. | Read |
| `list_events` | Every event this key can reach, with slug, dates, timezone, archived state. The source of the `eventSlug` other tools need. | Read |
| `get_event` | One event's full settings: dates, timezone, location, description, the call-for-papers window, and the role the key holds on it. | Read |
| `list_proposals` | Every proposal in the call for papers, with status and speaker count; filterable by status (`draft` → `pending` → `acceptQueue`/`declineQueue` → `accepted`/`declined` → `withdrawn`). | Read |
| `get_proposal` | One proposal in full: its form answers, its speakers, who submitted it, links to uploaded files. | Read |
| `review_progress` | How far review has got: per-proposal counts and a per-reviewer completion board (organizer key), or that reviewer's own assignments (reviewer key). | Read |
| `list_sessions` | Every session on the programme with its participants and each speaker's state (awaiting / confirmed / declined / withdrawn). | Read |
| `task_dashboard` | Speaker readiness and what blocks the programme: missing bios and headshots, outstanding and overdue tasks, draft content, unscheduled sessions, conflicts. The morning-sweep tool. | Read |
| `agenda_board` | The schedule grid: rooms, tracks, placed sessions, the unscheduled tray, and derived conflicts. | Read |
| `publish_state` | What the public page serves now versus what it would serve if published — flags, served version, staleness, and a per-channel diff. `state` carries two count pairs with different semantics: `servedSessionCount`/`servedAgendaItemCount` count entries actually on the public page (the population the diff's `servedCount` describes), while `flaggedSessionCount`/`flaggedAgendaItemCount` count records whose per-record publication flag is on — eligibility for the next publish. They legitimately diverge: the served agenda mixes scheduled sessions (session flags) with standalone agenda items (agenda-item flags), so six served agenda entries beside zero flagged agenda items is consistent, not a data bug. (These replace the former `publishedSessionCount`/`publishedAgendaItemCount`, which reported the flag counts under a name that read as served counts.) | Read |
| `list_task_reviews` | Speaker tasks in one review state (default `provided`: submitted, awaiting decision), due date first. The only tool that emits the `taskId` the task write tools need. | Read |
| `update_session_content` | Edits a session's title, description, format or length. Live at once. Title, description and format changes are snapshotted in the session's revision history; a length (`durationMinutes`) change is a scheduling fact and is not versioned, so a duration-only edit leaves no revision to restore from. On an **already-published** event this updates the public page immediately — exactly as the same edit in the web app does. It never publishes an unpublished event. | Organizer |
| `schedule_session` | Places a session in a time slot and room (room by name), or `slot: null` to unschedule. An internal draft: emails nobody, publishes nothing, re-issues no calendar invitation. Does not check for clashes — read `agenda_board` afterwards. | Organizer |
| `approve_task` | Accepts a speaker's submitted work on one task. Sends nothing. | Organizer |
| `request_task_changes` | Sends submitted work back with a note — and **emails** the person who owes it (or their manager, or the organizers). Note up to 2000 characters. The email cannot be recalled. | Organizer |

**Ceiling is not the only gate.** The column above is the *key ceiling*; the
minter's live *role* on the event applies on top of it. `list_proposals`,
`get_proposal`, `list_sessions`, `task_dashboard`, `agenda_board`,
`publish_state` and `list_task_reviews` require the organizer role, as do all
four writes, so a key minted by a reviewer reaches only `list_events`,
`get_event`, `search` and `review_progress` — the last in its "your assignments
only" form. Every one of those refusals is the same sentence: "This API key does
not have access to that."

**What no tool can do**, by absence rather than by a toggle: send outreach
campaigns, publish or unpublish the public programme, invite anyone, add or
remove team members, merge contacts, or delete anything. Those stay with a
signed-in human in the web app. The single outbound exception is
`request_task_changes`, whose notification _is_ the action.

## Audit

Agent writes are not described twice. The capability writes its own audit row,
as it does for a human, and the row is then marked `viaAgent` with the key's
prefix inside the same transaction — so the Control Center's change list renders
its usual sentence with an **Agent-assisted** badge. Two consequences worth
knowing: the flag appears on exactly the rows the capability wrote — no
envelope row is invented, so a call that writes nothing is recorded nowhere
(unscheduling an already-unscheduled session, for instance, returns without
touching anything) — and the flagged row carries the values the capability
actually stored, not the tool's copy of its arguments. That is a property of
`withAgentAudit`, not a promise that every call is diffed first: re-applying a
session's existing placement, for example, patches and records it again.

Key mints and revocations are audit rows of their own: `apiKey.mint` records
the name, ceiling and prefix, `apiKey.revoke` the name and prefix — never the
key.

## Troubleshooting

The endpoint never leaks internal error text: every refusal is one of these
sentences, or the generic one.

| What you see | What it means |
|---|---|
| `Provide an API key as an Authorization: Bearer header.` | No bearer token reached the endpoint. The client's config holds a reference to `STAGESTACK_MCP_KEY`, not the key itself, so check the variable is exported in the shell that launched the agent. |
| `That API key is not valid.` | No key with that value exists. Keys are shown once at mint; if it was lost, revoke it and mint another. |
| `That API key was revoked.` / `That API key has expired.` | Mint a replacement. Both are checked on every call, so revocation stops an agent mid-session. |
| `This API key does not have access to that.` | The single sentence for every authorization refusal: a read-ceiling key attempting a write, an organizer-only tool called with a key whose minter is a reviewer, wrong org, wrong event for an event-scoped key, or a minter whose live role no longer permits the call. |
| `No such record.` | Something you named does not exist on this event — a slug, a session or task id, or a room name passed to `schedule_session`. Re-read it from `list_events`, `list_sessions`, `list_task_reviews` or `agenda_board` rather than constructing one. |
| `Too many API calls — slow down.` | The key's bucket is empty: it refills at 300 calls a minute and holds 600. Back off, then retry. |
| `This organization has reached its API key limit.` | 50 active keys, or more than 50 unrevoked rows whatever their expiries. Revoke one — expired keys included — before minting another. |
| `This event has more records than one read can return, so no complete answer is available.` | The read refuses rather than answer partially — ask a narrower question. |
| `Send one JSON-RPC message per request — batched arrays are not supported.` | Your client batched. Every current MCP revision sends one message per request; check the client's transport settings. |
| `More than one room on this event has that name.` | Two rooms share a name, so `schedule_session` cannot tell which you meant. Rename one in the web app. |
| `That request could not be completed.` | The generic sentence for anything not in the list above. |

Two failures happen before any of that and look different, because they are HTTP
answers rather than JSON-RPC ones: a request whose `Host` or `Origin` header
does not match the deployment's own hostname is rejected outright (DNS-rebinding
protection), and a self-hosted deployment must have `CONVEX_SITE_URL` set or the
endpoint answers only to loopback — fail-closed on purpose.
