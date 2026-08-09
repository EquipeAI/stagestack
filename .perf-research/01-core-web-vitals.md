# Mobile Web Performance — Core Web Vitals for React 19 + TanStack Start + Vite 8 + Tailwind v4

Research date: 2026-08-09. Measured against this repo at `apps/web`
(react 19.2.8, @tanstack/react-start 1.168.40, @tanstack/react-router 1.170.23,
vite 8.2.1 / rolldown 1.2.3, tailwindcss 4.3.3, @clerk/tanstack-react-start 1.4.29).

Every number below marked **[measured]** came from `npx vite build` + serving
`.output/server/index.mjs` and reading the real SSR HTML. Everything else is
cited to a source URL.

---

## 0. Measured baseline for this app (the thing to beat)

Landing route (`/`) SSR HTML, production build **[measured]**:

| Critical-path resource | raw | gzip |
|---|---|---|
| `index-*.js` (entry — contains react-dom **and** Clerk react) | 446,092 | 132,678 |
| `use_queries-*.js` (react-query + convex) | 61,310 | 16,511 |
| `link-*.js` | 25,230 | 9,421 |
| `esm-*.js` | 23,061 | 7,310 |
| `Icon-*.js` | 16,343 | 5,740 |
| `routes-*.js` | 13,659 | 4,581 |
| + 11 more modulepreloaded chunks | 30,257 | 11,511 |
| **JS subtotal (17 `modulepreload`s)** | **615,952** | **187,753** |
| `app-*.css` (render-blocking, Tailwind v4 + DS) | 56,397 | 11,259 |
| 2 preloaded woff2 faces | 59,492 | (already compressed) |
| **Total critical-path transfer** | | **≈ 252 KB** |

(Chunk hashes shift between builds — the repo was being edited concurrently while
this was measured. Re-measure with
`curl -s localhost:3000/ | grep -o 'modulepreload[^>]*'` rather than trusting the
filenames above.)

Plus a **script-injected third-party** load that is *not* in the table because it
is not in the HTML at all **[measured]**:

```
https://adjusted-camel-99.clerk.accounts.dev/npm/@clerk/clerk-js@5/dist/clerk.browser.js
→ 88 KB brotli / 314 KB uncompressed, async, cross-origin, no preconnect
```

So the real mobile startup cost is **≈ 340 KB compressed / ≈ 990 KB of JS to
parse+compile**, from **3 origins** (self, `*.clerk.accounts.dev`,
`*.convex.cloud` for the WebSocket). On a mid-tier Android over 4G that is the
single dominant LCP and INP input.

Already correct in the repo (do not regress these):
- Fonts self-hosted from `/public/fonts`, latin-subset variable woff2,
  `font-display: swap`, `unicode-range` scoped, metric-matched
  `size-adjust`/`ascent-override` fallback faces, and the two first-paint faces
  `<link rel=preload as=font crossorigin>`ed from `__root.tsx` **[measured: present in SSR HTML]**.
- `xlsx` (492 KB) and `jszip` (96 KB) are `await import()`-ed in
  `src/components/abstracts/exporters.ts`, so they are **not** on the critical
  path **[measured: separate chunks, not modulepreloaded]**.
- `viewport-fit=cover` + `interactive-widget=resizes-content`, `100dvh`, safe-area insets.

---

## 1. Core Web Vitals on mobile — thresholds and the actual causes

### Thresholds (measure at the **75th percentile**, segmented mobile vs desktop)

| Metric | Good | Needs improvement | Poor |
|---|---|---|---|
| **LCP** | ≤ **2.5 s** | ≤ 4.0 s | > 4.0 s |
| **INP** | ≤ **200 ms** | ≤ 500 ms | > 500 ms |
| **CLS** | ≤ **0.1** | ≤ 0.25 | > 0.25 |

All three are `Stable` lifecycle. Source: <https://web.dev/articles/vitals>,
<https://web.dev/articles/inp>.

### LCP: budget it by subpart, don't guess

