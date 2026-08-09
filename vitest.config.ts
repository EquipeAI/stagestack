import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    // Blocks outbound HTTP (the raw Resend call in the .ics path) so the suite
    // never depends on the network. See convex/test.setup.ts.
    setupFiles: ["./convex/test.setup.ts"],
    // Deployment env vars the Convex modules read at import/call time. The
    // Resend client reads RESEND_API_KEY when it is constructed, so it has to
    // be present before any module that imports convex/emails.ts loads.
    env: {
      RESEND_API_KEY: "re_test_key",
      // The suite mails ordinary addresses (alice@example.com, …) and Resend's
      // test mode REFUSES any recipient outside resend.dev's own, throwing
      // inside the sending mutation. The deployment default is now test mode ON
      // (safe for a fresh clone, M14), so the suite has to pin the mode it has
      // always run in. Here rather than in convex/test.helpers.ts so the whole
      // deployment env lives in one place.
      RESEND_TEST_MODE: "false",
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
