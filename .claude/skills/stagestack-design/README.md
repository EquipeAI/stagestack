# StageStack Design System

StageStack is an **open source event content, speaker & abstract management platform** — everything between "we're running an event" and "attendees show up": call for speakers, review, speaker operations, agenda building, and the published program that comes out the other end. It sits at the *speaker-ops pole* of its market (with Sessionboard, Lineup Ninja, Sessionize) rather than the academic peer-review pole (Oxford Abstracts, Ex Ordo), and it is standalone best-of-breed rather than an all-in-one suite (Cvent, Bizzabo). It does **not** do registration, ticketing or attendee apps.

Design partner: **AI Engineer** (World's Fair, ~7,000 attendees, 9 tracks, 5 stages, ~500 CFP submissions at ~6% acceptance, run by a very small team). Every fixture in this system uses their real operating numbers.

**Because no prior visual identity existed, this system defines one.** The logo was designed from scratch for this project; it is not a recreation of any existing mark. Icons are Lucide (ISC); brand marks are Simple Icons (CC0).

---

## Content fundamentals

StageStack's voice is **an operations tool that tells you the truth about state**. It is the opposite of event-industry marketing language: no "supercharge", no "seamless", no exclamation marks, no emoji anywhere in the product.

**Rules**

- **Name the state, exactly.** The product's vocabulary is fixed and title-cased when it is a state: Draft, Submitted, Under Review, Accepted, Declined, Deferred, Withdrawn, Awaiting Response, Confirmed, Awaiting Acknowledgement, Acknowledged, Conflict, Provided, Awaiting Review, Approved, Changes Requested, Overdue, Not Applicable, Ready, Needs Attention, Blocked, Cancelled, Published, Unpublished. Never invent a synonym: a proposal is *Declined*, never "rejected"; work is *Provided*, not "done".
- **Sentence case everywhere else.** Buttons, headings, labels, table columns (columns are uppercase-tracked in *style*, not in the string). "Release decisions", not "Release Decisions".
- **Buttons are verbs that repeat in the confirmation.** "Publish agenda" → dialog titled "Publish agenda?" → confirm button "Publish agenda". Never "OK", never "Submit" alone.
- **State the consequence and the audience before the irreversible thing.** "9 acceptances and 3 declines become visible to submitters, and their emails send immediately." Who sees it, what leaves the building, when.
- **Second person for the person acting, third person for other people.** Speaker portal: "Confirm you will speak…", "Your tasks". Organizer app: "3 speakers have not acknowledged their slot". The product never says "I"; agent-assisted copy is the one exception — the Import flow speaks as the assistant: *"Here is what I understood from wf26-invited-speakers.csv."*
- **Empty states describe what will fill them.** "Your CFP is published. Submissions appear here the moment they arrive."
- **Numbers are concrete and mono.** "Showing 8 of 512", "closes 14 Apr, 23:59 PDT", "4/6". Never "a few", never a bare percentage where a count exists.
- **Timezone is always stated.** Event time is authoritative and labelled (`PDT`, `America/Los_Angeles`); local equivalents are secondary and muted.
- **Warnings distinguish "blocks" from "warns".** "A reported Conflict prevents only the affected session from being published." Never bury which one it is.
- **No motivational filler, no praise.** Toasts report: "12 decisions released." Not "Nicely done!"

Marketing copy is allowed one degree more voice — short, plain, slightly dry ("Run it yourself. Forever.", "Not another registration platform.") — but never hype, and the same vocabulary rules apply.

---

## Visual foundations

**The idea:** *graphite and stage light.* Cool, crisp, high-contrast surfaces — the neutral ramp is a slightly blue graphite, never beige — lit by one vivid amber accent that behaves like a spotlight: it appears where attention is being directed (the mark, the selected row, the focus ring, the one public CTA) and nowhere else. The status hues are fully saturated so a table of states reads instantly from across the room.

### Colour
- **Neutrals are cool graphite** (`--gray-*`, `#FFFFFF` → `#0A0E14`). Canvas `--gray-50` (#F5F7F9), cards pure white, text `#131920` on white (16:1). Never beige, never a muddy mid-grey for body text — `--text-secondary` (#4E5665) clears 7:1.
- **Brand: Spotlight amber** (`--amber-400` #FFAF1A). Used for: the mark's top riser, selected table rows (`--surface-selected`), focus rings, the active-nav edge tick, and public/marketing CTA fills. **Amber never means "warning"** — that is Ember.
- **Five workflow hues**, each with a bg/fg/dot triple: Jade (confirmed / ready / approved), Ember (needs attention / overdue), Rust (blocked / declined / destructive), Beam (information / links / awaiting), Iris (**agent-assisted only** — anything an AI action touched).
- Product primary action is **ink** (`--gray-900` fill, inverse text), not amber. Amber fills are reserved for public surfaces.
- **Dark theme** is a token remap under `[data-theme="dark"]`; components need no changes. Dark surfaces are lifted off pure black (canvas #0C0F14, cards #12161C) with brighter borders and high-chroma accents (amber #FFB733, jade #22C88C, beam #5B8FFF) so the UI reads *lit*, not switched off. Shadows carry almost no information on dark — separation there comes from the border and surface step, not elevation.
- **Scoped theme classes**: `.ss-theme-light` / `.ss-theme-dark` force a theme on one subtree regardless of the host page.
- Imagery: none is shipped, and none is required. Where a headshot is missing the system shows **initials**, and where a speaker is unpublished the public page says **"Speaker to be announced"** — both are normal states, not errors.

### Type
- **Instrument Sans** — display voice (page titles, hero, dialog titles), 21px+, semibold, `-0.015…-0.035em` tracking.
- **Geist** — all UI and body text. Product base is **14px**; public surfaces step up to 16–18px.
- **Geist Mono** — times, counts, ids, slugs, scores, deadlines. Always `tabular-nums` in tables.
- Uppercase + `0.07em` tracking + 11px mono is the eyebrow/column-header treatment. Nothing else is uppercase.
- All three are variable, latin-subset woff2 (~95KB total, `font-display: swap`), served from jsDelivr (Fontsource).

### Space, shape, elevation
- 4px grid. Control padding 12/7. Card padding 20. Section rhythm 32. Page gutter 24.
- Radii are odd on purpose: **3 / 5 / 7 / 10 / 14 / 20 / full**. Controls 7, cards 10, modals 14, pills full.
- Rows: 32 / 38 / **44px** (tables). Controls: 30 / 36 / 44px.
- **Cards are white, 1px `--border-default`, 10px radius, `--shadow-xs`.** A card never floats without a border, never carries a coloured left border (the *one* exception is the agenda block, where a 3px left edge encodes track colour), and never has a gradient.
- Shadows are cool `rgb(16,24,40)` at low opacity, five steps: xs resting · sm inputs · md hover/menus · lg popovers/toasts · xl modals.
- Transparency + blur appear in exactly two places: sticky public/marketing navs (`backdrop-filter: blur(10px)`) and the modal scrim (`rgba(27,26,23,0.44)`). Nothing else is translucent.
- Gradients: only two radial amber "stage glows", both on dark or canvas hero sections at ≤20% opacity. Never on a button, card or icon.

### Interaction
- **Hover:** neutral surfaces darken one step (`--surface-hover`/`--surface-active`); ink buttons lighten to `--gray-800`; borders step to `--border-strong`; interactive cards gain `--shadow-md`. Opacity is never used for hover.
- **Press:** `translateY(0.5px)` plus one step darker. No scale-down.
- **Focus:** 3px amber ring (`--shadow-focus`), never removed; destructive controls use the rust ring.
- **Disabled:** 45% opacity, `not-allowed`, no transform.
- **Selected:** amber tint band + amber left edge — used for table selection and the active nav item.
- **Motion:** 80 / 130 / 200 / 320ms with `--ease-standard` (`cubic-bezier(.32,.72,0,1)`) for controls and `--ease-out` for surfaces. Dialogs fade + rise 6px. **No bounce, no spring, no entrance animation on data**, and everything collapses to 0ms under `prefers-reduced-motion`.
- Layout: sidebar 236px fixed, topbar 52px sticky, content scrolls; tables get sticky headers; public content maxes at 1080–1120px.

---

## Iconography

- **Lucide**, 24px grid, rounded caps. The `Icon` component **inlines** the glyph paths (no asset path, no CDN) and always draws with `currentColor` at **1.75px** stroke — Lucide ships 2, lightened for dense UI. Never hard-code a fill.
- Sizes: **14px** in dense table cells, **16px** default (buttons, nav, callouts), **20px** in page headers and empty states.
- Brand marks (GitHub, Discord, X) live in `apps/web/src/ds/assets/brand-icons/` and are filled, not stroked — only used in marketing footers.
- **No emoji, ever**, in product UI or marketing. **No unicode glyph icons** (→, ✓) — use the Lucide equivalent. **Never hand-draw an SVG icon**: add the glyph to the `ICONS` map in `Icon.jsx` (source SVGs live in the Claude Design project's `assets/icons/`).
- Status is communicated by a **6px dot + tinted pill**, not by an icon.

---

## Logo

Designed from scratch for StageStack: **three stacked risers** — a stage seen head-on and a literal "stack" — with the top riser lit in Spotlight amber. Clearspace equals the height of one riser on all sides; minimum mark size 16px; the wordmark is Instrument Sans 600 at `-0.02em`.

Files (in `apps/web/src/ds/assets/`): `logo.svg` · `logo-inverse.svg` · `logomark.svg` · `logomark-mono.svg` (currentColor) · `logomark-inverse.svg` · `favicon.svg`. The `Logo` component reproduces the lockup live in React. Favicons in `apps/web/public/` (ico + png set) are generated from `favicon.svg`.

---

## Index (as vendored in this repo)

**`apps/web/src/ds/`**
- `styles.css` — the single entry point (imported by `src/styles/app.css`). `@import` list only.
- `index.ts` — the ONLY component import surface: `import { Button } from '~/ds'`.
- `tokens/` — `fonts.css`, `colors.css`, `typography.css`, `spacing.css`, `radius.css`, `elevation.css`, `motion.css`, `layout.css`, `base.css`.
- `assets/` — logos, favicon, `brand-icons/`.
- `components/<group>/<Name>.jsx` + `<Name>.d.ts` (the `.d.ts` documents the exact prop API — do not invent props):
  - `core/` — **Button**, **IconButton**, **Icon**, **Badge**, **StatusPill**, **Tag**, **Avatar** (+ **AvatarGroup**), **Logo**
  - `forms/` — **Field**, **Input**, **Textarea**, **Select**, **Checkbox**, **RadioGroup**, **Switch**, **SearchInput**
  - `layout/` — **Card**, **PageHeader**, **Toolbar**, **DataTable**, **EmptyState**, **DescriptionList**
  - `feedback/` — **Callout**, **Dialog**, **Toast**, **Tooltip**, **ReadinessMeter**
  - `navigation/` — **SidebarNav**, **Tabs**, **Breadcrumb**

**Adherence**: `apps/web/.oxlintrc.json` + `npm run lint:ds` warn on raw hex colours, raw px literals, non-system fonts, internal-path imports, and undeclared component props.

**Not vendored** (lives in the Claude Design project, readable via DesignSync, projectId `3047afca-cf73-49aa-bf6e-5de2f789d6b5`): 17 guideline specimen cards, per-component `.prompt.md` docs, Lucide source SVGs (`assets/icons/`), and four click-through UI kits (`organizer-app`, `speaker-portal`, `public-event`, `marketing-site`) — consult the UI kits before designing a new screen of the same type.

**Notable components**
- **StatusPill** — owns the workflow-state → colour mapping (`STATUS_TONES`) so no screen invents one.
- **ReadinessMeter** — readiness is derived and multi-state; a plain progress bar would misrepresent it.
- **Icon** — wraps the inlined Lucide set, tinted by `currentColor`.

---

## Rules of thumb for anyone designing with this system

1. One `primary` (ink) action per view. Amber fills are for public surfaces only.
2. Use `StatusPill` for any named workflow state — never pick a tone by hand.
3. Every external or consequential action gets a `Dialog` confirm immediately before it, and a `Toast` after.
4. Readiness and progress are *derived*. Never build a control that sets them.
5. Public output shows only published data; unpublished people become "Speaker to be announced".
6. State the timezone. State the count. State who will receive the email.
