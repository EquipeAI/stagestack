# PLAN — UX maturity cycle (v3) · ARCHIVED 2026-08-13

**Outcome: all thirteen workstreams (W1–W13) built, tested, and landed** —
one commit per workstream (`a6c6c0f` W1 → `74b2f53` W11), each through the
same loop: implement → independent verify → codex review → fix round →
commit. Tests grew 399→578 (root) and 125→504 (web); root `npm run typecheck`
now covers `convex/tsconfig.json` (previously silently uncovered). The work
was merged to `main` via PRs #1/#2 and is deployed. This plan is closed;
current work is [/PLAN.md](../PLAN.md), which also carries the few items
still open when this was archived (the develop/prod Resend-webhook
diagnosis, the eval re-run, and the final live-browser verification passes).

## STATUS AT ARCHIVE: LANDED 2026-08-12 — checkboxes below are the record

Covered **M8 (Operational truth)** and **M9 (Operating surfaces)** from
[MILESTONES.md](MILESTONES.md). M10 (expert efficiency) was deliberately
out of this plan; it gets its own once M9 has real usage behind it.

Context: [BUSINESS_CONTEXT.md](BUSINESS_CONTEXT.md) ·
[CHALLENGE.md](CHALLENGE.md) ·
[ARCHITECTURE.md](ARCHITECTURE.md) ·
[MILESTONES.md](MILESTONES.md)
Previous plans: [eval fix cycle](PLAN-2026-08-eval-fix.md) ·
[original build M0–M8](PLAN-2026-08-submission.md)

## Why this plan exists

The 2026-08-11 direct-browser eval scored **100% of applicable requirements**
(score report at `~/Code/killmysaas-evals/runs/codex-20260811T174250Z/report.md`;
method: Codex Desktop direct browser, not the killmysaas harness). The expert UX
review written against that same run (20 scenarios, 322 screenshots) was
delivered in-session and is **not preserved as a file** — this plan is the
surviving record of its findings, so the requirement lists below (W8's rows, the
protected list, the five "clicking too much" jobs) are authoritative here and
cannot be re-consulted elsewhere. The score report independently confirms three
of them (the `:20` cron anchor, "Event contributor" provenance, the
Lightning-Talk-in-a-60-minute-slot). The review reached a different verdict
about the same product:

> StageStack's feature architecture is stronger than its interaction
> architecture. The next leap is not more capability. It is helping organizers
> understand what needs attention, why something is blocked, and what will
> happen next.

So this plan adds **no new modules**. Every workstream either makes an existing
statement true (M8) or removes bookkeeping the organizer currently does in their
head (M9).

The review also named what must survive the work, and these are treated as
regressions if they degrade: the coherent proposal→session lineage; the
one-job-at-a-time reviewer queue; the tightly scoped speaker portal; the unusually
good consequence copy on declines, reopens, and blocked releases; the audit trail
(human attribution, timestamps, version history, non-destructive corrections);
the shared publication projection behind page/embed/API; and the restrained
visual language, including empty states like "No requirements yet" that explain
the concept and offer one next action.

## Decisions made with Alvaro (2026-08-11)

1. **Evals will re-run and are tolerant.** The harness re-derives paths from the
   UI, so renamed labels and merged pages are acceptable **as long as every
   capability stays reachable**. (Verified: the killmysaas harness is an LLM
   driving aria snapshots with no hardcoded selectors — "Dashboard"/"/dashboard"
   appear only as discovery hints — and the 100% run itself was Codex direct
   browser; both re-derive. Exception: a few spec criteria assert **verbatim
   strings** — the CFP format option labels and a visible CRM analytics widget —
   see the label constraint in W2 and the CRM note in W12.) Practical rule for this plan: no capability may
   become harder to find than it is today, and every current route keeps
   resolving (redirect, never 404) — see Cross-cutting.
2. **Scope is trust + the big bet** — M8 and M9 in one plan, ordered so the trust
   work lands first and the readiness vocabulary it produces becomes the
   backbone of the control center, the workspaces, and the Publish Center.
3. **Workspaces are routed pages, not drawers** (my call, made on the mobile
   constraint — reasoning in W7).
4. **No new editor dependency** for templates: token palette + insert-at-cursor
   + live personalized preview over the existing textarea, raw HTML kept as an
   explicit advanced mode. Full WYSIWYG is an M10 question.
5. **Dashboard and Overview merge.** The event root becomes the control center;
   today's Overview facts fold into Setup → Overview; `/dashboard` redirects to
   the root.
6. **Decisions is a filtered view of Proposals**, not a fifteenth module — a
   Select-group nav entry that deep-links into Proposals pre-filtered to staged
   decisions, with the release action there.
7. **Formats become a library type with default durations** (alongside tracks,
   rooms, tags), with an optional per-session override. This is what gives
   auto-place, the public widgets, and the CFP form one shared answer to "how
   long is a Lightning Talk".
8. **Full mobile parity, including the agenda board.** The schedule grid gets a
   real touch design, not a scroller. This is the one place the plan goes beyond
   the review's recommendations, and it carries its own workstream (W13).

## Constraints that shape every workstream

- **Mobile web is a first-class target at full parity** (decision 8) — every
  organizer job, including scheduling, must be completable on a phone. The shell
  already flips at 860px (`apps/web/src/styles/app.css:45`) and the sidebar
  becomes a scroll-snapping strip
  (`apps/web/src/ds/components/navigation/navigation.css:36`). Every new surface
  below states its phone behaviour explicitly; "it scrolls" is not a design, and
  "desktop only" is no longer an available answer for any surface.
- **Design system first.** All new UI composes `apps/web/src/ds` primitives
  (`Callout`, `ReadinessMeter`, `StatusPill`, `Toolbar`, `DataTable`,
  `Breadcrumb`, `Tabs`, `EmptyState`) and the `stagestack-design` skill. New
  patterns are added to the DS, not to one route.
