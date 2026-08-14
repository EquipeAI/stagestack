# Testing StageStack — the Meridian demo

StageStack ships with a seeded demo event so you can try every surface with
realistic data: **Meridian Dev Summit 2026** — a two-day conference (Oct 13–14,
2026, Fort Mason, San Francisco) run by the fictional org **Meridian
Conferences**. The data is deliberately imperfect: an unfinished review round,
an agenda with real scheduling conflicts, speakers at every state of
readiness, and a public page that is out of date on purpose. Live in that
mess the way a real organizer would.

Public page (no account needed):
`https://stagestack.dev/e/meridian-dev-summit-2026`

## Three shared accounts

Credentials are shared privately by the maintainer — never in this repo.

| Seat | Persona | What the seat holds |
|---|---|---|
| **Admin** | Maya Okonkwo, Program Chair | Org admin + event organizer: review board, agenda, tasks, publishing, API keys |
| **Reviewer 1** | Lena Hoffmann, Head of Platform | A completely fresh queue — 0 of 10 reviews done. The seat where you actually *do* reviewing |
| **Reviewer 2** | Tomas Ferreira, Staff SRE | All 8 reviews done, plus a declared conflict of interest — the finished state, as a worked example |

The other characters (a third reviewer, six speakers) are synthetic. Their
mail goes to the maintainer, and their half-done states are what make the
organizer's dashboards honest.

**Shared seat, shared consequences**: two people signed in as Maya at once
are editing the same agenda, and the audit log records "Maya Okonkwo" no
matter which human clicked. Fine for a demo — just call dibs in the team
channel for anything big.

## What to do in each seat

### Admin (Maya)

- **Review round**: the completion board shows a real gap — one reviewer has
  not started (that's Lena; maybe it's you in the other tab). Chase it the
  way you would in production.
- **Agenda**: three deliberate blockers are seeded — a Main Hall double-book,
  one speaker on two overlapping sessions, and a same-track warning — plus
  three sessions in the unscheduled tray. One replot fixes more than one
  problem; see if the board leads you there.
- **Tasks**: submissions sit in every state (pending, provided, approved,
  changes requested) with real PDFs attached. Approve one; request changes on
  another.
- **Publishing**: the public page was published before the latest changes
  landed, so the publish screen reports a genuine pending diff — read it
  before you ship it.
- **Speakers**: the roster shows every readiness state — unclaimed portals,
  missing bios, missing headshots — which is what the task machinery is for.

### Reviewer 1 (Lena)

Work the queue of 10 from zero: score, comment, and try declaring a conflict
of interest on a proposal you "know the author of". Tomas's seat shows what
done-with-a-COI looks like when you want to compare.

### Reviewer 2 (Tomas)

Everything is already submitted — this seat is for seeing the reviewer's
finished state and how a declared conflict renders, on both sides: check the
same round from the Admin seat afterwards.

## Bring your own account

Sign up at [stagestack.dev](https://stagestack.dev) with your real email if
you want the journey a stranger gets:

1. Browse the public event page and hit the open CFP — it has a conditional
   workshop field worth triggering.
2. Submit a proposal. The confirmation and everything after it lands in your
   real inbox, links and all.
3. Ping whoever holds the Admin seat: they'll see your proposal appear in the
   pipeline, can run it through review, and accept it.

Your own account holds no demo state — personas above are how you get the
pre-seeded mess.

## Drive it with an agent (MCP)

StageStack exposes a hosted MCP server — fifteen tools over the same
permission model as the UI. Full setup: [AGENT_ACCESS.md](AGENT_ACCESS.md).

1. In the Admin seat: **org settings → API keys → mint**. A `read` key can
   never write; an `organizer` key can use the three reversible write tools
   plus request changes on tasks. The connect panel shows your exact server
   URL.
2. Connect your agent — both clients read the key from the environment, so
   the secret never lands in a config file (the single quotes below are
   load-bearing; see [AGENT_ACCESS.md](AGENT_ACCESS.md)):

   ```bash
   export STAGESTACK_MCP_KEY=ssk_…
   ```

   ```bash
   claude mcp add --transport http stagestack https://<your-deployment>.convex.site/mcp --header 'Authorization: Bearer ${STAGESTACK_MCP_KEY}'
   ```

   ```bash
   codex mcp add stagestack --url https://<your-deployment>.convex.site/mcp --bearer-token-env-var STAGESTACK_MCP_KEY
   ```

3. Ask questions the dashboards answer slowly. Prompts that show it off:
   - *"Run a morning sweep of Meridian Dev Summit 2026: what's blocking the
     agenda, and what's the smallest set of moves that fixes it?"*
   - *"Where is the review round stuck, and who exactly is the gap?"*
   - *"If I publish right now, what changes — and is anything in that diff
     not ready?"*
- Writes are attributed: an agent-assisted change shows up in the Control
  Center as the key's owner, marked agent-assisted, with the key prefix in
  the audit log.
- `request_task_changes` emails a real human — in the demo that's the
  maintainer's inbox, so fire away, but know it's live mail.
- Revoking the key in org settings kills the agent's access on the next call
  — also worth testing.

## Ground rules

- Mail is real. Task emails for the synthetic personas go to the maintainer;
  anything involving your own account goes to you.
- Rearranging the seeded mess (fixing the agenda blockers, finishing Lena's
  queue) is the point — just say so in the team channel so the next tester
  knows why it's tidy.
- The maintainer can wipe and re-seed (`convex/seedDemo.ts`, internal
  functions only). A reseed destroys the demo org's API keys — re-mint after.
