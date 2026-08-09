# PLAN

Current focus only. Context: [docs/BUSINESS_CONTEXT.md](docs/BUSINESS_CONTEXT.md) · [docs/CHALLENGE.md](docs/CHALLENGE.md) · milestones: [docs/MILESTONES.md](docs/MILESTONES.md)

## STATUS: SUBMISSION-READY — M8 (code-review hardening) IN PROGRESS

All 8 milestones (M0-M7) built, tested (220 convex-test, incl. negative authz),
browser-verified as a signed-in user, prod-verified on https://stagestack.dev,
simplified, codex-reviewed + triaged, committed and deployed. Repo clean of
secrets (full-history scan) and submission-ready. The six challenge
requirements are all live and were each walked on prod — see the acceptance
map in the session log (Aug 9 final).

The ONE hand item before public launch (not a blocker for judging — the
deployed site is fully testable now): switch Clerk from its dev instance to a
production instance. See "Must-do by hand" below.

## Must-do by hand (Alvaro)

1. **Clerk production instance** — prod currently runs Clerk's DEV instance
   (orange "Development mode" watermark on the sign-in modal; dev instances
   cap total users and use shared OAuth creds). Judges CAN fully test on it,
   but for a real launch: create a Clerk production instance in the Clerk
   dashboard, add its DNS records (Vercel DNS, zero-config domain), then set
   the new `VITE_CLERK_PUBLISHABLE_KEY` (pk_live_…) + `CLERK_SECRET_KEY`
   (sk_live_…) on Vercel prod, and the prod `CLERK_JWT_ISSUER_DOMAIN` on the
   Convex deployment. Requires your Clerk dashboard — I can't create it.
2. **Promote Convex dev → prod deployment** (optional hardening): everything
   runs on the `scintillating-heron-597` dev deployment today (stable, fine
   for judging). For launch, `npx convex deploy` to a prod deployment and
   repoint `VITE_CONVEX_URL` + the worker's `CONVEX_URL`.
3. Nothing else. Vercel git auto-deploy, the worker VM, Resend, and the domain
   are all wired and working.

## M8 — Code-review hardening — Aug 9 (in progress)

Source: 5-agent comprehensive review (backend correctness, security/authz,
frontend, email/scheduling/worker, tests). Grouped into workstreams matching
the fix orchestration; severity in brackets.

### W-A Publish & portal (privacy/staleness)

- [x] [HIGH] Withdrawn speakers / cancelled sessions stay in the served public blob despite code+email claiming suppression (model/publish.ts:439, model/portal.ts:841, model/sessions.ts:464) — auto-republish on privacy-relevant events (withdraw/decline/decision-correction) when the event has a published program; keep explicit publish for editorial changes; make the withdrawal email wording truthful
- [x] [HIGH] Portal claim trusts unverified email: enforce email_verified from the Clerk JWT in enterPortal/completeHandoffs (model/portal.ts:530,565; users.ts:24) + document Clerk template requirement
- [ ] [MED] publishedPrograms.program single blob nears 1MiB cap and bricks unpublish when republish throws (schema.ts:528, model/publish.ts:269) — dedupe lineup/agenda session duplication + size guard with actionable error (M8 note: 900KiB size guard with largest-sessions error landed, and unpublish now always passes the guard; the lineup/agenda dedupe itself was skipped — agenda entries still embed full session copies)
- [x] [MED] Manager backstage link not gated on speaker confirmation (model/portal.ts:401)
- [x] [LOW] event.website stored/rendered unvalidated → javascript: href on public page (model/events.ts:160, ProgramView.tsx:179)
- [ ] [NIT] Slug rename leaves stale identity in served blob + old URL 404s (model/events.ts:142) (M8 note: rename now rewrites identity into the served blob immediately; no old-slug redirect was built — the old URL still 404s)

### W-B Reminders & email pipeline

- [x] [MED] Hourly sweep is one all-or-nothing transaction across all events (reminders.ts:354) — batch per-event via scheduler continuation; one bad event must not kill all reminders
- [x] [HIGH] Calendar invites fire-once, no retry, no failure record; "unchanged" guard blocks resend (model/agenda.ts:917, emails.ts:191) — record comms-log row at schedule time, patch on success/failure, allow forced resend
- [x] [LOW] Webhook race on .ics path drops delivery status forever (emails.ts:43) — fixed by pre-insert above
- [x] [LOW] Reminder due dates render UTC not event tz (reminders.ts:51); sweeps never stop after event end (only archive); >200-recipient cap silently drops (reminders.ts:75); counters double-count consolidated emails (reminders.ts:346)
- [x] [NIT] audienceCounts 4x read amplification (model/audiences.ts:360)

### W-C Worker queue & import