- **Convex rules unchanged**: read `convex/_generated/ai/guidelines.md` first;
  validators on everything; capabilities in `convex/model/*` with thin public
  wrappers; convex-test coverage including negative authz for every new surface.
- **One explanation, one producer.** Any sentence the UI says about state
  (readiness, blockers, publication, eligibility) is generated in
  `convex/model/*` and rendered verbatim. No route re-derives it in TSX.

---

# M8 — Operational truth

## W1 — Truthful automation & delivery status

The single biggest remaining trust issue in the review.

- [x] **The predicted next run must be the real next run.** `automationStatus`
      (`convex/reminders.ts`, ~line 917) returns
      `floor(now / hour) * hour + hour` — a clean clock hour. The sweep is
      `crons.interval("reminder sweep", { hours: 1 }, …)` (`convex/crons.ts`),
      which is anchored to when the cron was **first deployed** ("beginning when
      the job is first deployed to Convex" — installed-source jsdoc), so it
      actually fires at :20-past or wherever that deploy landed. Fix the anchor,
      not the wording: switch the sweep to `crons.cron` with a fixed minute —
      **not** `crons.hourly`, which `convex/_generated/ai/guidelines.md:374`
      forbids (and whose `minuteUTC` is backend-chosen when omitted, the exact
      unpredictability being fixed) — and export the `SWEEP_MINUTE` constant
      from one module that both `crons.ts` and `automationStatus` import
      (precedent: `worker.ts` imports `shared/jobTypes`; no isolate restriction
      applies). Cron minutes are UTC; the existing epoch-hour math stays correct
      in every timezone. Then the prediction is derived from the schedule
      instead of guessing at it.
- [x] **Say it in event time, and say what it is.** The copy at
      `apps/web/src/routes/app.e.$eventSlug.tasks.tsx:197-198` renders a browser
      local time with no zone label, in a product whose stated rule is that
      organizer surfaces show and label event time. Render the next evaluation
      in the event timezone via `apps/web/src/lib/datetime.ts`, labelled, and
      keep the honest hedge already in the backend comment — it is the next
      *evaluation*, not a promise of a send.
- [x] **Reconcile the two cadence stories.** (Code truth: empty cadence stops
      routine + confirmation chasing, but due-within-48h/overdue work keeps a
      once-daily safety reminder; per-requirement overrides acknowledged in one
      clause. Also surfaced during implementation: the sweep goes quiet after
      the post-event grace week, and `automationStatus` now says so.) The task page says daily safety
      reminders continue when the event cadence is off; Settings says an empty
      cadence sends none. Decide which is true (read `convex/reminders.ts`
      eligibility — the code is the tiebreaker), then state that one model in
      one shared copy constant used by both `tasks.tsx` and
      `app.e.$eventSlug.settings.tsx`.
- [ ] **Delivery lifecycle, end to end.** *(Code side done — lifecycle
      rendering, provider event timestamp stored/rendered. The develop
      webhook/env diagnosis below still needs deploy access: Alvaro.)* `messages.deliveryStatus` starts at
      `queued` (`convex/model/comms.ts:118`) and is advanced by the Resend
      webhook (`convex/emails.ts:117`, routed at `convex/http.ts:103`). The
      review saw `Queued` on mail Gmail had already received, so **first
      diagnose transport** — a persistent `Queued` means the row truly never
      advanced (only the webhook moves batch sends off `queued`), and there are
      two candidate causes on `develop` (`marvelous-snail-907`), check both:
      `RESEND_WEBHOOK_SECRET` unset there (the component throws "Webhook secret
      is not set" and the endpoint 500s loudly; env vars do not mirror from dev
      — see CLAUDE.md deploy table), or **no Resend-dashboard webhook endpoint
      pointing at that deployment's own `.convex.site/resend-webhook` URL** —
      Svix secrets are per-endpoint, and a missing endpoint fails silently with
      no errors anywhere. Then fix the surface either way.
- [x] **Never claim Queued for something that left.** Render the lifecycle as
      Queued → Provider accepted → Delivered / Failed / Bounced with the
      provider event's own timestamp, in `components/comms/` and the per-contact
      log. (Corrected during plan review: `convex/model/contacts.ts:937-941` is
      NOT the bug — it is the same-transaction send result, correctly `queued`
      at that instant, consumed only by a one-shot toast. The persistent
      surfaces — `outreachHistory` at `contacts.ts:880`, `contactLog` at
      `comms.ts:594` → `LogPanel` — already render raw `deliveryStatus`, so a
      persistent "Queued" means the webhook never fired: transport is the whole
      fix, and this item is the lifecycle *rendering* upgrade only.) When the
      provider accepted but no delivery event has arrived, say
      "Sent — delivery unconfirmed", not "Queued".
- [x] **Manual send confirmation states the audience and the consequence.**
      `apps/web/src/components/comms/SendPanel.tsx`: before sending, name who
      qualifies and who is excluded and why. (Corrected during implementation:
      the planned "sending resets cadence" sentence was FALSE — `sendOneOff`
      never touches `lastRemindedAt`; the dialog now states the verified truth
      that a one-off does not reset anyone's cadence. If a reset is *wanted*,
      that is a backend decision for a later cycle. Same statement added to the
      tasks page's manual-reminder confirmation, whose preview query and the
      mutation now share one `collectOutstanding()` so they cannot diverge.)
- [x] **Reminder facts panel** wherever reminders are configured or triggered:
      automatic on/off · evaluation interval · cadence floor · last automatic ·
      last manual · next eligible. One component, one query, both pages.
- *Mobile*: the lifecycle is a labelled vertical list, never a horizontal
  stepper; the facts panel stacks via `DescriptionList` (already stacks at
  640px, `layout.css:88`).

## W2 — Assisted placement you can trust

- [x] **Formats become a library type with default durations** (decision 7).
      Today `sessions.format` is a free-text optional string
      (`convex/schema.ts:675`) and no duration **default** exists anywhere in
      the schema — placed sessions carry an implicit one via `startsAt`/`endsAt`
      (`schema.ts:694-695`) and `PlaceDialog` already accepts arbitrary ends;
      what is missing is the *pre-placement* default — so the scheduler has
      nothing to be smart with. Add `formats` to the event
      library beside tracks/rooms/tags (`convex/model/library.ts`,
      `convex/schema.ts`): name + `defaultDurationMinutes` + order, plus an
      optional `durationMinutes` override on the session. Migrate existing
      free-text values into library rows per event (distinct strings → formats,
      unmatched left as free text so nothing is lost), and keep the free-text
      display fallback for any session that never matched.
- [x] **Wire formats through the surfaces that already show them**: the CFP form
      offers the library's formats where it currently takes free text
      (`components/cfp/CfpForm.tsx`), the public blob and widgets render the
      library label (`convex/model/publish.ts`, `components/public/widgets/`),
      and the accept path inherits it (W5). **Label constraint**: the eval
      asserts the CFP format options verbatim, duration parenthetical included
      ("Workshop (120 min)" — `specs/01-call-for-papers.yaml:39-64`), and CFP
      conditional logic matches by exact string
      (`convex/shared/formDef.ts:83-106`). Migrated library rows must render
      exactly the existing labels; do not normalize away the "(120 min)".
- [x] **Duration-aware placement.** `autoPlace` (`convex/model/agenda.ts:1729`)
      walks an hourly grid and writes `endsAt = startsAt + HOUR_MS` for every
      session, which is how a 10-minute Lightning Talk landed in a 60-minute
      slot. Derive the block from session override → format default → event
      default, and keep the slot walk independent of the block length so short
      sessions pack instead of each consuming an hour.
- [x] **Respect the constraints we already model.** The conflict engine
      (`conflictsFor`) is consulted for blockers; extend the candidate scoring to
      prefer track grouping and speaker gaps rather than taking the first
      non-blocking cell.
- [x] **Propose before writing.** Turn the action into "Suggest schedule" →
      preview list (session · day · time · room · why) → Apply / Discard. The
      mutation stays one call; the preview is a query over the same planner, so
      there is no second placement implementation.
- [x] **Explain the leftovers.** `unplaced` currently returns only
      `{sessionId, title}`. Add a reason per entry (no free room of that length,
      speaker double-booked at every candidate, outside event bounds) and render
      it — an unexplained "unplaced 2" is the thing the review objected to.
- [x] **Undo.** One action reverting exactly the placements this run wrote
      (the audit row at `convex/model/agenda.ts:1822` already records the run;
      extend its `meta` to carry the placement set).
- [x] **Surface the non-drag path that already exists.** `PlaceDialog.tsx` and
      keyboard placement (`keyboardDrag.ts`) both work; what is missing is a
      *visible* "Place…" action on every unscheduled session, so the alternative
      to dragging is discoverable rather than only keyboard-reachable. (Also W6,
      W13.)
- *Mobile*: the suggestion preview is the primary scheduling interface on a
  phone — it is a list, it reviews well at 375px, and it is how most phone
  scheduling should happen. The board's own touch design is W13.

## W3 — Snapshots, not inverse edits

- [x] **Reframe the history model.** `sessionRevisions` (`convex/schema.ts:262`)
      stores `before` and `after` per edit as **full snapshots** (no chain
      replay needed), so a snapshot list is already derivable: **Current**, then
      one entry per edit labelled "Before edit on 11 Aug at 13:42". Scope: these
      snapshot **content fields only** — title, description, format
      (`schema.ts:267`); schedule, track, and tags are not versioned, and the
      snapshot UI must not imply they are. Build that projection in `convex/model/sessions.ts`
      (near `listRevisions`, ~line 1145) and stop presenting rows as actions
      whose direction the organizer must infer.
- [x] **Restore previews the diff first.** Action becomes "Restore this
      snapshot" → field-level preview (`Title: X → Y`, `Format: Talk → empty`,
      `Description: unchanged`) → confirm. Note the existing sharp edge in the
      preview: absent fields restore as **cleared**, not as kept-current
      (`convex/model/sessions.ts:1180`) — that is defensible, but it must be
      shown, not discovered.
