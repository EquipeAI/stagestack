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
- [x] Resend: domain verified; `@convex-dev/resend` component installed (`emails.ts`, `/resend-webhook` HTTP route, hourly cleanup cron); real-mode send (testMode off) delivered to external inbox with `email.sent`/`email.delivered` webhook events landing in `handleEmailEvent`
- [x] .ics attachment test: `sendEmailManually` + raw Resend API (component batch API doesn't do attachments), `METHOD:REQUEST` invite delivered; **confirmed rendering natively in Gmail** (event card + RSVP buttons)
- [x] **Worker running on exe.dev VM, end-to-end verified**: jobs table + secret-guarded `worker.pending/claim/finish` in Convex; worker subscribes via `onUpdate`, CAS-claims, executes (ping handler). Enqueued from laptop → claimed+done on VM in <1s.
  - VM **stagestackdev** (ssh stagestackdev.exe.xyz, key `~/.ssh/pedro_exe_dev`), Node 24.19; env at `/home/exedev/stagestack/worker.env`; repo at `/home/exedev/stagestack/app` via **read-only deploy key** (chose over exe.dev GitHub integration — no OAuth dance, narrower grant); systemd `stagestack-worker.service` (Restart=always, enabled at boot)
  - Deploy updates: `scripts/deploy-worker.sh` (pull → npm ci → restart)
  - WORKER_SECRET in root `.env.local` + Convex dev deployment
- [x] Flue hello-agent in worker, **end-to-end verified on VM**: `@flue/runtime@2.0.3` pinned, `hello-agent` job type runs one guaranteed `get_server_time` tool call via `openrouter/openai/gpt-5.6-luna`; job result carries tool-call evidence; ~2s round trip (commit a94e861)
- [x] Public unauthenticated mutation + rate limiter (CFP path): `cfp:startDraft` + `cfpDrafts` table; `@convex-dev/rate-limiter` (per-client token bucket 5/min keyed on anonKey + global fixed-window 100/min backstop). Verified unauthenticated over plain HTTPS: 5 succeed, 6th rejected with `retryAfter`, different key unaffected
- [x] Signed-in auth test (Alvaro): verified on **https://stagestack.dev** — Convex resolves Clerk identity (`auth.viewer` non-null, correct email) → M0 unblocked: orgs, events, library (see MILESTONES.md)
- [x] Domain: **stagestack.dev** (via Vercel)

## Session log

- Aug 8 (Sat night): docs frozen pending Sun video; stack researched & decided; scaffold + walking skeleton pt 1 + prod deploy done. Lessons captured in CLAUDE.md ("fresh-docs-first", landmines). Next session: design system integration + walking skeleton pt 2 + M0.
- Aug 8 (later): scaffold architecture review → fixed `enqueueTest` (public→internal; was an unauthenticated OpenRouter-credit spend vector), dev-gated prod stack traces, loud-fail on missing `VITE_CONVEX_URL`, DS adherence allowlists extended for event handlers (was blocking M0 UI work), `cfp.startDraft` input validation + limiter order, shared `convex/env.d.ts`. Deferred items above.

## Next

Milestone M0 (event & library) → M1 (CFP forms). See MILESTONES.md for the full spine.

M0 first commits (from scaffold review, Aug 8): scaffold the capability layer (`convex-helpers` custom functions, `convex/model/*`, `orgQuery`/`eventMutation`) and the job-type registry (shared discriminated union for `jobs.type`/`payload`) **before** any feature table lands.

Deferred with named triggers:
- **Queue lease sweeper + finished-row pruning cron** — when the Import agent (M2) lands; that's the job type that will hit stuck-claimed jobs.
- **ICS input sanitization (CRLF in attendee, non-ASCII `btoa`)** — when `sendIcsTest` becomes the real invite path (M1/M2 comms work).
- **Worker drain-on-shutdown** — when jobs get long enough to care about losing in-flight results on deploy.

## Deadline

Submission: **Wed Aug 12, 10PM PT** — deployed site + open source repo.
