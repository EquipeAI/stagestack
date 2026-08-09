import { v, type Infer } from "convex/values";

// Job-type registry: the single source of truth for what can go on the queue.
// Both enqueue sites (convex/model/jobs.ts) and the worker's handler map
// (apps/worker/src/index.ts) derive from this object, so adding a job type
// without a payload validator or a handler is a type error, not a runtime
// surprise.
export const jobPayloadValidators = {
  ping: v.object({ sentAt: v.number() }),
  "hello-agent": v.object({ sentAt: v.number() }),
} as const;

export type JobType = keyof typeof jobPayloadValidators;

export type JobPayload<T extends JobType> = Infer<
  (typeof jobPayloadValidators)[T]
>;

export const jobTypes = Object.keys(jobPayloadValidators) as JobType[];

export function isJobType(type: string): type is JobType {
  return type in jobPayloadValidators;
}
