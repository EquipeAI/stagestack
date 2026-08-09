# StageStack — Architecture

Stack researched and pinned Aug 8, 2026 (all facts below verified against current docs; versions noted). Principle: managed infrastructure everywhere so the 4 remaining days go into product.

## System shape

```
┌─────────────────────┐         ┌──────────────────────────────┐
│  Vercel             │         │  Convex (source of truth)     │
│  TanStack Start     │◄───────►│  DB · functions · file storage│
│  UI + public pages  │  live   │  scheduler/crons · Resend     │
│  Clerk components   │ queries │  component · HTTP actions     │
└─────────────────────┘         └──────────────┬───────────────┘
                                               │ WebSocket (ConvexClient)
        Clerk ──JWT (template "convex")──┐     │ jobs table subscription
        auth, orgs, sessions             │     ▼
                                ┌────────┴─────────────────────┐
                                │  exe.dev VM (always-on)       │
                                │  Node worker · systemd        │
                                │  Flue 2.x agents (Import…)    │
                                └───────────────────────────────┘
```

- **Convex** is the database, API layer, and job scheduler. Reactive queries give the speaker-ops dashboard, abstracts table, and agenda views real-time updates for free — requirement #6 falls out of the infrastructure.
- **TanStack Start on Vercel** (chosen over Next.js and SvelteKit after research — see "Frontend framework" below): the Convex+Clerk+Start triangle is officially documented by Convex; typed URL search params + TanStack Table fit the table-heavy admin surface; `useSuspenseQuery(convexQuery(...))` gives SSR-then-live-WebSocket so public pages get real SSR/OG while the dashboard stays reactive.
- **Clerk** for identity/sessions/org membership (per BUSINESS_CONTEXT boundary: StageStack owns all domain authorization). Convex Auth is still beta; Clerk is the officially recommended production path.

  Dev and production are **separate Clerk instances with separate user pools** —
  accounts do not migrate, so switch before real users sign up, not after. Two
  things do *not* clone from dev when you create the production instance: SSO
  connections/Integrations/Paths, and — the one that silently breaks sign-in —
  **social credentials**. Clerk's shared Google OAuth credentials are
  development-only; production needs your own Google Cloud OAuth client
  (authorized origins `https://stagestack.dev` + `https://www.stagestack.dev`,
  redirect URI `https://clerk.stagestack.dev/v1/oauth_callback`), and that
  client must be published "In production" or it's capped at 100 listed test
  users. Also set **Paths → Home URL**, or the OAuth callback lands on the
  Account Portal and never returns to the app.
- **exe.dev VM** runs the long-lived Node worker: `ssh exe.dev new`, systemd unit with `Restart=always`, outbound-only (no inbound needed). Persistent disk holds Flue's durable session DB.
- **Flue 2.x** (`@flue/runtime`, Node ≥22.19) embedded in the worker via `start()` + `dispatch()` — no HTTP server. Powers the Import agent.

## The capability layer (the load-bearing decision)

Every meaningful read/action is one authorized function in `convex/model/*.ts` (plain TS, takes `ctx` + a resolved caller context). Three thin adapter layers call the same model functions:

1. **Public Convex functions** (`convex/*.ts`) — new object syntax with `args`/`returns` validators, wrapped by `customQuery`/`customMutation` helpers (`convex-helpers`) that resolve `{ user, org, event, role }` once (`orgQuery`, `eventMutation`, …).
2. **HTTP actions** (`convex/http.ts`, served on `.convex.site`) — public read API (published agenda/speakers/sessions) with `corsRouter`; Resend webhook.
3. **Agent tools** (worker) — Flue `defineTool` wrappers that invoke the same capabilities with the initiating user's authority (see Worker auth).

This is how the docs' invariant ("UI and agents call the same authorized capability") becomes literal, and the public read API is a projection, not a rewrite.

## Frontend framework (decided Aug 8 after three-way research)

**TanStack Start** (`@tanstack/react-start` 1.168.x + `@tanstack/react-router` 1.170.x). Key packages: `@convex-dev/react-query` (0.1.0 — the least-mature link, officially maintained), `@tanstack/react-query`, `convex/react-clerk` (`ConvexProviderWithClerk`), `@clerk/tanstack-react-start` (1.4.x), dnd-kit for the agenda builder.

