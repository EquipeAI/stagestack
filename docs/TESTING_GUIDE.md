# Testing StageStack — the Meridian demo

StageStack ships with a seeded demo event so you can try every surface with
realistic data: **Meridian Dev Summit 2026** — a two-day conference (Oct 13–14,
2026, Fort Mason, San Francisco) run by the fictional org **Meridian
Conferences**. The data is deliberately imperfect: an unfinished review round,
an agenda with real scheduling conflicts, speakers at every state of readiness,
and a public page that is out of date on purpose. Your job as a tester is to
live in that mess the way a real organizer would.

Public page (no account needed):
`https://stagestack.dev/e/meridian-dev-summit-2026`

## The cast

Each persona is a real seat at the event. To take one over, send your email
address to the maintainer **before** the seed runs; the seeder attaches the
persona's assignments to whatever account owns that address (tag → email via
the `SEED_DEMO_EMAILS` deployment env var).

| Tag | Persona | Role | What you inherit |
|---|---|---|---|
| `demo-organizer` | Maya Okonkwo, Program Chair | Org admin + event organizer | The whole cockpit: review board, agenda, tasks, publishing, API keys |
| `reviewer1` | Priya Raman, Principal Engineer | Reviewer | 10/10 reviews already done — the finished-reviewer view |
| `reviewer2` | Tomas Ferreira, Staff SRE | Reviewer | 8/8 done plus one declared conflict of interest |
| `reviewer3` | Lena Hoffmann, Head of Platform | Reviewer | **0/10 done — the best seat**: a fresh queue, and the gap the organizer is chasing |
| `speaker1` | Ada Whitfield, Distinguished Engineer | Speaker | Portal claimed, bio + headshot in, a task with changes requested |
| `speaker2` | Kenji Nakamura, Director of Infrastructure | Speaker | Portal claimed, bio + headshot in |
| `speaker3` | Rosa Delgado, Developer Advocate | Speaker | Portal claimed, bio in, **no headshot** |
| `speaker4` | Omar Haddad, Founding Engineer | Speaker | Portal **unclaimed**, no bio, no headshot — the cold-start speaker |
| `speaker5` | Ingrid Solberg, ML Systems Lead | Speaker | Portal unclaimed; she is also double-booked on the agenda |
| `speaker6` | Marcus Bell, CTO | Speaker | Portal unclaimed, no bio — and a single point of failure across three sessions |

## Getting in

**Order matters for organizer and reviewer seats.** Sign up at
[stagestack.dev](https://stagestack.dev) with the email you sent, and verify
it, **before** the seed runs — the seeder finds your account by email and
hangs the persona's memberships and review assignments on it. If you sign up
after the seed, those assignments belong to a placeholder instead of you.

**Speakers are forgiving.** The speaker portal matches your verified email
when you enter it, so you can sign up before or after the seed. Visit:

`https://stagestack.dev/portal/meridian-dev-summit-2026`

## What to test, by seat

### As Maya (organizer)

- **Review round**: the completion board shows a real gap — one reviewer has
  not started. Chase it the way you would in production.
- **Agenda**: three deliberate blockers are seeded — a Main Hall double-book,
  one speaker on two overlapping sessions, and a same-track warning — plus
  three sessions still in the unscheduled tray. One replot fixes more than one
  problem; see if the board leads you there.
- **Tasks**: the review queue holds submissions in every state (pending,
  provided, approved, changes requested), with real PDF uploads attached.
  Approve one; request changes on another and check what the speaker receives.
- **Publishing**: the public page was published before the latest changes
  landed, so the publish screen reports a genuine pending diff — read it
  before you ship it.
- **Agent access**: mint an API key in org settings, connect an agent (see
  [AGENT_ACCESS.md](AGENT_ACCESS.md)), and watch the Control Center attribute
  agent-assisted actions.

### As Lena (reviewer)

Work your queue of 10 from zero: score, comment, and try declaring a conflict
of interest on a proposal you "know the author of". Compare against Priya's
finished queue and Tomas's COI if those seats are taken by teammates.

### As a speaker

- Unclaimed seats (Omar, Ingrid, Marcus): enter the portal, claim your
  profile, and fill in what's missing — the missing bios and headshots are
  real gaps the organizer sees on their side.
- Ada's seat: respond to the requested changes on the slide deck and re-upload.
- Everyone: check what lands in your inbox along the way — portal invitations,
  task reminders, change requests. Every email's links should bring you back
  to the right page.

### As anyone (no persona needed)

- Browse the public page; the CFP is open with a conditional workshop field —
  submit a proposal and watch it appear in the organizer's pipeline.
- Point an MCP-capable agent at the read-only API with a key an organizer
  mints for you: [AGENT_ACCESS.md](AGENT_ACCESS.md) has copy-paste setup for
  Claude Code and Codex.

## Ground rules

- The demo org is synthetic except for the emails you volunteered — but mail
  is **real**: change requests and reminders you trigger will land in real
  inboxes of teammates holding seats.
- Don't fix all three agenda blockers at once and then wonder why it's tidy
  for the next tester. Big rearrangements are fine; just say so in the team
  channel so others know the mess is gone.
- The seed can be wiped and re-run by the maintainer (`convex/seedDemo.ts`,
  internal functions only). A wipe destroys the demo org's API keys — re-mint
  after a reseed.
