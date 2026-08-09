# PLAN

Current focus only. Context: [docs/BUSINESS_CONTEXT.md](docs/BUSINESS_CONTEXT.md) · [docs/CHALLENGE.md](docs/CHALLENGE.md) · milestones: [docs/MILESTONES.md](docs/MILESTONES.md)

## Now: M7 — Public content out (page, API, embeds) + M3-M6 codex fixes

M0-M6 all built, browser + prod verified, deployed. codex M3-M6 review triaged (fixes agent running): fixing .ics RFC correctness (quoted CN + terminal CRLF), first-reminder cadence baseline, one-email-per-recipient sweep consolidation, task routing stays on manager after portal claim, session-task accountable assignee, audience-truncation visibility, ack idempotency, agenda-item room clear, profile-link validation, executeRecords/listAudiences organizer re-check. Deferred (logged): the M6 publication boundary IS M7 (building now); released-change detection for track/title/description is a v1 limitation (only start/end/room propagate).

Remaining: M7 backend (publishedPrograms projection, publish/unpublish lineup+agenda independently, public read query + HTTP API + embed), public event page, browser + prod verify, then final acceptance sweep.

## Done: M6 — Agenda builder — Aug 9

- [x] Drag-and-drop board (5 views: list/day/week/track/room; Room grid = pixel time-grid DnD w/ 15-min snap, overlap lanes, unscheduled tray, manual Place dialog fallback)
- [x] Conflict detection derived from one shared pure function (board = release gate = readiness): room clash + speaker double-book = non-overridable blockers, same-track = warning
- [x] Explicit slot release → per-participant schedule email + .ics REQUEST; date/start change bumps sequence + resets ack; room/end updates without reset; per-id results skip blocked; cancel-release sends .ics CANCEL; participant-specific CANCEL on withdrawal
- [x] Acknowledgement (acknowledged/conflict) by speaker/manager/organizer; conflict → session blocked in readiness; agenda items (breaks/meals); virtual links with audience scoping
- [x] Speaker portal slot display + acknowledge/flag-conflict
- [x] Browser-verified: room-clash blocker in lanes → release refused → resolve → release 2 → Released v0 + 2 schedule.released emails with .ics; 203 tests

## Done: M5 — Communications — Aug 9

- [x] 13 organizer-editable templates over defaults ({{var}}, HTML-escaped, header-injection-safe subjects); all lifecycle sends render through them; event reply-to wired
- [x] Templates editor (server preview + dirty-draft local preview, variable hints, reset); state-derived audiences w/ representation routing; one-off sends (personalized, confirm-with-count, per-send results); per-contact comms log
- [x] Hourly reminder sweep (consolidated, cadence + per-requirement override/disable, unconfirmed→participation not task chasing)
- [x] .ics machinery (RFC escaping + CRLF-injection fix + folding + UTF-8 base64); internal sendCalendarInvite → comms log
- [x] Browser-verified: personalized one-off delivered to a real inbox + recorded in comms log w/ webhook Delivered status; prod live

## Done: M4 — Speaker ops: tasks & readiness — Aug 9

