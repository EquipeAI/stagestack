# StageStack

Open source event content, speaker and abstract management — everything between
"we're running an event" and "attendees show up". StageStack runs the call for
speakers, review and decisions, speaker operations and the agenda, then
publishes the program. It does not do registration, ticketing or attendee apps.

Hosted at [stagestack.dev](https://stagestack.dev). Hosted and self-hosted run
the same code.

## What it does

- **Call for speakers** — form builder with sections, conditional fields and a
  live preview; versioned publish; public submission wizard with autosaving
  drafts and file uploads; the form locks at the deadline.
- **Review & decisions** — individual and bulk reviewer assignment; one
  autosaving review screen with Submit & Next; reviewers see only assigned
  proposals and never contact details. Decisions stage in a private queue and
  release in one explicit step: sessions created, speakers invited, emails sent.
- **Speaker portal** — speakers confirm, decline or hand off to a manager;
  access is claimed by Clerk-verified email, no parallel passwords or tokens.
- **Speaker ops** — requirements (bios, headshots, decks, …) instantiate per
  speaker and per session; readiness is derived from facts, never set by hand;
  one consolidated reminder digest does the chasing.
- **Agenda** — drag-and-drop across rooms and tracks with 15-minute snapping;
  room clashes and speaker double-bookings block release; released slots email
  each participant an .ics invite, and date changes re-request acknowledgement.
- **Publish** — one published projection feeds the public event page
  (`/e/<slug>`), the embed (`/embed/<slug>`) and the JSON API
  (`GET /api/events/<slug>/program`), so they cannot disagree. Only Confirmed
  speakers are named; everyone else is "Speaker to be announced".
- **Import agent** — CSV import planned by an LLM, approved by an organizer,
  executed deterministically through the same capabilities as the UI.

## Repository layout

| Path | What |
|---|---|
| `convex/` | Backend: [Convex](https://convex.dev) schema and functions. Capabilities live in `convex/model/*` with thin public wrappers. |
| `apps/web` | Web app: [TanStack Start](https://tanstack.com/start), Clerk auth, deployed on Vercel. The design system is vendored at `apps/web/src/ds`. |
| `apps/worker` | Import agent: [Flue](https://flueframework.com) runtime on a plain VM, polling a Convex-backed job queue. |
| `docs/` | [ARCHITECTURE.md](docs/ARCHITECTURE.md) — stack decisions, version pins, env var reference. |

## Running it yourself

Prerequisites: Node 22.19+ (the Flue worker's floor; the web app is less
picky), plus free-tier accounts for
[Convex](https://convex.dev) (backend), [Clerk](https://clerk.com) (auth) and
[Resend](https://resend.com) (email). The import agent additionally needs an
[OpenRouter](https://openrouter.ai) key; everything else works without it.

```bash
git clone https://github.com/EquipeAI/stagestack
cd stagestack
npm install
npm run dev
```

`npm run dev` starts a Convex dev deployment and the web app on
`http://localhost:3000`.

Configuration lives in three places (full reference in
[ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- **Root `.env.local`** (mirrored to `apps/web/.env.local` for Vite):
  `VITE_CONVEX_URL`, `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`.
- **Convex deployment** (`npx convex env set`): `CLERK_JWT_ISSUER_DOMAIN`,
  `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SITE_URL`, `WORKER_SECRET`.
- **Worker** (`apps/worker`, only for the import agent): `CONVEX_URL`,
  `WORKER_SECRET`, `OPENROUTER_API_KEY`.

Two setup notes: Clerk needs a JWT template named `convex`, and the Resend
component starts in `testMode` — flip it deliberately when you want real email.

Tests: `npm test` (Vitest against the Convex functions via `convex-test`).

## License

[MIT](LICENSE) — copyright (c) 2026 EquipeAI LTDA.
