# PLAN — Eval fix cycle (v2)

Context: [docs/BUSINESS_CONTEXT.md](docs/BUSINESS_CONTEXT.md) · [docs/CHALLENGE.md](docs/CHALLENGE.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
Previous plan (original build, M0–M8): [docs/PLAN-2026-08-submission.md](docs/PLAN-2026-08-submission.md)

## Why this plan exists

The 2026-08-10 direct-browser eval (killmysaas-evals, 18 required scenarios + 2
optional, 98 rubric items) against `stagestack-git-develop-…vercel.app` scored
**49.8% required / 83.4% coverage**. Area scores: CFP 76.5%, **Abstract
Management 5.4%**, Speaker Mgmt 74.0%, Content Mgmt 54.2% (38.7% coverage —
blocked by a datetime input bug), AI Agenda 93.3%, **Public Widgets 24.3%**,
optional CRM 26.3%. This plan closes the gaps, ordered so that cheap unblockers
land first (they restore coverage for whole areas), then the two big rebuilds.

Decisions made with Alvaro (2026-08-10): **full multi-round review rebuild**,
**light CRM only**, no deadline pressure — plan for completeness.

Eval rubric source: `~/Code/killmysaas-evals/specs/*.yaml` (IDs like ABS-05
below refer to those rubrics). Re-run target: same harness, same fixtures.

## W1 — Unblockers & small correctness fixes (do first)

These four bugs each blocked whole scenario chains in the eval:

- [ ] **Popover opens below the viewport in the bulk bar** (blocked ABS-05
  assignment + the whole reviewer round trip / CFP-11).
  `apps/web/src/components/abstracts/Popover.tsx:88` hard-codes downward
  opening (`top: calc(100% + …)`); `BulkBar.tsx` is fixed to the viewport
  bottom, so the 22rem panel is unreachable. Add flip logic (open upward when
  the host is in the lower half / insufficient space below) or portal the
  panel with collision-aware positioning. Verify with the bar at the bottom in
  a normal viewport.
- [ ] **CFP wizard advances past empty required fields** (CFP-01 partial).
  `apps/web/src/routes/cfp.$eventSlug.submit.tsx` `goto()` (~line 735) never
  blocks: when leaving `submission` (and `participants`) with `blockers > 0`,
  block the step change, set the flagged set, scroll to the first missing
  field, and show the validation error inline. Keep the Review-step jump list.
- [ ] **`submitProposal` rolls back when email send throws** (eval finding 4:
  Resend test-mode + real address → whole submission rolled back).
  `convex/model/cfp.ts:1046-1150` awaits both `sendLoggedEmail` and
  `notifyOrganizers` inline in the mutation. Move both sends to
  `ctx.scheduler.runAfter(0, …)` (pattern already used by
  `convex/model/publish.ts:455`) so the proposal commit never depends on email
  rendering/delivery. Same review for other user-facing mutations that await
  sends inline.
- [ ] **`datetime-local` value parsing rejects browser-driven fill** (made 9
  of 14 CNT items cannot-judge). `apps/web/src/lib/datetime.ts:72`
  `fromInputValue` only accepts strict ISO; drivers can deliver localized
  strings to the controlled state. Make it tolerant: try `fromISO`, then
  luxon `fromFormat` fallbacks for common localized shapes, then
  `new Date(value)` as last resort; on total failure show the parse error
  instead of silently blocking. Three call sites:
  `components/tasks/NewRequirementDialog.tsx:187`, `RequirementCard.tsx:322`,
  `InstanceActions.tsx:457` (and the agenda `PlaceDialog.tsx` uses the same
  control — route it through the same helper).
- [ ] **Reviewer sees organizer navigation** (CFP-10 partial, eval finding 3).
  `apps/web/src/routes/app.e.$eventSlug.tsx:49-137`: nav items without
  `requires` leak to reviewers (Overview, CFP, Proposals, Settings, Team).
  Default nav items to organizer-only; give reviewers a reviewer-scoped
  landing (Reviews + their queue) with no organizer tabs. Backend scoping is
  already enforced — this is presentation, but it's a scored rubric item.

## W2 — Abstract Management rebuild (ABS-01…13; area weight 20, scored 5.4%)

Full multi-round build. Today reviews are one table with a fixed 1–5 score +
recommendation + comment (`convex/model/reviews.ts`, no rounds/criteria/
weights/pools). Target model:

- [ ] **Schema**: `reviewRounds` (eventId, name, opensAt, closesAt,
  anonymized, order), `scorecardFields` per round (kind: numeric{min,max,
  weight} | dropdown{options} | text; label; order), `roundReviewers` (per-
  round pool membership), and `reviews` keyed (roundId, proposalId,
  reviewerId) with `answers` keyed by scorecard field. Migrate the existing
  reviews into a default "Initial Review" round with a scorecard matching the
  current fixed fields (score→numeric 1-5, recommendation→dropdown,
  comments→text) so history survives. (ABS-01, ABS-02, ABS-03, ABS-04)
- [ ] **Evaluation-plan UI**: new organizer route (Reviews → Rounds /
  "Evaluation plan"): CRUD rounds with names + open/close dates + per-round
  anonymization toggle + scorecard editor (add numeric/dropdown/text
  criteria, per-criterion weight input). Persist + render after reload.
  (ABS-01, ABS-03, ABS-04, ABS-07)
- [ ] **Per-round reviewer pools**: attach reviewers to a round (reuse team
  invitations for account provisioning); round 2 pool independent of round 1.
  (ABS-02)
- [ ] **Assignment at scale**: assignment UI gains (a) per-reviewer cap
  setting, (b) auto-distribute action (spread unassigned proposals across the
  round pool respecting caps), (c) track filter before bulk assign. Any one
  passes ABS-06 — build auto-distribute + track filter, cap if cheap.
- [ ] **Blind review**: when the round is anonymized, the reviewer projection
  strips speaker names/companies/emails everywhere (queue, readout, files);
  organizer views unaffected. Extend the existing reviewer privacy projection
  in `convex/model/reviews.ts` / `ProposalReadout.tsx`. (ABS-07)
- [ ] **Reviewer scoring UI**: render the round's scorecard dynamically
  (numeric steppers, dropdown, textarea), draft autosave, submit; reopen shows
  stored values. Queue scoped to (round, assigned) only — already enforced,
  keep it. (ABS-03, ABS-05)
- [ ] **Conflict-of-interest**: "Declare conflict" action on an assigned
  review → flags the row, removes it from the reviewer's actionable queue,
  surfaces to organizer for reassignment. (ABS-12)
- [ ] **Progress dashboard**: per-reviewer assigned/completed counts per
  round, live; select lagging reviewers → bulk reminder email (template +
  comms log). (ABS-08, ABS-09)
- [ ] **Aggregate results table**: per-proposal aggregate (weighted mean of
  numeric criteria; label it "weighted"), sortable asc/desc by score column,
  visible per-review breakdown; co-authors with role labels visible in the
  organizer results/detail view. (ABS-10, ABS-11, CFP-11)
- [ ] **Export**: CSV/XLSX of review results (one row per proposal: title,
  per-criterion aggregates, recommendation, status) — reuse
  `components/abstracts/exporters.ts`. (ABS-13)
- [ ] **Co-author role labels**: participants already exist; ensure the CFP
  wizard's participants step offers a role label (Co-author/Co-speaker/…)
  and it renders in speaker dashboard detail + organizer review views.
  (ABS-11)
- [ ] ABS-14 (AI triage) is judged only if we claim AI review — we don't;
  explicitly out of scope.

## W3 — Public Widgets (EMB-01…16; area weight 20, scored 24.3%)

Today: one flat lineup list + one grouped agenda list on `/e/$slug`, an embed
route with `?section=`, one JSON endpoint. The eval wants five distinct widget
surfaces + an embed console. Build on the existing published-blob architecture
(one privacy-filtered projection — keep it).

- [ ] **Blob enrichment** (`convex/model/publish.ts`): add per-speaker
  jobTitle/company (tagline split or new fields — see W5 speaker fields),
  session format everywhere, stable per-day grouping data. Watch the 1MiB
  guard — dedupe agenda/lineup session duplication while in here (carried
  from M8 W-A).
- [ ] **Sessions catalog widget**: card list with title, truncated
  description + "Show more" expansion, date/time, room, speakers (name +
  title/company), format + track tags; keyword search matching titles AND
  speaker names with live result count; faceted filters (Track, Format,
  Room). (EMB-01, EMB-02, EMB-03)
- [ ] **Speakers directory widget**: alphabetical-by-surname directory
  (headshot, name, title, company), name search, drill-down detail with bio +
  that speaker's sessions (title, date/time, room). (EMB-04, EMB-05)
- [ ] **Agenda grid widget**: room-columns × time-gutter grid per day (reuse
  the internal `TimeGrid` rendering read-only), day navigation tabs, click a
  block → detail view (full time range, room, description, format, track) with
  back/close. (EMB-06, EMB-07, EMB-08)
- [ ] **Schedule itinerary widget**: day tabs, chronological cards with time
  headers, full card anatomy (track chip, title, description + show more,
  date/time, room, speakers w/ title+company); keyword search + track filter.
  (EMB-09)
- [ ] **Personal schedule**: star/add control per itinerary card; "My
  schedule" view with exactly the chosen sessions in time order; persists
  across reload (localStorage for anonymous is enough per rubric); remove
  updates the view; .ics export of the selection (reuse `convex/model/ics.ts`
  building blocks client-side or via an endpoint). (EMB-10, EMB-11)
- [ ] **Speaker gallery widget**: photo-grid visually distinct from the
  directory (headshot-forward cards), name search, graceful fallback for
  missing photos, card → detail modal (photo, name, title, bio + show more,
  company, "Sessions (N)" list) restoring the grid on close. (EMB-12, EMB-13)
- [ ] **Embed console upgrade** (`app.e.$eventSlug.publish.tsx`): named,
  saved embeds with enable/disable; widget-type picker covering all five;
  output formats: styled iframe/script snippet, basic HTML, **JSON feed**,
  **iCal feed** (new HTTP endpoints in `convex/http.ts`); config options —
  content filter by track, field selection checkboxes, basic brand color;
  per-embed "Get Code" snippet copy. (EMB-15, EMB-14)
- [ ] **All five widgets reachable by a non-admin** — public page routes
  (`/e/$slug/…` tabs or paths) + embed variants render anonymously. (EMB-14)
- [ ] **Consistency** (EMB-16): guaranteed by the shared blob — but see W4
  staleness fixes; verify one session shows identical fields across catalog/
  agenda/itinerary and organizer record.

## W4 — Publish freshness (eval finding 8; EMB-16, SPK partials)

Confirmed speakers and profile edits currently don't reach an already-
published program until a manual republish (`convex/model/portal.ts`: decline
and withdraw trigger rebuilds; **confirm and updateMyProfile do not**).

- [ ] Trigger `requestRebuild` on: speaker **confirm** (portal.ts:~786 — today
  only `declined` triggers), `updateMyProfile` (:717), `updateSessionContent`
  (:906), organizer speaker-record edits, and content-approval changes (W5).
  Keep explicit publish for editorial control of *whether* something is
  published; auto-rebuild only refreshes already-published content.
- [ ] Test: publish → speaker confirms + saves profile → public blob shows the
  named speaker without any organizer action.

## W5 — Content Management (CNT; area weight 15, coverage was 38.7%)

The datetime fix in W1 restores the whole task-fixture chain. Then:

- [ ] **File comments**: comment thread on task uploads (author + timestamp,
  visible cross-role, organizer can reply). New `uploadComments` table +
  thread UI in `InstanceActions`/portal task views. (CNT-05)
- [ ] **Upload constraints copy**: state accepted types + max size at the
  upload control (portal + organizer). (CNT-06)
- [ ] **Files library**: per-event Files view aggregating all task uploads
  with session/speaker association, upload date, version count; per-session
  Files tab if cheap. Data exists in `uploads` — this is a query + route.
  (CNT-13)
- [ ] **Bulk ZIP export of deliverables**: multi-select sessions/files →
  jszip bundle of latest versions, folder per session/speaker grouping option
  (reuse `components/abstracts/exporters.ts` pattern). (CNT-14)
- [ ] **Session content history + restore**: record before/after values on
  session title/description edits (extend the existing audit rows or a new
  `sessionRevisions` table), history panel with editor + timestamp, restore a
  prior version. (CNT-11)
- [ ] **Content approval status**: per-session content status
  (draft/approved), organizer control, and the **publish projection excludes
  unapproved sessions** — this is the gate CNT-12 grades; wire into W3
  widgets and W4 auto-rebuild.
- [ ] Organizer speaker profile editing (bio + headshot upload from the admin
  side) — verify it exists end-to-end; the eval couldn't reach it. (CNT-10)

## W6 — Speaker Management gaps (SPK-01, SPK-03, SPK-15)

- [ ] **Dedicated Speakers roster route** (`app.e.$eventSlug.speakers`):
  all event speakers with identity fields, search/filter, status, link to
  sessions/tasks/comms. Today the roster is implicit in sessions + dashboard.
  (SPK-01, helps several SPK partials)
- [ ] **Deterministic CSV import**: plain column-mapping importer for
  speakers (upload → map columns → dedupe by email → create), alongside the
  AI import. The eval failed SPK-03 because only the AI-plan path exists.
  (SPK-03, also CRM-05 at org level if pointed at contacts)
- [ ] **Custom/logistics fields wired**: `customFields` schema exists
  (`appliesTo: "speaker"`) but no value storage — add value storage on
  eventContacts, render on speaker record (organizer side), persist.
  (SPK-15)
- [ ] Speaker fields: add jobTitle/company as first-class fields (today only
  `tagline`) — needed by W3 widgets and SPK/EMB card anatomy. Migrate
  tagline→jobTitle heuristically only if trivial; else keep tagline as
  fallback display.

## W7 — Agenda auto-place (AIA-08, weight 1)

- [ ] "Auto-place" button in the agenda toolbar right cluster
  (`AgendaBoard.tsx:289`): one action places all unscheduled sessions into
  free slots using the existing conflict engine (greedy: iterate released-
  hours grid, skip blockers). Deterministic is fine — rubric judges "any
  one-action assisted placement" generously. Optionally label it "Suggest
  schedule" with a review-before-apply preview.

## W8 — Light CRM (optional area; cheap wins only)

On the existing org Contacts tab (`app.org.$orgSlug.tsx` ContactsTab):

- [ ] Company + jobTitle fields on contacts (shared with W6).
- [ ] **Tags** on contacts, editable inline, shown as chips. (CRM-04)
- [ ] **Attribute filter** beyond text search (by tag, company); clearable.
  (CRM-02)
- [ ] **Internal notes** on a contact (persist, timestamped) + a simple
  history surface: linked events/sessions list from `eventContacts` (data
  already exists). (CRM-03)
- [ ] **Add-to-event**: push a contact into an event (creates eventContact
  snapshot, optional invite) with profile carried over. (CRM-10)
- [ ] Explicitly out of scope: kanban pipeline (CRM-07/08), merge (CRM-06),
  saved segments (CRM-09), CRM dashboard (CRM-12), org-level bulk outreach
  (CRM-11).

## Cross-cutting

- Convex rules: read `convex/_generated/ai/guidelines.md` before backend
  work; validators on everything; capabilities in `convex/model/*` with thin
  wrappers; tests in convex-test incl. negative authz for every new
  reviewer/round/public surface.
- Schema migrations: reviews→rounds migration must not strand the deployed
  dev data (`scintillating-heron-597`); use @convex-dev/migrations if a
  backfill is needed.
- Blob size guard: W3 enrichment + W5 approval gating touch
  `assertProgramFits` — do the lineup/agenda dedupe (M8 leftover) as part of
  W3.
- Design system: all new UI through `apps/web/src/ds` + the
  stagestack-design skill.
- Every workstream ends browser-verified against the dev deployment, then
  deployed to develop (Vercel preview) for the next eval run.

## Verification

- [ ] `tsc` + full convex-test + web tests green per workstream.
- [ ] Self-run the relevant eval scenario steps (specs in
  `~/Code/killmysaas-evals/specs/`) in the browser before calling a
  workstream done — the rubric pass_criteria are the acceptance tests.
- [ ] Final: full eval re-run by Alvaro; target ≥85% required score with
  ~100% coverage (no cannot-judge from our own bugs).

## Suggested order

W1 (unblockers) → W2 (review rebuild) → W4 (freshness, small) → W6 speaker
fields (W3 depends on jobTitle/company) → W3 (widgets + embeds) → W5 (content)
→ W7 (auto-place) → W8 (light CRM).
