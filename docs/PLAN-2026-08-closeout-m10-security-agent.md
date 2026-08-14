# PLAN — Challenge close-out + M10 slice + security + agent access (v5) · ARCHIVED 2026-08-14

**Outcome: Parts A1, B, C, and D all landed on `develop` (pushed, preview
verified).** A1 fixed deployment truth (Resend webhooks, test-mode
loudness, backfills, pushes). B shipped the M10 slice — global search +
Cmd-K palette, saved views, composer tokens + server-rendered preview,
turnaround analytics — codex-clean after five fix rounds. C closed the
Aug 12 security review end to end, including the header verification that
waited for a preview deploy. D (re-staged by Alvaro to ship WITH the
submission) built agent access: hashed API keys acting as their minter,
a hosted MCP server at `/mcp` with 11 read + 4 write tools, the org
settings key UI + connect panel, and the published skill + docs — six
codex rounds, proven end-to-end with real Claude Code and Codex client
sessions, tests 715→750 root / 625→635 web. **The still-open A2/A3
submission items moved forward to the live [PLAN.md](../PLAN.md) (v6).**
This plan is closed; the text below is the state at archive time.

## STATUS: ARCHIVED — was: started 2026-08-13, challenge hard stop Sunday 2026-08-16

The organizers' Aug 13 update (see [docs/CHALLENGE.md](CHALLENGE.md)
"Post-deadline update") opened an optional working window until **Sunday,
Aug 16, 2026**. This plan has three parts. **Part A** is the overarching
challenge work: make what we built verifiably true on the judged deployments
and give the AIE team the easiest possible evaluation. **Part B** pulls a
deliberate slice of **M10 (expert efficiency)** from
[docs/MILESTONES.md](MILESTONES.md) forward as feature workstreams,
shaped for the process that worked last cycle: one development agent per
workstream → independent verify → codex review → fix round → one commit.
**Part C** remediates the Aug 12 security review (verified against
`9f2a836` on Aug 13 — see
[docs/reference/security-review-2026-08-12.md](reference/security-review-2026-08-12.md)):
C1 ships before Sunday, the rest is staged for after. **Part D** is the
first post-challenge cycle: agent access — API keys + a hosted MCP server so
users connect their own Claude Code / Codex to StageStack in minutes. It was
planned and de-risked (spike validated 2026-08-14) inside this window on a
feature branch. RE-STAGED 2026-08-14 (Alvaro): Part D ships WITH the
submission — built and reviewed to the full merge bar on
`feature/agent-access`, it merged to `develop` the same day instead of
waiting out the window.

Part A gates the eval re-run; Part B workstreams land independently and only
merge if green — an unfinished feature never blocks Sunday. Part C1 is small
enough to hold to the same bar.

Context: [docs/CHALLENGE.md](CHALLENGE.md) ·
[docs/MILESTONES.md](MILESTONES.md) ·
[docs/ARCHITECTURE.md](ARCHITECTURE.md) ·
[docs/BUSINESS_CONTEXT.md](BUSINESS_CONTEXT.md)
Previous plans: [UX maturity cycle M8–M9](PLAN-2026-08-ux-maturity.md) ·
[eval fix cycle](PLAN-2026-08-eval-fix.md) ·
[original build M0–M8](PLAN-2026-08-submission.md)

---

# Part A — Challenge close-out (overarching)

## A1 — Deployment truth

- [x] **Resend webhook on `develop` (`marvelous-snail-907`) and prod
      (`healthy-lynx-620`)** — FIXED 2026-08-13. Root cause was the silent
      one: only the dev deployment had a Resend endpoint; develop and prod
      had none, and both carried dev's (per-endpoint, therefore useless)
      Svix secret. Created one endpoint per deployment (all events, matching
      dev), set each endpoint's own signing secret on its deployment
      (`--deployment-name` / clipboard flow — secrets never printed), and
      proved transport with a real send: both new endpoints show
      `email.sent` + `email.delivered` as Success, which requires the
      signature check to have passed. Remaining tail: the first real send
      FROM the develop/prod apps (demo seed or eval) will show its comms row
      advancing to Delivered end-to-end; the shared-account cross-noise
      ("Email not found … ignoring") stays benign per CLAUDE.md.
- [x] **`RESEND_TEST_MODE=false` confirmed on develop AND prod** — verified
      2026-08-13 via `npx convex env list` against both deployments: both
      already carry `false`. Env vars do
      not mirror between deployments. NO LONGER SILENT (2026-08-13): the knob
      stays (safety default for a public, self-hostable repo) but test mode is
      now a loud product state — a banner on the comms page AND the control
      center fires proactively from the live env, before any send fails, and
      every refused row records why (test mode vs key/domain). Confirming a
      deployment is now "open its control center as an organizer".
- [x] **Confirm `internal.library.backfillFormats` ran per event** on dev
      (`scintillating-heron-597`), develop, and prod (idempotent; refuses
      >1000-session events; keeps labels verbatim — the CFP format labels are
      asserted verbatim by the eval). RUN 2026-08-13 against every event on
      develop (8) and prod (14): all zeros except prod's Aug-12 eval event
      (1 format created, 2 sessions linked), `unmatched: 0` everywhere.
- [x] **Push `develop`** (ahead of origin) so the preview deploy — what the
      evals hit — matches local; merge to `main` before Sunday so prod
      carries everything we want judged. (Done 2026-08-13: develop pushed and
      main fast-forwarded to the same commit, `10f449f` — both carry the full
      M10 slice and the docs reorganisation.)

## A2 — Evaluation package

