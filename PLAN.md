# PLAN — Submission final mile (v6)

## STATUS: ACTIVE — started 2026-08-14, challenge hard stop Sunday 2026-08-16

Everything buildable has shipped: the M10 slice, the full security
remediation, and agent access (API keys + hosted MCP) are on `develop`,
pushed, with the preview deploy verified — see the archived
[close-out plan](docs/PLAN-2026-08-closeout-m10-security-agent.md) for what
landed and every decision made on the way. What remains is the submission
package itself: seed, access, guide, and the verification walks — plus the
develop→main merge that puts all of it on prod. New fixes and small changes
discovered along the way get their own section below rather than a new file.

Context: [docs/CHALLENGE.md](docs/CHALLENGE.md) ·
[docs/MILESTONES.md](docs/MILESTONES.md) ·
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/BUSINESS_CONTEXT.md](docs/BUSINESS_CONTEXT.md)
Previous plans:
[challenge close-out + M10 + security + agent access](docs/PLAN-2026-08-closeout-m10-security-agent.md) ·
[UX maturity cycle M8–M9](docs/PLAN-2026-08-ux-maturity.md) ·
[eval fix cycle](docs/PLAN-2026-08-eval-fix.md) ·
[original build M0–M8](docs/PLAN-2026-08-submission.md)

---

## S1 — Evaluation package (was Part A2)

The repo is public. Goal: the AIE team — swyx@ai.engineer ·
sydney@ai.engineer · phlo@ai.engineer · kelsey@ai.engineer — lands
signed-in, in a populated event, with a map from the six requirements to
the exact screens that prove them.

(Form submission — https://forms.gle/RJMXWp2jAD32uHvB9 — is handled directly
by Alvaro, outside this plan.)

- [x] **Seeded demo event on prod**, in its own demo organization so demo
      data never touches anything real: a published CFP, proposals across
      every status, a launched review round with scores, a part-scheduled
      agenda with deliberate conflicts to show detection, speakers at every
      readiness state, task/reminder history, and a published public page +
      embed + API — every one of the six requirements demonstrable with zero
      reviewer setup. NEW since Part D: the demo org can also carry a
      revoked-example API key so the keys tab isn't empty, and the seeded
      event gives the MCP tools something to answer about.
      **Built 2026-08-14 and rehearsed on dev** — the seeder is
      `convex/seedDemo.ts` (internal-only), and it produced
      org `meridian-conferences` / event `meridian-dev-summit-2026` on
      `scintillating-heron-597`. What remains for this box: run the same
      sequence against prod once develop→main lands. Run order matters —
      `headshots`, `publishAgendaItems` and `slideUploads` come AFTER `seed` so
      the published program is deliberately stale and `publish_state` has a
      real diff to report:
      ```
      npx convex run seedDemo:seed '{"ownerEmail":"…"}' --prod
      npx convex run seedDemo:exampleKey '{}' --prod
      npx convex run seedDemo:headshots '{}' --prod
      npx convex run seedDemo:publishAgendaItems '{}' --prod
      npx convex run seedDemo:slideUploads '{}' --prod
      ```
      `seedDemo:wipe` deletes the demo org's `apiKeys` too, so never re-seed
      after minting a key that is still wanted.
      *Closed 2026-08-14:* seeded on prod `healthy-lynx-620` in the recorded
      order; public page live at stagestack.dev/e/meridian-dev-summit-2026.
      Three shared team seats (Maya / Lena / Tomas) exist as prod Clerk users
      at alvaro+{demo-organizer,reviewer3,reviewer2}@; their Convex user rows
      were imported with the real `https://clerk.stagestack.dev|user_…` token
      identifiers BEFORE seeding, so the personas' memberships and Lena's
      10-review queue attach to the real accounts (verified) and dashboard
      sign-in just works. A wipe+reseed loses that linkage unless the rows
      survive or are re-imported first. Remaining manual: mint demo API keys
      from the admin seat (D4 flow); docs/TESTING_GUIDE.md is the team's
      entry point.
