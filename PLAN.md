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
- [x] Account wiring: Convex project (dev: scintillating-heron-597), Clerk app + `convex` JWT template + issuer set on Convex, Vercel project (scope equipe-ai, root dir `apps/web`, git-connected, env vars set), domain stagestack.dev attached
- [x] Walking skeleton part 1: Clerk wired (start.ts middleware, ConvexProviderWithClerk), `auth.viewer` round-trip works locally AND on https://stagestack.dev (anonymous leg verified; signed-in leg: Alvaro to click through)
- [x] Vercel production deploy working (nitro plugin → .vercel/output; deployed via CLI)
- [ ] Resend: DNS records added, **waiting on propagation** → then component install, real send + webhook, .ics attachment test
- [ ] Walking skeleton part 2: worker job claim on exe.dev VM, Flue hello-agent (OpenRouter/GPT-5.6-Luna), public unauthenticated mutation + rate limiter
- [ ] Signed-in auth test (Alvaro) → then M0: orgs, events, library (see MILESTONES.md)
- [x] Domain: **stagestack.dev** (via Vercel)

## Session log

- Aug 8 (Sat night): docs frozen pending Sun video; stack researched & decided; scaffold + walking skeleton pt 1 + prod deploy done. Lessons captured in CLAUDE.md ("fresh-docs-first", landmines). Next session: design system integration + walking skeleton pt 2 + M0.

## Next

Milestone M0 (event & library) → M1 (CFP forms). See MILESTONES.md for the full spine.

## Deadline

Submission: **Wed Aug 12, 10PM PT** — deployed site + open source repo.
