# PLAN — Submission window close-out

## STATUS: ACTIVE — started 2026-08-13, hard stop Sunday 2026-08-16

The organizers' Aug 13 update (see
[docs/CHALLENGE.md](docs/CHALLENGE.md) "Post-deadline update") opened an
optional working window until **Sunday, Aug 16, 2026** and posted the
submission form. This is a short ops plan, not a feature cycle: submit
properly, make everything we already built verifiably true on the deployments
the judges will touch, and close the loose ends carried from the
[UX maturity cycle](docs/PLAN-2026-08-ux-maturity.md). The next feature plan
(M10 candidate) starts after this closes.

Context: [docs/CHALLENGE.md](docs/CHALLENGE.md) ·
[docs/MILESTONES.md](docs/MILESTONES.md) ·
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
Previous plans: [UX maturity cycle M8–M9](docs/PLAN-2026-08-ux-maturity.md) ·
[eval fix cycle](docs/PLAN-2026-08-eval-fix.md) ·
[original build M0–M8](docs/PLAN-2026-08-submission.md)

## Evaluation package

The repo is already public (flipped 2026-08-12). Goal: the AIE team —
swyx@ai.engineer · sydney@ai.engineer · phlo@ai.engineer ·
kelsey@ai.engineer — can evaluate StageStack with the least possible
friction: land signed-in, in a populated event, with a map from the six
requirements to the exact screens that prove them.

(Form submission — https://forms.gle/RJMXWp2jAD32uHvB9 — is handled directly
by Alvaro, outside this plan.)

- [ ] **Seeded demo event on prod** with realistic volume: a published CFP,
      proposals across every status, a launched review round with scores, a
      part-scheduled agenda with deliberate conflicts to show detection,
      speakers at every readiness state, task/reminder history, and a
      published public page + embed + API — so every one of the six
      requirements is demonstrable without the reviewer doing setup work.
- [ ] **Zero-friction reviewer access**: organizer invites pre-sent to the
      four @ai.engineer addresses (our own invite flow is the demo), each
      deep-linking into the seeded event; verify the Clerk production
      instance accepts fresh sign-ups cleanly.
- [ ] **Reviewer guide** — `docs/EVALUATION.md`, linked prominently from the
      README: the deployed URLs (site, public page, embed, API endpoint), how
      to get in, and a 10–15 minute walkthrough mapped requirement-by-
      requirement to the six, with deep links into the seeded event; also
      point at the trailer video and where the tests/CI live for the
      code-side story.
- [ ] **README front door check**: the first screen of the README should
      serve a judge — product summary, live demo link, evaluation guide link,
      screenshots current with the post-W13 UI.
- [ ] **Push `develop`** (currently ahead of origin) so the preview deploy —
      the thing the evals hit — matches local, and merge to `main` before
      Sunday so prod carries everything we want judged.

## Deployment truth (make what we built verifiably true)

- [ ] **Resend webhook on `develop` (`marvelous-snail-907`) and prod
      (`healthy-lynx-620`)** — Alvaro has Resend + email open in the local
      browser. Per deployment, check both causes from the archived W1 item:
      `RESEND_WEBHOOK_SECRET` set on the Convex deployment (missing → the
      endpoint 500s loudly), and a Resend-dashboard webhook endpoint pointing
      at that deployment's own `.convex.site/resend-webhook` URL (missing →
      fails silently; Svix secrets are per-endpoint). Fix, then prove it: send
      a real email on each deployment and watch its comms-log row advance past
      "Sent — delivery unconfirmed" to Delivered.
- [ ] **`RESEND_TEST_MODE=false` confirmed on develop AND prod** — env vars do
      not mirror between deployments; a missing knob silently turns real mail
      into `failed` comms-log rows (CLAUDE.md deploy table).
- [ ] **Confirm `internal.library.backfillFormats` ran per event** on dev
      (`scintillating-heron-597`), develop, and prod (idempotent; refuses
      >1000-session events; keeps labels verbatim — the CFP format labels are
      asserted verbatim by the eval).

## Verification before Sunday

- [ ] **Eval re-run** against the develop preview once the webhook and env
      items above land — target: no regression from 100%, with the UX
      review's named rough edges closed. (Alvaro runs the harness.)
- [ ] **Live a11y passes** the static audit explicitly deferred: axe + manual
      keyboard pass + screen-reader pass over the running app
      ([audit doc](docs/reference/a11y-audit-2026-08.md)).
- [ ] **Re-walk the five "clicking too much" jobs** and confirm each is one
      workspace or one flow: prepare a speaker · publish a session · launch a
      review round · resolve an uploaded file · answer "why isn't this
      public?".
- [ ] **Final prod walk** of the six challenge requirements on
      https://stagestack.dev as a signed-in organizer, phone width included.

## After the window

- [ ] Absorb the individual feedback the organizers send (optional to act on,
      worth recording in docs/ either way).
- [ ] Draft the next plan — M10 (expert efficiency) is the milestone on deck,
      gated on M9's surfaces getting real usage.