- [x] [HIGH] No lease/expiry/requeue — claimed jobs stranded forever on worker death (worker.ts:38); claimedAt-based lease sweep + attempts counter with max→failed
- [x] [HIGH] SIGTERM abandons in-flight jobs on every deploy (apps/worker/src/index.ts:113) — drain inFlight before exit
- [x] [MED] Transport errors escape claimAndRun as unhandled rejections → crash loop (index.ts:73)
- [x] [MED] import-execute not idempotent for proposals/sessions — duplicates on re-run (model/imports.ts:160)
- [x] [MED] Worker fns: constant-time secret compare + finish status guard (worker.ts:12,55)
- [x] [HIGH] Import UI unreachable (no nav link) and plan unrecoverable on navigation (import.tsx:90,255) — nav entry + latest-jobs query + resume from server state
- [x] [NIT] Dead "running" job status (schema.ts:203)

### W-D Sessions & CFP backend

- [x] [HIGH] Decline→accept correction duplicates email-less participants + their tasks (model/sessions.ts:157,233,485)
- [x] [LOW] Correction resurrects withdrawn participants (model/sessions.ts:495)
- [x] [MED] File answers hit storage.getUrl unvalidated — one bad proposal breaks reviewer lists (model/cfp.ts:849,1269,1395; model/reviews.ts:315) — normalizeId gate
- [x] [MED] CFP speaker links skip scheme validation → javascript: URLs reach public program JSON (model/cfp.ts:964)
- [x] [LOW] listProposals >500 truncation keeps wrong rows (status-skewed index order) + speakerCount under-count (model/cfp.ts:1210)
- [x] [NIT] vAnswerValue admits numbers that assertAnswerShape always rejects (shared/formDef.ts:73)

### W-E Agenda .ics sequencing

- [x] [MED] SEQUENCE goes backwards after cancel→re-release (Outlook drops invite) + per-participant cancel doesn't persist bump (model/agenda.ts:1041,1188,1261) — persist monotonic per-UID sequence that survives cancellation

### W-F Backend misc

- [x] [LOW] Date.now() in queries (model/team.ts:198,384,411) — inject now
- [x] [LOW] Room/track delete leaves dangling refs in sessions/releasedSlots (model/library.ts:183) — in-use guard; + assertEventActive on library writes
- [x] [NIT] Dead contacts.userId field + by_userId index; auth.viewer skeleton query removal (check no frontend refs)

### W-G Frontend data-loss & correctness

- [x] [HIGH] Form builder loses unsaved work on in-app navigation — useBlocker (app.e.$eventSlug.cfp.tsx:139)
- [x] [MED] Resubmit-mode edits silently discarded when window expires mid-edit (cfp.$eventSlug.proposal.$proposalId.tsx:142)
- [x] [MED] Locale-dependent SSR on public pages → hydration mismatch (lib/datetime.ts:73) — pin luxon locale
- [x] [MED] Settings/builder last-write-wins with no conflict signal (settings.tsx:60, cfp.tsx:128) — dirty-aware re-seed + conflict notice
- [x] [NIT] Builder addField reads draft from closure (cfp.tsx:167); CfpWindowBanner Date.now in render (CfpChrome.tsx:86)

### W-H Frontend a11y & polish

- [x] [MED] DS Dialog: focus trap/restore, Escape, aria-labelledby (ds/components/feedback/Dialog.jsx)
- [x] [MED] Agenda DnD keyboard access (KeyboardSensor + Enter on GridBlock) + DataTable clickable rows keyboard (TimeGrid.tsx:330, DataTable.jsx:20)
- [x] [MED] Agenda drops surface mutation errors (AgendaBoard.tsx:141)
- [x] [LOW] Unify clipboard helper w/ fallback+feedback (proposals/team/publish); room capacity integer≥1 validation (settings.tsx:850); org invite email validation; review timestamps in event tz (ProposalDetailDialog.tsx:451); decision-panel catches surface backend message (ProposalDetailDialog.tsx:165); PARTICIPANT_STATE_LABEL + useNow dedupe; per-row pending + delete confirm in library sections (settings.tsx:546); shift-select stale anchor (proposals.tsx:203); publicLinks hardcoded origin (ProgramView.tsx:33); import reviewer-gate flash (import.tsx:93)

### W-T Tests & deps

- [x] Publish: staleness semantics (edit w/o republish serves old blob), setAgendaItem, http.ts via t.fetch (404/CORS/cache), archived gating, production-path seeding (drive accept/release instead of raw inserts)
- [x] Calendar-invite action body executes in a test (finishAllScheduledFunctions + mocked fetch): attachment/idempotency-key/failure recording
- [x] Reminder sweep: >cap overflow behavior, stop-on-cancel/withdraw
- [x] New M8 behaviors: dup-participant fix, sequence monotonicity, lease requeue, import idempotency, email_verified gate
- [x] Frontend test infra (vitest+testing-library in apps/web) + 3 priority tests: CFP wizard validation/conditional logic, agenda placement math, portal confirm dialog fields
- [x] xlsx@0.18.5 advisory: swap to a patched/alternative lib or document bounded-exposure decision (swapped both apps to SheetJS CDN xlsx@0.20.3)

