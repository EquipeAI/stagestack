# PLAN — Challenge close-out + M10 slice (v4)

## STATUS: ACTIVE — started 2026-08-13, challenge hard stop Sunday 2026-08-16

The organizers' Aug 13 update (see [docs/CHALLENGE.md](docs/CHALLENGE.md)
"Post-deadline update") opened an optional working window until **Sunday,
Aug 16, 2026**. This plan has two parts. **Part A** is the overarching
challenge work: make what we built verifiably true on the judged deployments
and give the AIE team the easiest possible evaluation. **Part B** pulls a
deliberate slice of **M10 (expert efficiency)** from
[docs/MILESTONES.md](docs/MILESTONES.md) forward as feature workstreams,
shaped for the process that worked last cycle: one development agent per
workstream → independent verify → codex review → fix round → one commit.

Part A gates the eval re-run; Part B workstreams land independently and only
merge if green — an unfinished feature never blocks Sunday.

Context: [docs/CHALLENGE.md](docs/CHALLENGE.md) ·
[docs/MILESTONES.md](docs/MILESTONES.md) ·
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/BUSINESS_CONTEXT.md](docs/BUSINESS_CONTEXT.md)
Previous plans: [UX maturity cycle M8–M9](docs/PLAN-2026-08-ux-maturity.md) ·
[eval fix cycle](docs/PLAN-2026-08-eval-fix.md) ·
[original build M0–M8](docs/PLAN-2026-08-submission.md)

---

# Part A — Challenge close-out (overarching)

## A1 — Deployment truth

- [ ] **Resend webhook on `develop` (`marvelous-snail-907`) and prod
      (`healthy-lynx-620`)** — Alvaro has Resend + email open in the local
      browser. Per deployment, check both causes from the archived W1 item:
      `RESEND_WEBHOOK_SECRET` set on the Convex deployment (missing → the
      endpoint 500s loudly), and a Resend-dashboard webhook endpoint pointing
      at that deployment's own `.convex.site/resend-webhook` URL (missing →
      fails silently; Svix secrets are per-endpoint). Fix, then prove it: send
      a real email on each deployment and watch its comms-log row advance past
      "Sent — delivery unconfirmed" to Delivered.
- [ ] **`RESEND_TEST_MODE=false` confirmed on develop AND prod** — env vars do
      not mirror between deployments; a missing knob silently turns real mail
      into `failed` comms-log rows (CLAUDE.md deploy table).
- [ ] **Confirm `internal.library.backfillFormats` ran per event** on dev
      (`scintillating-heron-597`), develop, and prod (idempotent; refuses
      >1000-session events; keeps labels verbatim — the CFP format labels are
      asserted verbatim by the eval).
- [ ] **Push `develop`** (ahead of origin) so the preview deploy — what the
      evals hit — matches local; merge to `main` before Sunday so prod
      carries everything we want judged.

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
      ([audit doc](docs/reference/a11y-audit-2026-08.md)).
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
