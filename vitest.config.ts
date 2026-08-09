import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    // Deployment env vars the Convex modules read at import/call time. The
    // Resend client reads RESEND_API_KEY when it is constructed, so it has to
    // be present before any module that imports convex/emails.ts loads.
    env: {
      RESEND_API_KEY: "re_test_key",
      SITE_URL: "https://test.stagestack.dev",
      WORKER_SECRET: "test-worker-secret",
    },
    server: {
      deps: {
        // The component packages ship their convex-test registration helpers as
        // raw TS with `import.meta.glob`, which only works when Vite transforms
        // them instead of externalizing them.
        inline: ["@convex-dev/resend", "@convex-dev/rate-limiter"],
      },
    },
  },
});
