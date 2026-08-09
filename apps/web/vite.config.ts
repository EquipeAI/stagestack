import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'

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
