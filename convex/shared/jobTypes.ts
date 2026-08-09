import { v, type Infer } from "convex/values";

// Job-type registry: the single source of truth for what can go on the queue.
// Both enqueue sites (convex/model/jobs.ts) and the worker's handler map
// (apps/worker/src/index.ts) derive from this object, so adding a job type
// without a payload validator or a handler is a type error, not a runtime
// surprise.
export const jobPayloadValidators = {
  ping: v.object({ sentAt: v.number() }),
  "hello-agent": v.object({ sentAt: v.number() }),
  // Import agent (M2): plan from an uploaded file, then execute the
  // organizer-confirmed plan. See convex/shared/importPlan.ts.
  "import-plan": v.object({
    eventId: v.id("events"),
    storageId: v.id("_storage"),
    filename: v.string(),
    description: v.optional(v.string()),
  }),
  "import-execute": v.object({
    eventId: v.id("events"),
    planJobId: v.id("jobs"),
    // The organizer-approved subset of the plan, copied at confirm time so
    // the worker needs no extra reads and the approved set is immutable.
    records: v.array(v.any()),
  }),
} as const;

export type JobType = keyof typeof jobPayloadValidators;

export type JobPayload<T extends JobType> = Infer<
  (typeof jobPayloadValidators)[T]
>;

export function isJobType(type: string): type is JobType {
  return type in jobPayloadValidators;
}