- [x] **Undo the restore.** The restore already writes its own revision
      (`restoreRevision`, ~line 1169); expose that as a one-click Undo in the
      persistent result (W5) rather than expecting a second manual restore.
- [x] **Group restoration entries** visually in the log so a restore reads as
      one event, not as another edit war.
- *Mobile*: the diff is a stacked before/after list, not a two-column table.

## W4 — One readiness vocabulary

The backbone the M9 surfaces consume. Build it before the control center.

- [x] **Extend `convex/model/readiness.ts`** — which already derives
      `{status, reasons}` and is explicitly never stored — with a **publication**
      dimension: `whyNotPublic(session, deps)` returning structured reasons, each
      with a machine `code`, a rendered sentence, and a repair target
      (`{tab, params}`, tab ids taken from the shell's `TAB_PATHS`) so every
      count and every blocker can deep-link. Six codes: `session_cancelled`,
      `content_draft`, `session_not_published`, `lineup_not_published`,
      `slot_not_released`, `agenda_not_published`. Still derived-only: no
      schema change, no stored status.
- [x] **Compose the exact sentences the review asked for**, from the real
      dependency chain, mirroring `computeProgram` gate for gate. One
      correction the code forced: **lineup and agenda really do publish
      independently** — turning the public page off empties the lineup while a
      released session goes on being served in a published schedule — so each
      reason carries `blocks: both | lineup | agenda` and there is a fourth
      summary shape ("Public in agenda, not lineup: the public page is off.").
      Speaker confirmation is deliberately not a blocker (publish serves a
      session as "speaker to be announced"); it shows up in `toBeAnnounced` and
      in the summary's ready clause.
- [x] **One producer, many surfaces.** `api.readiness.publication` returns the
      per-session `{inLineup, inAgenda, toBeAnnounced, reasons, summary}` the
      sessions table and the publish console now print verbatim; the publish
      console's re-derived speaker/slot badges are gone. W7/W8/W9/W10 consume
      the same query.
- [x] **A cheap counts query for the nav rail** (consumed by W7):
      `api.readiness.attention` — per-module counts via `takeCapped`
      (truncating, with a `capped` flag, never `event_too_large`), no ticking
      argument, and the three publication counts charge each session to the
      repair tab of its FIRST unresolved blocker, so a badge can never disagree
      with the sentence on the row. NOT wired into the nav here (W7 does that).
- [x] Convex tests (`convex/readiness.test.ts`): one case per reason code, the
      all-ready case, agreement asserted against `publish.preview`
      (`computeProgram`) / `publish.state` / the served blob rather than a
      re-implementation, counts + `capped`, and negative authz per new query.

## W5 — Rough edges from the 100% run

Each is small, each was individually named in the review.

- [x] **Persistent results replace toast-only outcomes.** Exports, bulk actions,
      publishes, imports, and restores keep an inline result on the page
      (prepared / downloaded / failed, with retry). Toasts stay for low-risk
      confirmations only. Added as `ActionResult` in the DS beside `Toast`
      (`apps/web/src/ds/components/feedback/`), composing `Callout` so tone has
      one owner. Converted: proposals export menu + review-results export +
      attachment bundle (`abstracts/TableMenus.tsx`), files-library ZIP
      (`tasks/FilesPanel.tsx`), proposal bulk moves/release and reviewer
      assignment (`abstracts/BulkBar.tsx` → result rendered by the proposals
      route so it survives the selection clearing; its retry re-attempts only
      the failed ids), reviewer reminders and
      auto-distribute (`reviews/ProgressPanel.tsx`), lineup/agenda publish
      (`publish.tsx`), AI import refusal (`import.tsx`), speaker CSV import
      (`speakers/ImportCsvDialog.tsx`), CRM CSV import and bulk outreach
      (`contacts/CrmTools.tsx`), and the W3 restore result (promoted, not
      duplicated). Embed enable/disable/create/delete stay toasts: config
      toggles, not outcomes with arithmetic.
- [x] **Proposal → session field inheritance.** Confirmed broken during plan
      review, and the cited line was the wrong path: `sessions.ts:769` is the
      **direct-invitation** path, which already carries format. The CFP accept
      path is `materializeSession` (`convex/model/sessions.ts`), which
      copied title/description/track but no format — and proposals have no
      format field: format lives inside free-form `answers`. Fixed with
      `formatFromAnswers`, which identifies the QUESTION first (exactly one
      non-system choice field whose label names a format, read from the form
      definition) and only then reads that question's answer — never by
      scanning answers for a string that happens to match a format name, which
      would promote a track answer of "Talk" into the session's format. The
      answer goes through W2's shared `normalizeFormatLabel` (so a
      materialized session and a hand-typed one store the same string and link
      the same row) and links `formatId` on an exact library match. Zero or
      multiple candidate questions, no answer, an over-long label, or a library
      holding the same name twice all carry NOTHING: an empty format is one
      edit away, a wrong one is a silent misstatement. Regression tests cover
      the library-match, verbatim, nothing, stolen-track-answer and
      duplicate-name cases.
