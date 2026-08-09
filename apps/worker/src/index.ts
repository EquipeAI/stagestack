// StageStack worker — runs on the exe.dev VM under systemd.
// Subscribes to the Convex jobs queue over WebSocket and executes claimed jobs.
// See docs/ARCHITECTURE.md ("Worker & agents").

import { ConvexClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { isJobType, type JobType } from "../../../convex/shared/jobTypes";
import {
  IMPORT_LIMITS,
  type PlannedRecord,
  type RecordResult,
} from "../../../convex/shared/importPlan";
import { runHelloAgent } from "./hello-agent";
import { runImportPlan, type ImportContext } from "./import-agent";

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
  "import-plan": async (job) => {
    const context = (await client.query(api.worker.importContext, {
      secret,
      jobId: job._id,
    })) as ImportContext;
    return await runImportPlan(job._id, context);
  },
  "import-execute": async (job) => {
    const { records } = job.payload as { records: PlannedRecord[] };
    const results: RecordResult[] = [];
    for (let i = 0; i < records.length; i += IMPORT_LIMITS.executeBatch) {
      const batch = records.slice(i, i + IMPORT_LIMITS.executeBatch);
      // batchIndex is the idempotency key: a re-run after a lost response
      // replays the recorded results instead of duplicating writes.
      const batchResults = await client.mutation(
        api.worker.importExecuteBatch,
        {
          secret,
          jobId: job._id,
          batchIndex: i / IMPORT_LIMITS.executeBatch,
          records: batch,
        },
      );
      results.push(...batchResults);
      console.log(
        `[worker] import ${job._id}: ${Math.min(i + batch.length, records.length)}/${records.length} records`,
      );
    }
    return {
      total: records.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  },
};

async function runJob(job: PendingJob): Promise<unknown> {
  if (!isJobType(job.type)) {
    throw new Error(`Unknown job type: ${job.type}`);
  }
  return await handlers[job.type](job);
}

// Set while shutting down: no new claims, in-flight jobs get to finish.
let draining = false;

async function claimAndRun(job: PendingJob) {
  if (draining || inFlight.has(job._id)) return;
  inFlight.add(job._id);
  // Everything below stays inside this try: claim/finish are network calls,
  // and an escaped rejection here would crash the process (systemd
  // Restart=always would then crash-loop against the same job).
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
      // Job failure: report it. If this finish itself throws, the outer
      // catch logs and the lease sweep requeues the job.
      await client.mutation(api.worker.finish, {
        secret,
        jobId: job._id,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[worker] failed ${job._id}`, err);
    }
  } catch (err) {
    // Claim or finish never reached the deployment. Don't rethrow: the lease
    // sweep recovers the job once the claim (if any) expires.
    console.error(
      `[worker] transport error on ${job._id} — lease sweep will recover`,
      err,
    );
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

// Graceful shutdown under systemd restarts: stop claiming, drain in-flight
// jobs (bounded — systemd's default TimeoutStopSec is 90s, then SIGKILL),
// then close. Jobs still running at the deadline are left to the lease sweep.
const DRAIN_TIMEOUT_MS = 60_000;

function shutdown(sig: string) {
  if (draining) return; // second signal: drain already in progress
  draining = true;
  console.log(`[worker] ${sig} — draining ${inFlight.size} in-flight job(s)`);
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  const poll = setInterval(() => {
    if (inFlight.size > 0 && Date.now() < deadline) return;
    clearInterval(poll);
    if (inFlight.size > 0) {
      console.warn(
        `[worker] drain timeout — abandoning ${inFlight.size} job(s) to the lease sweep`,
      );
    }
    void client.close().finally(() => process.exit(0));
  }, 250);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => shutdown(sig));
}
