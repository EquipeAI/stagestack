import { defineConfig } from 'vitest/config'
import tsConfigPaths from 'vite-tsconfig-paths'
import viteReact from '@vitejs/plugin-react'

// Standalone test config: vitest prefers vitest.config.ts over vite.config.ts,
// so the Start/nitro/tailwind build plugins never load under test. The root
// vitest.config.ts only includes convex/**, so the two suites cannot collide —
// run this one with `npm run test -w apps/web` (or vitest from this directory).
export default defineConfig({
  // Pin the mode too, not just NODE_ENV below: Vite derives
  // `import.meta.env.DEV` from the resolved mode, and an ambient
  // NODE_ENV=production would otherwise make DEV false inside the tests —
  // silently inverting any test whose premise is "in development, …".
  mode: 'development',
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
