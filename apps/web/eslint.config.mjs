import { readFileSync } from 'node:fs'
import { defineConfig, globalIgnores } from 'eslint/config'
import { tanstackConfig } from '@tanstack/eslint-config'
import convexPlugin from '@convex-dev/eslint-plugin'

// Design-system adherence rules (raw hex/px literals, non-system fonts,
// internal ds imports, undeclared component props). The JSON mirrors the
// _adherence.oxlintrc.json shipped with the StageStack Design System;
// ESLint runs its no-restricted-* rules natively.
const adherence = JSON.parse(
  readFileSync(new URL('./_adherence.oxlintrc.json', import.meta.url), 'utf8'),
)

export default defineConfig([
  ...tanstackConfig,
  ...convexPlugin.configs.recommended,
  // src/ds is vendored verbatim from the StageStack Design System project —
  // style rules don't apply to it, and it is exempt from its own adherence rules.
  globalIgnores(['convex/_generated', 'src/ds', 'dist', '.vercel', '.output']),
  {
    name: 'stagestack/design-adherence',
    files: ['src/**/*.{ts,tsx,jsx}'],
    rules: {
      'no-restricted-imports': adherence.rules['no-restricted-imports'],
      'no-restricted-syntax': adherence.rules['no-restricted-syntax'],
    },
  },
])
