import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'

// Security response headers live in `apps/web/vercel.json`, NOT here and NOT in
// `src/start.ts`. JSON has no comments, so the reasoning is recorded here, at
// the build config a reader would check first (C3/S1).
//
// Three mechanisms were on the table; the current docs decided it:
//
//  1. Start request middleware (`start.ts`). REJECTED. TanStack Start's
//     middleware guide scopes global request middleware to "every request,
//     including server routes, SSR and server functions" — i.e. requests the
//     Start handler actually serves. Confirmed in the installed package:
//     `@tanstack/start-server-core/dist/esm/createStartHandler.js` flattens
//     `requestMiddleware` inside the fetch handler, so it only ever sees
//     function invocations. On Vercel every built asset is served from
//     `.vercel/output/static` by the CDN and never invokes the function
//     (nitro's vercel preset sets `publicDir: "{{ output.dir }}/static/…"`),
//     so our JS, CSS, fonts and icons would ship with no headers at all.
//
//  2. nitro `routeRules` via `nitro({ routeRules })`. WORKS but rejected.
//     nitro 3.0.260610-beta's own shipped docs (`node_modules/nitro/dist/docs/
//     0.docs/3.routing.md`, "Headers") document `'**': { headers: {…} }`, and
//     the vercel preset does translate rules carrying `headers` into
//     `.vercel/output/config.json` routes. The catch is that those generated
//     routes are emitted WITHOUT `continue: true`, and per Vercel's Build
//     Output API a matched route without `continue` ends the routing phase —
//     so a catch-all header rule sits in front of nitro's own asset
//     cache-control and CDN-rewrite routes. Not a trade worth making for
//     headers.
//
//  3. `vercel.json` `headers`. CHOSEN. Vercel's project-configuration docs
//     give this exact use case as the example, covering "static files, Vercel
//     functions, and a wildcard that matches all routes" — the CDN coverage
//     (1) cannot reach. It is MERGED with, not overridden by, the framework's
//     emitted `.vercel/output/config.json` (the CLI's build command runs
//     `getTransformedRoutes()` on the user config and `mergeRoutes()` against
//     the builder's), and each entry becomes a `continue: true` route, so it
//     cannot short-circuit nitro's routing the way (2) would. The file lives
//     in `apps/web/` because that is this project's Vercel Root Directory,
//     which is where the CLI reads `vercel.json` from.
//
// Scope note: these headers cover the Vercel-served app ONLY. The public feeds
// at `/api/events/*` and `/api/embeds/*` are served by Convex's HTTP router on
// `*.convex.site` — a different origin, deliberately CORS-open (convex/http.ts)
// — and nothing here touches them.
//
// ── Where the CSP origins come from ──────────────────────────────────────────
//
// Convex: `*.convex.cloud` (reactive websocket + HTTPS) and `*.convex.site`
// (HTTP actions — headshot upload, embed feeds). Both derived from
// VITE_CONVEX_URL at runtime, hence wildcards in a static file.
//
// Clerk: taken from Clerk's CSP guide
// (https://clerk.com/docs/guides/secure/best-practices/csp-headers), which
// names six required directives. Its own "recommended" script-src is
// `'self' 'unsafe-inline' https: http:` — effectively no script restriction at
// all — so we deliberately do NOT copy that line; we allow only the hosts the
// doc lists as required and let report-only tell us if that is too tight:
//   · script-src  — FAPI host, `challenges.cloudflare.com`, `*.protect.clerk.com`
//   · connect-src — FAPI host, `*.protect.clerk.com`, `img.clerk.com`
//   · frame-src   — `challenges.cloudflare.com`, `*.protect.clerk.com`
//   · worker-src 'self' blob:, style-src 'unsafe-inline', form-action 'self'
// `*.protect.clerk.com` is Clerk's abuse/fraud-protection embed and ships on
// every plan, so it is required, not optional. `clerk-telemetry.com` is only
// needed on Clerk's default config — which is ours — so it is listed to keep
// the violation reports signal and not noise. Stripe, Google Maps and
// `images.clerkstage.dev` are in the doc's default policy but this app uses
// none of them, so they are omitted.
//
// The FAPI host is derived from the publishable key at runtime
// (`src/lib/preconnect.ts`), so both shapes are allowed: `*.clerk.accounts.dev`
// (the dev instance the develop preview uses) and `clerk.stagestack.dev` (the
// production custom domain).
//
// Known future gap: Clerk's doc appends `'unsafe-eval'` to script-src in
// DEVELOPMENT instances only. We do not ship it, so the develop preview may
// report eval violations that production will not. Report-only, so it is
// measurement noise rather than breakage — but do not "fix" it by adding
// `'unsafe-eval'` to a policy that also covers prod.
//
// ── Blocker on ever ENFORCING the /embed/* policy ────────────────────────────
//
// The `/embed/*` policy is deliberately stricter than the main one: it allows
// no Clerk origins, because an embed renders anonymous already-published data
// and should never need an identity provider. That is the right TARGET state,
// and it is not the state the app is in.
//
// `ClerkProvider` is mounted in the root component (`src/routes/__root.tsx`,
// `RootComponent`), wrapping `<Outlet/>` — so it wraps EVERY route, `/embed/*`
// included, and ClerkJS load attempts happen on embed views too. Consequences,
// in order of importance:
//
//   1. Flipping the embed policy from report-only to enforcing TODAY would
//      break embeds on third-party sites — the worst place to find out. Do not
//      flip this one on the strength of "the app looks fine".
//   2. Until then the embed policy is a MEASUREMENT TOOL, not a control, and
//      its Clerk violations are expected noise. Do not chase them by widening
//      the policy; that would cement the wrong target state.
//
// Unblocking it is a root-layout split: `/embed/*` (and arguably the public
// `/e/*` program page) rendered outside `ClerkProvider`, which means a root
// route that branches on the matched route rather than one that wraps
// unconditionally. That is a real refactor with SSR and Convex-client
// consequences, not a config change — hence written down here rather than
// bundled into a headers commit.
export default defineConfig({
  server: { port: 3000 },
  plugins: [
    tailwindcss(),
    tsConfigPaths({ projects: ['./tsconfig.json'] }),
    tanstackStart(),
    nitro(),
    viteReact(),
  ],
  // Client-only chunking. Scoped to `environments.client` on purpose: the server
  // build is Nitro's, and it already emits its own `_libs/*` grouping.
  //
  // Vite 8 is Rolldown, so this is `rolldownOptions.output.codeSplitting.groups`
  // and NOT `rollupOptions.output.manualChunks` — `manualChunks` is deprecated and
  // is ignored outright when `codeSplitting` is also set.
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                // Highest priority first: a module is claimed by exactly one group.
                // Use [\\/] rather than / so the tests also match on Windows.
                //
                // Without these, React, Clerk and Convex share one 447 kB
                // `index-*.js`, so a patch to any one of them busts the cache for
                // all three. Splitting also lets a phone fetch them in parallel.
                {
                  name: 'react',
                  test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                  priority: 30,
                },
                {
                  name: 'clerk',
                  test: /node_modules[\\/]@clerk[\\/]/,
                  priority: 25,
                },
                {
                  name: 'convex',
                  test: /node_modules[\\/](convex|@convex-dev)[\\/]/,
                  priority: 20,
                },
                // Anything else from node_modules, but ONLY if it is already on the
                // initial static path. `tags: ['$initial']` is load-bearing: without
                // it this catch-all also claims modules that are only reachable via
                // `await import(...)` and merges them into the entry chunk — which
                // pulled the 492 kB `xlsx` and `jszip` out of their async chunks and
                // grew `index-*.js` from 447 kB to 891 kB [measured]. That would make
                // every visitor download the spreadsheet exporter just to view a page.
                {
                  name: 'vendor',
                  test: /node_modules/,
                  tags: ['$initial'],
                  priority: 1,
                  minSize: 20 * 1024,
                },
              ],
            },
          },
        },
      },
    },
  },
})
