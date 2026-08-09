// StageStack worker — runs on the exe.dev VM under systemd.
// Subscribes to the Convex jobs queue over WebSocket and executes claimed jobs.
// See docs/ARCHITECTURE.md ("Worker & agents").

import { ConvexClient } from "convex/browser";

const CONVEX_URL = process.env.CONVEX_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!CONVEX_URL || !WORKER_SECRET) {
  console.error("Missing CONVEX_URL or WORKER_SECRET env vars");
  process.exit(1);
}

const client = new ConvexClient(CONVEX_URL);

async function main() {
  console.log(`[worker] connecting to ${CONVEX_URL}`);
  // Walking-skeleton placeholder: real subscription lands with the jobs table.
  //   client.onUpdate(api.worker.pending, { secret: WORKER_SECRET }, async (jobs) => {
  //     for (const job of jobs) await claimAndRun(job);
  //   });
  console.log("[worker] up — waiting for jobs table to exist");
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});

// Graceful shutdown under systemd restarts.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} — closing`);
    void client.close().finally(() => process.exit(0));
  });
}
