import { defineConfig } from 'vitest/config'
import tsConfigPaths from 'vite-tsconfig-paths'
import viteReact from '@vitejs/plugin-react'

// Standalone test config: vitest prefers vitest.config.ts over vite.config.ts,
// so the Start/nitro/tailwind build plugins never load under test. The root
// vitest.config.ts only includes convex/**, so the two suites cannot collide —
// run this one with `npm run test -w apps/web` (or vitest from this directory).
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
  },
})
