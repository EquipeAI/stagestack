import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { JobPayload, JobType } from "../shared/jobTypes";

/**
 * The only way to put work on the worker queue. Typed against the job-type
 * registry so an enqueue site can't drift from the worker's handler map.
 * `initiatedBy` is the user whose authority the worker executes with.
 */
export async function enqueueJob<T extends JobType>(
  ctx: MutationCtx,
  type: T,
  payload: JobPayload<T>,
  initiatedBy?: Id<"users">,
): Promise<Id<"jobs">> {
  return await ctx.db.insert("jobs", {
    type,
    payload,
    status: "queued",
    initiatedBy,
  });
}
