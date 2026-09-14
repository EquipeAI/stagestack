# StageStack — Comprehensive Code Review (historical record)

Archived 2026-08-13 from the repo root (`REVIEW.md`). Findings were verified
against commit `a48410e`; the "Remediation status (live)" section below is a
snapshot from 2026-08-09, not a live tracker — the fix-order items landed in
the subsequent cycles (see [PLAN-2026-08-eval-fix.md](../PLAN-2026-08-eval-fix.md)
and [PLAN-2026-08-ux-maturity.md](../PLAN-2026-08-ux-maturity.md)).

**Date:** 2026-08-09 · **Scope:** full repo — `convex/` backend, `apps/web`, `apps/worker`, tests, infra
**Method:** 5 parallel review agents (backend security/authz, schema/perf, frontend, worker/import-agent, tests/comms/infra) + direct validation runs. Nothing was modified.

---

## Verdict

The codebase is in unusually good shape — arguably submission-ready with caveats. The architecture's core invariants (identity derived from `ctx.auth` only, capability layer with server-side caller resolution, reviewers never see PII, derived-not-stored readiness/conflicts, LLM never holds write authority) are implemented consistently and verified by real negative-authz tests. **No Critical issues were found.** The findings below are mostly scale ceilings, a few genuine PII/authorization slips, and — most pressingly — quality gates that exist but are currently red with no CI to catch them.

### Validation status (run as part of this review)

| Gate | Status |
|---|---|
| `npm run typecheck` (all workspaces) | ✅ clean |
| `npx vitest run` (root — Convex backend) | ✅ 19 files / 267 tests pass |
| `npx vitest run -w apps/web` | 🔴 **7/41 fail** — `React.act is not a function` |
| `npm run lint -w apps/web` | 🔴 **red** — 1 warning vs `--max-warnings 0` |
| CI | ❌ **does not exist** — nothing runs any gate automatically |

---

## Remediation status (live)

Work started 2026-08-09 from commit `a48410e`. Scope = the six steps in *Suggested fix order* below.
Findings in the 🟡 Low section that are **not** referenced by the fix order are explicitly out of scope for this pass.

**Correction to the validation table above (verified 2026-08-09):** the web suite is **not** broken.
`npm run test -w apps/web` is green (41/41). The reported `React.act is not a function` failure reproduces
only with `NODE_ENV=production` set, which makes Vite resolve React's production build. The finding survives
as *"the web suite is not hermetic and will break in any CI image that sets NODE_ENV=production"* — the fix is
to pin React's development condition in the test config, not to bump `@testing-library/react`.
The review's own repro command (`npx vitest run -w apps/web`) selects nothing: in vitest 4 that is a filename
filter against the root config's `include: convex/**`.

