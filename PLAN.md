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

- [ ] **Seeded demo event on prod**, in its own demo organization so demo
      data never touches anything real: a published CFP, proposals across
      every status, a launched review round with scores, a part-scheduled
      agenda with deliberate conflicts to show detection, speakers at every
      readiness state, task/reminder history, and a published public page +
      embed + API — every one of the six requirements demonstrable with zero
      reviewer setup. NEW since Part D: the demo org can also carry a
      revoked-example API key so the keys tab isn't empty, and the seeded
      event gives the MCP tools something to answer about.
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

- (empty)