- [ ] **Zero-friction reviewer access**: organizer invites pre-sent to the
      four @ai.engineer addresses (our own invite flow is the demo), each
      deep-linking into the seeded event; verify the Clerk production
      instance accepts fresh sign-ups cleanly. Invites are staged first and
      sent only on Alvaro's go.
- [ ] **Reviewer guide** — `docs/EVALUATION.md`, linked prominently from the
      README: deployed URLs (site, public page, embed, API endpoint), how to
      get in, a 10–15 minute walkthrough mapped requirement-by-requirement to
      the six with deep links into the seeded event, plus pointers to the
      trailer video and where the tests/CI live for the code-side story.
      NEW: a short "connect your agent" beat — the org-settings keys tab +
      [docs/AGENT_ACCESS.md](docs/AGENT_ACCESS.md) — as the differentiator
      demo.
- [ ] **README front door check**: the first screen serves a judge — product
      summary, live demo link, evaluation guide link, screenshots current
      with the post-W13 UI (and the new API-keys tab).

## S2 — Verification before Sunday (was Part A3)

- [ ] **develop → main merge** so prod carries the M10 slice, Part C, and
      agent access; watch the prod deploy (Convex `healthy-lynx-620` takes
      the `apiKeys` schema + `/mcp` routes on that push) and smoke `/mcp`
      on prod's `.convex.site` (401 + registry sentence, no key minted).
- [ ] **Eval re-run** against the develop preview — target: no regression
      from 100%, with the UX review's named rough edges closed. (Alvaro runs
      the harness.)
- [ ] **Live a11y passes** the static audit explicitly deferred: axe +
      manual keyboard pass + screen-reader pass over the running app
      ([audit doc](docs/reference/a11y-audit-2026-08.md)).
- [ ] **Re-walk the five "clicking too much" jobs** — prepare a speaker ·
      publish a session · launch a review round · resolve an uploaded file ·
      answer "why isn't this public?" — each now one workspace or one flow.
- [ ] **Final prod walk** of the six challenge requirements on
      https://stagestack.dev as a signed-in organizer, phone width included.

## S3 — Fixes and small changes (rolling)

Discovered work lands here with a date and a one-line why; anything that
grows beyond a day's slice gets promoted to its own workstream section.

All four items below were found on 2026-08-14 rehearsing the S1 seeded demo
event against dev and running the MCP proof over it (read key + organizer key
minted through the keys tab, `request_task_changes` exercised end to end).
They are ordered by what a reviewer would hit first. Items 2–4 are all in the
agent-access surface, so they are cheapest done in one pass.

- [x] **Fix `SITE_URL` on the non-prod deployments** — dev
      `scintillating-heron-597` has `SITE_URL=https://stagestack.dev`, so every
      link in mail sent from dev points at prod. Confirmed end to end: the
      change-request email triggered over MCP arrived carrying
      `https://stagestack.dev/portal/meridian-dev-summit-2026`, an event that
      exists only on dev — a reviewer following a link out of a demo email
      lands on a 404 in the wrong environment. Set dev to its own origin, and
      **check `marvelous-snail-907` before the eval re-run** (the eval drives
      email flows, and the same misdirection there would send an eval-clicked
      portal link to prod). Same shape as the `RESEND_TEST_MODE` miss: a knob
      set on one deployment and assumed everywhere.
      *Verify:* `npx convex env get SITE_URL` on each of the three
      deployments; re-trigger one task email and read the link.
      *Closed 2026-08-14:* only dev was wrong — staging already pointed at the
      develop preview and prod at stagestack.dev. Dev set to
      `http://localhost:3000`; verified by re-triggering `request_task_changes`
      on Omar Haddad's task and reading the delivered email — portal link now
      `http://localhost:3000/portal/meridian-dev-summit-2026`.