The repo is already public (flipped 2026-08-12). Goal: the AIE team —
swyx@ai.engineer · sydney@ai.engineer · phlo@ai.engineer ·
kelsey@ai.engineer — lands signed-in, in a populated event, with a map from
the six requirements to the exact screens that prove them.

(Form submission — https://forms.gle/RJMXWp2jAD32uHvB9 — is handled directly
by Alvaro, outside this plan.)

- [ ] **Seeded demo event on prod**, in its own demo organization so demo
      data never touches anything real: a published CFP, proposals across
      every status, a launched review round with scores, a part-scheduled
      agenda with deliberate conflicts to show detection, speakers at every
      readiness state, task/reminder history, and a published public page +
      embed + API — every one of the six requirements demonstrable with zero
      reviewer setup.
- [ ] **Zero-friction reviewer access**: organizer invites pre-sent to the
      four @ai.engineer addresses (our own invite flow is the demo), each
      deep-linking into the seeded event; verify the Clerk production
      instance accepts fresh sign-ups cleanly. Invites are staged first and
      sent only on Alvaro's go.
- [ ] **Reviewer guide** — `docs/EVALUATION.md`, linked prominently from the
      README: deployed URLs (site, public page, embed, API endpoint), how to
      get in, a 10–15 minute walkthrough mapped requirement-by-requirement to
      the six with deep links into the seeded event, plus pointers to the
      trailer video and where the tests/CI live for the code-side story.
- [ ] **README front door check**: the first screen serves a judge — product
      summary, live demo link, evaluation guide link, screenshots current
      with the post-W13 UI.

## A3 — Verification before Sunday

- [ ] **Eval re-run** against the develop preview once A1 lands — target: no
      regression from 100%, with the UX review's named rough edges closed.
      (Alvaro runs the harness.)
- [ ] **Live a11y passes** the static audit explicitly deferred: axe + manual
      keyboard pass + screen-reader pass over the running app
      ([audit doc](reference/a11y-audit-2026-08.md)).
- [ ] **Re-walk the five "clicking too much" jobs** — prepare a speaker ·
      publish a session · launch a review round · resolve an uploaded file ·
      answer "why isn't this public?" — each now one workspace or one flow.
- [ ] **Final prod walk** of the six challenge requirements on
      https://stagestack.dev as a signed-in organizer, phone width included.

---

# Part B — M10 slice (feature workstreams)

Selection rationale: M10 is "the organizer running their fourth event moves
faster than the one running their first". The slice below picks the M10 items
that are high-impact for a judge walking the product this week and buildable
in this window on foundations that already exist. Deliberately NOT pulled:
offline-tolerant phone / installability (M10 gates it on real usage of M9's
surfaces, and a service worker two days before judging is risk with no demo
payoff) and the customizable control center (the fixed four-panel answer is
the demo; configurability adds settings surface, not judged value).

