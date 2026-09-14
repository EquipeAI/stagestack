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
import { runImportPlan } from "./import-agent";

// Lease renewal interval. Must stay well under the deployment's
// WORKER_LEASE_TTL_MS (10 min, convex/worker.ts) — an import plan is ~10
// sequential LLM exchanges of up to 5 min each, so without renewals the sweep
// would requeue a job that is still running and a second worker would plan it
// concurrently (double LLM spend, clobbered capture map). Duplicated rather
// than imported: importing convex/worker.ts would drag the Convex function
// registry into this Node process.
const HEARTBEAT_MS = 2 * 60 * 1000;

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
// Fencing token minted by `claim`. Every later call about the job carries it,
// so a worker whose lease was swept and re-claimed elsewhere is refused
// instead of mutating a job it no longer owns.
type Lease = { claimToken: string };

// One handler per registry entry (convex/shared/jobTypes.ts). Adding a job
// type without a handler here is a compile error.
const handlers: {
  [K in JobType]: (job: PendingJob, lease: Lease) => Promise<unknown>;
} = {
  ping: async (job) => ({ pong: true, at: Date.now(), payload: job.payload }),
  "hello-agent": async (job) => await runHelloAgent(job._id),
  "import-plan": async (job) => {
    // A mutation, not a query: the deployment consumes worker rate-limit
    // budget for this call (convex/worker.ts `importContext`).
    const context = await client.mutation(api.worker.importContext, {
      secret,
      jobId: job._id,
    });
    return await runImportPlan(job._id, context);
  },
  "import-execute": async (job, lease) => {
    // The approved records live on the job row; the deployment slices them by
    // batchIndex. We only count batches here — sending records would let this
    // process (or an agent that manipulated it) execute rows the organizer
    // never approved.
    const { records } = job.payload as { records?: PlannedRecord[] };
    if (!Array.isArray(records) || records.length === 0) {
      // Only imports.confirm enqueues these, and it rejects an empty
      // selection — so this means the row was tampered with or truncated.
      throw new Error("import-execute job has no approved records");
    }
    const total = records.length;
    const batchCount = Math.ceil(total / IMPORT_LIMITS.executeBatch);
    const results: RecordResult[] = [];
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
      // batchIndex is the idempotency key: a re-run after a lost response
      // replays the recorded results instead of duplicating writes.
      const batchResults = await client.mutation(
        api.worker.importExecuteBatch,
        {
          secret,
          jobId: job._id,
          claimToken: lease.claimToken,
          batchIndex,
        },
      );
      results.push(...batchResults);
      console.log(
        `[worker] import ${job._id}: ${Math.min(results.length, total)}/${total} records`,
      );
    }
    return {
      total,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  },
};

async function runJob(job: PendingJob, lease: Lease): Promise<unknown> {
  if (!isJobType(job.type)) {
    throw new Error(`Unknown job type: ${job.type}`);
  }
  return await handlers[job.type](job, lease);
}

/** Renew the lease until the returned stop() is called. A refused renewal
 * means the lease is gone (swept and re-claimed, or already finished): stop
 * renewing and say so loudly — the job's own finish will be refused too. */
function startHeartbeat(job: PendingJob, lease: Lease): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const held = await client.mutation(api.worker.touch, {
          secret,
          jobId: job._id,
          claimToken: lease.claimToken,
        });
        if (!held) {
          clearInterval(timer);
          console.warn(
            `[worker] lost the lease on ${job._id} — its results will be discarded`,
          );
        }
      } catch (err) {
        // Transport blip: keep the timer, the TTL tolerates a few misses.
        console.error(`[worker] heartbeat failed for ${job._id}`, err);
      }
    })();
  }, HEARTBEAT_MS);
  // Don't hold the event loop open on shutdown.
  timer.unref();
  return () => clearInterval(timer);
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
    const claimToken = await client.mutation(api.worker.claim, {
      secret,
      jobId: job._id,
    });
    if (claimToken === null) return; // lost the race or already handled
    const lease: Lease = { claimToken };
    console.log(`[worker] claimed ${job.type} ${job._id}`);
    const stopHeartbeat = startHeartbeat(job, lease);
    try {
      const result = await runJob(job, lease);
      const accepted = await client.mutation(api.worker.finish, {
        secret,
        jobId: job._id,
        claimToken,
        result,
      });
      console.log(
        accepted
          ? `[worker] done ${job._id}`
          : `[worker] finish refused for ${job._id} (lease lost) — result discarded`,
      );
    } catch (err) {
      // Job failure: report it. If this finish itself throws, the outer
      // catch logs and the lease sweep requeues the job.
      await client.mutation(api.worker.finish, {
        secret,
        jobId: job._id,
        claimToken,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[worker] failed ${job._id}`, err);
    } finally {
      stopHeartbeat();
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