- [x] Requirements (participant/session scope; manual/file/profileField evidence; optional review gate; due dates) instantiate on create for existing accepted speakers/sessions AND on every future acceptance
- [x] Task instances: mark provided (organizer/speaker/manager, actor recorded), versioned file uploads with retained history, approve / request-changes(note) / mark N/A(reason) / reopen, due-date overrides; profile-field evidence auto-observed from the snapshot
- [x] **Speaker-tracking dashboard (requirement #6)**: live stat tiles incl. "N accepted speakers are missing a bio or headshot" (verbatim phrasing), per-speaker participation/portal-claim/missing-profile/outstanding/overdue, drill-down, session readiness derived (ready/needsAttention/blocked) with reasons always exposed
- [x] Portal tasks section (yours vs managed), speaker-friendly labels, upload/replace
- [x] Reminders backend (M5): consolidated cadence sweep, unconfirmed→participation not task chasing, per-requirement override/disable
- [x] Browser-verified (dashboard, requirement create → per-speaker instances, readiness reasons); 131→181 tests through the window; prod live

## Done: M3 — Speaker portal — Aug 9

- [x] Access = verified-email auto-claim (Clerk-verified email links event snapshots on portal entry; no parallel passwords/tokens); manager handoff completes the same way, old manager revoked
- [x] Speaker: status visibility, Confirm (dialog previews the exact publishable fields) / Decline / Withdraw (organizers alerted, session stays planned + flagged); profile editing refreshes event snapshot AND org directory current profile (other events untouched — verified at data level)
- [x] Manager: session content editing, co-speaker states, on-behalf confirmation (actor+time recorded)
- [x] Organizer: participation state override, invite-to-portal email, handoff start/revoke, read-only "Preview portal" with persistent banner (renders the real portal component)
- [x] My StageStack Speaking section (cross-event)
- [x] 131 tests green (14 portal + 22 M4-backend landed same window); browser-verified: invite → auto-claim → confirm → profile propagation → preview

## Done: M2 — Review, decisions, sessions, Import agent — Aug 9

- [x] Abstracts admin table: search, sort, status chips, saved views (URL-state + named), column prefs, CSV/XLSX export, file-bundle download, manual add, detail dialog (answers + files + review summary + decision actions + reopen)
- [x] Reviews: manual assignment (individual + bulk), single-screen Submit & Next with keyboard flow + autosave, strict reviewer scoping (assigned-only, professional identity only, no contact details — enforced server-side), draft content withheld from organizers
- [x] Pipeline: pending → accept/decline queue (internal, masked from submitters as "Submitted"; editing while queued resets to pending + notifies) → explicit release (per-id results, batches >100 chunked) → session + event-contact snapshots + participants Awaiting Response + decision emails; corrected release both directions
- [x] Direct invitation (session + invitation email → /portal link); sessions list
- [x] **Import with AI verified end-to-end**: CSV upload → Flue planner on VM (gpt-5.6-luna, bounded chunks) → plan with reuse/duplicates/uncertainties/skips → organizer approval → deterministic execution through the same capabilities with the confirming organizer's authority (server-resolved; worker never names a user) → 5/5 records (proposals, track, session-no-comms, contact)
- [x] codex round triaged: fixed reviewer privacy (answers projection), draft-bricking on removed fields, upload-URL rate limit, withdrawal-locks-reviews, condition-graph validation, autosave flush races, resubmit semantics, wizard resume, org gating; logged as v1 cuts: review version history/locking/reopen, rich-text editor (textarea + honest hint), builder concurrent-edit protection, correction edge cases (no-email speaker duplication)
- [x] 95 tests green; browser-verified: import e2e, assign → 3 reviews → stage → release (2A/1D) → sessions + delivered emails; queue masking checked as submitter

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
- `xlsx@0.18.5` carries a known npm advisory (used for client-side export + worker-side parsing of organizer-owned files; bounded exposure) — revisit if a patched build ships before submission.
- Simplify pass for M2-M4 UI additions scheduled at M4 close (M2 closed on the codex triage instead; backend already simplified).
- Dev-server tab on :3000 from another session may hold stale Vite deps; this session runs on :3106.

## Next

Milestone M0 (event & library) → M1 (CFP forms). See MILESTONES.md for the full spine.

M0 first commits (from scaffold review, Aug 8): scaffold the capability layer (`convex-helpers` custom functions, `convex/model/*`, `orgQuery`/`eventMutation`) and the job-type registry (shared discriminated union for `jobs.type`/`payload`) **before** any feature table lands.

Deferred with named triggers:
- **Queue lease sweeper + finished-row pruning cron** — when the Import agent (M2) lands; that's the job type that will hit stuck-claimed jobs.
- **ICS input sanitization (CRLF in attendee, non-ASCII `btoa`)** — when `sendIcsTest` becomes the real invite path (M1/M2 comms work).
- **Worker drain-on-shutdown** — when jobs get long enough to care about losing in-flight results on deploy.

## Deadline

Submission: **Wed Aug 12, 10PM PT** — deployed site + open source repo.
