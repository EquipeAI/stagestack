---
name: stagestack-design
description: Use this skill to generate well-branded interfaces and assets for StageStack, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping. Trigger whenever building or styling ANY StageStack UI (routes, components, emails, mocks, marketing pages).
user-invocable: true
---

Read the README.md file within this skill — it is the full design-system brief
(voice, colour, type, spacing, iconography, logo, rules of thumb).

The design system is **vendored in this repo** at `apps/web/src/ds/`:

- `apps/web/src/ds/styles.css` — single CSS entry point (tokens + component CSS).
  Already imported globally via `apps/web/src/styles/app.css`.
- `apps/web/src/ds/index.ts` — the ONLY import surface for components:
  `import { Button, StatusPill, Card, ... } from '~/ds'`.
  Never import from `~/ds/components/...` internals (enforced by
  `apps/web/.oxlintrc.json`; run `npm run lint:ds` in `apps/web`).
- `apps/web/src/ds/tokens/*.css` — design tokens. Style with `var(--...)`
  tokens, never raw hex/px values.
- `apps/web/src/ds/assets/` — logo lockups, logomark, favicon, brand icons.
  Favicons in `apps/web/public/` are generated from `assets/favicon.svg`.
- Each component has a `.d.ts` beside it documenting its exact props —
  those props are the entire API; do not invent new ones.

For visual artifacts (slides, mocks, throwaway prototypes), copy assets out
and create static HTML files. For production code, use the vendored
components and tokens.

The full Claude Design project (guideline specimen cards, ui_kits click-through
prototypes for organizer-app / speaker-portal / public-event / marketing-site,
per-component prompt docs, Lucide source SVGs) lives at
https://claude.ai/design/p/3047afca-cf73-49aa-bf6e-5de2f789d6b5 — readable via
the DesignSync tool (projectId `3047afca-cf73-49aa-bf6e-5de2f789d6b5`).
