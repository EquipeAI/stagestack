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
- **exe.dev VM** runs the long-lived Node worker: `ssh exe.dev new`, systemd unit with `Restart=always`, outbound-only (no inbound needed). Persistent disk holds Flue's durable session DB.
- **Flue 2.x** (`@flue/runtime`, Node ≥22.19) embedded in the worker via `start()` + `dispatch()` — no HTTP server. Powers the Import agent.

## The capability layer (the load-bearing decision)

Every meaningful read/action is one authorized function in `convex/model/*.ts` (plain TS, takes `ctx` + a resolved caller context). Three thin adapter layers call the same model functions:

1. **Public Convex functions** (`convex/*.ts`) — new object syntax with `args`/`returns` validators, wrapped by `customQuery`/`customMutation` helpers (`convex-helpers`) that resolve `{ user, org, event, role }` once (`orgQuery`, `eventMutation`, …).
2. **HTTP actions** (`convex/http.ts`, served on `.convex.site`) — public read API (published agenda/speakers/sessions) with `corsRouter`; Resend webhook.
3. **Agent tools** (worker) — Flue `defineTool` wrappers that invoke the same capabilities with the initiating user's authority (see Worker auth).

This is how the docs' invariant ("UI and agents call the same authorized capability") becomes literal, and the public read API is a projection, not a rewrite.

## Frontend framework (decided Aug 8 after three-way research)

**TanStack Start** (`@tanstack/react-start` 1.168.x + `@tanstack/react-router` 1.170.x, **versions pinned exactly** — daily release cadence). Key packages: `@convex-dev/react-query` (0.1.0 — the least-mature link, officially maintained), `@tanstack/react-query`, `convex/react-clerk` (`ConvexProviderWithClerk`), `@clerk/tanstack-react-start` (1.4.x), **TanStack Table pinned to v8** (v9 shipped Aug 4, 2026 — too fresh), shadcn/ui, dnd-kit for the agenda builder.

- Convex's official Convex+Clerk+Start guide is the wiring source of truth (server `auth()`→`getToken()`, `convexQueryClient.serverHttpClient?.setAuth(token)` in root `beforeLoad`, `ConvexProviderWithClerk` client-side).
- Saved views = table state serialized into typed/validated URL search params (`validateSearch`) — shareable URLs for free.
- Public pages SSR via route loaders + `useSuspenseQuery(convexQuery(...))`, resuming as live WebSocket subscriptions after hydration.
- Scaffold from the official template/quickstart; **never let codegen write Start config from memory** (pre-RC tutorials with Vinxi/`./app` dir are obsolete).
- Why not Next.js: with Convex the data layer goes unused (Next reduces to router+shell), plus 2025–26 CVE history on its server surface and caching-model churn — complexity tax without benefit here. Why not SvelteKit: viable (official `convex-svelte` exists), but Clerk requires a community single-maintainer SDK + ~40 lines of DIY auth glue, and the admin-table ecosystem is thinner. React+shadcn is also the most AI-codegen-fluent UI stack, which matters when AI writes most of the code.

## Convex specifics (current best practice, not old-tutorial style)

- Function syntax: `query({ args: {...}, returns: v..., handler })` — validators everywhere. Table-name-first db calls (`ctx.db.get("events", id)`).
- **Auth**: Clerk JWT template named `convex`; `CLERK_JWT_ISSUER_DOMAIN` env var on the deployment; `convex/auth.config.ts` provider entry. Identity via `ctx.auth.getUserIdentity()`; org claims via custom JWT claims if needed (StageStack's own `members` table remains authoritative).
- **Public CFP submission**: public mutations without auth for the wizard steps + **Rate Limiter component** to protect them. Account step uses Clerk verified email; draft is linked to the account after sign-in.
- **Files** (headshots/slides): `ctx.storage.generateUploadUrl()` → client POST → store `v.id("_storage")` on the doc; serve via `storage.getUrl` (fine for headshots) or HTTP-action proxy if access-controlled (≤20MB).
- **Email**: `@convex-dev/resend` component. Durable queued sends, exactly-once idempotency, delivery events via webhook (`https://<deployment>.convex.site/resend-webhook`) feeding our per-contact comms log — delivery state was already in the product spec, and the component hands it to us. **`testMode` defaults to `true`; flip deliberately.** Env: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`. Hourly cleanup cron.
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
- Env vars — Convex deployment: `CLERK_JWT_ISSUER_DOMAIN`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `WORKER_SECRET`. Vercel: `VITE_CONVEX_URL`, Clerk publishable/secret keys (exact names per the official template). Worker VM: `CONVEX_URL`, `WORKER_SECRET`, `OPENROUTER_API_KEY`.
- **Domain: `stagestack.dev`** (registered via Vercel, so app DNS is zero-config). Serves three roles: app URL (judges see `https://stagestack.dev`), Clerk production instance (Clerk doesn't work on `*.vercel.app`), and Resend sending domain (send from `@stagestack.dev` or `@mail.stagestack.dev`; add Resend's DKIM/SPF records in Vercel DNS immediately — propagation is the only slow step in the stack).

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