| Step | Items | Status |
|---|---|---|
| 1 — Gates & CI | H1 (hermetic web tests, lint gate, CI workflow) | ✅ **done** — `apps/web/vitest.config.ts` pins `test.env.NODE_ENV='development'` (React/react-dom choose their CJS bundle from `process.env.NODE_ENV` at *require* time; `resolve.conditions` is a no-op because React's exports map has no `development` condition, and `mode:'development'` alone was verified insufficient); design-adherence eslint block now `ignores` `**/*.test.*`; new `.github/workflows/ci.yml` runs typecheck + both suites + lint on push/PR. Verified: web suite green with `NODE_ENV` unset, `=production` **and** `=test`, lint exit 0. **Amended at close-out:** pinning `NODE_ENV` was not sufficient on its own — Vite derives `import.meta.env.DEV` from the resolved *mode*, so an ambient `NODE_ENV=production` still flipped `DEV` to false and broke a test added later in this pass (`RouteBoundary` → "shows the stack in development only"). Fixed by also pinning `mode: 'development'` in the config **and** making that test stub `DEV` explicitly rather than inheriting it — a test that can silently invert its own premise is worse than no test. |
| 2 — One-liners with real impact | H2, M9, invite `noindex`, `og:url` via `siteOrigin()` | ✅ **done** — **H2:** `requireOrganizer(ctx.caller)` on `imports.getJob` + a `NEGATIVE:` test proving a reviewer is refused on a done plan carrying email/phone. **M9:** new `sheetSafe()` applied in `buildSheet`, so both the CSV and XLSX paths are covered from one place; plain numbers (`-4`, `+1.5`, `1e3`) are exempt so real numbers stay numeric in the workbook, and leading tab/CR triggers are caught. **noindex** on `invite.$token` (byte-identical to the embed route). **og:url** now `siteOrigin()`-derived — but see the follow-up below, it is only half-fixed. Plus **M1's UI half**: the approval step renders every writeable field enumerated from the record itself (not a hardcoded list, so a field added to `vImportRecord` can never again be invisible), long values clamped-but-expandable and `pre-wrap` so a smuggled newline shows. |
| 3 — Worker trust | H3, M1, M3 | ✅ **done** — **H3:** `claim` now mints a 128-bit fencing token (`jobs.claimToken`) required by `finish`/`touch`/`importExecuteBatch`; new `worker.touch` heartbeat writes `jobs.heartbeatAt` every 2 min and the sweep measures the lease from `max(heartbeatAt, claimedAt)`, so a live 50-minute plan is never requeued; the sweep retires the token on requeue/give-up so an evicted worker stays fenced. **M1:** `importExecuteBatch`'s `records` argument is *gone* — the batch is sliced server-side out of `job.payload.records` (what `imports.confirm` stored) by `batchIndex`, making the confirmation boundary structural rather than client-side. **M3:** worker endpoints share a 600/min bucket (sized from the worker's real push-based behavior). Also: `assertPlanShape` is no longer dead — `finish` validates LLM plan output before an organizer sees it; `agentKey` is now per-run so two runs can't clobber the capture map. `worker.test.ts` 9 → 16 tests, including stale-worker-after-reclaim, heartbeat-vs-sweep, and server-side slicing. |
| 4 — Scale ceilings | H4, H5, M4, M5, M6 | ✅ **done** — **H4:** one read per table + in-memory grouping + memoized `getUrl`; rebuilds funnel through one scheduled writer that skips the write when the projection is byte-identical (N flips → one row rewrite, no version churn/OCC storm); portal withdraw/decline now cost **zero** program computes. **H5:** one shared `takeAll`/`takeCapped` in `model/validation.ts` on a single `.take(cap + 1)` probe; each of ~15 call sites was decided individually — *throw* where a partial read is a wrong answer (board, release gate, readiness, audiences, reminders, the whole published projection), *report `capped`* where it is merely incomplete (`listProposals`), *documented plain bound* where a newest-first limit is what the view means (`contactLog`). **No cap number was raised.** The reminders sweep lost its 500-event window entirely via a `by_reminderCadenceDays` index over opted-in events. **M4:** `by_eventId_and_toEmail` + normalize-on-write (no migration needed, and it fixes a latent bug — the old read was `.take(2000)` *ascending*, so busy events missed the **newest** messages). **M5:** the calendar trail is read once per release wave and memoized (100-session re-release: ~200k doc reads → 3). **M6:** `instancesBySession` grouped once. |
| 5 — Self-host coherence | M14, `.env.example`, doc drift, `engines` | ✅ **done** — **M14:** `MAIL_FROM` + `RESEND_TEST_MODE` are env-driven with **fail-safe defaults** (test mode ON unless explicitly `false`/`0`/`no`/`off`; any typo stays ON). This matters more than it looks: the Resend component enforces `testMode` *inside* the sending mutation by throwing for non-`resend.dev` recipients, so a wrong default doesn't log a failed send — it **rolls back the caller's write**. Hence `testMode` is read *per send* via a getter, not captured at module construction, so an env flip takes effect on the next send. `MAIL_FROM` is now the single source of truth at all five From sites (the fifth — a hardcoded `.ics` ORGANIZER in `model/agenda.ts:66` — was found at close-out; a self-host would otherwise have advertised *our* domain as organizer, which is exactly what gets invites flagged). **Docs:** the `testMode` claim now matches the code, `DATA_MODEL.md`'s two phantom fields are replaced with the real ones, the env table gains `SITE_URL`/`MAIL_FROM`/`RESEND_TEST_MODE` **and** records that `SITE_URL` is now read in *two* runtimes, and the false "versions pinned exactly" claim is replaced by what the tree actually does (exact pins + carets + `npm ci` on the lockfile as the real pin). `engines: node >=22.19` added, matching CI. `.env.example` created from a grep of the code, not the docs, grouped by *where* each var must be set. `deploy-worker.sh` no longer carries a personal SSH identity. |
| 6 — UX edges | H5-frontend, M10, M11, M12, M13, M15 | ✅ **done** — **M13:** solved centrally via a new `RouteBoundary` (`RouteError`/`RouteNotFound` on `defaultErrorComponent`/`defaultNotFoundComponent`), so all four public surfaces inherit a styled fallback with no per-route edits; the DEV-only stack gating was verified against the *built* prod bundle (`grep "Stack trace" .output/…` → 0 hits). **M10:** client-only token cache (30s TTL, further clamped by the JWT's own `exp` minus 10s), SSR path deliberately untouched so no server module-level state can leak a token across users, plus a Clerk `useAuth` watcher that drops the cache the instant identity changes. **M11:** the re-seed effect early-returns while editing, and a conflict callout offers "Discard my edits". **M12:** `Field` now injects `aria-describedby`/`aria-invalid` into a cloned single child with `role="alert"` on the message; every CFP control kind wired — *except radios*, see step 7. **Wizard dead-end** fixed. +11 web tests. **M15:** `List-Unsubscribe: <mailto:…>` on `manual.oneoff` + `reminder.*` only — never on transactional lifecycle mail. `List-Unsubscribe-Post` is deliberately **not** sent: RFC 8058 advertises an endpoint that auto-honours the request, and without a suppression row checked in `sendLoggedEmail` that would be a header promising something the backend ignores. The full one-click path (suppressions table → check in `sendLoggedEmail` → HMAC route) is written down in ARCHITECTURE.md instead. |
| 7 — Follow-ups found *while fixing* | SSR-correct `siteOrigin()`, remaining `robots` gaps, `RadioGroup` a11y, grouped-control label/jump targets, dead `--ext` flag, worker↔`imports` payload-coupling guard | ✅ **done** — **a11y:** `RadioGroup` takes `...rest` (spread only on the `role="radiogroup"` element, matching `Select`/`Textarea`), `.d.ts` + `_adherence.oxlintrc.json` allow-list widened so no call-site `eslint-disable` was needed; the `'radio'` case is wired, completing M12 for *every* control kind; and the pre-existing grouped-control bug is fixed at the cause — a `<label for>` aimed at a group names nothing, so grouped controls now use `aria-labelledby` → the label and carry the `fieldDomId` + `tabIndex={-1}` so the error-jump resolves *and* focuses. **Origin:** new `apps/web/src/lib/origin.ts` resolves the origin server-side from `x-forwarded-host`→`Host`→`SITE_URL`→`PRODUCT_ORIGIN`, with `x-forwarded-proto` choosing the scheme (http only for loopback). `Host` is *validated, never sanitised* (a value carrying `/`, `?`, `@`, whitespace or a second hop is rejected), and the code states why reflecting Host is acceptable for metadata/copyable links but must never reach a redirect `Location`, cookie domain or email body. Verified three ways: 8 unit tests, the built client chunk proving the Start compiler strips the server branch (no h3/`async_hooks` in `.output/public`), and **curl against the built SSR server** for six header combinations including forged hosts. **noindex** now on all four non-public surfaces, confirmed in SSR'd HTML. **`--ext`** removed, proven by identical before/after ESLint file lists (117 files, byte-identical). Plus: the worker↔`imports.confirm` coupling is now pinned by a test that replays the worker's own `batchIndex` slicing against `payload.records`, so a future refactor that moves the approved records fails loudly instead of silently breaking execution. |


### Follow-ups opened by this remediation pass (not in the original review)

**These are in scope and being fixed in this pass** (tracked as step 7 in the table above).

- **`og:url` is only half-fixed.** `e.$slug.tsx` now calls `siteOrigin()`, but `siteOrigin()`
  (`apps/web/src/components/public/ProgramView.tsx`) returns the hardcoded `PRODUCT_ORIGIN` during SSR — it only knows
  `window.location` on the client — and `og:url` is read by crawlers from the SSR HTML. So a self-hosted or preview
  deployment still emits `https://stagestack.dev`. The real fix is for `siteOrigin()` to read the request Host on the
  server; same latent issue at `routes/index.tsx:18`. Folded into step 5 (self-host coherence).
- **`robots` meta gaps beyond invite:** `portal.$eventSlug.tsx` and `cfp.$eventSlug.proposal.$proposalId.tsx` have no
  `noindex`. Neither carries a token in the URL (portal is verified-email claim, the proposal route is auth-gated), so the
  leak class is weaker than invite's bearer URL, but the inconsistency is worth closing.
- **`apps/web`'s lint script passes `--ext ts,tsx`**, which ESLint 9 flat config ignores. Harmless, cosmetic.
- **Worker/`imports.ts` coupling to record on purpose:** `importExecuteBatch` now depends on the approved records living at
  `job.payload.records`. If `imports.confirm` ever moves them, `convex/worker.ts` must move with it.
- **The worker rate limit does not throttle wrong-secret guessing**, because a throwing mutation rolls its own
  rate-limit consumption back (the component is transactional). Guessing stays bounded by secret entropy + the
  constant-time compare; the limiter bounds what an *accepted* caller can push. Documented in code.

### Post-remediation gate status (re-run by the integrator, not self-reported)

| Gate | Before (commit `a48410e`) | After |
|---|---|---|
| `npm run typecheck` (all workspaces) | ✅ clean | ✅ clean |
| `npx vitest run` (Convex backend) | ✅ 19 files / 267 tests | ✅ **19 files / 299 tests** (+32) |
| `npm run test -w apps/web` | reported 🔴 7/41 fail — actually ✅ 41/41 | ✅ **11 files / 75 tests** (+34) |
| same, with `NODE_ENV=production` | 🔴 7 fail (`React.act is not a function`) | ✅ 75/75 |
| same, with `NODE_ENV=test` | not checked | ✅ 75/75 |
| `npm run lint -w apps/web` | 🔴 1 warning vs `--max-warnings 0` | ✅ exit 0 |
| `npm run build -w apps/web` | not checked | ✅ builds (client + SSR + nitro) |
| `apps/worker` typecheck | ✅ clean | ✅ clean |
| Backend suite hermeticity | 🔴 made a real request to `api.resend.com` | ✅ network-blocked; 10/10 clean runs |
| CI | ❌ does not exist | ✅ `.github/workflows/ci.yml` runs every gate above on push + PR |

Backend tests grew 267 → 299 and web 41 → 75; every new test asserts a behavior this pass changed, and no existing
test was weakened to pass. Where an existing test encoded the *old* behavior (the unfenced worker `claim`/`finish`,
inline republish, `listProposals`' bare array) it was updated deliberately and named as such in the agent's report.

### One more thing the review missed entirely: the suite was not hermetic

`emails.sendWithIcs` posts the calendar invite to the **raw Resend API with `fetch`** (the component can't carry an
attachment), so any test that drains scheduled functions made a real request to `api.resend.com`. It 401s on the fake
key, and the round trip is what made `publish.test.ts`'s production-path test **flake at the 5s timeout — about 1 run
in 8 locally**. In a sandboxed CI with no egress it would not have flaked, it would have failed *every* run: the
brand-new workflow from step 1 would have gone red on its first push for a reason unrelated to any code change.
Fixed with a suite-wide `fetch` guard (`convex/test.setup.ts`) that answers the Resend endpoint locally and refuses
every other host **by name**. `publish.test.ts` went from ~5s to 517ms, and 10 consecutive full runs are clean.
The guard assigns `globalThis.fetch` directly rather than via `vi.stubGlobal`, so a test that installs its own fetch
spy restores *the guard* on `vi.unstubAllGlobals()` instead of the real `fetch`.

### Where this review was wrong (found by fixing it)

1. **H1's "7/41 web tests fail" was an environment artifact**, not broken code — see the correction above. Root cause is
   `NODE_ENV=production` making React resolve its production CJS bundle; the review's suggested
   `resolve.conditions: ['development']` fix would have been a **no-op** (React's exports map has no `development`
   condition) and `mode: 'development'` alone was verified insufficient. The real fix is `test.env.NODE_ENV`.
2. **M5's stated premise is false.** The review says "the patch sites are already centralized" and recommends stamping
   `lastCalendarMessageStatus` onto `sessionParticipants`. `messages.deliveryStatus` is actually written from *two*
   places — the Resend webhook (`emails.ts handleEmailEvent`, keyed by `resendEmailId`) and `patchCalendarMessage` — so
   that stamp would have needed a second writer inside the webhook path and would have been a cached copy free to
   disagree with the log it derives from. Fixed by indexing + memoizing the lookup instead, leaving the comms log as the
   single source of truth and the derived-not-stored property intact.
3. **H5's throw condition has an off-by-one.** "On `rows.length === CAP`, throw" cries wolf on an event sitting exactly
   at the cap. The shared helper probes `cap + 1` so "exactly full" and "overflowing" are distinguishable.
4. **`audiences.ts` was cited as the *reference implementation* of correct truncation handling, but its own loader was
   silently capped.** `finalize()`'s `truncated` flag and `sendOneOff`'s refusal were computed from a read that could
   itself drop rows, understating `totalKnown` and reporting `truncated: false`. The pattern the review told everyone to
   copy needed fixing first.
5. **10 of 58 file:line citations omit the `model/` path prefix** (e.g. `publish.ts:443` is `model/publish.ts:443`).
   Line numbers are correct in the model files.

### Deliberate trade-offs accepted while fixing (read before "optimizing" these back)

- **An explicit organizer publish now computes the projection twice** — once to validate size synchronously, once in the
  scheduled writer. That is intentional: the 900KB guard has to fail *the organizer's own mutation* with its actionable
  message, or the click succeeds while a scheduled function throws into the void and the public program goes silently
  stale. H4 removes the write + OCC on `publishedPrograms` and the N+1 read pattern from the *flag-flip* path, not the
  validation read from the rare explicit publish.
- **`publish.state` gained `stale: boolean`**, computed by comparing the stored blob against a fresh projection, so a
  *failed* rebuild is visible rather than serving the last good blob with confidence. "Skipped because byte-identical"
  and "failed" are deliberately distinguishable. Cost: one projection recompute per `state` read — confined to
  `app.e.$eventSlug.publish.tsx`, the only caller, which already recomputes it for `publish.preview`.
- **API shape changed:** `publish.setLineup/setAgenda/setSession/setAgendaItem` now return `null` instead of the version
  number — the version is written by the scheduled rebuild, so returning one would have been a lie. The web app never
  read those return values (it reads `state.version` reactively).
- **`republishIfPublished` is still inline** at `model/events.ts:203` (rename) and `model/sessions.ts:510`
  (correction/cancel). Both are infrequent organizer actions whose tests assert immediate republish, and neither is on a
  user-facing hot path like the portal was. Switching them is a one-line change if profiling ever justifies it.
- **The worker rate limit does not throttle wrong-secret guessing** (a throwing mutation rolls its own consumption
  back); that stays bounded by secret entropy + the constant-time compare. Accepted and documented in code.

---

## Findings by severity

### 🔴 High

**H1 — Broken web component tests; nothing enforces the gates.**
`npx vitest run` in `apps/web` fails every React-render test: vitest resolves React's *production* build where `act` doesn't exist (`@testing-library/react/dist/act-compat.js:46`). The two most valuable frontend suites — `components/agenda/placement.test.tsx` (3/9 fail) and `components/portal/SpeakingCard.test.tsx` (4/4 fail) — provide zero signal. Root cause of them shipping broken: **no CI**. The lint gate is also red (`placement.test.tsx:166` raw-px warning vs `--max-warnings 0`).
*Fix:* make `apps/web/vitest.config.ts` resolve React's development condition (`resolve.conditions: ['development']`) and/or bump `@testing-library/react` for React 19.2; exclude `*.test.*` from the design-adherence eslint block; add a minimal CI workflow running backend tests, web tests, typecheck, lint.

**H2 — Reviewers can read import job results containing contact PII.**
`convex/imports.ts:105-134` — `getJob` is an `eventQuery` (admits reviewers) and returns `result: job.result`, which for a done `import-plan` job is the full plan: speaker names, emails, phones. The sibling `listJobs` (imports.ts:78) correctly calls `requireOrganizer`. This violates the project's own hard rule ("reviewers must never see contact details") — the same rule `model/reviews.ts:253-262` enforces so carefully elsewhere. Job IDs aren't enumerable (why not Critical), but they leak via URLs/screenshots/audit entries.
*Fix:* one line — add `requireOrganizer(ctx.caller)` to `getJob`.

**H3 — Worker lease has no heartbeat: slow-but-healthy planning jobs get requeued mid-run and can double-execute.**
`WORKER_LEASE_TTL_MS` is 10 min (`convex/worker.ts:33`); a plan job runs up to ~10 sequential LLM exchanges, each allowed 5 min (`apps/worker/src/import-agent.ts:26,355-369`). Nothing renews `claimedAt`, so the sweep (`worker.ts:122-127`) can requeue a live job; a second planner then runs concurrently (double OpenRouter spend, capture-map clobbering via shared `agentKey` at `import-agent.ts:329-331`). Worse, `finish` only checks `status === "claimed"` (worker.ts:86-88), so once worker B re-claims, stale worker A can still `finish` the job — the race the comment claims to prevent is only prevented for the *requeued* case, not the *re-claimed* case.
*Fix:* heartbeat (`touch` mutation every ~2 min, or sweep skips fresh heartbeats) + a claim token written at claim and required by `finish`/`importExecuteBatch`.

**H4 — `computeProgram` is an N+1 rebuild executed inline inside every publish-affecting mutation.**
`convex/model/publish.ts:168-190` — per published session: one participants query; per confirmed speaker: an `eventContacts` get + a `storage.getUrl` call. A 500-session × 3-speaker event is ~500 queries + 1,500 gets + 1,500 storage calls **in one transaction**, and it runs on every single-session flag flip (`publish()` ends with `republish`, publish.ts:443) and inline inside user-facing portal mutations (withdraw at `portal.ts:856-860`, decline at `portal.ts:784-786`). Risk: 16k-doc-read/8MiB transaction limits at realistic conference sizes, OCC contention on the single `publishedPrograms` row, latency on portal writes.
*Fix:* (a) load participants/contacts once via `by_eventId` indexes (the pattern `audiences.ts:150-184` already uses) and memoize `getUrl` per headshotId; (b) debounce flag flips — set the flag, schedule one rebuild via `ctx.scheduler.runAfter(0, …)`; (c) move `republishIfPublished` out of portal mutations into a scheduled mutation.

**H5 — `.take(N)` caps silently truncate event-graph reads; the UI compounds it.**
The "load whole event graph with a cap" pattern (`agenda.ts:400-418`, `readiness.ts:200-222`, `reminders.ts:129-142`, `publish.ts:132-149`, `audiences.ts:154-167`) drops rows past the cap with no error: conflict detection can miss a double-booking, reminders stop chasing, the published blob drops sessions. `reminders.sweep` scans only the first 500 events (`reminders.ts:434`). The codebase already has the right answer — `audiences.finalize()` reports `truncated` and `sendOneOff` *refuses* a capped audience (`comms.ts:252-258`) — it just isn't applied elsewhere. Frontend counterpart: `listProposals` caps at 500 (`cfp.ts:1248`) and the table reports "Showing 500 of 500" for a 700-proposal event (`app.e.$eventSlug.proposals.tsx:374`) — silent data loss in the organizer's primary surface.
*Fix:* on `rows.length === CAP`, throw (conflict/release paths — a wrong answer is worse than an error) or return a `truncated` flag the UI surfaces; index the sweep on `reminderCadenceDays`; make `listProposals` return `{ rows, capped }`.

---

### 🟠 Medium

**Security & worker trust**

- **M1 — Worker executes caller-supplied records, not the organizer-approved plan.** `convex/worker.ts:192-241` accepts `records` from the worker rather than slicing `job.payload.records` (the approved subset stored by `imports.confirm`). A prompt-injected agent or compromised worker could execute unapproved records with the initiating organizer's authority. Bounded (validated, own authority), but the confirmation boundary the spec calls "structural" is only client-side. Related: the approval UI renders only speakers/email (`app.e.$eventSlug.import.tsx:68-85`) — `bio`/`abstract`/`description` are never shown, so injected text can hide in unrendered fields; and `confirm` never hash-verifies the approved set against `planJob.result`. *Fix:* execute from `job.payload.records` by `batchIndex`; render all writeable fields in the approval UI.
- **M2 — Failed `import-execute` jobs can't resume; re-confirm duplicates proposals/sessions.** Execution is per-record partial by design and batch commits are idempotent — but if the job fails after some batches (e.g. initiator demoted mid-import), there's no resume path; "Start over" creates a fresh job with empty `completedBatches`, and proposals/sessions always create (`model/imports.ts:160-179`). *Fix:* retry in place preserving `completedBatches`, or make proposal/session creation execution-time-idempotent on (eventId, normalized title).
- **M3 — Rate limiter installed but never used.** `app.use(rateLimiter)` is wired (`convex/convex.config.ts`) and ARCHITECTURE.md promises it guards abuse-prone endpoints, but grep finds zero usages. Consequences: (a) unauthenticated-guessable worker endpoints (`pending`/`claim`/`finish`, public + shared-secret only — `worker.ts:36-97`) have no throttling; (b) `imports.start`/`generateUploadUrl` let one organizer burn unbounded LLM credit; (c) authenticated CFP writes (`startProposal` etc., `cfp.ts:173-253`) have no per-user cap when an event leaves `maxSubmissionsPerUser` unset (the default). Upload-URL minting *is* limited — the asymmetry suggests partial application. *Fix:* wire the installed limiter onto these four surfaces.

**Backend performance**

- **M4 — `contactLog` filters unindexed `toEmail` over a 2,000-row event scan** (`model/comms.ts:355-363`); silently truncates past the cap. *Fix:* index `(eventId, toEmailLower)` or stamp `eventContactId` at send sites.
- **M5 — `failedLastInvites` scans the event comms log per re-released session** (`model/agenda.ts:1010-1016`); a 100-session bulk re-release can read 200k message docs. *Fix:* store `lastCalendarMessageStatus` on `sessionParticipants` (patch sites are already centralized) or index `messages` by `(eventId, kind)`.
- **M6 — `readiness.dashboard` is O(sessions × instances)** — `instances.filter(...)` per session (`readiness.ts:304-315`), 8M comparisons at cap, re-run on every reactive invalidation. Participants already get grouped; instances didn't. *Fix:* build `instancesBySession` once.
- **M7 — N+1 batching gaps:** `reviews.myAssignments` (`reviews.ts:304-329`, per-assignment proposal get + speakers query + per-file `getUrl`), `imports.executeRecord` re-reading the whole library per track/tag record (`imports.ts:142-143`), `sendOneOff` re-getting contacts it already held (`comms.ts:280-284`).
- **M8 — `auditLog` grows unbounded** — per-id rows on bulk ops (up to 500 per `assignReviewers`), no retention sweep, no audit-UI-friendly index. *Fix:* retention cron + index/pagination when an audit viewer ships.

**Frontend**

- **M9 — CSV/XLSX export vulnerable to spreadsheet formula injection.** `components/abstracts/exporters.ts:105-110` quotes but doesn't neutralize cells starting with `=`, `+`, `-`, `@`; `buildSheet` includes every attacker-controllable CFP answer. A submitter can ship `=HYPERLINK(...)` into a file an organizer opens in Excel. *Fix:* prefix matching strings with `'` in `buildSheet` (covers both formats).
- **M10 — Root `beforeLoad` makes a Clerk round-trip on every navigation — and every link hover.** `__root.tsx:71-79` + `defaultPreload: 'intent'` + `defaultPreloadStaleTime: 0` (`router.tsx:30-37`). *Fix:* cache the token client-side with a short TTL (Clerk JWTs already expire ~60s).
- **M11 — Manager's in-progress session edits clobbered by the live query.** `ManagedSessionCard.tsx:45-50` re-seeds the edit form from the live subscription; an organizer edit silently replaces a manager's unsaved typing. Everywhere else the codebase deliberately avoids this ("local copy wins"). *Fix:* don't re-seed while editing/dirty.
- **M12 — CFP wizard errors aren't announced to screen readers.** `ds/components/forms/Field.jsx:15-19` renders the error as an unlinked sibling — no `aria-describedby`, no live region; `Select`/`Textarea`/`RadioGroup`/`Checkbox` never receive `aria-invalid` (`CfpForm.tsx:244-272`). Focus moves correctly; the error itself is invisible to AT. *Fix:* `useId()`-linked `aria-describedby` + `role="alert"`.
- **M13 — Public/judge-facing routes fall back to a bare `<p>` on error.** `router.tsx:39-41`; `e.$slug`, `embed.$slug`, `invite.$token`, `portal.$eventSlug` have no route-level `errorComponent`. A Convex outage on the shareable event page renders an unstyled paragraph. *Fix:* styled `defaultErrorComponent` (reuse the `Callout`/`PageBody` pattern).

**Comms & infra**

- **M14 — `testMode: false` is hardcoded and contradicts the README.** `emails.ts:15-17` vs README.md:72-73 ("the Resend component starts in testMode — flip it deliberately"). A fresh self-hosted clone attempts **real sends** from `hello@stagestack.dev` (a domain the self-hoster doesn't control) and records every lifecycle email as failed. Related: `MAIL_FROM` is hardcoded in two places (`emails.ts:85`, `model/comms.ts:23`). *Fix:* env-var-driven (`RESEND_TEST_MODE`, `MAIL_FROM`), fix the README claim.
- **M15 — No unsubscribe mechanism anywhere.** Grep for `unsubscribe|List-Unsubscribe|opt-out`: nothing. `sendOneOff` broadcasts to audiences up to 200 — bulk mail under Gmail/Yahoo 2024 sender rules, which penalize missing `List-Unsubscribe` even below the 5k/day threshold. *Fix:* add the header (ideally one-click + per-event opt-out row checked in `sendLoggedEmail`) at least for `manual.oneoff` and `reminder.*` kinds.

---

### 🟡 Low (selected — grouped)

**Authz hardening** (no live holes, latent footguns)
- Invitation acceptance not bound to invitee email — a forwarded link is usable by any signed-in mailbox (`model/team.ts:216-293`); portal claim already has the right pattern (verified-email match at `model/portal.ts:548`). Duplicate-invite check silently bounded at `.take(20)` (team.ts:84-100).
- `publish.preview` (`publish.ts:27-33`) and `team.listForEvent` (`team.ts:33-42`) expose would-be-public program / colleague emails to reviewers — beyond their assigned-proposal scope.
- Model-layer role re-checks applied unevenly: `updateEventSettings`, `setArchived`, all of `model/library.ts` lack the re-check their siblings perform — fine today (only organizer wrappers call them), footgun for the agent-adapter pattern.
- Storage read side is bearer-URL with no expiry; upload issuance is well-gated and rate-limited. Acceptable v1; proxy via auth-checked HTTP action for sensitive evidence files later.
- `WORKER_SECRET` travels as a function argument → visible in Convex dashboard function history; documented v1 tradeoff with the right upgrade path (Custom JWT).
- `assertPlanShape` is dead code (`model/imports.ts:68-88`) — plan results are never validated server-side; call it in `worker.finish` or delete it.

**Backend correctness/scale**
- `conflictsFor` O(n²) pairwise (`agenda.ts:273-295`) — owned trade-off, bounded; sweep-line when profiling says so.
- `jobs` table never pruned (embeds full plans + results); no retry/backoff for deterministic job failures (only hung jobs retry via sweep); worker error messages passthrough OpenRouter internals to the organizer UI; no file-size cap before `XLSX.read` (rows capped, bytes not); `OPENROUTER_API_KEY` not validated at startup (fails per-job instead — graceful but quiet).
- Wall clock in `cfp.getMyProposal` query (hint-only, acknowledged); `assignReviewers` bulk cap 500 vs the codebase's own 100 norm; `completedBatches` whole-array rewrite per batch; `publicationFlags.targetType/targetId` as bare `v.string()`.
- Webhook can regress `deliveryStatus` on out-of-order events (`emails.ts:50-56` — the *send* path already guards this, the webhook path doesn't).
- Dev-probe sends still shipped: `sendTestEmail`, `sendIcsTest` send real email (internal-only, so unreachable — delete post-skeleton).
- .ics: `URL:` value TEXT-escaped though URI-typed (`ics.ts:187-189` — unreachable today). Everything else in .ics verified RFC-correct (see strengths).

**Frontend**
- Wizard can dead-end on a blank step after an event switch with a foreign stored draft (`cfp.$eventSlug.submit.tsx:147-156` — one-line reset fix).
- Agenda detail dialog renders a stale snapshot while the board subscription moves (`AgendaBoard.tsx:100,245-249` — store the id, look up live).
- `og:url` hardcodes `https://stagestack.dev` (`e.$slug.tsx:40`) — wrong for self-host/previews; `siteOrigin()` exists for exactly this.
- Invite links lack `robots: noindex` (a URL that *is* a bearer credential); embed has it, invite doesn't.
- No client-side upload size guard; "Replace"/"Remove" orphan storage objects (`CfpForm.tsx:382-466`).
- Unguarded post-unmount `setState` timers ×3 (harmless on React 19; a shared `useCopied` hook dedupes); three near-identical `useNow` wrappers; duplicated `jumpToField` with inconsistent timeouts (0 vs 60ms); review keyboard shortcuts listen on `window` (safe today, fragile to future modals); the pre-hydration click-drop fix exists in exactly one place with the *class* of bug undocumented.

**Tests & docs**
- Thin suites: `orgs.test.ts`/`users.test.ts` smoke-level; `importExecuteBatch` idempotency (the riskiest import path) has no direct test; `crons.ts` and `http.ts` untested (thin, so Low).
- Doc drift: DATA_MODEL.md claims `proposals.lastDecisionAt?` and `reviews.versions` — neither exists in schema; ARCHITECTURE.md env table omits `SITE_URL`; "versions pinned exactly" claim vs caret ranges on TanStack packages; Node 22.19+ floor in no `engines` field.
- Hygiene: duplicate `.vercel` in `.gitignore`; `!.env.example` whitelisted but no `.env.example` exists (the obvious missing piece for a self-hosted project); `scripts/deploy-worker.sh` hardcodes a personal SSH identity.

---

## Done well (worth keeping as house style)

**Security posture.** Identity is never taken from arguments — every auth path derives from `ctx.auth` via `tokenIdentifier`; ownership misses return `not_found` (never `forbidden`) so IDs aren't probeable; the reviewer projection deliberately *non-spreads* with a comment naming the fields that must not cross the wire; `enterPortal`'s verified-email gate ships with its threat model written in the comment; 256-bit CSPRNG invite tokens with TTL, single-use, non-enumerable lookup, withheld from reviewers; profile links refuse `javascript:`/`data:`; answers filtered to known form field IDs server-side; the public program serves only a pre-filtered blob with forced republish on privacy-revoking transitions.

**Worker trust architecture.** The LLM never holds write authority — its only tools append to an in-memory capture; writes happen in deterministic worker code through the *same* capability layer as the UI, each capability re-checking auth; execution authority is re-derived from `job.initiatedBy` at run time so a demoted organizer's queued job fails closed; compare-and-set claims, idempotent batch commits in the same transaction as the data writes, crash-loop guards, graceful SIGTERM drain, bounded LLM exposure (rows/records/exchanges all capped); constant-time secret comparison.

**Convex discipline.** Every DB query uses `.withIndex()` matching a schema index — no bare table scans; `now` passed as an argument with injectable clocks; object-form validators on all public functions; derived-not-stored readiness/conflicts/audiences so the board, release gate, and dashboard cannot disagree; cron design follows guidelines exactly (interval crons, internal refs, cheap dispatcher + isolated per-event mutations); the 900KB program-size guard fails with an actionable message before hitting the 1MiB doc cap.

**Email & .ics.** Idempotency is real at both layers (component-level exactly-once + `Idempotency-Key` on raw sends); the comms-log row exists *before* the network call so the delivery webhook can't race; every `{{var}}` is HTML-escaped unless server-built, subjects CR/LF-stripped — with tests proving an XSS attempt stays inert; reminder consolidation is literally the spec (one bucket per recipient, manager routing, cadence overrides, deferred-recipient visibility). The .ics generator was verified line-by-line against RFC 5545/5546: octet-exact folding without splitting UTF-8, CRLF throughout, injection-safe escaping at every input class, stable UIDs, and a persisted per-session SEQUENCE counter with the correct Outlook-tombstone rationale documented — the part most implementations get wrong.

**Frontend craft.** Backend-derived role gating with skip-gated queries; the autosave implementation (serialized write chain, ordered unmount flush, keep-queued-on-failure) is the strongest code in the app; keyboard drag-and-drop with per-slot screen-reader announcements; dialog focus management with stack-aware Escape; SSR/locale discipline (dates pinned to `en` + event zone both sides); draft resume validates the stored ID against the server twice; prod never shows raw `Error.message`; no user HTML rendering anywhere (no XSS surface); heavy libs dynamically imported.

**Tests.** 267 backend tests with negative authz as a first-class citizen (`NEGATIVE:` tests asserting `not_found`-never-`forbidden`, cross-org isolation, reviewer refusals); `test.helpers.ts` registers components under real names and matches on `ConvexError.data.code`; reminder tests assert cadence-window no-ops, not just happy paths.

---

## Suggested fix order

1. **Gates first:** fix the web test runner + lint warning, add CI. Everything else below should land behind green gates. *(H1 — small)*
2. **One-liners with real impact:** `requireOrganizer` on `imports.getJob` *(H2)*; formula-injection prefix in `buildSheet` *(M9)*; `noindex` on invite routes; `og:url` via `siteOrigin()`.
3. **Worker trust:** heartbeat + claim token *(H3)*; execute from `job.payload.records` *(M1)*; wire the installed rate limiter *(M3)*.
4. **Scale ceilings:** hoist `computeProgram` reads + debounce rebuilds *(H4)*; truncation signaling on capped reads *(H5)*; group instances in `readiness.dashboard` *(M6)*; message-log indexing *(M4/M5)*.
5. **Self-host coherence:** env-driven `RESEND_TEST_MODE`/`MAIL_FROM` + README/doc fixes *(M14)*; `.env.example`; `SITE_URL` in the env table.
6. **UX edges:** proposals-capped callout *(H5 frontend)*; Clerk token caching *(M10)*; `ManagedSessionCard` dirty-guard *(M11)*; form error a11y *(M12)*; styled public error fallback *(M13)*; `List-Unsubscribe` *(M15)*.

*Review agents: backend security/authz, schema/perf, frontend, worker/import-agent, tests/comms/infra. Full per-agent reports available in session history; every finding above cites file:line and was verified against the code as of commit `a48410e`.*
