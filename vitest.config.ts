import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "convex-test-storage-content-type",
      enforce: "pre",
      transform(code, id) {
        if (!id.includes("/convex-test/dist/index.js")) return;
        const withoutMime = `size: blob.size,\n                        sha256: await blobSha(blob),`;
        if (!code.includes(withoutMime)) {
          throw new Error(
            "convex-test storage shim no longer matches; verify its fake metadata implementation",
          );
        }
        // convex-test 0.0.55 keeps the Blob itself (including Blob.type) but
        // omits contentType from its fake `_storage` system row. Real Convex
        // persists it. Keep the fake faithful so production validators remain
        // fail-closed rather than learning a test-only missing-MIME fallback.
        return code.replace(
          withoutMime,
          `size: blob.size,\n                        contentType: blob.type || undefined,\n                        sha256: await blobSha(blob),`,
        );
      },
    },
  ],
  test: {
    environment: "edge-runtime",
    // The worker is plain Node code, but its file parsing is the kind of thing
    // that only breaks on real bytes, so its tests run in the same suite.
    include: ["convex/**/*.test.ts", "apps/worker/src/**/*.test.ts"],
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
        inline: [
          "@convex-dev/resend",
          "@convex-dev/rate-limiter",
          "convex-test",
        ],
      },
    },
  },
});