**How versions are actually pinned** (the plan said "pinned exactly"; the tree says something narrower, and the tree wins): the load-bearing, least-mature packages carry EXACT pins — `convex`, `@convex-dev/react-query`, `@convex-dev/resend`, `@convex-dev/rate-limiter`, `convex-helpers`, `@tanstack/react-query`, dnd-kit, `@flue/runtime`, `vitest`. The TanStack Start/Router packages, React and Vite carry caret ranges, because Start ships several times a day and pinning it exactly means a manual bump per patch; `package-lock.json` is the reproducible pin for those, so `npm ci` (what CI and every deploy runs) installs one exact tree. Node floor: `>=22.19` in the root `package.json` `engines` — Flue's floor, matched by CI's `node-version: '22'`. TanStack Table is not a dependency at all: the admin tables are plain DS components, so the "pin Table to v8" decision never had to be taken.

- Convex's official Convex+Clerk+Start guide is the wiring source of truth (server `auth()`→`getToken()`, `convexQueryClient.serverHttpClient?.setAuth(token)` in root `beforeLoad`, `ConvexProviderWithClerk` client-side).
- Saved views = table state serialized into typed/validated URL search params (`validateSearch`) — shareable URLs for free.
- Public pages SSR via route loaders + `useSuspenseQuery(convexQuery(...))`, resuming as live WebSocket subscriptions after hydration.
- Scaffold from the official template/quickstart; **never let codegen write Start config from memory** (pre-RC tutorials with Vinxi/`./app` dir are obsolete).
- Why not Next.js: with Convex the data layer goes unused (Next reduces to router+shell), plus 2025–26 CVE history on its server surface and caching-model churn — complexity tax without benefit here. Why not SvelteKit: viable (official `convex-svelte` exists), but Clerk requires a community single-maintainer SDK + ~40 lines of DIY auth glue, and the admin-table ecosystem is thinner. React+shadcn is also the most AI-codegen-fluent UI stack, which matters when AI writes most of the code.

## Convex specifics (current best practice, not old-tutorial style)

