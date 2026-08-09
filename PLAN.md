# PLAN

Current focus only. Context: [docs/BUSINESS_CONTEXT.md](docs/BUSINESS_CONTEXT.md) · [docs/CHALLENGE.md](docs/CHALLENGE.md) · milestones: [docs/MILESTONES.md](docs/MILESTONES.md)

## Now: M2 — Review & decisions UI + Import agent

M2 backend is done and tested (95 tests; reviews, decision queues/release/correction, sessions, direct invitations). Remaining: abstracts admin table (search/filter/sort/saved views/export), review screens (assignments queue + Submit & Next), decision release UI, sessions list, direct-invite dialog, Import-with-AI agent (worker/Flue), browser + prod verification, codex triage (running).

Carry-overs into M2 UI: org-page capability gating (hide New event/Contacts for event-scoped members; Owner invite option only for owners) — small, from M0 codex review.

## Done: M1 — CFP forms & public submission — Aug 9

- [x] Form builder: sections/fields, locked system fields, conditional show/hide editor, options/kinds, live preview, versioned publish (working/published boundary), form settings (per-user limit, success message)
- [x] Public wizard: Welcome → Account (Clerk) → Submission → Participants → Review; autosave drafts; conditional logic live; file uploads; validation with jump-to-blockers; mobile-friendly
- [x] Proposal manage page (edit/resubmit until close, withdraw); reopen-by-organizer; My proposals on home
- [x] Fixed transactional emails on submit (submitter confirmation + admin notification), recorded in `messages` with webhook-updated delivery status — VERIFIED delivered end-to-end
- [x] Organizer proposals list + detail
- [x] Browser-verified locally end to end (incl. conditional field appearing on Workshop selection); tests 95 green
- [x] Prod deploy via git push (auto-deploy fixed in M0 session)

## Done: M0 — Foundation (orgs, events, library, team) — Aug 8

- [x] Capability layer: `convex/lib/functions.ts` wrappers (authed/org/event × query/mutation) resolving { user, org, event, role } once; domain logic in `convex/model/*`; UI and future agents share the same authorized functions
- [x] Job-type registry (`convex/shared/jobTypes.ts`) typed end-to-end into the worker handler map; worker e2e re-verified after refactor (ping claimed/done on VM)
- [x] Schema: users/organizations/members/eventMembers/invitations/events/contacts/tracks/tags/rooms/customFields/auditLog (+ M1 tables below)
- [x] Web M0: My StageStack home, self-service org onboarding, org page (events/contacts/team), event shell (overview/settings incl. library CRUD/team), invite accept page, landing
- [x] Tests: 72 green (convex-test incl. negative authz: cross-org scope, reviewer write rejection, unauthenticated); components (resend, rate-limiter) registered for real
- [x] Browser-verified locally (org create → event create → settings → library add/remove → team) AND signed-in on https://stagestack.dev (My StageStack renders live data)
- [x] Simplify pass applied (validation/organizer-check single-sourced, read-amplification fixes, dead skeleton path removed)
- [x] codex review triaged (see log)

## Phase 0 — Docs & architecture

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
- Aug 8-9 (overnight, autonomous): **M0 complete + M1 backend complete.**
  - Test suite caught a real authz hole (event-A organizer could revoke event-B invitations) — fixed; also made invitation tokens organizer-only in team lists (a reviewer could have copied an organizer-invite link and escalated).
  - M1 backend: cfpForms (working/published FormDef, conditional visibility), proposals + speakers + submit/resubmit/withdraw/reopen, per-user limits, submission window, comms log (`messages` table fed by Resend webhook), starter form on event creation. 72 tests.
  - Simplify pass (4-agent review, triaged): single-sourced validation + organizer checks, Promise.all on hot listings, compound indexes for submission-limit/speaker-count/org-membership queries, removed dead `cfpDrafts` skeleton path, web cleanups (shared ROLE_LABEL, memoized tz options, one contact subscription).
  - **Vercel git auto-deploys had never worked** (only CLI deploys had): the build installs only the apps/web workspace subtree, so repo-root deps used by `convex/` types were missing; plus a tsc bin ambiguity (TS6 alias vs TS7 native — TS6's inference collapses on convex-helpers generics). Fixed: convex packages declared as apps/web devDeps + typecheck pinned to `@typescript/native` via script. Deploys green from git now.
  - codex review triaged: fixed org-membership scan false-deny risk (new compound index); logged for M2: archived-event mutation gating (when automations exist), acceptQueue/declineQueue must stay submitter-editable + invisible (M2 statuses), model-layer role re-checks before the agent adapter lands, typed `initiatedBy` on jobs. (Note: review output got tail-truncated — re-run reviews without piping through tail.)
  - Signed-in prod verification done via Clerk backend-API sign-in token (ephemeral ticket; credentials never in transcript/logs).

## Before submission (accumulating)

- **Switch Vercel to the production Clerk instance** — prod currently runs dev-instance keys (orange "Development mode" watermark visible in the sign-in modal; dev instances also cap users).
- Deploy worker after any worker-touching milestone (`scripts/deploy-worker.sh`).

## Next

Milestone M0 (event & library) → M1 (CFP forms). See MILESTONES.md for the full spine.

M0 first commits (from scaffold review, Aug 8): scaffold the capability layer (`convex-helpers` custom functions, `convex/model/*`, `orgQuery`/`eventMutation`) and the job-type registry (shared discriminated union for `jobs.type`/`payload`) **before** any feature table lands.

Deferred with named triggers:
- **Queue lease sweeper + finished-row pruning cron** — when the Import agent (M2) lands; that's the job type that will hit stuck-claimed jobs.
- **ICS input sanitization (CRLF in attendee, non-ASCII `btoa`)** — when `sendIcsTest` becomes the real invite path (M1/M2 comms work).
- **Worker drain-on-shutdown** — when jobs get long enough to care about losing in-flight results on deploy.

## Deadline

Submission: **Wed Aug 12, 10PM PT** — deployed site + open source repo.
