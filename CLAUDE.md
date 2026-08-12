<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

# StageStack rules

Docs: [PLAN.md](PLAN.md) is the current work; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) holds stack decisions + version pins; [docs/CHALLENGE.md](docs/CHALLENGE.md) is the acceptance test.

## Fresh-docs-first (the rule that would have saved us an hour on day one)

Several of our dependencies are **newer than any model's training data or move faster than it** (TanStack Start, `@convex-dev/react-query`, `@clerk/tanstack-react-start`, Flue 2.x, nitro/vite). For these:

1. **Never write config or integration code from memory.** Fetch the current official docs page (or read the installed package source in `node_modules`) before writing.
2. **When template and research/docs disagree, docs win.** Templates ship stale pins (this bit us: `react-router-with-query` was 40 minors behind; the Convex template lacked the Nitro plugin that Vercel requires).
3. **When debugging framework weirdness, check patch versions FIRST.** TanStack ships daily patches; align every `@tanstack/*` package to the same current patch set and `npm dedupe` before real debugging (this fixed our hydration crash).
4. Anything mentioning Vinxi, `app.config.ts`, or an `./app` dir for TanStack Start is obsolete pre-RC content — ignore it.

## Stack landmines already stepped on (don't re-diagnose)

- Clerk on TanStack Start requires `apps/web/src/start.ts` exporting `startInstance` with `clerkMiddleware()` in `requestMiddleware`.
- Clerk components: use `<Show when="signed-in|signed-out">` — there is no `SignedIn`/`SignedOut` in `@clerk/tanstack-react-start`.
- Vercel deploys need the `nitro()` plugin in `vite.config.ts` (emits `.vercel/output`); without it the deploy 404s.
- Query integration is `@tanstack/react-router-ssr-query` (`setupRouterSsrQueryIntegration`), NOT `react-router-with-query`.
- Convex `auth.config.ts` runs in an isolate without Node types — it declares its own `process` type.
- Vite loads env from `apps/web/.env.local` (mirrored from root `.env.local`); root file is the source of truth.
- Dev server: killing the root `npm run dev` can orphan the Vite child on port 3000 — `lsof -ti :3000 | xargs kill` before restarting.
- Resend component (`@convex-dev/resend`): batch `sendEmail` has NO attachment support — .ics invites go through `sendEmailManually` + raw `fetch` to Resend `/emails` (base64 attachment, `Idempotency-Key: <emailId>`); status/webhook tracking still works. `convex/emails.ts` needs the same `declare const process` line as `auth.config.ts`.

## Flue 2.0.3 facts (from hello-agent verification; docs-first still applies)

- **Read the shipped docs**: `node_modules/@flue/runtime/docs/` (guide + reference, version-exact) — better than the website.
- No build step under tsx: `'use agent'` is only a build-scan marker. Register agents explicitly with `start({ agents: [...] })` from `@flue/runtime/node`. `start()` is once-per-process → lazy singleton in the worker (`apps/worker/src/hello-agent.ts`).
- Tool-call evidence comes from `agent.read(receipt, { onEvent })` stream chunks (`tool-input` / `tool-output`); `AgentReply` only carries `text`/`data`/`metadata`.
- `defineTool` `run` returns `{ output }` envelope (bare string is shorthand); input schema is optional Valibot — omit for zero-arg tools.
- Model slug format `provider-id/model-id` (model-id may contain slashes): `openrouter/openai/gpt-5.6-luna`. Runtime resolves `OPENROUTER_API_KEY` from env itself; agent code never touches keys. Default `thinkingLevel` is `medium`.

## Deploy targets

| Target | What | How |
|---|---|---|
| **Convex** (backend) | dev deployment `scintillating-heron-597` (team equipeai, project stagestack) | `npx convex dev` while coding; `npx convex dev --once` to push once; env vars via `npx convex env set` |
| **Convex** (staging) | `marvelous-snail-907` — backend of the **develop-branch Vercel preview** (`stagestack-git-develop-…vercel.app`), which is what killmysaas evals hit | code deploys via the Vercel preview build's `CONVEX_DEPLOY_KEY`; env vars are per-deployment and do NOT mirror from dev — new knobs (e.g. `RESEND_TEST_MODE=false`) must be set here (and on prod `healthy-lynx-620`) explicitly, or mail silently fails as `failed` comms-log rows |
| **Vercel** (web) | scope `equipe-ai`, project `stagestack`, root dir `apps/web`, prod = **https://stagestack.dev** | git push to `main` auto-deploys; manual: `vercel deploy --prod --yes` from repo root. Requires `nitro()` in vite.config (already there) |
| **exe.dev VM** (worker) | VM `stagestackdev` — `ssh -i ~/.ssh/pedro_exe_dev -o IdentitiesOnly=yes stagestackdev.exe.xyz` | `scripts/deploy-worker.sh` (pull → npm ci → restart). Service: `stagestack-worker.service` (systemd, Restart=always); logs: `journalctl -u stagestack-worker` |

Worker VM facts: repo at `/home/exedev/stagestack/app` (read-only GitHub deploy key — VM can pull, never push); secrets in `/home/exedev/stagestack/worker.env` (`CONVEX_URL`, `WORKER_SECRET`, `OPENROUTER_API_KEY`; systemd reads via `EnvironmentFile=`); Node 24.19.

Test the queue end-to-end: `npx convex run worker:enqueueTest '{"type":"ping"}'` locally, then check the VM journal for `claimed`/`done` lines.

Secrets flow: root `.env.local` is the source of truth (never committed); mirrored to `apps/web/.env.local` for Vite, to Convex via `env set`, to the VM env file via SSH stdin (never in argv/output), to Vercel via `vercel env add`.

## Conventions

- Monorepo: `convex/` at root (shared types), `apps/web` (TanStack Start), `apps/worker` (tsx runtime, exe.dev). Web imports Convex via the `@convex/*` alias.
- Versions of volatile packages are **pinned exactly** — don't loosen to `^` and don't bump casually; bump deliberately to current patches when debugging.
- Convex code: object syntax with `args`/`returns` validators always; capabilities live in `convex/model/*` with thin public wrappers (see ARCHITECTURE.md).
- Never commit secrets — the repo flips public at challenge submission; history must stay clean.