web.dev gives the target *shape* of a well-optimized LCP, which is the only way
to know which fix matters (<https://web.dev/articles/optimize-lcp>):

| LCP subpart | share of LCP |
|---|---|
| Time to first byte | ~40 % |
| Resource load **delay** | **< 10 %** |
| Resource load duration | ~40 % |
| Element render **delay** | **< 10 %** |

> "The **vast majority** of the LCP time should be spent loading the HTML
> document and LCP source. Any time before LCP where one of these two resources
> is *not* loading is **an opportunity to improve**."

Read the breakdown in the field, don't infer it:

```ts
// src/lib/vitals.ts — ship this behind a flag, it is ~1 KB
import { onLCP, onINP, onCLS } from 'web-vitals/attribution'

const send = (m: unknown) => {
  navigator.sendBeacon?.('/api/vitals', JSON.stringify(m))
}
// `attribution` build gives you the element selector + LCP subpart timings,
// which is what turns a bad score into an actionable line of code.
onLCP(send, { reportAllChanges: false })
onINP(send)
onCLS(send)
```

Top LCP causes, in the order they actually bite an SSR React app:

1. **Element render delay from render-blocking JS on the main thread.** Even a
   fully-downloaded LCP image "may still have to wait until an unrelated script
   finishes executing before it can render. All browsers today render images on
   the main thread." With 990 KB of JS to parse, this is *this app's* LCP
   bottleneck, not image bytes. → §2, §5, §6.
2. **Render-blocking stylesheet larger than the LCP resource.** `app.css` is
   56 KB raw / 11 KB gz **[measured]** — fine, keep it under the LCP resource
   size. If it grows, "the best way to ensure the style sheet does not block
   rendering of the LCP element is to reduce its size so that it's smaller than
   the LCP resource."
3. **LCP resource not discoverable by the preload scanner.** Not discoverable:
   an `<img>` added by JS, a `data-src` lazy-loader, or **a CSS background
   image**. Discoverable: `src`/`srcset` in the initial HTML, or a
   `<link rel=preload>`.
4. **Text LCP waiting on a webfont** — already handled here via font preload (§3).

### CLS: the four causes

Source: <https://web.dev/articles/optimize-cls>.

1. **Images without dimensions.** Always set `width`/`height` attributes; modern
   browsers derive `aspect-ratio: auto W / H` from them *before* the image
   loads. **This repo has 3 `<img>` with no `width`/`height`**
   (`marketing/Landing.tsx` ×2, `public/ProgramView.tsx` ×1) **[measured]** — see §4.
2. **Ads / embeds / late-loaded content** — reserve space, place low, never
   insert above existing content without a user interaction.
3. **Animations** — animate `transform`, never `top`/`left`/`width`/`height`.
4. **Web fonts** (FOUT/FOIT). Both shift, because invisible text is still laid
   out in the fallback. Fixed here already with `size-adjust` +
   `ascent-override` + preload.

Plus: **make pages bfcache-eligible** — "a highly effective technique for
keeping CLS scores low", because a back-navigation restores the painted page
with zero shifts. Killers: `unload` handlers, `Cache-Control: no-store` on the
document. Check `chrome://` DevTools → Application → Back/forward cache.

---

## 2. JS bundle size and code-splitting on Vite 8 / Rolldown

### `manualChunks` is gone — Vite 8 is Rolldown

**This is the biggest API break to get right.** Vite 8 ships Rolldown, and
chunking moved from `build.rollupOptions.output.manualChunks` to
`build.rolldownOptions.output.codeSplitting`
(<https://vite.dev/guide/build#chunking-strategy>,
<https://rolldown.rs/in-depth/manual-code-splitting>). `advancedChunks` is
**deprecated** and "if `advancedChunks` and `codeSplitting` are both specified,
`advancedChunks` will be ignored" **[measured in `rolldown/dist/shared/define-config-*.d.mts`]**.

Also: Vite 8's default `build.target` is Baseline Widely Available —
**Chrome/Edge ≥ 111, Firefox ≥ 114, Safari ≥ 16.4**. No polyfills are emitted.

Concrete config for this repo. The goal is to stop `react-dom` and Clerk from
sharing one 446 KB hash-unstable chunk, and to let them cache independently:

```ts
// apps/web/vite.config.ts
export default defineConfig({
  plugins: [tailwindcss(), tsConfigPaths({ projects: ['./tsconfig.json'] }), tanstackStart(), nitro(), viteReact()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Highest priority first — a module is claimed by exactly one group.
            // Use [\\/] not / so the regexes also match on Windows.
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'clerk',  test: /node_modules[\\/]@clerk[\\/]/,                     priority: 25 },
            { name: 'convex', test: /node_modules[\\/](convex|@convex-dev)[\\/]/,       priority: 20 },
            { name: 'router', test: /node_modules[\\/]@tanstack[\\/]/,                  priority: 15 },
            // Everything else from node_modules, but only if it's worth a request.
            { name: 'vendor', test: /node_modules/, priority: 1, minSize: 20 * 1024 },
          ],
        },
      },
    },
  },
})
```

Group knobs that matter, all verified in the installed `rolldown@1.2.3` types **[measured]**:

| Option | Default | Use it for |
|---|---|---|
| `priority` | `0` | Higher wins; claimed modules are removed from lower groups. |
| `minSize` | `0` | Drop a group that isn't worth an HTTP request (it falls back to automatic chunking). |
| `maxSize` | `∞` | Split a fat group into ~`maxSize` pieces so mobile downloads them in parallel. |
| `minShareCount` | `1` | Only capture a module referenced by ≥ N entries. |
| `entriesAware` | `false` | **Mobile win.** `false` merges every match into one chunk that *every* entry must download whole. `true` subgroups by which entries actually import them. |
| `tags: ['$initial']` | — | Only modules statically reachable from a user entry. `{ name: 'initial', tags: ['$initial'], maxSize: 1<<20 }` caps first-load chunks. |

Do **not** over-split. Two real constraints: each chunk is an extra HTTP request
+ modulepreload line, and Rolldown always emits a `runtime.js` chunk.

### Route-level splitting: TanStack **Start** already does it, unconditionally

Widespread advice says "set `autoCodeSplitting: true` in the router plugin". For
plain TanStack **Router** that is right
(<https://tanstack.com/router/latest/docs/framework/react/guide/code-splitting>).
**For TanStack Start it is wrong and the option does not exist** — Start's config
schema explicitly *omits* it and pushes the code splitter unconditionally
**[measured]**:

```ts
// node_modules/@tanstack/start-plugin-core/src/schema.ts
const tsrConfig = configSchema.omit({ autoCodeSplitting: true, target: true }).partial()
// node_modules/@tanstack/start-plugin-core/src/vite/start-router-plugin/plugin.ts
tanStackRouterCodeSplitter(() => ({ ...routerConfig, codeSplittingOptions: { ..., deleteNodes: ['ssr','server','headers'] } }))
```

Confirmed by the build: every route is its own chunk
(`app.e._eventSlug.agenda-*.js` = 83,942 B, etc.) and none of them are
modulepreloaded on `/` **[measured]**. So route splitting is **done**; don't add
config for it.

What you *can* tune is the split granularity. The default grouping is
`[['component'], ['errorComponent'], ['notFoundComponent']]` **[measured in
`router-plugin/src/core/constants.ts`]** — the `loader` stays in the critical
route file on purpose (it must run before the component to avoid a request
waterfall). To also split pending components, or to split a specific fat route
differently:

```ts
tanstackStart({
  router: {
    codeSplittingOptions: {
      defaultBehavior: [['component'], ['pendingComponent'], ['errorComponent', 'notFoundComponent']],
      // Per-route override; `undefined` falls back to defaultBehavior.
      splitBehavior: ({ routeId }) =>
        routeId === '/app/e/$eventSlug/agenda' ? [['component'], ['loader']] : undefined,
    },
  },
})
```

### Dynamic import of heavy libs — the pattern this repo already uses

`exporters.ts` is the model to copy. The rule: **the heavy module must not be
reachable by any static import from a route's critical file**, or it lands in the
route chunk anyway.

```ts
// GOOD — 492 KB xlsx never enters a chunk an organizer downloads to *view* a table.
export async function xlsxBytes(input: SheetInput): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx')
  const book = XLSX.utils.book_new()
  // ...
  return XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
}

// BAD — a top-level `import type`-adjacent value import, or a re-export barrel:
// export { writeXlsx } from './exporters'   ← in an index.ts imported by the route
```

`luxon` is the outstanding one here: **71,640 B / 22,304 B gz as
`datetime-*.js`** **[measured]**, statically imported by `src/lib/datetime.ts`,
`components/agenda/model.ts` and `components/public/ProgramView.tsx`. It is *not*
modulepreloaded on `/`, so it is not a landing-page problem — but it is on the
critical path of every `/app/e/$eventSlug/*` route. `Intl.DateTimeFormat` +
`Temporal`-style helpers cover most of what `DateTime` is used for here at zero
bytes; if Luxon must stay, keep it out of any component that renders above the fold.

### Treeshaking

- `"sideEffects": false` is already set in `apps/web/package.json` **[measured]** — this
  is what lets Rolldown drop unused DS/icon exports. Keep it, and make sure no
  module actually relies on an import for its side effect (CSS imports are
  exempt; Vite handles those).
- Import leaf modules, not barrels: `import { Badge } from '~/ds/components/Badge'`
  beats `from '~/ds'` for both treeshaking and chunk attribution.
- **Avoid namespace re-exports** (`export * from`) in `~/ds/index.ts`; they defeat
  per-export granularity in practice.

### modulepreload

Vite emits `<link rel="modulepreload">` for the entry's static import graph
(`build.modulePreload` defaults to `true`) — **17 of them on `/` [measured]**.
This is correct and you want it: it flattens the import waterfall into one round
trip. But every entry in that list is a *guaranteed* download, so the list is
your real first-load budget. Two rules:

- If a chunk shows up in the SSR HTML's modulepreload list, it is critical-path.
  Audit that list, not `dist/` totals: `curl -s localhost:3000/ | grep -o 'modulepreload[^>]*'`.
- Deferred-hydration child chunks are deliberately **not** modulepreloaded
  ("Transformed `Hydrate` JavaScript chunks are not modulepreloaded with the
  route") — that's the point of §5.

Handle stale-deploy chunk 404s, which read as a hard failure on mobile:

```ts
// src/client.tsx
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  window.location.reload()
})
// and serve the HTML document with `Cache-Control: no-cache`, or old assets stay referenced.
```
<https://vite.dev/guide/build#load-error-handling>

---

## 3. Font loading

The repo is already at the recommended end state; this section is the rationale
so it doesn't get undone, plus the two remaining wins.

**Rules, from <https://web.dev/articles/font-best-practices>:**

1. **WOFF2 only.** "Use only WOFF2 and forget about everything else." Brotli-based,
   ~30 % smaller than WOFF. ✅ done.
2. **Subset + `unicode-range`.** ✅ done (latin only; `unicode-range` stops the
   browser downloading a face for a page that never uses those codepoints).
3. **Self-host, but only behind a CDN + HTTP/2.** Self-hosting removes a third-party
   connection setup; without a CDN it "much less likely" wins. ✅ done — and the
   in-repo comment is exactly right that jsdelivr put "a DNS lookup + TLS handshake
   to a third origin on the critical path."
4. **`font-display`** — the tradeoff table:

   | value | block period | swap period |
   |---|---|---|
   | `block` | 2–3 s | ∞ |
   | `swap` | **0 ms** | ∞ |
   | `fallback` | 100 ms | 3 s |
   | `optional` | 100 ms | **none** |

   `swap` is right for branding/LCP text (never invisible text). `optional` is the
   most performant and is CLS-free by construction, but the font may not be used
   at all. ✅ `swap` + metric-matched fallbacks is the right combination here.
5. **Preload sparingly.** Preload "bypasses some of the browser's built-in content
   negotiation… `preload` ignores `unicode-range` declarations", and steals
   bandwidth from the LCP image. Preload **only** faces that paint first-viewport
   text. ✅ exactly 2 of 3 faces preloaded; Geist Mono deliberately not. `crossorigin`
   is mandatory even same-origin — fonts are fetched in CORS mode and a
   mode-mismatched preload is discarded and re-fetched. ✅ present.
6. **Metric-matched fallback** via `size-adjust` / `ascent-override` /
   `descent-override` / `line-gap-override` — this is what keeps font swap out of
   CLS. ✅ done.

**Remaining wins:**

- **Inline the `@font-face` block into `<head>`.** Confirmed: `ds/styles.css`
  does `@import "./tokens/fonts.css"`, so all **5 `@font-face` rules end up inside
  the external `app-*.css`** **[measured in the built CSS]** — discovery needs that
  stylesheet to download *and* parse. The `<link rel=preload>`s paper over this for
  2 of the 3 real faces; inlining fixes the cause:
  "This allows the browser to discover the font declarations sooner as the browser
  doesn't need to wait for the external stylesheet to download."
- ✅ **Already correct: every `font-family` names the metric-matched face then a
  generic** **[measured in `ds/tokens/typography.css`]** —
  `--font-sans: "Geist","Geist Fallback",-apple-system,…,sans-serif`. Keep it that
  way: per `optimize-cls`, with no fallback listed Chrome falls back to *Times* —
  a serif — "a worse match than the default `sans-serif` font".
  One gap: `--font-mono` has no `"Geist Mono Fallback"` face, so mono text
  (eyebrows, numerics) does shift when Geist Mono swaps in. It's deliberately not
  preloaded, so either add a `size-adjust` fallback for it or accept the shift on
  small secondary text.
- Long-cache the immutable font files: `Cache-Control: public, max-age=31536000, immutable`.

---

## 4. Images

Sources: <https://web.dev/articles/serve-responsive-images>,
<https://web.dev/articles/fetch-priority>, <https://web.dev/articles/optimize-cls>.

**The full-correctness `<img>`:**

```html
<img
  src="/hero-1000.webp"
  srcset="/hero-500.avif 500w, /hero-1000.avif 1000w, /hero-1500.avif 1500w"
  sizes="(max-width: 640px) 100vw, 50vw"
  width="1000" height="563"
  fetchpriority="high"
  decoding="async"
  alt="…"
/>
```

- `srcset` + `w` descriptors = which files exist and how wide each is.
  `sizes` = how wide the slot will be *at layout time* — it does not size the
  image, CSS still does. The browser combines `sizes` with viewport + DPR to pick.
- **`width`/`height` on every image, always.** Browsers compute
  `aspect-ratio: auto 1000 / 563` from the attributes before bytes arrive; the
  `auto` keyword lets real dimensions win after download. Even a *wrong* ratio
  "still causes less layout shift than the 0x0 default size of an image with no
  dimensions provided." With `srcset`, **every candidate must share one aspect
  ratio** so a single `width`/`height` pair is valid. Pair with
  `img { height: auto; width: 100% }`.
- **AVIF then WebP then JPEG** via `<picture>` when you need per-format art:
  ```html
  <picture>
    <source type="image/avif" srcset="/hero-500.avif 500w, /hero-1000.avif 1000w" sizes="100vw">
    <source type="image/webp" srcset="/hero-500.webp 500w, /hero-1000.webp 1000w" sizes="100vw">
    <img src="/hero-1000.jpg" width="1000" height="563" fetchpriority="high" alt="…">
  </picture>
  ```
- **`fetchpriority`.** Images are never render-blocking so they get Low/Medium by
  default. `fetchpriority="high"` on the LCP image moved a real Google Flights
  test from **2.6 s → 1.9 s LCP**. Use it on **at most one or two** images —
  "setting a high priority on more than one or two images makes priority setting
  unhelpful." Use `fetchpriority="low"` for offscreen carousel slides (the browser
  may otherwise consider them "close enough" to boost, and `loading=lazy` won't
  stop that).
- **Never `loading="lazy"` on the LCP image.** "Using lazy loading means that the
  resource won't be loaded until after layout confirms the image is in the
  viewport" — a guaranteed LCP regression. Lazy-load only below-the-fold images.
- `fetchpriority` is a **hint**, `preload` is a **mandatory fetch**; preload helps
  *discovery*, `fetchpriority` helps *ordering*. They compose:
  `<link rel=preload as=image fetchpriority=high href=/hero.avif type=image/avif>`
  for a CSS-background LCP.
- Also applies to `fetch()`: `fetch('/content/suggested', { priority: 'low' })`
  to keep a nice-to-have query out of the LCP's way.

**In this repo [measured]:** 3 `<img>` elements, none with `width`/`height`.

- `components/public/ProgramView.tsx:135` — `event.logoUrl`, **user-supplied,
  unknown intrinsic size, sized only by CSS `height: var(--space-12); width: auto`.**
  This is the real CLS risk: it's near the top of a public program page and its
  width is unknown until the bytes land, so every text node after it shifts. Fix
  by reserving the box, not the image:
  ```tsx
  // The logo's intrinsic width is unknown, so reserve a fixed-size box and let
  // the image contain itself inside it. Layout no longer depends on the download.
  <span style={{ display: 'block', height: 'var(--space-12)', width: 'min(100%, 12rem)' }}>
    <img src={event.logoUrl} alt="" loading="eager" decoding="async"
         style={{ height: '100%', width: '100%', objectFit: 'contain', objectPosition: 'left' }} />
  </span>
  ```
- `marketing/Landing.tsx:31` and `:458` — the GitHub icon, a build-time-imported
  SVG at a known `var(--space-4)` square. Add `width={16} height={16}`, or better,
  inline it as JSX and delete the request entirely (an inline SVG also dodges the
  `filter: invert(1)` repaint in the footer).

---

## 5. INP: long tasks, React 19, and TanStack Start's deferred hydration

INP = **input delay** + **event callback processing** + **presentation delay**.
Sources: <https://web.dev/articles/optimize-inp>,
<https://web.dev/articles/optimize-long-tasks>.

### Input delay during startup is the mobile killer

> "After a JavaScript file has been fetched from the network, the browser still
> has work to do… parsing a script to check its syntax is valid, compiling it
> into bytecode, and then finally executing it. Depending on the size of a
> script, this work can introduce long tasks on the main thread."

The page is *visible* (SSR HTML) long before it is *interactive*, and a user who
taps during that window eats the whole hydration long task as input delay. With
**990 KB of uncompressed JS** to parse, evaluate and hydrate **[measured]**, this
app's INP is dominated by startup, not by any single handler. The three levers,
in impact order: ship less startup JS (§2), defer hydration (below), defer
third-party (§6).

### TanStack Start's `<Hydrate>` — the highest-leverage INP tool available here

Start 1.168 ships **deferred hydration** (experimental), which is strictly more
powerful than React's selective hydration for this problem:

> "React's selective hydration controls the *order* in which server-rendered
> boundaries hydrate. Deferred hydration controls *whether and when* each
> boundary hydrates at all… By default the child JavaScript also moves into a
> separate chunk that the browser does not download until the boundary is about
> to hydrate. If the condition never fires, the boundary never hydrates and its
> code is never fetched."

Source: <https://tanstack.com/start/latest/docs/framework/react/guide/deferred-hydration>.
Verified installed: `@tanstack/react-start` exports `Hydrate` and a `./hydration`
subpath with `load, idle, visible, media, interaction, condition, never` **[measured]**.

Three independent decisions per boundary:

| prop | default | controls |
|---|---|---|
| `when` (required) | — | when the preserved SSR HTML becomes interactive |
| `split` | `true` | whether children move to a separate chunk |
| `prefetch` | none | whether loading starts before hydration |

Strategies and their options **[measured against the d.ts]**:
`load()` · `idle({ timeout = 2000 })` · `visible({ rootMargin = '600px', threshold })` ·
`media('(min-width: 800px)')` · `interaction({ events })` — default events are
`pointerenter, focusin, pointerdown, click` · `condition(boolOrFn)` · `never()`.

Patterns that map onto this codebase:

```tsx
// 1) Below-the-fold marketing on `/` — visible, styled, indexable immediately;
//    interactive only when the user scrolls near it.
import { Hydrate } from '@tanstack/react-start'
import { visible, never, idle, interaction } from '@tanstack/react-start/hydration'

<Hydrate when={visible({ rootMargin: '800px' })}>
  <WorkflowSection />
</Hydrate>

// 2) Truly static SSR content — never hydrate it at all on the initial document.
<Hydrate when={never()}>
  <MarketingFooter />
</Hydrate>

// 3) The agenda board: 84 KB route chunk + 93 KB of @dnd-kit [measured].
//    Keep drag-and-drop cold until the user reaches for it, but warm the chunk
//    while it's on screen so the first grab isn't late.
<Hydrate when={interaction({ events: ['pointerdown', 'focusin'] })}
         prefetch={visible({ rootMargin: '1200px' })}>
  <AgendaBoard {...props} />
</Hydrate>

// 4) Desktop-only affordance — never costs a phone anything.
<Hydrate when={media('(min-width: 861px)')}>
  <DesktopNavRail />
</Hydrate>

// 5) Small component already in the startup bundle: delay hydration only.
<Hydrate when={idle()} split={false}>
  <PersonalizedBadge />
</Hydrate>
```

**Bad candidates** (the docs are explicit, and this matters for correctness):
primary nav, route chrome, search boxes, **account controls**, above-the-fold
forms and submit buttons, the interactive part of the LCP/hero,
accessibility-critical controls that must be keyboard-ready immediately.

**Extraction limits** — `split` silently needs a statically-imported, directly
rendered `Hydrate` tag. These are rejected: function-as-children, **hook calls
directly inside the extracted JSX**, `this`/`super` captures, and
`const Deferred = Hydrate` aliasing (an `import { Hydrate as Deferred }` rename
*is* fine). `split={false}` must be a literal, not `split={shouldSplit}`.

Also note: **CSS is not deferred with the chunk.** "CSS used by split, deferred,
and `never()` boundaries is linked in the SSR HTML for the matched route" — so
`<Hydrate>` reduces JS, never CSS.

### `defaultPreload: 'intent'` is an INP hazard on touch

`src/router.tsx` sets `defaultPreload: 'intent'` with
`defaultPreloadStaleTime: 0`. On desktop, intent preloading waits
`defaultPreloadDelay` (50 ms) after `mouseenter`. **On touch there is no delay** **[measured]**:

```js
// node_modules/@tanstack/react-router/dist/esm/link.js
const handleTouchStart = (_) => { if (disabled || preload !== "intent") return; doPreload(); }
// vs. mouseenter → enqueueIntentPreload → setTimeout(doPreload, preloadDelay)
```

So on a phone, every `touchstart` synchronously kicks off the route chunk import
**and** the loader fetch inside the same task as the tap that generates the INP
measurement — and with `defaultPreloadStaleTime: 0` it refetches on every tap.
Options: keep it (the navigation genuinely feels faster) but wrap expensive
loader work so it can't run inline, or gate it for constrained devices:

```ts
// Data-saver / slow-connection users get no speculative work at all.
const conn = typeof navigator !== 'undefined' ? (navigator as any).connection : undefined
const thrifty = conn?.saveData === true || /(^|-)2g$/.test(conn?.effectiveType ?? '')
const router = createRouter({ routeTree, defaultPreload: thrifty ? false : 'intent', /* … */ })
```

### Yield to the main thread: `scheduler.yield()`

Available **Chrome/Edge 129, Firefox 142** **[measured from the browser-support
block]**; not Safari yet, so ship a fallback. Its advantage over `setTimeout(0)`
is that **the continuation is prioritized** — "if you yield in the middle of a
task, the continuation of the current task will run *before* any other similar
tasks are started", so third-party tasks can't jump your queue.

```ts
// src/lib/yield.ts
export function yieldToMain(): Promise<void> {
  if (typeof globalThis.scheduler?.yield === 'function') return globalThis.scheduler.yield()
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}
```

```ts
// Applied: bulk proposal import / xlsx parse — do NOT run 500 rows in one task.
async function importRows(rows: Row[]) {
  for (let i = 0; i < rows.length; i++) {
    validateAndStage(rows[i])
    if (i % 25 === 0) await yieldToMain()   // one yield every ~25 rows
  }
}
```

**Do not use `isInputPending()`** — web.dev now explicitly recommends against it.

### Yield so *rendering* happens sooner (the real INP trick)

Split an event handler into "what the next frame needs" and "everything else":

```ts
textBox.addEventListener('input', (inputEvent) => {
  updateTextBox(inputEvent)            // visual, must be in this frame
  requestAnimationFrame(() => {        // everything else, after the next paint
    setTimeout(() => {
      updateWordCount(text); checkSpelling(text); saveChanges(text)
    }, 0)
  })
})
```

The `setTimeout` inside `requestAnimationFrame` is "admittedly a bit esoteric,
but it is an effective method that works in all browsers to prevent non-critical
code from blocking the next frame."

### React 19 concurrent features — precisely what each one buys

- **`useTransition`** — marks updates as interruptible so an urgent update (typing)
  preempts an expensive one (a re-rendering table). Caveats that bite:
  - Updates inside a `setTimeout` inside `startTransition` are **not** transitions.
  - **You must re-wrap state updates that happen after an `await`** in another
    `startTransition`.
  - **Transitions cannot control text inputs.**
  - Multiple concurrent transitions are batched together.
  <https://react.dev/reference/react/useTransition>
- **`useDeferredValue`** — use when you *don't own* the setter (a prop, or a
  `useQuery` result). Perfect for filter/search over a big list:
  ```tsx
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)          // keystrokes stay at 60fps
  const rows = useMemo(() => filterProposals(all, deferredQuery), [all, deferredQuery])
  const isStale = query !== deferredQuery
  return (
    <>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <div style={{ opacity: isStale ? 0.6 : 1, transition: 'opacity 120ms' }}>
        <ProposalTable rows={rows} />
      </div>
    </>
  )
  ```
  Pass **primitives or objects created outside render** — "if you create a new
  object during rendering and immediately pass it to `useDeferredValue`, it will
  be different on every render, causing unnecessary background re-renders."
  The background render is interruptible and restarts from scratch on a newer value.
  <https://react.dev/reference/react/useDeferredValue>
- **Neither one reduces total work.** They reschedule it. A 200 ms render is still
  200 ms of main thread; `useTransition` only stops it from blocking the *next*
  frame. To actually cut it: fewer DOM nodes, `React.memo` on row components with
  stable props, and virtualization.

### Presentation delay: DOM size and `content-visibility`

> "Large DOMs do require more work to render than small DOMs… in response to a
> user interaction, a large DOM can cause rendering updates to be very expensive."

The fat routes here are `settings` (1330 lines), `cfp.submit` (1121), `cfp` (956),
`proposals`, `agenda` **[measured]**. `content-visibility` is the cheap win — it
lazily renders off-screen subtrees. **`contain-intrinsic-size` is mandatory** or
you trade INP for CLS and a broken scrollbar:

```css
/* Long lists of proposals / sessions / tasks. Each row is ~72px tall, so give the
   skipped box that intrinsic height — without it the scrollbar jumps as rows render. */
.list-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 72px;
}
```

Do **not** put `content-visibility: auto` on anything that could be the LCP
element or above the fold.

### Layout thrashing

Reading a geometry property after a style write in the same task forces a
synchronous layout. In DevTools' Performance panel it appears as **Recalculate
Style** / **Layout** with a red triangle. The offender list is
`offsetTop/Height`, `scrollTop/Height`, `clientWidth`, `getBoundingClientRect`,
`getComputedStyle` — see <https://gist.github.com/paulirish/5d52fb081b3570c81e3a>.
This repo's `@dnd-kit` agenda drag and the `.scroll-x` containers are the likely
sites: batch all reads, then all writes, and prefer `ResizeObserver` /
`IntersectionObserver` over measuring in a scroll or pointermove handler.

---

## 6. Third-party script cost (Clerk, analytics)

### What Clerk actually costs here [measured]

1. **In your own bundle**: `@clerk/react` is inside the 446 KB entry chunk
   (392 `clerk` occurrences, `clerk.browser.js`, `data-clerk-publishable-key`)
   — it is *not* a separate chunk, so it can't be cached or deferred separately.
2. **A second, script-injected download** from a **third origin**:
   `@clerk/shared/loadClerkJsScript` builds
   `https://<frontendApi>/npm/@clerk/clerk-js@<v>/dist/clerk.browser.js` and calls
   `loadScript(url, { async: true, crossOrigin: 'anonymous' })`. For this app's
   publishable key the origin is `adjusted-camel-99.clerk.accounts.dev` and the
   payload is **88 KB brotli / 314 KB uncompressed**.

Because it's **script-injected**, the preload scanner can never see it: the
browser must first download+parse+execute your entry chunk, *then* discover it,
*then* do DNS + TLS + TCP to a brand-new origin. That is 3 serialized round trips
before Clerk's JS even starts downloading — and it lands on the main thread right
around hydration, i.e. exactly the INP window.

**Fixes, cheapest first:**

```tsx
// 1) __root.tsx head.links — warm the connection during HTML parse.
//    Two entries: one for the handshake, one crossorigin for the CORS fetch.
//    Saves 100–500 ms per web.dev/articles/efficiently-load-third-party-javascript.
{ rel: 'preconnect', href: 'https://adjusted-camel-99.clerk.accounts.dev' },
{ rel: 'preconnect', href: 'https://adjusted-camel-99.clerk.accounts.dev', crossOrigin: 'anonymous' },
// The Convex WebSocket origin too — it's opened during hydration.
{ rel: 'preconnect', href: 'https://scintillating-heron-597.convex.cloud' },
```

Budget preconnects: each one is a speculative TLS handshake, so **cap it at ~4
origins**, and use `dns-prefetch` for the rest.

```tsx
// 2) Don't mount ClerkProvider above pages that don't need auth.
// Today __root.tsx wraps EVERY route — including /e/$slug, /embed/$slug and
// /cfp/$eventSlug/index, which are public. Those visitors pay for clerk-js twice.
// Either move ClerkProvider into the authed layout routes (app.tsx, portal.*,
// invite.*), or gate the whole auth shell behind a deferred boundary on public routes.
```

```tsx
// 3) Split Clerk out of the entry chunk so it caches independently and can be
//    fetched in parallel — see the codeSplitting group in §2.
```

```tsx
// 4) Sign-in UI is interaction-only by definition. `SignInButton mode="modal"`
//    in Landing.tsx pulls Clerk's modal into first load; a deferred boundary
//    keeps it cold until the user reaches for it.
<Hydrate when={interaction({ events: ['pointerdown', 'focusin'] })} prefetch={idle()}>
  <SignInButton mode="modal"><Button size="sm" variant="secondary">Sign in</Button></SignInButton>
</Hydrate>
```

### General third-party rules

- **`async` vs `defer`** (<https://web.dev/articles/efficiently-load-third-party-javascript>):
  `async` runs at the first opportunity after download and **can still block HTML
  parsing**; `defer` runs after parsing completes, before `DOMContentLoaded`, and
  preserves order. **Use `defer` for analytics and anything below the fold**; only
  use `async` when the script must run early. Never a bare synchronous
  `<script src>` in `<head>` — "It is almost never necessary… and doing so will
  almost always have a negative impact on performance."
- **Never `<script>` the analytics vendor from `__root.tsx` directly.** Load it
  after the app is idle, so it can't compete with hydration:
  ```tsx
  React.useEffect(() => {
    const load = () => {
      const s = document.createElement('script')
      s.src = 'https://cdn.example.com/analytics.js'
      s.defer = true
      document.head.append(s)
    }
    // requestIdleCallback isn't in Safari; the timeout fallback is the point.
    if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 3000 })
    else setTimeout(load, 3000)
  }, [])
  ```
- **Lower the priority of non-critical preloaded third-party scripts**:
  `<link rel="preload" as="script" href="/x.js" fetchpriority="low">`.
- **Self-host what you can.** Serving a third-party script from your own origin
  removes a DNS+TLS handshake and lets you set your own cache headers — at the
  cost of owning updates. Worth it for pinned, slow-changing scripts.
- **Consider a Clerk proxy.** `@clerk/shared` supports `proxyUrl`, and a relative
  `proxyUrl` makes it build `<proxyUrl>/npm/@clerk/clerk-js@<v>/dist/clerk.browser.js`
  **[measured in `buildRelativeProxyScriptUrl`]** — i.e. **same-origin clerk-js**,
  which deletes the third origin from the critical path entirely.

---

## 7. Ordered action list for this repo

| # | Action | Metric | Est. win |
|---|---|---|---|
| 1 | `preconnect` ×2 to the Clerk FAPI origin + ×1 to Convex | LCP, INP | 100–500 ms |
| 2 | Move `ClerkProvider` off public routes (`/e`, `/embed`, `/cfp/*`) | LCP, INP | −88 KB br, −314 KB parse on public pages |
| 3 | `build.rolldownOptions.output.codeSplitting` groups: react / clerk / convex / router | LCP, caching | breaks up the 446 KB entry; stable hashes |
| 4 | `width`/`height` on all 3 `<img>`; reserve a box for `event.logoUrl` | CLS | removes the main remaining shift |
| 5 | `<Hydrate when={visible()}>` / `never()` on below-fold marketing + `interaction()` on `AgendaBoard` (93 KB dnd-kit) | INP | large; defers both hydration and chunks |
| 6 | `content-visibility: auto` + `contain-intrinsic-size` on long list rows | INP | large on proposals/sessions/tasks |
| 7 | `yieldToMain()` in the xlsx/csv import loop | INP | removes multi-second long tasks |
| 8 | `useDeferredValue` on proposal/session filter inputs | INP | keeps typing at 60 fps |
| 9 | Replace or defer `luxon` (72 KB / 22 KB gz) on `/app/e/*` | LCP | −22 KB gz per authed route |
| 10 | Inline `@font-face` into `<head>`; verify `*Fallback` in every `font-family` | LCP, CLS | small but free |
| 11 | `vite:preloadError` → reload; `Cache-Control: no-cache` on the document | reliability | prevents stale-deploy white screens |
| 12 | Gate `defaultPreload: 'intent'` off for `saveData`/2G | INP | removes touchstart work on cheap devices |
| 13 | Ship `web-vitals/attribution` → `/api/vitals` | all | turns this list into measurements |

---

## Sources

**Core Web Vitals**
- <https://web.dev/articles/vitals> — metric set, thresholds, p75, lifecycle
- <https://web.dev/articles/lcp> · <https://web.dev/articles/optimize-lcp> — subpart budget, discovery, render-blocking
- <https://web.dev/articles/inp> · <https://web.dev/articles/optimize-inp> — 200/500 ms, input delay, presentation delay
- <https://web.dev/articles/cls> · <https://web.dev/articles/optimize-cls> — causes, image dimensions, bfcache
- <https://web.dev/articles/optimize-long-tasks> — `scheduler.yield()`, yielding, don't use `isInputPending()`
- <https://web.dev/articles/dom-size-and-interactivity> · <https://web.dev/articles/bfcache>
- <https://gist.github.com/paulirish/5d52fb081b3570c81e3a> — layout-thrashing property list

**Loading / assets**
- <https://web.dev/articles/font-best-practices> — WOFF2, subsetting, `font-display` table, preload cautions
- <https://web.dev/articles/css-size-adjust> · <https://developer.chrome.com/blog/font-fallbacks>
- <https://web.dev/articles/fetch-priority> — priority table, LCP boost, `fetch({priority})`
- <https://web.dev/articles/serve-responsive-images> — `srcset` / `sizes`
- <https://web.dev/articles/preload-scanner> · <https://web.dev/articles/browser-level-image-lazy-loading>
- <https://web.dev/articles/efficiently-load-third-party-javascript> — async/defer, preconnect, self-hosting
- <https://web.dev/articles/preconnect-and-dns-prefetch>

**Build**
- <https://vite.dev/guide/build> — Vite 8 Baseline targets, `codeSplitting`, `vite:preloadError`
- <https://rolldown.rs/in-depth/manual-code-splitting> · <https://rolldown.rs/reference/OutputOptions.advancedChunks>

**Framework**
- <https://tanstack.com/start/latest/docs/framework/react/guide/deferred-hydration> — `<Hydrate>`, strategies, limits
- <https://tanstack.com/router/latest/docs/framework/react/guide/code-splitting> — `autoCodeSplitting`, `.lazy.tsx`
- <https://react.dev/reference/react/useTransition> · <https://react.dev/reference/react/useDeferredValue>

**Verified in `node_modules` at the installed versions [measured]**
- `@tanstack/start-plugin-core/src/schema.ts` — Start omits `autoCodeSplitting`
- `@tanstack/start-plugin-core/src/vite/start-router-plugin/plugin.ts` — splitter always applied
- `@tanstack/router-plugin/src/core/{config,constants}.ts` — `codeSplittingOptions`, default groupings
- `@tanstack/react-router/dist/esm/link.js` — `handleTouchStart` has no preload delay
- `@tanstack/react-start-client/dist/esm/Hydrate.d.ts` + `@tanstack/start-client-core/dist/esm/hydration/*`
- `rolldown/dist/shared/define-config-*.d.mts` — `CodeSplittingGroup`, `advancedChunks` deprecated
- `@clerk/shared/dist/loadClerkJsScript.mjs` — script URL construction, `proxyUrl` behavior