- [x] **Headshot uploader provenance.** `convex/model/tasks.ts` resolved the
      uploader through `storedPersonName` alone and fell back to a generic
      "Event contributor" — which named nobody while reading like a resolved
      actor, and fired even when the event knew exactly who the person was. Now
      resolved through `resolveEventUserDisplayName`, a reason-carrying sibling
      of the shared `eventUserDisplayName` chain, so the row's model-produced
      `uploadedByNote` distinguishes all three real gaps: nobody was recorded
      (no provenance row), the account exists and has set no display name, and
      the account record is missing or the event holds conflicting names for it
      (not attributable). No blank is described as another kind of blank.
- [x] **Attribution names collected up front.** Already at first entry for
      `/app/**` (`AuthGate`) and the speaker portal; extended to the remaining
      collaborative surface, the CFP proposal-management page
      (`cfp.$eventSlug.proposal.$proposalId.tsx`), whose edits, withdrawals and
      resubmissions reach organizer surfaces under this person's name. The
      requirement itself (`requirePersonDisplayName`) is unchanged and still
      backs the write path.
- [x] **Embed brand colour**: picker + validation + contrast warning + live
      preview. The rule now lives once in `convex/shared/brandColor.ts`
      (`convex/model/embeds.ts` imports it), and the console's hint no longer
      invites "any CSS color" into a hex-only validator. The pattern was also
      **narrowed** from `{3,8}` to exactly 3/4/6/8 digits: 5- and 7-digit
      values are not colours, so they used to validate, save, and then render
      as nothing. Contrast is checked against both the light and dark embed
      surfaces and WARNS below 3:1 without blocking. Built as
      `components/publish/BrandColorField.tsx` so W10's rebuild inherits it by
      import.
- [x] **Public filters and session detail are deep-linkable** — facets, search,
      and the expanded session/speaker reflected in the URL, via
      `validateSearch` on `/e/$slug` over one typed schema
      (`apps/web/src/lib/publicSearch.ts`). Facet and expansion changes push
      history (Back undoes one step); the free-text query replaces. Widgets
      take an optional controller, so the embed iframe — which does not own the
      address bar — keeps working on local state through the same code path.
      "My schedule" stays local: it reads this browser's starred sessions, so a
      link carrying it would promise a schedule the recipient never starred.
- [x] **Bulk actions state their arithmetic**: selection count, eligible,
      excluded and why, expected result, then the actual outcome. The rules
      live in `convex/shared/bulkDecisions.ts`, which `convex/model/sessions.ts`
      imports for its own eligibility check, so the bar and the mutation cannot
      disagree; the after-statement is derived from the mutation's per-id
      results. `reviews.remind` gained per-reason skip counts
      (`skippedNothingOutstanding` / `skippedNoAddress`) because one `skipped`
      number could not say why.

