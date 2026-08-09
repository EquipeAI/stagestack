// StageStack worker — runs on the exe.dev VM under systemd.
// Subscribes to the Convex jobs queue over WebSocket and executes claimed jobs.
// See docs/ARCHITECTURE.md ("Worker & agents").

import { ConvexClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { isJobType, type JobType } from "../../../convex/shared/jobTypes";
import { runHelloAgent } from "./hello-agent";

const CONVEX_URL = process.env.CONVEX_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!CONVEX_URL || !WORKER_SECRET) {
  console.error("Missing CONVEX_URL or WORKER_SECRET env vars");
  process.exit(1);
}
const secret = WORKER_SECRET;

const client = new ConvexClient(CONVEX_URL);
const inFlight = new Set<string>();

type PendingJob = { _id: Id<"jobs">; type: string; payload: unknown };

// One handler per registry entry (convex/shared/jobTypes.ts). Adding a job
// type without a handler here is a compile error.
const handlers: { [K in JobType]: (job: PendingJob) => Promise<unknown> } = {
  ping: async (job) => ({ pong: true, at: Date.now(), payload: job.payload }),
  "hello-agent": async (job) => await runHelloAgent(job._id),
};

async function runJob(job: PendingJob): Promise<unknown> {
  if (!isJobType(job.type)) {
    throw new Error(`Unknown job type: ${job.type}`);
  }
  return await handlers[job.type](job);
}

async function claimAndRun(job: PendingJob) {
  if (inFlight.has(job._id)) return;
  inFlight.add(job._id);
  try {
    const claimed = await client.mutation(api.worker.claim, {
      secret,
      jobId: job._id,
    });
    if (!claimed) return; // lost the race or already handled
    console.log(`[worker] claimed ${job.type} ${job._id}`);
    try {
      const result = await runJob(job);
      await client.mutation(api.worker.finish, {
        secret,
        jobId: job._id,
        result,
      });
      console.log(`[worker] done ${job._id}`);
    } catch (err) {
      await client.mutation(api.worker.finish, {
        secret,
        jobId: job._id,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[worker] failed ${job._id}`, err);
    }
  } finally {
    inFlight.delete(job._id);
  }
}

console.log(`[worker] connecting to ${CONVEX_URL}`);
client.onUpdate(api.worker.pending, { secret }, (jobs) => {
  for (const job of jobs) {
    void claimAndRun(job);
  }
});
console.log("[worker] subscribed to jobs queue");

// Graceful shutdown under systemd restarts.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} — closing`);
    void client.close().finally(() => process.exit(0));
  });
}
