# PLAN

## STATUS: NO ACTIVE PLAN — ready for the next cycle (2026-08-13)

The UX maturity cycle (M8 + M9, W1–W13) landed 2026-08-12 and is archived at
[docs/PLAN-2026-08-ux-maturity.md](docs/PLAN-2026-08-ux-maturity.md). The next
plan is drafted here, pulling from one milestone (or one named pair) in
[docs/MILESTONES.md](docs/MILESTONES.md) — M10 (expert efficiency) is the next
one on the arc, gated on M9 getting real usage first.

Context: [docs/BUSINESS_CONTEXT.md](docs/BUSINESS_CONTEXT.md) ·
[docs/CHALLENGE.md](docs/CHALLENGE.md) ·
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/MILESTONES.md](docs/MILESTONES.md)
Previous plans: [UX maturity cycle M8–M9](docs/PLAN-2026-08-ux-maturity.md) ·
[eval fix cycle](docs/PLAN-2026-08-eval-fix.md) ·
[original build M0–M8](docs/PLAN-2026-08-submission.md)

## Loose ends carried from the last cycle

Open items from the archived plan that are not part of any new milestone —
close them opportunistically or fold them into the next plan:

- [ ] **Resend webhook diagnosis on `develop` (`marvelous-snail-907`) and prod
      (`healthy-lynx-620`)** — needs deploy access (Alvaro). Check both:
      `RESEND_WEBHOOK_SECRET` set on the deployment (missing → the endpoint
      500s loudly), and a Resend-dashboard webhook endpoint pointing at that
      deployment's own `.convex.site/resend-webhook` URL (missing → fails
      silently; Svix secrets are per-endpoint). Until fixed, delivery rows
      honestly read "Sent — delivery unconfirmed"/Queued. Env vars do not
      mirror between deployments — per-deployment check.
- [ ] **Confirm `internal.library.backfillFormats` ran per event** on dev
      (`scintillating-heron-597`) and develop (idempotent; refuses
      >1000-session events; keeps labels verbatim).
- [ ] **Eval re-run** (Alvaro) — target: no regression from 100%, with the UX
      review's named rough edges closed.
- [ ] **Final live-browser verification passes** the archived plan scoped to
      the end: axe + manual keyboard pass + screen-reader pass over the
      running app (the a11y work so far was a static code audit — see
      [docs/reference/a11y-audit-2026-08.md](docs/reference/a11y-audit-2026-08.md)),
      and the re-walk of the review's five "clicking too much" jobs.