- Function syntax: `query({ args: {...}, returns: v..., handler })` — validators everywhere. Table-name-first db calls (`ctx.db.get("events", id)`).
- **Auth**: Clerk JWT template named `convex`; `CLERK_JWT_ISSUER_DOMAIN` env var on the deployment; `convex/auth.config.ts` provider entry. Identity via `ctx.auth.getUserIdentity()`; org claims via custom JWT claims if needed (StageStack's own `members` table remains authoritative).
- **Public CFP submission** (contract settled in M1, matching MILESTONES step order): the wizard's Welcome/landing pages are public *reads*; every write happens after the Clerk account step, so drafts belong to their author from the first keystroke and no anonymous-draft claim flow exists. The **Rate Limiter component** guards abuse-prone authenticated endpoints (e.g. upload-URL minting).
- **Files** (headshots/slides): `ctx.storage.generateUploadUrl()` → client POST → store `v.id("_storage")` on the doc; serve via `storage.getUrl` (fine for headshots) or HTTP-action proxy if access-controlled (≤20MB).
- **Email**: `@convex-dev/resend` component. Durable queued sends, exactly-once idempotency, delivery events via webhook (`https://<deployment>.convex.site/resend-webhook`) feeding our per-contact comms log — delivery state was already in the product spec, and the component hands it to us. Env: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_TEST_MODE`, `MAIL_FROM`. Hourly cleanup cron.
  - **Send mode and sender identity are env vars, not constants** (M14, `convex/emails.ts`). `resendTestMode()` keeps the component in test mode — where it accepts *only* Resend's own test addresses and throws inside the sending mutation for anyone else — unless `RESEND_TEST_MODE` is explicitly `false`/`0`/`no`/`off`; any other value, including a typo, leaves test mode ON, because the cost of guessing wrong is real mail to real people from a domain the deployment may not own. **`RESEND_TEST_MODE` is currently unset on `prod:healthy-lynx-620`, so production sends no real email** — deliberate, so the Convex cutover couldn't start mailing speakers as a side effect. Set it to `false` when you actually want mail to leave. `mailFrom()` reads `MAIL_FROM` (default `StageStack <hello@stagestack.dev>`) and is the single source of truth for the From on both the batch path (`model/comms.ts`) and the raw-API calendar path. The hosted deployment therefore sets `RESEND_TEST_MODE=false` and `MAIL_FROM` explicitly — the walking skeleton's real delivery is opt-in, not the default a clone inherits. Both are read per send (a getter on `resend.config.testMode`), so flipping the var takes effect on the next send instead of the next isolate.
  - **Bulk mail & unsubscribe (M15)**. `sendLoggedEmail` attaches `List-Unsubscribe` to bulk/nudge kinds only — `manual.oneoff` (organizer broadcasts, up to `MAX_AUDIENCE` recipients) and `reminder.*` (the digests) — classified by `isBulkKind()` off the machine `kind`, so no call site can forget. Transactional lifecycle mail (invitations, decisions, calendar invites/updates) deliberately carries no opt-out: it is a one-to-one consequence of something the recipient's organizer did, and an unsubscribe link on it offers to break a flow the recipient still needs. The header is `mailto:` (the event's `replyTo`, else the `MAIL_FROM` address) and `List-Unsubscribe-Post` is omitted, because RFC 8058 one-click advertises an HTTPS POST endpoint that honours the request automatically — and a request-accepting endpoint with no suppression check behind it is worse than no header at all.
    - *What the automated per-event opt-out needs, when it is wanted*: (1) a `suppressions` table — `{ orgId, eventId?, email (normalized), kind?, createdAt, source: mailto|oneclick }` with a `by_eventId_and_email` index; (2) one check at the top of `sendLoggedEmail` — the single write path — skipping bulk kinds for a suppressed address while still letting transactional mail through, and recording the skip in the comms log so organizers see *why* nobody was reached; (3) only then an `http.ts` `POST /unsubscribe/:token` route with an HMAC token over `(eventId, email)` signed with a deployment secret (never a raw email in the URL), plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Steps 1–2 are the product decision; step 3 is only the transport.
  - *Named alternative behind the same boundary*: **Cloudflare Email Service** (public beta Apr 2026) — REST API callable from Convex, arbitrary recipients after domain onboarding, attachments, lifecycle events via Cloudflare Queues (HTTP pull). Not chosen for v1: unpublished "conservative" beta daily quotas land exactly on judging days, and delivery events would need a hand-built Queues consumer vs. the Resend component's built-in webhook→comms-log path. Swappable post-beta for an all-Cloudflare posture.
- **Reminders**: one-offs via `ctx.scheduler.runAfter/runAt` (cancellable through `_scheduled_functions`); recurring consolidated sweeps via `crons.ts`.
- **Components in use**: resend, rate limiter; workpool/workflow/aggregate/migrations available if needed — don't hand-roll these.
- Free tier (1M calls, 0.5GB DB, 1GB files) is ample for the demo; Pro is $25 if we hit walls.

## Worker & agents

- **Queue**: `jobs` table in Convex (`type`, `payload`, `status: queued/claimed/running/done/failed`, `initiatedBy`, timestamps, result). Worker uses `ConvexClient` (WebSocket) with `onUpdate(api.worker.pending, { secret })` — push, not polling; claims via mutation (compare-and-set on status).
- **Worker auth (v1 judgment call)**: worker-scoped public functions guarded by a shared secret in Convex env vars. Deploy keys are not a documented path for function calls, and Custom JWT service identity is the *correct* later answer — documented, deferred. The worker executes each job **as the initiating user** recorded on the job row; model-layer authorization re-checks on every call (the agent never gets standing super-access, per spec).
- **Flue Import agent**: v2 hooks API only (2.0 shipped Jul 31, 2026 — ignore all pre-2.0 `createAgent` tutorials). Valibot tool schemas; structured plan output via `options.result`; **confirm gate = conditional tool mounting** (`execute_import` is only mounted after the organizer approves the plan — structural enforcement of the spec's confirmation boundary). CSV/XLSX parsed in Node (`xlsx`), text seeded into the in-memory sandbox for agent inspection. Durable sessions on the VM's persistent disk (SQLite file).
- **LLM**: **OpenRouter** gateway, model **`openai/gpt-5.6-luna`** — `useModel('openrouter/openai/gpt-5.6-luna', { thinkingLevel: 'high' })`, `OPENROUTER_API_KEY` on the VM. Flue ≥2.0.1 required (thinking-level mapping fix). Usage rules from research:
  - **Chunk spreadsheets** — Luna's documented weakness is long-context recall (MRCR 41.3%); the worker parses files in Node and feeds the agent bounded chunks, never whole dumps.
  - **Two-phase effort**: `high` thinking for the planning phase (column mapping → proposed records); drop to `low`/`medium` for post-confirmation mechanical execution — per-step reasoning latency is the binding constraint, not cost (~$0.05–0.25/import session at $0.20/$1.20 per M).
  - Prefer OpenRouter **Exacto** routing (providers ranked by measured tool-calling accuracy); verify Flue/Pi passes `reasoning_details` back across tool turns (known silent-degradation trap with reasoning models via OpenRouter).
- **Deploy**: git pull + `systemctl restart stagestack-worker`; logs via `journalctl`.

## Calendar invites (.ics)

Generated in Convex (pure TS, `METHOD:REQUEST`, stable `UID` per session+participant, `SEQUENCE` bump on reschedule, `METHOD:CANCEL` on withdrawal/cancellation) and sent via Resend as `text/calendar` attachment/alternative part. **Must verify in walking skeleton**: the Resend component's attachment support — if the component's `sendEmail` doesn't expose attachments, fall back to raw Resend API from a Convex action for calendar sends only (keep the comms-log write path identical).

## Repo layout (npm workspaces)

```
stagestack/
  convex/            # schema, model/ (capabilities), public functions, http, crons
  apps/web/          # TanStack Start (Vercel) — organizer app, portal, public pages
  apps/worker/       # exe.dev Node worker + Flue agents (imports ../../convex/_generated)
  docs/
  PLAN.md
```

## Environments & config

- Convex: `dev` + `prod` deployments (`npx convex dev` / `deploy`). Vercel preview/prod point at the matching deployment.

  **Live topology** (verified Aug 2026 — deployment names are not secrets, the keys behind them are):

  | Branch | Vercel env | Convex deployment | Clerk | URL |
  |---|---|---|---|---|
  | `main` | Production | `prod:healthy-lynx-620` | production (`pk_live`, issuer `https://clerk.stagestack.dev`) | `stagestack.dev` |
  | `staging` | `staging` (custom env) | `staging` = `charming-mosquito-897` | development (`pk_test`) | `staging.stagestack.dev` |
  | `develop` | Preview, pinned to the branch | `develop` = `marvelous-snail-907` | development (`pk_test`) | `stagestack-git-develop-equipe-ai.vercel.app` |
  | any other branch | Preview | *none* — frontend only, reads `dev:scintillating-heron-597` | development (`pk_test`) | per-deployment URL |
  | — | Development (`vercel dev`) | `dev:scintillating-heron-597` | development (`pk_test`) | localhost |

  `staging` and `develop` are **prod-type Convex deployments inside the same
  project** (`npx convex deployment create <name> --type prod`), not preview
  deployments: preview deployments are beta and temporary, and staging is
  supposed to be the thing you trust right before prod. They have their own
  data, their own env vars, and nothing expires them.

  Staging and develop share the **development** Clerk instance, so they also
  share its user pool with local dev — a test user created on staging shows up
  in dev. That is the trade for not paying for a third Clerk instance.

  `staging.stagestack.dev` is behind Vercel's deployment protection (team SSO).
  Automation gets through with the `x-vercel-protection-bypass` header; the
  token is in the project's Protection Bypass settings.

  Local `npm run dev` uses the dev deployment via root `.env.local`; nothing local touches prod.
- Env vars — the authoritative, commented list is [`.env.example`](../.env.example) (every variable the code actually reads, grouped by where it has to be set). Summary:

  | Where | Variables | Notes |
  |---|---|---|
  | Convex deployment (`npx convex env set`) | `CLERK_JWT_ISSUER_DOMAIN`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_TEST_MODE`, `MAIL_FROM`, `SITE_URL`, `WORKER_SECRET` | `RESEND_TEST_MODE`/`MAIL_FROM` per the Email section above. Without `SITE_URL` every emailed link points at `https://stagestack.dev`. |
  | Vercel project | `VITE_CONVEX_URL`, `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` per scope + `CONVEX_DEPLOY_KEY` on Production, `staging` and Preview@`develop` | Scopes are Production / `staging` (custom env) / Preview / Preview pinned to a branch / Development. A var spanning two scopes is ONE entry — replacing it for one scope silently deletes the other, so re-audit every scope after editing. Branch-pinned Preview vars can't be added by `vercel env add` (its branch prompt ignores piped input); use `POST /v10/projects/{id}/env` with `target` + `gitBranch`. |
  | Web (root `.env.local`, mirrored to `apps/web/.env.local`) | `VITE_CONVEX_URL`, `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, optionally `SITE_URL` | On Vercel these are project env vars. |
  | Worker VM (`EnvironmentFile=`) | `CONVEX_URL`, `WORKER_SECRET`, `OPENROUTER_API_KEY` | Import agent only. |
  | `scripts/deploy-worker.sh` | `WORKER_SSH_HOST` (required), `WORKER_SSH_IDENTITY`, `WORKER_APP_DIR`, `WORKER_SERVICE` | The script refuses to run rather than guess a host/key. |

  `SITE_URL` is read in **two** runtimes, which is easy to miss: the Convex deployment builds emailed links from it (`siteUrl()` in `convex/model/comms.ts`), and the web server uses it in `apps/web/src/lib/origin.ts` as the origin fallback when a request carries no usable `X-Forwarded-Host`/`Host` (prerender, scripts, tests). Same value, two places to set it — a self-host that sets it only on Convex still gets correct emails but can advertise the wrong `og:url` on a hostless render.
- **Domain: `stagestack.dev`** (registered via Vercel, so app DNS is zero-config). Serves three roles: app URL (judges see `https://stagestack.dev`), Clerk production instance (Clerk doesn't work on `*.vercel.app`), and Resend sending domain (send from `@stagestack.dev` or `@mail.stagestack.dev`; add Resend's DKIM/SPF records in Vercel DNS immediately — propagation is the only slow step in the stack).

  DNS lives in Vercel (`vercel dns ls stagestack.dev`). Clerk's production
  instance needs **five** CNAMEs — `clerk`, `accounts`, `clkmail`,
  `clk._domainkey`, `clk2._domainkey` — all present and verified; SSL is issued
  automatically once they resolve.

## Deploying

Work on `develop`, merge to `staging`, merge to `main`. Each branch deploys its
own frontend *and its own Convex backend* in one step, so code and schema never
drift apart:

```
develop ──▶ develop backend      (look at your work)
staging ──▶ staging backend      (rehearse the release)
main    ──▶ production           (the real thing)
```

GitHub Actions (`.github/workflows/ci.yml`) runs typecheck + both test suites on
every push, but it gates nothing on Vercel's side — a red CI run and a green
deploy can coexist. Read CI before assuming a push was safe.

Vercel build command (one command, all environments):

```
cd ../.. && if [ -n "$CONVEX_DEPLOY_KEY" ]; then \
  npx convex deploy --typecheck=disable --check-build-environment disable \
    --cmd-url-env-var-name VITE_CONVEX_URL --cmd 'npm run build --workspace apps/web'; \
else npm run build --workspace apps/web; fi
```

Every part of it is load-bearing, and most were learned by breaking something:

- **`cd ../..` is not optional.** Vercel's Root Directory is `apps/web`, but
  `convex/` lives at the repo root. Run `convex deploy` from `apps/web` and it
  finds no functions, concludes you deleted them all, and **unmounts every
  component and drops every index on the target deployment** — a
  successful-looking build that empties the backend. This happened once, to
  production; the recovery is `npx convex deploy` from the repo root, which
  remounts everything (documents are untouched — only functions and indexes are
  lost).
- **The `if` guard** is what lets an ordinary feature branch build at all. The
  deploy key only exists on Production, `staging` and `develop`; without the
  guard every other branch fails at the Convex step. With it, such a branch
  builds frontend-only against the shared dev deployment.
- **`--check-build-environment disable`** turns off Convex's refusal to push a
  prod-*type* key from a non-production build environment. That guard exists to
  stop a preview build from writing to prod, and it is right to have — but
  `staging` and `develop` are prod-type deployments used from non-production
  Vercel environments on purpose. The cost of disabling it: if the *production*
  key were ever pasted into a preview scope, nothing would catch it. Check the
  scope, not the guard.
- **`--cmd-url-env-var-name VITE_CONVEX_URL`** makes the frontend point at
  whichever backend this build just deployed to, instead of trusting a
  hand-set env var to agree. Without it, `convex deploy` run from the repo root
  exports `CONVEX_URL` (no `VITE_` prefix), Vite ignores it, and you can ship a
  staging frontend wired to the dev backend.
- **`--typecheck=disable`** skips a *duplicate* check, not a real one. Vercel
  installs from `apps/web`, so the convex test files' types are missing and
  `tsc` fails there. CI already typechecks the whole repo on the same commit.
- **Deploy keys** need `deployment:deploy` **and** `deployment:data:view` —
  deploy reads existing data to validate the schema, so a deploy-only key fails
  with a permissions error. Create them with
  `npx convex deployment token create <name> --deployment <ref>`; there is no
  need to visit the dashboard.

Verifying a deploy — a green build is not proof:

```bash
vercel inspect --logs <url> | grep -E "Unmounted component|Deleted table indexes"   # must be empty
npx convex function-spec --deployment <prod|staging|develop> | grep -c '"identifier"'  # expect 134
```

**No backups are configured.** Convex snapshots are opt-in (dashboard →
Backup & Restore); a bad schema change now reaches prod without a human, so this
is worth turning on before real data lands.

**Branch protection is not enabled** — GitHub rulesets need Pro for a private
repo, so nothing mechanically stops a push straight to `main`. The
develop → staging → main order is currently a convention, not a rule.

## Walking-skeleton validation checklist (before real feature work)

1. Clerk sign-in round-trips into a Convex function (`getUserIdentity()` non-null) from Vercel deploy.
2. Resend real-mode email (testMode off) delivered to an external Gmail inbox, webhook event recorded in Convex.
3. .ics attachment path verified (component or raw-API fallback) — invite appears natively in Gmail calendar UI.
4. exe.dev worker claims a job via `onUpdate` subscription and writes a result back (systemd restart survives reboot).
5. Flue 2.x hello-agent runs one tool call inside the worker.
6. Public unauthenticated mutation works from an incognito browser (CFP path).

## Known bets & fallbacks

| Bet | Risk | Fallback |
|---|---|---|
| Flue 2.0 (1 week old) | API churn/bugs | Import agent is day-4 scope; raw OpenAI-compatible tool loop via OpenRouter (~100 lines) in the same worker |
| TanStack Start "RC-in-name" + `@convex-dev/react-query` 0.1.0 | Adapter bugs, codegen emitting dead beta APIs | Exact version pins; scaffold from official Convex+Clerk template; current docs in context during codegen |
| GPT-5.6-Luna long-context recall cliff | Import agent misreads large files | Node-side parsing + bounded chunks by design; escalate to `gpt-5.6-terra` for large files if needed |
| Resend component attachments for .ics | May not be exposed | Raw Resend API from Convex action (attachments are supported by Resend itself) |
| Shared-secret worker auth | Not "proper" service identity | Documented as v1 judgment call; Custom JWT provider is the designed upgrade path |
| No Cloudflare/Airtable/Forge bonuses | Leave all stack bonus points | Deliberate: velocity + reactive dashboard beat "mild" bonuses (decision log #17) |