House rules apply unchanged (see the archived plan's Constraints): DS
primitives first, one producer per sentence in `convex/model/*`, validators
everywhere, convex-test with negative authz per new query, mobile parity
stated per surface, every `TAB_PATHS` route keeps resolving.

## W1 — Global search + command palette

The M10 headline. One fast affordance that makes the whole product feel
expert-grade — and makes every reviewer's "where is X?" self-answering.

- [x] **Backend**: one `search` capability in `convex/model/` scoped to the
      caller's memberships — events, sessions, speakers/contacts, proposals
      by title/name; per-type caps with a `capped` flag; reviewers only ever
      see their assigned scope (negative authz tests mandatory).
      (`convex/model/search.ts` + `api.search.everything`. Reviewer path is
      built ONLY from their own assignment index — no by-id proposal reads,
      no contact/session reads — so unassigned records are unreachable by
      construction. Speaker rows carry professional identity only, never
      email/phone, for organizers too. A capped scan that matched nothing
      says so instead of "no matches"; membership sweeps report their own
      overflow. Deferred, deliberately: search-by-email (the row shows no
      email, so a match would be invisible), per-proposal deep links (the
      route has no id param — hits land on the pre-filtered table), and
      cross-event record search (unbounded read).)
- [x] **Command palette** (Cmd/Ctrl-K + a visible topbar search button):
      results grouped by type, each row deep-linking to the W9 workspace or
      module; recent/frequent destinations when the query is empty;
      navigation-only actions in v1 (no mutations from the palette).
      (`CommandPalette` is a DS primitive composing Dialog; empty query shows
      the lifecycle-grouped destinations. Below 640px the topbar search
      collapses to icon-only and the event-switcher title ellipsises inside
      its own box, so nothing overlaps at 375/320px.)
- [x] **Fuzzy jump to nav destinations** by current AND old label (the alias
      list W7 kept) so renamed surfaces stay findable. (`paletteNav.ts` reads
      the same alias list the rail announces — "Overview, also called
      Dashboard".)
- *Mobile*: full-screen sheet from the topbar search button; keyboard
  behaviour degrades to plain list taps.

## W2 — Saved views with shareable URLs

Finishes what W12 started: table state already lives in typed
`validateSearch` URLs; make that state nameable, savable, and shareable.

- [x] **Persistence**: `savedViews` table (event-scoped, per-user, named,
      module + serialized search params) with capability wrappers; validate
      params through the destination route's real `validateSearch` on save
      (the `links.test.ts` pattern) so a stored view can never point at a
      dropped param. (Done by MOVING each route's parser into
      `convex/shared/viewParams.ts` — the routes re-export it — so the
      route's `validateSearch` and the stored-params check are one function
      rather than two that agree by maintenance. Params are re-parsed on the
      way out too: a row can outlive the vocabulary it was written against in
      a way a URL cannot. Role gates the module on READ and WRITE, from the
      same map the rail's `requires: 'organizer'` uses.)
- [x] **UI**: the existing `Toolbar` saved-view slot becomes real — save
      current view, rename, delete, set as my default for this table; a
      shared view is just its URL (copy button), since the state is already
      in the address bar. (One `components/views/SavedViewsMenu` over the DS
      `MenuButton`, on the four module tables that have a Toolbar: proposals,
      sessions, speakers, tasks. Reviews and Agenda have no toolbar to put it
      in — the backend supports both modules, the picker is not drawn there.
      Also added: "update this view to what is on screen", separate from
      rename so neither silently does the other's job. The picker CARRIES the
      id of the view it applied rather than inferring it from the params:
      two views can hold identical filters, and inferring backwards named —
      and renamed, defaulted, deleted — whichever came first. With nothing
      picked and several views matching, the toolbar says so and offers no
      destructive action against a guess.)
- [x] **Decisions entry stays a saved view** (W7 decision 6) — migrate it to
      this mechanism rather than keeping a bespoke filter link. (It is now a
      code-level PRESET in `convex/shared/viewParams.ts`; `DECISIONS_SEARCH`
      in the nav and the "Decisions" row in the proposals picker read that one
      definition. The old `BUILT_IN_VIEWS` list is derived from the presets,
      and its "Queues" entry is that preset renamed to Decisions.)
- *Mobile*: the picker is one compact menu button; the `Toolbar` has no
  overflow container — it WRAPS below 640px (`layout.css:37`) — so the picker
  takes its own line rather than being hidden behind a second menu. Card-list
  rendering (W12) honors the same params, unchanged.

## W3 — Message composer: tokens + live preview

M10's composition item, minus the full-WYSIWYG bet the last plan deferred.

- [x] **Token palette + insert-at-cursor** over the existing template
      textarea: clickable `{{speaker.name}}`-style merge tokens, list driven
      by the variables the backend already resolves — one shared definition
      in `convex/shared/` so the palette and the renderer cannot disagree.
      (`convex/shared/templateVars.ts` enumerates per-context availability
      from every real send site; the palette shows only what THIS template's
      send passes. The token warning distinguishes a misspelling from a real
      variable this context never fills — one `varWarning` producer consumed
      by the editor AND SendPanel, whose hand-rolled client substitution was
      deleted rather than left as a second source of truth. Found-and-fixed:
      the old preview substituted speaker vars into templates whose sends
      pass no speaker — it previewed a lie.)
- [x] **Live personalized preview**: rendered against a real selectable
      recipient (or an explicit sample person), through the same server-side
      render path the send uses — never a client-side re-implementation.
      (`templates.preview` runs the send's own substitute+shell calls; a test
      asserts preview output is byte-identical to the stored sent message.
      Sample recipient is explicitly labelled as not a real speaker.)
- [x] **Raw HTML stays an explicit advanced mode**; full WYSIWYG remains out
      (unchanged decision 4 from the archived plan). (No toggle was needed:
      the body field IS the raw-HTML textarea — there is nothing to gate.)
- *Mobile*: palette as a bottom sheet; preview stacks under the editor.

## W4 — Turnaround analytics

M10's analytics item, derived entirely from audit rows already written —
no new write path, which is what makes it safe for this window.

- [x] **One `convex/model/analytics.ts` producer** deriving per-event
      medians/distributions from existing audit history: proposal→decision
      time, decision→speaker-confirmation time, task assignment→completion
      time, publish latency (ready→published). Derived on read, capped reads
      with truncation flags, never stored. (Anchors: `cfp.submit`→
      `decision.release`; `decision.release`→`participation.setState`
      to `confirmed`; instance creation→`task.markProvided`/`task.upload`/
      `task.approve`; `sessions.setContentStatus` to `approved`→
      `publish.session`. TWO DOCUMENT FALLBACKS, both because the audit trail
      genuinely cannot answer: task instances are GENERATED by a requirement
      so nothing audits the assignment — `_creationTime` is it; and a BULK
      publish writes one event-wide row with no session ids, so
      `publicationFlags.updatedAt` is the only per-session record — trusted
      ONLY while no unpublish can have rewritten it, since it holds the LAST
      flip; a session whose flag an unpublish could have moved leaves the
      population and makes that count a floor. Earliest row wins everywhere
      EXCEPT the approval that starts a publish, which is the latest one at or
      before the publish itself — the approval that actually governed it —
      because approve/revert/re-approve would otherwise report the fortnight
      the content spent in draft. Neither rule ever flatters a number.
      `capped` is PER STATISTIC, computed from the reads that feed it: a
      session ceiling says nothing about whether the decision figures are
      complete.
      Distribution is p50/p90 by NEAREST RANK — every figure printed is an
      interval that actually happened, not an interpolation between two that
      did not. Withdrawn proposals, declined speakers, cancelled sessions and
      Not-Applicable tasks are excluded from BOTH the population and the open
      count: they are answered, not outstanding. No `now` argument — medians
      over closed intervals need no clock.)
- [x] **One analytics panel** on the event control center (collapsible,
      below the four questions — it must not dilute the attention-first
      answer), each stat a sentence with its population size, not a bare
      KPI grid (the review's objection stands). (`components/dashboard/
      TurnaroundPanel.tsx`, collapsed by default, behind its own
      event-keyed `PanelBoundary`. Deviation: the boundary grew a `quiet`
      flag and this one panel uses it — a supplementary retrospective that
      cannot compute has nothing to say, and a red callout under the four
      answers that DID load would make a nice-to-have look like a fault.
      Deviation: the disclosure is the DS `Panel` (native
      `<details>/<summary>`) rather than a hand-rolled button with
      `aria-expanded`, so the semantics come from the platform and the panel
      matches the other four; the brief asked for the ARIA, the platform
      supplies it. First events never see it — they have no history to
      review.)
- [x] Convex tests over seeded audit fixtures, incl. the empty-event case
      and negative authz. (`convex/analytics.test.ts`, 13 tests. Fakes only
      `Date` — convex-test stamps `_creationTime` from `Date.now()`, and
      these intervals ARE creation times — and seeds strictly forward,
      because convex-test keeps `_creationTime` monotonic and would collapse
      a backwards clock into millisecond ticks.)
- *Mobile*: the panel is a stacked list of sentences; no chart is required
  for v1 — numbers with populations beat sparklines this week. (Stacked at
  EVERY width: there is no wide-screen variant to fall back from, because a
  chart or a tile grid is exactly what this panel refuses to be.)

## Suggested order & orchestration

A1 first (it gates A3's eval re-run and A2's invite emails actually
delivering). A2's seed next, because W1/W2/W4 all demo better against the
seeded event, and `docs/EVALUATION.md` is written last so it can point at
whatever Part B lands. Part B agents run in parallel per workstream —
W1 and W3 touch disjoint surfaces; W2 and W4 both touch the control-center /
toolbar edges, so they rebase in that order. Merge bar per workstream:
`tsc` + full test suites green, browser-verified at 1440px and 375px,
keyboard pass, negative authz for every new query — then it ships to
`develop`; anything not green by Saturday evening is cut without ceremony.

---

# Part C — Security remediation (Aug 12 review)

Source of truth for the findings:
[docs/reference/security-review-2026-08-12.md](reference/security-review-2026-08-12.md)
— every status there was re-verified line-by-line on 2026-08-13 against
`develop` @ `9f2a836`. Important context: commit `7634031` (Aug 9) closed the
**earlier** review's findings, not these; nothing from this review has landed
anywhere.

Staging rationale: the repo is public and prod is judged this week, so the
one real privilege-escalation path (C1) closes before Sunday; everything else
is either defense-in-depth on an already-secret-guarded surface (C2), needs
docs-first research we should not rush against the deadline (C3), or is
hygiene with zero judged value this week (C4). C1 holds to the Part B merge
bar; C2–C4 are explicitly NOT this window's work — they are written down here
so the next cycle starts from a plan, not a memory.

## C1 — Close the exploit path (before Sunday)

- [x] **F1: bind invitation acceptance to the invited email.**
      (DONE 2026-08-13. Binds to the LIVE `ctx.auth` identity with
      `emailVerified === true` required — not the stored `users.email`, which
      users.ts itself marks "NEVER an authorization key" (codex caught this;
      the fix follows `portal.enterPortal` exactly). Unverified gets its own
      `email_unverified` code, checked BEFORE the address comparison so the
      two codes are not an address oracle. Mismatch leaves the invite pending,
      writes nothing. Four negatives in team.test.ts incl. unverified-match
      and stale-stored-email.)
      `convex/model/team.ts` `acceptInvitation` (216–293) must compare the
      redeeming user's verified email against `invite.email`
      (case-insensitive) and refuse with a clear ConvexError naming the
      mismatch — today any signed-in account holding a leaked or forwarded
      token can redeem it into org/event membership. This is the only
      realistic privilege escalation in the app. Ship with a negative
      convex-test: wrong-email redeemer refused, right-email redeemer
      admitted, and the audit row unchanged on refusal. Decision to make in
      the diff, not silently: whether a mismatch marks the invite spent or
      leaves it pending (leaning pending — a wrong account trying must not
      burn the right account's invite).
- [x] **S2: stop serializing the Clerk JWT into the SSR payload.**
      (DONE 2026-08-13. Exactly the predicted one-line return change;
      `setAuth` untouched; comment states the serialization constraint.)
      `apps/web/src/routes/__root.tsx:189-196` — drop `token` from the
      `beforeLoad` return (`setAuth(token)` already ran above it). Verified:
      nothing outside `__root.tsx` consumes route-context `token`, so this is
      one line plus the `ClerkAuth` type. Check the app still hydrates
      signed-in (the Convex client re-auths via `useAuth`, not this field).
- [x] **S3 rider: `https` floor for non-loopback hosts.**
      (DONE 2026-08-13. The proto header may only select http for loopback;
      the old test asserting the downgrade was rewritten into floor cases.
      Ruled with codex: an `http:` SITE_URL stays accepted — operator config
      is not attacker input; judgment recorded on `configuredOrigin`.)
      `apps/web/src/lib/origin.ts:71-78` currently honors a client-supplied
      `x-forwarded-proto: http`; behind Vercel the edge overwrites it, but
      the code shouldn't depend on that. Only `LOOPBACK_HOSTS` may resolve to
      `http`. One conditional + one test in the existing `resolveOrigin`
      table.

## C2 — Rate-limit parity (next cycle, or Saturday if C1 lands early)

Both fixes copy patterns already in the tree — no design work, just parity.

- [x] **F3: `worker.importContext` joins the limiter.**
      (DONE 2026-08-13. Two rounds: `check()` parity first, then codex
      observed a query only OBSERVES the bucket — so importContext became a
      mutation that `.limit()`s like its siblings (sole call site is one-shot
      in apps/worker/index.ts, no subscription semantics to lose). The test
      proves consumption: refusal is reachable with no other worker call
      spending.) `convex/worker.ts`
      284–351 is the only worker endpoint without a `workerLimiter` check
      (the sibling endpoints throw `rateLimited()` — see worker.ts:120/143/
      171/194/376). Same key shape as its siblings.
- [x] **F4: cap `tasks.generateUploadUrl`.**
      (DONE 2026-08-13. 20/HOUR token bucket keyed on the user, matching
      `importUploadPerUser`; same `rate_limited` error shape as CFP/portal.
      Test: 20 mint, 21st refused, a second user unaffected.) `convex/tasks.ts:217-223` mints
      storage upload URLs with no ceiling; `imports.ts:28` (`importLimiter`,
      per-user per-hour) is the pattern for exactly this shape. Key on the
      calling user.

## C3 — Web/worker hardening (next cycle; docs-first)

- [x] **S1: security headers.** (DONE 2026-08-13, pulled forward — docs-first
      research landed `apps/web/vercel.json` over nitro routeRules (nitro's
      generated header routes lack `continue: true` and would shadow its own
      asset routes) and over Start middleware (CDN-served assets never invoke
      the function). CSP is REPORT-ONLY; HSTS without `preload` (one-way
      door); XFO DENY everywhere except `/embed/*`, which external sites
      iframe by design. Clerk's six required directives verified per-directive
      against their current CSP doc; their `script-src https: http:`
      recommendation and dev-only `'unsafe-eval'` deliberately NOT copied,
      pinned by negative tests. KNOWN enforce-blocker, documented in
      vite.config.ts: ClerkProvider mounts on `/embed/*`, so the strict embed
      policy is a measurement tool until a root-layout split. VERIFIED
      2026-08-14 on the develop preview (the Part D merge's deploy):
      document route carries CSP-report-only + HSTS + XFO DENY + nosniff +
      referrer-policy; the hashed asset carries HSTS + nosniff; `/embed/*`
      answers `frame-ancestors *` with no XFO — Vercel merged the file.) CSP (report-only first), HSTS,
      `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`,
      `Referrer-Policy` on the Vercel-served app. FRESH-DOCS-FIRST applies
      hard here: the right mechanism (nitro route rules vs `vercel.json`
      headers vs Start middleware) must come from current TanStack
      Start/nitro docs, not memory — and the public program page + embed
      (`/api/events/*`, CORS-open by design) must keep working, so
      `frame-ancestors` needs the embed story decided, not defaulted.
- [x] **S5: byte-cap the worker's file download.** (DONE 2026-08-13, pulled
      forward. Finding en route: the upload path never had a byte limit
      either, so there was no constant to share — created
      `IMPORT_LIMITS.maxFileBytes` (10 MB) in convex/shared/importPlan.ts and
      wired BOTH ends: the browser refuses before storing, the worker's
      `downloadCapped` refuses on Content-Length when present AND on a
      streaming tally because the header can lie; reader cancelled on
      refusal. 5 worker tests incl. the lying-header case.)
      `apps/worker/src/import-agent.ts:403-404` buffers the whole body;
      check `Content-Length` when present AND enforce a streaming cap while
      reading (the header can lie). Cap should match whatever
      `imports.upload` already enforces at upload time — one shared constant,
      not two that agree by luck.
- [x] **S4: type the `location.search` read.** (DONE 2026-08-13, pulled
      forward. `useSearch({ strict: false })` types `status` from the
      proposals route's registered `parseProposalsSearch` — the W2 shared
      parser — so dropping the param stops compilation instead of silently
      reading undefined.)
      `apps/web/src/routes/app.e.$eventSlug.tsx:60` — replace the
      `as { status?: string }` cast with the route's real `validateSearch`
      types (the `convex/shared/viewParams.ts` parsers from W2 are the
      obvious source).

## C4 — Hygiene backlog (post-challenge; parked, not forgotten)

Verified snapshot in the review doc. None of this is judged value this week;
it is the debt list for the first post-challenge cycle, roughly in order of
leverage:

- [x] Consolidate the ~10 redeclared scan caps (portal's drifted `200`
      included) and the 5 copies of `vParticipantState` into one shared
      definition each. (DONE 2026-08-13: `convex/lib/readCaps.ts` holds the
      eight full-read ceilings; truncating summary caps stay distinct on
      purpose. Portal's `200` was NOT drift — it is per-person, introduced at
      that value; renamed `PERSON_CONTACT_SCAN` so it can't be re-flagged. The
      reminders sweep keeps its own `INSTANCE_SCAN = 4000`: codex showed 8000
      note-heavy instances could blow the 16 MiB transaction byte budget in
      the one mutation that reads the whole graph. `vParticipantState` now
      lives in lib/validators.ts.)
- [x] Replace the 17-string plain-message whitelist (`convex/http.ts:69-87`)
      with error-code-driven mapping. (DONE 2026-08-13: registry in
      `model/headshotImages.ts` — code → sentence, `HTTP_SAFE_FAILURE_CODES`
      allowlist, sentences looked up from the registry so a throw site cannot
      smuggle text. All 17 verified to still reach the client; six internal
      codes deliberately non-public. Known residual, stated in the boundary
      comment: ConvexError `data.message` (app-authored) still passes through
      for any code — pre-existing behavior, kept to avoid a public-surface
      change this week.)
- [x] `program: v.any()` at `convex/schema.ts:960` gets a real validator
      (it is a privacy-filtered snapshot — its shape is known).
      (DONE 2026-08-13: `vPublicProgram`, derived from `computeProgram` and
      history-checked commit-by-commit — the shape changed once (0c7d1d0 added
      speaker fields, nothing ever removed), so exactly `speakerId`/`jobTitle`/
      `company` are optional and the rest is strict. convex-test enforces the
      validator on every test publish. NOT yet pushed to any deployment —
      the next `convex dev/deploy` carries it; watch that push.)
- [x] Unwind the cfp↔sessions nested `runMutation`
      (`convex/model/cfp.ts:1485`) into a direct model call.
      (DONE 2026-08-13: same-ctx call, wrapper deleted (no other callers);
      the wrapper's re-read-after-patch semantics preserved by re-fetching
      rather than reconstructing. The import cycle this created was then
      BROKEN by the cfpForms split below. Codex verdict: clean.)
- [x] Split the monster models (`agenda` 2404 · `reviews` 2289 · `tasks`
      2231 · `cfp` 1966 · `speakers` 1908 lines), starting with extracting
      reminders out of tasks.
      (DONE 2026-08-13, with two premise corrections. Four pure-move
      extractions: `taskFiles` (tasks 2235→1594), `headshots` (speakers
      1928→785), `agendaPlanner` (agenda 2406→1644), `cfpForms` (cfp
      1976→1529, and moving the shared form helpers to this leaf broke the
      cfp↔sessions cycle). Public api paths unchanged. NOT split, by
      measurement: `reviews.ts` — every candidate seam needs 10+ names from a
      shared round-resolution core; a hub, not a seam. And the "reminders out
      of tasks" premise was stale: reminders never lived in model/tasks —
      the sweep is its own top-level `convex/reminders.ts` whose public
      handlers ARE the capability; moving its helpers would trade one big
      file for 21 re-imports.)
- [x] DS vendor dir: decide the story for the 37 `.jsx`+`.d.ts` pairs
      (convert or document why vendored as-is). (DECIDED 2026-08-13:
      documented, not converted — `apps/web/src/ds/README.md`. The vendor
      ships the pair, the `.d.ts` is the published API so the boundary is
      fully typed, and conversion guarantees 37 conflicts on the next
      DesignSync.)
- [x] Replace boilerplate `convex/README.md`; dedupe workspace dependencies.
      (DONE 2026-08-13. README is real now. Deps: audited all nine
      cross-workspace names — every one is deliberate (Vercel installs only
      the apps/web subtree; the TS6/TS7 bin split), so NOTHING was hoisted,
      and `npm dedupe` was run and REVERTED: its only wins were two nested
      safe-buffer copies at the price of floating four transitive versions —
      a version bump wearing a hygiene costume. Reasoning appended to
      ARCHITECTURE.md so it isn't "cleaned up" later.)

---

# Part D — Agent access: API keys + hosted MCP server (post-challenge cycle)

The deferred half of challenge decision #14 ([docs/CHALLENGE.md](CHALLENGE.md):
UI and agents were built on the same `convex/model/*` capabilities so a later
external API is natural — see [docs/MILESTONES.md](MILESTONES.md):196,
which parked exactly this). Goal: a user creates an API key in org settings,
runs one `claude mcp add` command, and their own Claude Code / Codex operates
their events through the same authorized capability layer the UI uses.

**Shape decided 2026-08-14** (research + live spike; details in the memory
notes and the spike worktree): a **hosted MCP server served directly from
`convex/http.ts`** with **API keys as bearer headers**, an **org-settings
key-management UI**, and a **published skill**. OAuth 2.1 CIMD (claude.ai
connectors, enterprise audit) is deliberately deferred — the API-key path is
the fast lane and the same endpoint takes OAuth in front of it later.

**Spike facts (validated live on dev, 2026-08-14 — do not re-derive):**

- `createMcpHandler(factory).fetch(request)` from
  `@modelcontextprotocol/server@2.0.0` runs **directly in an `httpAction`**.
  No Hono adapter, no `HttpRouterWithHono` (that would replace the whole
  router export for zero benefit), no hand-rolled JSON-RPC. Proven with real
  `initialize` / `tools/list` / `tools/call` round-trips plus the official
  streamable-HTTP client, including live data through `ctx.runQuery`.
- Why the isolate tolerates it: Convex bundles isolate code
  `platform: "browser"`, so the SDK resolves its browser shims —
  `@cfworker/json-schema`, no eval codegen. Nothing to configure.
- Construct the handler **per request** so the server factory closes over
  that request's `ActionCtx`; the default `legacy: 'stateless'` serves both
  2025-era and 2026-07-28 clients from one tool definition.
- Landmines: never import `@modelcontextprotocol/server/stdio` from anything
  reachable by `convex/` (real Node stdio); a git worktree must mirror root
  `.env.local` or `npx convex dev --once` silently creates an anonymous
  LOCAL deployment; production must put Host/Origin validation (the SDK
  exports `hostHeaderValidationResponse` / `originValidationResponse`) and
  real auth in front of `handler.fetch`; `responseMode: 'json'` exists if
  SSE framing is ever unwanted.
- **Cleanup owed**: dev (`scintillating-heron-597`) still serves the
  unauthenticated read-only `/mcp-spike` route — the next
  `npx convex dev --once` from a clean checkout removes it. The spike code
  lives in disposable worktree `.claude/worktrees/agent-aa7b3108bc572d1c6`.

Staging rationale (SUPERSEDED 2026-08-14, see the intro: Alvaro ruled Part D
ships with the submission, so the finished branch merged to `develop` on
Aug 14 rather than after Sunday): build on a feature branch off `develop`;
the first slice (D1 + a read-only D2) is the end-to-end proof and ships
together. House rules apply unchanged: one producer per sentence in
`convex/model/*`, validators everywhere, convex-test with negative authz per
new query/mutation, DS primitives first, error text only through the
sanitization boundary. Merge bar = Part B's.

## D1 — API keys: table + caller resolution

The key model, decided: **a key acts as the user who created it, never above
that user's live role** — membership is re-resolved at use time, so a
departed teammate's keys die with their membership (a feature, not a bug; org
"service identities" are the later answer, already named in
[docs/ARCHITECTURE.md](ARCHITECTURE.md):85).

- [x] **`apiKeys` table** in `convex/schema.ts`: `keyHash` (SHA-256,
      indexed `by_hash` — the `invitations.by_token` shape), display
      `prefix` (e.g. `ssk_…last4`), `name`, `createdByUserId`, `orgId`
      scope, optional `eventId` scope, `ceiling: 'read' | 'organizer'`,
      `lastUsedAt`, `revokedAt`, optional `expiresAt`. Plaintext format
      `ssk_<random>`; shown exactly once at mint. Hashing means a DB read
      never yields a usable credential; constant-time compare is not needed
      on a hash lookup, but mint uses crypto-strength randomness
      (`convex/model/slugs.ts` is NOT the precedent — use
      `crypto.getRandomValues`).
      (DONE 2026-08-14, commit bde47b6.)
- [x] **Key capabilities** in `convex/model/apiKeys.ts` + thin
      `convex/apiKeys.ts` wrappers (org-admin gated: `requireOrgAdmin`):
      mint (returns plaintext once, stores hash), list (prefix/name/scope/
      lastUsed only — never the hash), rename, revoke. `lastUsedAt` is
      touched from the MCP path, throttled (once per ~5 min per key) so it
      isn't a write per tool call.
      (DONE 2026-08-14; 50-active-key ceiling added in review — budget decidable from one bounded probe over by_orgId_and_revokedAt.)
- [x] **`resolveCallerFromApiKey`** in `convex/lib/functions.ts`: hash the
      presented key → `by_hash` lookup → refuse revoked/expired → load the
      creating user → resolve the SAME `OrgCaller`/`EventCaller` objects the
      wrappers build, clamped by the key's `ceiling`. All writes through this
      path set `viaAgent: true` via `convex/model/audit.ts` — the Control
      Center already renders it.
      (DONE 2026-08-14; ceiling implemented as read|write INTENT per the recorded deviation above; server-side clock after codex caught a client-suppliable now.)
  - **Ceiling semantics — DECIDED DEVIATION (2026-08-14, shipped).** This
    bullet originally read "a `read` key never resolves organizer even if the
    user is one". Taken literally — downgrading `EventCaller.role` to
    `reviewer` — it contradicts D2's own tool list: `list_sessions`,
    `list_proposals`, `agenda_board`, `publish_state`, `review_progress` and
    `task_dashboard` all call `requireOrganizer` in `convex/model/*`, so a
    read key would be refused six of the ten read tools it exists for. What
    shipped instead: **`read` = the minter's live READ access with every
    write refused; `organizer` = writes allowed; both always clamped to the
    minter's live role.** The ceiling is write authority, enforced at one
    `intent: "read" | "write"` parameter on `apiKeyOrgCaller` /
    `apiKeyEventCaller` (see `assertCeilingAllows`), so a `read` key can never
    reach a mutation capability however its minter is privileged.
- [x] **Negative authz tests** (convex-test): revoked refused · expired
      refused · unknown key refused · `read`-ceiling key refused on a
      mutation capability · key of a removed member dead · event-scoped key
      refused outside its event · audit rows carry `viaAgent`.
      (DONE 2026-08-14: all listed negatives plus HTTP-boundary t.fetch suite.)

## D2 — MCP endpoint (read-only first slice)

- [x] **`/mcp` route** in `convex/http.ts` (POST/GET/DELETE → one
      `httpAction`, the spike shape): bearer-token extraction → D1
      resolution → Host/Origin validation via the SDK's exports →
      `createMcpHandler` per request. Auth failures return proper JSON-RPC
      errors; nothing but the sanitization boundary's vocabulary leaks.
      (DONE 2026-08-14; host validation fails closed to loopback without CONVEX_SITE_URL; JSON-RPC batch bodies refused so one token = one action.)
- [x] **Per-key rate limit**: a token bucket alongside `workerCalls`
      (`@convex-dev/rate-limiter`, key = apiKey id; start ~300/min). Heed
      the C2 lesson: `check()` only observes — spend in a mutation. Note
      the documented rollback caveat (a throwing call refunds its spend);
      acceptable for v1 exactly as it is for the worker.
      (DONE 2026-08-14: 300/min capacity 600, spent in mcp.authenticate once per HTTP request.)
- [x] **Curated read tools (~10, not a mirror of the ~150-function
      surface)** — each a thin call into `convex/model/*` with the resolved
      caller, JSON output, respecting the existing `readCaps` ceilings and
      surfacing their `capped` flags in the tool output: `search`
      (model/search scoped to memberships) · `list_events` · `get_event` ·
      `list_proposals` + `get_proposal` · `review_progress` ·
      `list_sessions` · `task_dashboard` · `agenda_board` · `publish_state`
      (+ diff). Tool descriptions are product docs — write them for an agent
      that has never seen StageStack.
      (DONE 2026-08-14: 11 read tools — list_task_reviews added, see D3 deviations; explicit validated projections; honest capped flags after three review rounds.)
- [x] **End-to-end proof** (the slice's exit test): a real Claude Code
      session added via
      `claude mcp add --transport http stagestack <url>/mcp --header
      "Authorization: Bearer …"` answers a real question about a seeded
      event; a revoked key observably stops it mid-session.
      (DONE 2026-08-14: proven with a real Codex client session — streamable HTTP + bearer env var — plus raw curl; Claude Code CLI blocked only by its own expired login. Revoked key refused 401 mid-session.)
- [x] **Spike cleanup**: `/mcp-spike` gone from dev (redeploy), worktree
      deleted; the MCP packages move from spike-installed to deliberate,
      exact-pinned root deps per the volatile-pins convention.
      (DONE 2026-08-14: /mcp-spike 404 on dev, worktree+branch deleted, @modelcontextprotocol/server 2.0.0 + zod 4.4.3 exact-pinned.)

## D3 — Write tools (organizer-ceiling keys only)

The dangerous half, deliberately thin. v1 allows **reversible,
non-outbound** writes only: `update_session_content` · task
`approve`/`request_changes` · `schedule_session` (agenda placement).
Explicitly NOT in v1, listed so nobody "helpfully" adds them:
`sendBulkOutreach`/`sendOneOff` (outbound email), `bulkPublish`/`setLineup`
(public surface), contact `merge` (destructive), anything minting invites or
touching membership. A per-key "allow sends/publishes" toggle is the later
door; it is not this cycle's.

- [x] Each write tool: `organizer` ceiling required, capability re-checks
      authorization in `model/*` as always, audit row `viaAgent: true`,
      negative test that a `read` key is refused.
      (DONE 2026-08-14, commit b2515ee: 4 write tools + withAgentAudit marking the capability's own rows; all negatives tested; live write smoke audited viaAgent on dev.)

**DECIDED DEVIATIONS (2026-08-14, found in implementation):** the plan's
"non-outbound" rule collides with its own tool list twice. (1)
`request_task_changes` DOES email the responsible speaker — that is
`Tasks.requestChanges`'s own M4 semantics (a change request nobody is told
about is not one), not agent-added behavior; suppressing it for agents would
fork the capability. Kept, with the tool description leading with THIS TOOL
NOTIFIES and the server instructions naming it as the single exception.
"Non-outbound" is recorded as meaning no outreach *campaigns*
(`sendBulkOutreach`/`sendOneOff` stay absent). (2) `update_session_content`
on an ALREADY-published event updates the public page at once
(`republishIfPublished`), exactly as the same edit in the web app does; it
never publishes an unpublished event. Described verbatim in the tool
description rather than papered over. Also: one read tool was added beyond
the D2 ten — `list_task_reviews` — because no other tool emits the
`taskInstances` id that `approve_task`/`request_task_changes` require;
discovery for the acting half, not scope creep.

## D4 — Key management UI + connect flow

- [x] **Org settings surface**: an "API keys" tab on
      `apps/web/src/routes/app.org.$orgSlug.tsx` (the existing
      `events | contacts | team` tab bar; org-admin gated like team
      actions). Create (name + scope + ceiling → full key shown ONCE, with
      copy button + "you won't see this again"), list with prefix/scope/
      last-used, rename, revoke with confirm. DS primitives; clipboard via
      `apps/web/src/lib/clipboard.ts`.
      (DONE 2026-08-14, commit 129c6e7: ADMIN_TABS gate shared with Team; reveal-once pinned by tests; browser-verified signed-in at 1440/375.)
- [x] **"Connect your agent" panel** next to the key list: the ready-to-
      paste `claude mcp add --transport http …` command with the
      deployment's `.convex.site` URL filled in (derive, don't hardcode),
      plus the Codex/generic streamable-HTTP equivalent. This panel is the
      minutes-to-connected moment — treat its copy as product surface, not
      docs.
      (DONE 2026-08-14: single-quoted ${STAGESTACK_MCP_KEY} env indirection probed against the installed CLI; footer states the key lives outside StageStack.)
- *Mobile*: the tab is a stacked list; the reveal-once dialog and connect
  command must be copyable at 375px (no horizontal scroll traps).

## D5 — Skill, docs, and the deferred OAuth door

- [x] **Published skill** (SKILL.md, the open Agent Skills format): teaches
      workflows over the tools — "prep a review round", "morning readiness
      sweep", "chase missing speaker tasks" — not tool syntax (the MCP
      schemas carry that). Lives in-repo (e.g. `skills/stagestack/`) so it
      ships with the public repo; users install it alongside the MCP server.
      (DONE 2026-08-14: skills/stagestack/SKILL.md — five workflows, role-aware after codex caught the reviewer path directing at organizer-only tools; refusal sentences quoted as the sanitizer actually emits them.)
- [x] **Docs page**: connect instructions (Claude Code, Codex, claude.ai
      when OAuth lands), key scoping model, rate limits, tool catalog.
      (DONE 2026-08-14: docs/AGENT_ACCESS.md + README link; every number, command and refusal sentence cross-checked against code, then re-checked by codex — six accuracy fixes applied.)
- [ ] Optional: MCP Registry listing under a DNS-verified namespace.
- **Deferred, explicitly**: OAuth 2.1 CIMD in front of the same endpoint
  (unlocks claude.ai custom connectors + per-user identity for enterprise
  audit). The API-key design must not paint over this door: auth extraction
  stays one function in front of `handler.fetch`.

## Suggested order & orchestration

D1+D2 are one workstream and one merge — the end-to-end slice proves the
whole architecture and nothing user-visible exists until D4 anyway. D3 and
D4 then run in parallel (disjoint surfaces: convex tools vs web UI). D5
last, written against whatever tool surface actually shipped. One
development agent per workstream → independent verify → codex review → fix
round → one commit, per the process that has worked for three cycles.