- [x] **Make Codex work against `/mcp`, or stop documenting it.**
      [docs/AGENT_ACCESS.md](docs/AGENT_ACCESS.md) gives `codex mcp add
      stagestack --url … --bearer-token-env-var STAGESTACK_MCP_KEY` as a
      first-class client. It connects and lists all fifteen tools, but **every**
      `tools/call` fails — codex 0.145.0 reports `user cancelled MCP tool call`
      for `list_events` as readily as for a write. Claude Code and raw curl
      with the same key both work, so this is an interop gap, not auth.
      Two candidates on our side, both spec-legal but strict — check
      `convex/http.ts` (`mcpEndpoint`, the route registration near line 282)
      and `convex/lib/mcpServer.ts`:
      - `GET /mcp` answers **405**. rmcp (Codex's MCP transport) opens a
        server→client SSE channel and may treat the refusal as fatal for the
        session.
      - a `tools/call` whose `Accept` is `application/json` alone answers
        **406**; we require `text/event-stream` in the list.
      Reproduce with `codex exec --sandbox workspace-write -c
      sandbox_workspace_write.network_access=true` (a read-only sandbox blocks
      the network and fails differently, which is a red herring). If the fix is
      not cheap, cut the Codex block from AGENT_ACCESS.md rather than ship
      instructions that dead-end.
      *Closed 2026-08-14:* both suspects exonerated — the 405 and 406 come from
      the MCP SDK and rmcp tolerates both (it never even opens the GET stream
      on a sessionless server). The real cause is Codex's client-side approval
      gate: un-annotated tools default to requires-approval, and in `exec` mode
      the unshowable prompt becomes "user cancelled MCP tool call" before any
      HTTP request is sent. Fix: truthful MCP annotations in
      `convex/lib/mcpServer.ts` — `readOnlyHint: true` on the 11 reads,
      `destructiveHint: false` on the 3 reversible writes,
      `openWorldHint: true` on `request_task_changes` (so Codex still — by
      design — requires interactive approval for the one outbound tool).
      Verified live: `codex exec` (0.145.0, workspace-write sandbox) called
      `list_events` and answered with the October ISO date. AGENT_ACCESS.md
      Codex block documents the behavior.
- [x] **Emit ISO-8601 alongside epoch ms in the MCP projections.** `get_event`,
      `agenda_board` and the task tools return `startsAt: 1791907200000` with
      the timezone as a separate string and no rendered form, leaving the date
      arithmetic to the model — and one `claude -p` run duly reported the event
      as **April** 13–14 instead of October, wrong by six months, on the first
      question anyone asks the connect-your-agent demo. Add a sibling field
      (`startsAtIso` etc.) rendered in the event's own zone rather than
      replacing the numbers, so nothing that sorts on them breaks. Touches the
      projections in `convex/mcp.ts`; the tool descriptions in
      [docs/AGENT_ACCESS.md](docs/AGENT_ACCESS.md) need the same note.
      *Closed 2026-08-14:* `isoInZone` helper in `convex/mcp.ts` adds `…Iso`
      siblings (event-zone offset, e.g. `2026-10-13T09:00:00-07:00`) across
      nine tools; numeric fields untouched; tool descriptions +
      AGENT_ACCESS.md note the pairing. Verified on the wire via `get_event`.
- [x] **Rename `publish_state.publishedAgendaItemCount`** (or report the served
      count beside it). It counts *flagged agenda items*, not entries on the
      served agenda, so it read `0` while the same payload's diff said six
      entries were being served — an agent flagged it as a data inconsistency
      and told the organizer to go verify in the web app, which is the opposite
      of what the tool is for.
      *Closed 2026-08-14:* old flag counts renamed `flaggedSessionCount` /
      `flaggedAgendaItemCount`; new `servedSessionCount` / `servedAgendaItemCount`
      sourced from the served-blob counts. Verified on the wire:
      `servedAgendaItemCount: 6` now agrees with `diff.agenda.servedCount: 6`.
      Root cause documented in the tool description (served agenda mixes
      session-flag and agenda-item-flag governance, so the old name lied).