### M8 verification (Aug 9)

Integration pass: convex codegen + tsc clean, web/worker typecheck clean,
267 convex tests + 41 web tests green, lint:ds 0 errors. Frontend wired to
the new team.ts `now` args (team/org/invite/BulkBar via useNow+useLastLoaded).

**M8 manual steps (Alvaro):**

- **Clerk JWT template**: add the `email_verified` claim
  (`{{user.email_verified}}`) to the `convex` JWT template in the Clerk
  dashboard. Portal entry now REQUIRES it — an absent claim reads as
  unverified and every portal claim is refused with `email_unverified`.
- **Redeploy the worker VM** (`scripts/deploy-worker.sh`) after this lands:
  SIGTERM drain, batchIndex idempotency, and the xlsx 0.20.3 swap all live
  in apps/worker.
- **Schema push check**: the schema now drops `contacts.userId` (+ its
  `by_userId` index) and the jobs `"running"` status. If any existing rows
  on the deployment still carry those values the push is refused — clear
  them first (none expected: portal claims live on eventContacts.userId and
  no job ever reached "running").

## QA-walk fixes — Aug 9

From an external CFP-flow QA table (5 items):

- [x] "Create organization"/"New organization" header button dropped pre-hydration clicks — now disabled until hydrated (new lib/useHydrated.ts; onboarding-card variant was already SSR-disabled)
- [x] Stale Settings copy "The form builder arrives with M1" — replaced with accurate two-gate copy + link to the builder
- [x] Builder "isn't public" callout now explains both gates (Publish form vs CFP published) + that the submission window and tracks/tags/rooms/custom fields live in Settings (QA spec-deviation #2)
- [x] Locked-field label hint clarifies what IS editable (label/help) vs fixed (type/required/removal) (QA "not-the-right-flow")
- [x] "Conditional logic is section-level, not field-level" — NOT a deviation: field-level visibleIf is fully wired (formDef.ts:56, evaluator :106, builder ConditionEditor at cfp.tsx field editor); the editor lives inside the expanded field row, which the QA agent likely never opened. No change beyond the discoverability of the callout copy above.

## Done: M7 — Public content out — Aug 9

- [x] One shared published-program projection (model/publish.ts): only Confirmed speakers named, awaiting -> "to be announced", NO contact/backstage/host data in the blob; republish is the sole writer; unpublish = flag flip + rewrite
- [x] Independent lineup vs agenda publication; per-session + per-agenda-item flags; public page toggle
- [x] Public read: unauthenticated query (SSR event page) + HTTP API GET /api/events/<slug>/program (CORS, 60s cache) — same blob so page/API/embed can't disagree
- [x] Public event page /e/<slug> (SSR + OG meta), publish console, embed /embed/<slug>
- [x] Browser + API verified: publish -> API returns confirmed-only projection (privacy invariant holds) -> page + embed render; 220 tests (7 new)

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
- Aug 9 (final): **ALL MILESTONES DONE.** Acceptance map (each walked on prod https://stagestack.dev):
  1. **Custom CFP forms** — builder w/ conditional logic (verified: Workshop-format field appears on selection), locked system fields, versioned publish; public wizard Welcome→Account→Submission→Participants→Review w/ autosave, file upload, submitter confirmation + admin notification emails delivered.
  2. **Speaker portal** — verified-email auto-claim, confirm/decline (fields-preview dialog), profile edit propagating to snapshot + directory, manager handoff, organizer read-only preview.
  3. **Templated comms + calendar invites** — 13 editable templates, personalized one-off delivered to a real inbox + comms log w/ webhook Delivered; reminder sweep; .ics REQUEST/CANCEL (RFC-correct) sent on slot release, rendered natively in Gmail (walking-skeleton confirmed).
  4. **Review & scoring + Import** — assign → Submit&Next → stage → release (accept/decline) creating sessions + awaiting participants + decision emails; queue masked from submitters; **Import-with-AI ran on the exe.dev VM** (Flue/gpt-5.6-luna): CSV → plan (reuse/dup/uncertainty/skip) → approve → 5/5 records via authorized capabilities.
  5. **Drag-and-drop agenda + conflict detection** — 5 views, pixel time-grid DnD, room-clash + speaker-double-book blockers (verified in lanes), same-track warning; release refused while clashed → resolved → released w/ .ics.
  6. **Real-time speaker-ops dashboard** — "N accepted speakers are missing a bio or headshot" verbatim, per-speaker state/claim/missing/outstanding/overdue, derived session readiness w/ reasons.
  Plus M7: public event page + read API + embed serving one privacy-filtered projection (confirmed-only, no contact/host data — verified on prod API).
  Repo: no secrets in history; .env files ignored; 220 tests + 3 workspaces typecheck + DS lint all green.
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
