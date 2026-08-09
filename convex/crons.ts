import { cronJobs } from "convex/server";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const crons = cronJobs();

crons.interval(
  "cleanup finalized resend emails",
  { hours: 1 },
  internal.crons.cleanupResend,
  {},
);

// Scheduled reminders (M5). Hourly is the sweep frequency, NOT the send
// frequency: each event's configured cadence (and each requirement's override)
// decides who is actually due, and `lastRemindedAt` keeps a re-run inside the
// same window a no-op. `sweep` only dispatches — it schedules one independent
// per-event mutation per eligible event (M8), so a failing event cannot
// starve the others.
crons.interval(
  "reminder sweep",
  { hours: 1 },
  internal.reminders.sweep,
  {},
);

// Worker-queue lease sweep: requeues jobs whose claim outlived the lease TTL
// (see convex/worker.ts sweepExpiredLeases).
crons.interval(
  "requeue expired job leases",
  { minutes: 5 },
  internal.worker.sweepExpiredLeases,
  {},
);

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const cleanupResend = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, components.resend.lib.cleanupOldEmails, {
      olderThan: ONE_WEEK_MS,
    });
    await ctx.scheduler.runAfter(0, components.resend.lib.cleanupAbandonedEmails, {
      olderThan: 4 * ONE_WEEK_MS,
    });
    return null;
  },
});

export default crons;
