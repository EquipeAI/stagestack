# `convex/` — the backend

Everything StageStack knows how to do lives here. The load-bearing rule is that
a capability is written **once** and called by every surface: the organizer app,
the speaker portal, the public read API and the agent tools all reach the same
function. See [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md#the-capability-layer-the-load-bearing-decision)
for why, and [`_generated/ai/guidelines.md`](_generated/ai/guidelines.md) for the
Convex API rules — those override anything a model thinks it remembers about
Convex.

## What lives where

| Path | What it is |
|---|---|
| `model/*.ts` | **The capabilities.** Plain TypeScript taking `ctx` plus an already-resolved caller. All authorization, all business rules, all reads and writes. This is where the work happens. |
| `*.ts` (top level) | **Thin public wrappers.** `query`/`mutation`/`action` declarations with `args` and `returns` validators that resolve the caller and delegate to `model/`. They should read as one call plus its contract. |
| `http.ts` | HTTP actions on `.convex.site` — the public read API, headshot ingestion, the Resend webhook. Public-facing, so it is the one place that decides what error text reaches the open internet. |
| `schema.ts` | Tables, indexes, and the validators for stored shapes. |
| `lib/` | Backend-only helpers: the `customQuery`/`customMutation` wrappers (`functions.ts`), shared validators (`validators.ts`), URL helpers, and the per-event read ceilings (`readCaps.ts`). |
| `shared/` | Pure logic and validators shared with `apps/web` — parsers, form definitions, view params, schedules. No `ctx`, no database. |
| `crons.ts`, `reminders.ts` | Scheduled sweeps. |
| `*.test.ts` | `convex-test` suites, one per module, run with `npx vitest run` from the repo root. |

## Conventions

- **Object syntax and validators, always.** `query({ args: {...}, returns: v...., handler })` — on every function, including internal ones. Table-name-first db calls: `ctx.db.get("events", id)`.
- **One producer per sentence.** A rule, a message, a cap or a shape is declared in exactly one place and imported everywhere else. If you find yourself retyping a constant or a user-facing sentence, that is the bug.
- **Authorization lives in `model/`, not in the wrapper.** Every mutating capability re-checks its own caller, because the portal and the organizer console both call straight into it.
- **Bounded reads only.** Ceilings come from `lib/readCaps.ts`. Use `takeAll` when a truncated read would be a wrong answer (it refuses), and `takeCapped` when it would merely be a shorter one (it reports `capped`). Never a bare `.take(n)`.
- **Never `v.any()` for a shape we control.** If we write it, we can validate it.