## W6 — Accessibility floor

Scheduled as its own pass, before the organizer UX is called mature.

- [x] **Audit first, fix second**: recorded in
      [docs/reference/a11y-audit-2026-08.md](reference/a11y-audit-2026-08.md)
      — 76 findings, 57 fixed, 19 deferred with reasons, per surface with
      file:line and WCAG criterion. **Scope correction, stated at the top of
      the doc**: this pass is a STATIC code audit. axe, a manual keyboard pass
      and a screen-reader pass over the running app are NOT done and are not
      claimed; they belong to the final verification step.
- [x] Every `Switch` named by its own requirement/setting. The DS now makes an
      unnamed switch a **type error** (`Switch.d.ts` requires one of `label` /
      `aria-label` / `aria-labelledby`) with a dev-time `console.error` as the
      runtime backstop for JS call sites and labels that are only blank at
      runtime. Four bare switches found (three in the publish console, one on
      the embed row) plus two named by their own STATE rather than their
      subject (the review's `Active` requirement switch, and the CFP builder's
      per-question `Required`, and the requirement edit form's "Require
      organizer review" and "Reminders off").
- [x] Modal focus. Corrected during the audit: `Dialog.jsx` **already** trapped
      Tab both ways, moved focus in on open, returned it to the opener, and
      closed on Escape with `stopPropagation` for nesting — it was confirmed,
      not rebuilt. The one real defect: the focusable-element filter treated
      "reports no geometry" as "is not focusable", so a dialog whose layout had
      not happened yet silently lost its whole trap. Bottom-sheet mode is the
      same element and is asserted as such.
- [x] Toasts and async state changes announced. The toast viewport returned
      `null` when empty, so its live region was inserted WITH the message
      already inside — not reliably announced, for every toast in the product.
      Fixed, and `lib/announce.ts` is now the app's one PAIR of live regions —
      mounted at the document ROOT, because `/invite` runs mutations through
      `usePending` and has no toasts. `usePending` feeds them, with an
      `{ announce: false }` opt-out applied at the 15 of 84 call sites (traced
      individually) whose failure is already spoken by an `ActionResult`, a
      `Field` error or the portal's `role="alert"`. Toasts announce through the
      shared region and are no longer live regions themselves, so no sentence
      is read twice. `ActionResult`'s existing `aria-live` was verified, not
      duplicated.
- [x] Status carries more than colour. `StatusPill`/`Badge`/`ReadinessMeter`
      audited and found already correct (the dot never appears without its
      text). The real colour-only states were elsewhere: agenda blocker vs
      warning, the reviewer queue's draft dot, the settings colour swatches,
      the task filter chips, and the active nav entry below 860px.
- [x] Targets. **The plan's pointer was wrong**: `app.css:298` is a
      `touch-action` fix, not a target-size block — the coarse-pointer sizing
      lives in `ds/tokens/base.css:39-71` and already reached 44px. The gap was
      the FINE pointer: `.ss-switch`, `.ss-check`, `.ss-toast__action`,
      `.ss-tag__x` and `.ss-crumbs a` were all under 24px with a mouse. Fixed
      in a new `ds/tokens/a11y.css` imported last (it has to beat component
      rules by source order). Per-control verdicts are in the audit doc. Also
      fixed there: the focus ring measured ~1.33:1 against a white card on
      every button in the product.
- [x] Keyboard operability. `DataTable` rows and agenda placement **confirmed**
      as the plan said. The open ground turned up one hard failure — there was
      no keyboard path to ANY file picker in the app (seven sites, all
      `<Button as="label">` around a `display:none` input), now one shared
      `FileButton` — plus the Popover trigger's missing `aria-expanded` and its
      Tab-out, the event switcher menu's absent focus management and arrow
      keys, and an unqualified 1-9 shortcut in the reviewer panel.
- [x] **Tooltips**: one fix, as scoped. `AgendaItemDialog` gained a Conflicts
      section, so an agenda item's clash is tap-reachable for the first time;
      both dialogs now render one `ConflictList` over the sentences
      `convex/model/agenda.ts` already produces. The mark on the block also
      carries the reason in its accessible name and differs by shape, not only
      colour. Tooltip itself was not redesigned.
- [x] 200% zoom and 375px width. Static check: no navigation entry and no
      action is hidden at any width. Two `display:none` rules below 860px are
      **flagged, not fixed** — `.ss-sidebar__head` and `.ss-sidebar__group` —
      because they are W7's mobile-drawer work by the plan's own division.

---

# M9 — Operating surfaces

## W7 — Lifecycle navigation & the mobile drawer

Bigger than "cheap": the drawer is a new DS variant (Dialog is a bottom sheet
under 640px, not full-height), there is no topbar menu affordance today, and
this workstream owns the active-tab fix below — but it still unblocks how
everything else is found.

- [x] **Regroup the fourteen entries by lifecycle** in
      `apps/web/src/routes/app.e.$eventSlug.tsx:52-133` (`SidebarNav` already
      supports groups; `NAV_GROUPS` is a single group today):
      **Setup** (Overview, Settings, Team, Import) · **Collect** (Call for
      speakers) · **Select** (Proposals, Reviews, Decisions) · **Prepare**
      (Sessions, Speakers, Tasks, Communications) · **Schedule** (Agenda) ·
      **Publish** (Public page, embeds, feeds).
- [x] **Merge Dashboard into the event root** (decision 5). The root becomes the
      **control center** (operational, time-sensitive); today's Overview content
      — stable event facts, CFP link, archive — folds into Setup → Overview.
      `/dashboard` redirects to the root, and the `dashboard` entry leaves
      `TAB_PATHS` while its path keeps resolving. (Verified safe: no external
      deep links, no search params. But note the root is a real page today —
      Overview, visible to reviewers and speakers — not a redirect, and
      Dashboard is `requires: 'organizer'` (`app.e.$eventSlug.tsx:60`): the
      merged root needs **role-conditional rendering**, not just a route swap.)
- [x] **Decisions as a filtered Proposals view** (decision 6). A Select-group
      entry that navigates to `/proposals` with the staged-decision filter
      applied through W12's URL-persisted search params — so it is a saved view,
      not a new route, and the release action stays where the proposals already
      are. The lifecycle step becomes visible without a fifteenth module.
- [x] **Attention counts in the rail**: `SidebarNav`'s `count` slot already
      renders (`navigation.css` `.ss-navitem__count`). Do NOT subscribe
      `Readiness.dashboard` from the shell — it is five `takeAll` reads that
      REFUSE with `event_too_large` (`convex/model/validation.ts:67-80`) plus a
      ticking per-minute `now`; under every page that turns one over-ceiling
      table into "navigation errors everywhere" and re-runs a five-table scan
      per minute on every route. W4 must also ship a **cheap counts query**
      (`takeCapped` counts, no ticking arg) for the rail, and the rail degrades
      to no badges on error — it never blocks navigation. Same numbers, same
      producer, different query shape, so rail and control center still cannot
      disagree.
- [x] **Real mobile drawer.** Under 860px the rail becomes a horizontal strip
      with group labels hidden (`navigation.css:36-79`,
      `.ss-sidebar__group{display:none}`) — so on a phone the lifecycle grouping,
      the thing this workstream adds, is invisible, and fourteen items become a
      memory test. Replace the strip with a topbar menu button opening a
      full-height drawer that shows the groups and counts. Keep the strip only
      if it can show the active group; otherwise drop it.
- [x] **Prefix-based active matching.** `app.e.$eventSlug.tsx:149-153` resolves
      the active nav entry by **exact** pathname equality with an
      `?? 'overview'` fallback — W9's routed workspaces (`/sessions/$id`) would
      highlight the control center and scroll the phone strip to the wrong
      item. Switch to longest-prefix matching before W9 lands.
- [x] **Breadcrumbs everywhere.** `PageHeader` takes them and the event layout
      passes three levels already (`app.e.$eventSlug.tsx:202`); extend through
      the new workspace routes so a phone always has an up-path. Note those
      breadcrumbs terminate at the event: per-workspace crumbs mean making the
      shared layout header route-aware (owned here, consumed by W9).
- *Eval compatibility*: labels may change, but every `TAB_PATHS` entry keeps
  resolving, and the old label stays as a search alias.

## W8 — Event control center

The headline bet, part one.

- [x] **One screen, four questions**: what needs my attention · what is blocked ·
      what changed recently · what happens next. Four panels, four queries, each
      with its read policy chosen deliberately in
      `convex/model/controlCenter.ts`: the attention panel and the change feed
      TRUNCATE (they must render), the blocked panel is `tasks.dashboard` which
      REFUSES (a dropped participation would report a session Ready nobody
      checked). EVERY panel owns a `PanelBoundary`, including the attention
      panel — which is why the first-event verdict is reported upward rather
      than branched on, since the query that answers it lives inside the
      boundary. Boundaries are keyed by event and offer "Try again", so a
      caught error never outlives the event or the condition that caused it.
      The ticking `now` split is preserved: it rides the three queries that
      need it, and the speaker drill-down keeps stable args.
- [x] **The rows the review specified**, each with a count that deep-links to
      the already-filtered work. The backend emits `{tab, search}` in the
      DESTINATION route's own vocabulary, and `links.test.ts` runs each search
      object through that route's real `validateSearch` — a param the
      destination would drop fails the build rather than silently landing on an
      unfiltered page. Four routes gained a typed `validateSearch` to receive
      them (reviews, speakers, tasks, sessions); agenda's was extracted so it
      could be asserted the same way. The tasks row also added an `outstanding`
      filter — the same `isOpen` predicate the count uses — because linking an
      open-task count at `status=pending` showed a shorter list than the number
      the organizer had just clicked. Also added: the `decisions` count W7 noted
      missing from `api.readiness.attention`, sharing one `stagedDecisions`
      producer with the panel row.
- [x] **What changed recently** reads the audit rows already written by every
      capability (`convex/model/audit.ts`) — no new write path. Action codes map
      to sentences in the model; an unrecognised code renders an honest generic
      line (`performed a recorded action: …`) rather than crashing the panel.
- [x] **First event vs returning event**: ONE decision point, measurably
      defined — no proposal has ever arrived (any status, including withdrawn),
      no session exists, and the CFP has never opened. A first event gets the
      six-step lifecycle checklist (setup · CFP · collect · select · schedule ·
      publish), each with a state and exactly one next action; anything with
      history gets the four panels.
- [x] Preserve today's dashboard strengths while merging: live subscriptions,
      `ReadinessMeter`, per-speaker drill-down and the ticking `now` all kept.
      The KPI tile grid is gone on purpose (the review's objection); the same
      numbers now read as a sentence on the speakers card.
- *Mobile*: single column of collapsible sections, attention first; counts are
  full-width tap targets; no KPI grid that shrinks to unreadable tiles.

## W9 — Speaker & session workspaces

The headline bet, part two. **Routed pages** —
`/app/e/$eventSlug/speakers/$eventContactId` and
`/app/e/$eventSlug/sessions/$sessionId` — with in-page `Tabs`.

Why routed rather than drawers, given mobile: a drawer over a table at 375px is
a scroll-locked overlay competing with the list underneath, and its back-button
and focus behaviour has to be hand-built; a route is the native phone pattern
(list → full-screen detail → back). Routes also give W4's blockers somewhere to
link to and satisfy the review's URL-persistence asks for free. Desktop keeps
list context through breadcrumbs and a "next/previous in list" control rather
than by keeping the table on screen.

- [x] **Speaker workspace**: identity + contact details · participations ·
      sessions · readiness · tasks · files · comments · communication history.
      Composed from existing pieces (`components/speakers/SpeakerProfileDialog.tsx`,
      `components/tasks/`, `components/comms/`), which then shed their dialog
      shells.
- [x] **Session workspace**: source proposal · speakers · content approval ·
      tasks and files · schedule · publication state (W4 sentences, verbatim) ·
      history (W3 snapshots).
- [x] **Rows open workspaces.** Speakers, sessions, and proposals tables
      navigate on row click; existing dialogs (`ProposalDetailDialog.tsx`,
      `SpeakerProfileDialog.tsx`, `SessionDetailDialog.tsx`) are either promoted
      to the workspace or reduced to a quick-peek that links to it. Do not leave
      two competing detail surfaces for the same record.
- [x] **Top-level modules stay** as batch/cross-event views — this workstream
      removes no capability, it adds the per-record path the review found
      missing.
- [x] **Tab state in the URL** so a blocker can link to
      `…/sessions/$id?tab=content`.
- *Mobile*: full-page workspace, sticky title + back, tabs in the existing
  overflow-scrolling `ss-tabs` strip (`navigation.css:80`), primary action
  pinned within thumb reach. Chrome budget: the event layout already renders its
  own header (breadcrumbs + event name + role badge) above every child
  (`app.e.$eventSlug.tsx:200-228`) and the nav strip is already sticky — the
  workspace must absorb or collapse that header at phone width, not stack a
  second uncoordinated sticky region under it. Route-aware header work is owned
  by W7's breadcrumb item; this workstream consumes it.

## W10 — Publish Center

- [x] Rebuild `apps/web/src/routes/app.e.$eventSlug.publish.tsx` (1123 lines
      today) around **lineup and schedule as separate decisions**, each with its
      own state, blockers, and history. History caveat: `publishedPrograms` is
      one row/one `version` per event and any rebuild rewrites both halves
      (`convex/model/publish.ts:426-473`). A per-channel *diff* is derivable
      from the combined blob (`program.lineup` / `program.agenda`); independent
      per-channel *version history* needs a schema change — decide which this
      means before building.
- [x] **Blocker list** straight from W4, each row linking to the repair.
- [x] **Diff preview before publishing**: what will be added, changed, removed.
      The published blob already exists (`convex/model/publish.ts`) — the
      comparison is against the last published projection, not a new store.
      (Verified feasible in one query: `publishState` at `publish.ts:711-714`
      already loads the blob and recomputes fresh in the same query to derive
      `stale`; the diff is that read pattern with a structural diff instead of
      a boolean. Two ~900KiB guarded blobs are far under read limits.)
- [x] **"Last published by Jordan Alvarez at …"** attribution on both channels.
- [x] **Bulk publish everything eligible**, with the eligibility arithmetic from
      W5 stated before and after.
- [x] Keep the embed console; it moves under Publish in the new grouping and
      inherits the brand-colour work from W5.

## W11 — Review round launch flow

- [x] Turn round setup (`apps/web/src/components/reviews/RoundsPanel.tsx`, 807
      lines) into a guided flow: basics → scorecard → reviewers and pools →
      eligible proposals → assignment policy → blind preview → launch summary.
- [x] **The summary states consequences in sentences**: "2 proposals will be
      assigned to Sam Whitfield. Both already have released decisions; those
      decisions will not change. Reviewer identities are hidden. Cap: 2."
- [x] **Outcomes explain themselves**: replace `Assigned 0 · unplaced 0` with
      "No new assignments: both selected proposals are already assigned."
- [x] **"Preview as reviewer"** on every blind round — demonstrate anonymity
      rather than asking the organizer to reason about which custom fields carry
      identity. This is also the cheapest guard against a blind-round leak.
- [x] Post-launch dashboard: per-reviewer progress and overdue state (exists —
      wire it as the flow's destination).
- *Mobile*: one step per screen, sticky Back/Next, the summary readable without
  horizontal scroll.

## W12 — Table & batch-action standard

Applied as the surfaces above are touched, not as a big-bang refactor.

- [x] **One toolbar** (`ds/components/layout/Toolbar.jsx`): search · filters ·
      saved view · columns · export.
- [x] **Removable filter chips**, and **URL-persisted filter state** via typed
      `validateSearch` — the ARCHITECTURE.md saved-views mechanism, finally used
      consistently.
- [x] **Row click opens the workspace**; at most two visible row actions, rest in
      overflow.
- [x] **Selection reveals a batch bar** stating count, eligibility, exclusions,
      expected result (`components/abstracts/BulkBar.tsx` is the existing
      pattern — promote it into the DS).
- [x] **Hide zero-count filters** unless the zero is operationally meaningful
      (an empty "Blocked" is worth showing; an empty "Withdrawn" is noise).
- [x] **Skeleton/progress during load and export.**
- [x] **CRM page order** (`apps/web/src/routes/app.org.$orgSlug.tsx`): the
      contact directory leads; KPIs, segments, and duplicates move below. Eval
      constraint: `specs/07-speaker-crm.yaml:337-351` requires a
      screenshot-visible populated analytics widget — do **not** collapse the
      KPIs by default. The primary work should not be the last thing on screen.
- *Mobile*: under 640px the operational tables (proposals, sessions, speakers,
  tasks, contacts) render as a **card list** — primary identity, the one or two
  states that matter, one action, tap to open the workspace — with the existing
  horizontal scroller (`DataTable.jsx` + `.scroll-x`) kept for genuinely tabular
  comparison views like review results. Selection and the batch bar work in both
  renderings from the same state.

## W13 — Agenda on a phone

Decision 8 goes beyond the review, which accepted a desktop-only board. **Most of
the foundation is already built** — this workstream is four additions on top of
it, not a new interaction model. What exists today:

- `TouchSensor`, `MouseSensor` and `KeyboardSensor` are configured separately
  with deliberate activation constraints, because one `PointerSensor` gave touch
  the wrong contract (`AgendaBoard.tsx:142-164`).
- Full keyboard placement: `keyboardDrag.ts` walks the 15-minute droppable
  lattice by arrow key, with screen-reader instructions and board-specific
  dnd-kit announcements, and it is unit-tested (`keyboardDrag.test.ts`).
- `PlaceDialog.tsx` already edits start, end and room without any gesture.
- `ListView.tsx` already renders the whole board chronologically — sessions and
  agenda items interleaved, unscheduled trailing — and works with nothing
  scheduled.
- `Dialog` already becomes a bottom sheet below 640px
  (`ds/components/feedback/feedback.css:44+`), and the agenda layout already
  stacks its tray at 860px with measured phone fixes (`app.css:79-113`).

What is genuinely missing:

- [x] **Scoping pickers.** The grid still renders every room as a column and
      relies on horizontal scroll, so at 375px the organizer sees a sliver of a
      two-dimensional layout. Add day and room/track pickers that reduce the
      phone view to one column of time — reusing `ListView`'s data shaping rather
      than writing a third rendering of the board.
- [x] **Tap-to-place.** Select a session from the tray → eligible slots highlight
      → tap to place. Keyboard pick-up exists; select-then-tap does not, and
      neither does slot **eligibility highlighting** (today the board shows
      conflicts for placements that already exist, not which empty cells would be
      legal).
- [x] **Client-visible eligibility.** That highlighting needs the conflict math
      where the client can call it. `conflictsFor` is pure but lives in
      `convex/model/agenda.ts`; move the pure part to `convex/shared/agenda.ts` —
      the repo already shares `formDef`, `scorecard`, `importPlan` and `jobTypes`
      this way — so the board, `autoPlace`, and W2's preview all agree by
      construction instead of by careful maintenance. (Verified a pure move:
      `conflictsFor`/`overlaps`/`blockers` + their types move verbatim — no
      ctx/db/clock, `Id<>` types erase. One addition: the client holds
      `BoardSession` projections, not raw docs, so it needs a ~15-line
      `BoardSession → ScheduledThing` adapter replicating the `counts()`
      withdrawn/declined filter at `agenda.ts:184-186`; the existing
      `api.agenda.board` subscription already carries every required field.)
- [x] **Touch-reachable conflict explanations.** `Tooltip` reveals on
      `:hover`/`:focus-within` only (`feedback.css`), which a touch device never
      triggers — so any conflict reason carried by a tooltip is invisible on a
      phone. Render blocker reasons inline on the block or in the sheet, using
      W4's sentences.
- [x] **Duration-accurate blocks** once W2 lands: block height and the
      `PlaceDialog` default end come from the format's duration rather than a
      fixed hour (`PlaceDialog.tsx:34` `DEFAULT_DURATION_MS`).
- [x] Verify at 375px and 320px, both orientations, with `pointer: coarse` target
      sizes from W6.

---

## Cross-cutting

- **Eval compatibility** (per decision 1): every path in `TAB_PATHS` and every
  current deep link keeps resolving — redirect, never 404. No capability moves
  behind more clicks than today. Renamed labels keep their old wording as a
  nav/search alias for one cycle.
- **Nothing regresses the protected list** in "Why this plan exists". Reviewer
  scoping, portal scoping, audit attribution, and the shared publication
  projection are invariants, not features to redesign.
- **Copy is code.** Any user-facing sentence about state comes from the model
  layer (W4). Two surfaces disagreeing about the same fact is the exact class of
  bug this plan exists to remove.
- **Schema changes**: W3's snapshot projection and W2's undo metadata should be
  derivable from existing tables; if a backfill is needed use
  `@convex-dev/migrations` and do not strand `dev:scintillating-heron-597` or
  `develop:marvelous-snail-907`.
- **Env parity**: W1's webhook diagnosis is a per-deployment check — Convex env
  vars do not mirror between dev, develop, staging, and prod.
- Every workstream ends browser-verified against the dev deployment, then
  deployed to `develop` for the next eval run.

## Verification

- [ ] `tsc` + full convex-test + web tests green per workstream; new negative
      authz tests for every new query.
- [ ] **Browser-verified at 1440px and at 375px** for every workstream — the
      phone pass is not optional and not deferred to the end.
- [ ] **Keyboard-only pass** of the changed surface before a workstream is called
      done (tab order, focus return, no drag-only action).
- [ ] **Route-resolution check**: every path in `TAB_PATHS` plus the public and
      portal routes still resolve after W7.
- [ ] Re-walk the review's five "clicking too much" jobs and confirm each is now
      one workspace or one flow: prepare a speaker · publish a session · launch a
      review round · resolve an uploaded file · answer "why isn't this public?".
- [ ] Eval re-run by Alvaro; target is **no regression from 100%** with the UX
      report's named rough edges closed.

## Suggested order

W1 → W2 → W3 → W5 → **W4** → W6 → W7 → **W8** → W9 → W10 → W12 → W13 → W11

Trust first, because the review's own recommendation is to fix what the product
says before restructuring where it says it. W4 sits at the hinge: it is trust
work, and it is the vocabulary W8, W9, and W10 all render. W7 (navigation) is
cheap and comes before the control center so the new surfaces have a home. W12
is applied continuously from W9 onward rather than as its own sprint. W13 follows
W12 so it inherits the settled DS mobile patterns, and it is smaller than it
first looks — the sensors, keyboard placement, place dialog, list rendering and
bottom-sheet dialog all already exist, so it is four additions rather than a new
interaction model. W11 is last because the reviewer experience is already the
cleanest role in the product.

The item that carries the most risk relative to its line count is the **format
library migration** in W2: it changes a field that the CFP form, the published
blob, and the public widgets all render, and existing values are free text with
no guaranteed vocabulary. Rehearse the backfill (`convex-migrate-rehearse`)
rather than running it straight at `develop`.
