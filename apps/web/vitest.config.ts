import { defineConfig } from 'vitest/config'
import tsConfigPaths from 'vite-tsconfig-paths'
import viteReact from '@vitejs/plugin-react'

// Standalone test config: vitest prefers vitest.config.ts over vite.config.ts,
// so the Start/nitro/tailwind build plugins never load under test. The root
// vitest.config.ts only includes convex/**, so the two suites cannot collide —
// run this one with `npm run test -w apps/web` (or vitest from this directory).

// Kill an ambient NODE_ENV=production BEFORE Vite's transform pipeline starts.
// Vite reads process.env.NODE_ENV in the PARENT process to decide how to
// transform each module (baking `import.meta.env.DEV` and choosing how to
// externalize `node:` builtins), and that decision is taken before the
// `test.env` pin below ever reaches a worker. An ambient production value
// (Docker, CI images, `npm ci --omit=dev` shells) therefore flips DEV to false
// in four suites and makes the two `node:fs`-importing suites die with
// `No such built-in module: node:` — while the same run passes in a clean
// shell. Neutralizing it here, at config-load time, makes the transform
// environment deterministic no matter what the invoking shell exports.
if (process.env.NODE_ENV === 'production') {
  process.env.NODE_ENV = 'development'
}

export default defineConfig({
  plugins: [
    tsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    viteReact(),
  ],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // Pin the development build of React inside the test workers. react and
    // react-dom pick their CJS bundle from process.env.NODE_ENV at require
    // time, and the production bundles omit `React.act`, so every
    // @testing-library/react render throws "React.act is not a function".
    // CI images (and `npm ci --omit=dev` shells) commonly export
    // NODE_ENV=production, which would otherwise make the suite fail there
    // while passing locally — the gate must be NODE_ENV-agnostic. Do not
    // remove.
    env: {
      NODE_ENV: 'development',
    },
  },
})
