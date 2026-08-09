# PLAN

Current focus only. Context: [docs/BUSINESS_CONTEXT.md](docs/BUSINESS_CONTEXT.md) · [docs/CHALLENGE.md](docs/CHALLENGE.md) · milestones: [docs/MILESTONES.md](docs/MILESTONES.md)

## Now: Phase 0 — Docs & architecture

- [x] Business context doc
- [x] Challenge doc (requirements, decision log, freeze tracking)
- [x] Milestones doc
- [ ] Review & polish docs together (Alvaro pass)
- [x] Watch walkthrough video — no new requirements beyond the docs
- [x] Define technical architecture ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)): Convex + Clerk + Vercel + exe.dev/Flue worker
- [x] Scaffold workspaces (convex/ at root, apps/web TanStack Start, apps/worker) — typechecks + builds
- [ ] Account wiring (Alvaro): Convex project (`npx convex dev` login), Clerk app + `convex` JWT template, Vercel project (root dir `apps/web`), Resend + DNS for stagestack.dev, exe.dev VM, OpenRouter key
- [ ] Walking-skeleton validation (see ARCHITECTURE.md checklist): Clerk→Convex auth, Resend real send + webhook, .ics attachment path, worker job claim on exe.dev, Flue hello-agent, public unauthenticated mutation
- [x] Domain: **stagestack.dev** (via Vercel) — add Resend DNS records next

## Next

Milestone M0 (event & library) → M1 (CFP forms). See MILESTONES.md for the full spine.

## Deadline

Submission: **Wed Aug 12, 10PM PT** — deployed site + open source repo.
