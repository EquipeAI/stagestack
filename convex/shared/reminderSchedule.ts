// ─────────────────────────────────────────────────────────────────────────
// The reminder sweep's schedule, shared by the cron registration and by the
// UI-facing prediction (W1).
//
// `crons.interval` anchors to whenever the cron was FIRST deployed, so the
// sweep fired at whatever minute that deploy happened to land on while the
// task page confidently predicted the top of the hour. Anchoring the sweep to
// a fixed UTC minute with `crons.cron` makes the prediction derivable instead
// of guessed. (`crons.hourly` is forbidden by
// convex/_generated/ai/guidelines.md:374, and its `minuteUTC` is
// backend-chosen when omitted — the exact unpredictability being fixed here.)
//
// Cron minutes are UTC and the epoch-hour arithmetic below is zone-free, so
// this stays correct for every event timezone; rendering in event time is the
// caller's job.
// ─────────────────────────────────────────────────────────────────────────

/** Minute past each UTC hour at which `internal.reminders.sweep` runs. */
export const SWEEP_MINUTE = 20;

/** How often the sweep evaluates. One entry, one hour — stated, not implied. */
export const SWEEP_INTERVAL_HOURS = 1;

/**
 * The anti-spam floor that applies when no cadence is configured at all: work
 * inside the due-soon window (or already overdue) is chased at most once a day.
 * Mirrors DUE_REMINDER_CADENCE_DAYS in convex/reminders.ts.
 */
export const SAFETY_CADENCE_DAYS = 1;

/** The crontab expression `crons.cron` registers. */
export const SWEEP_CRON = `${SWEEP_MINUTE} * * * *`;

/**
 * How long past `endsAt` the sweep keeps chasing. A week covers post-event
 * collection (slides, recordings); after that the automation goes quiet whether
 * or not anyone remembered to archive the event.
 *
 * It lives here rather than in reminders.ts because the UI has to state the
 * quiet window, and importing a Convex function module into the web app to read
 * one number is not a trade worth making.
 */
export const POST_EVENT_GRACE_DAYS = 7;

/**
 * The instant automation stops for an event that ends at `endsAt` — the same
 * boundary `sweepEligible` enforces, so the copy and the behaviour cannot
 * disagree. Archiving is a separate, earlier off-switch.
 */
export function automationQuietAfter(endsAt: number): number {
  return endsAt + POST_EVENT_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * The next time the sweep runs, STRICTLY after `now`.
 *
 * At 09:05 with SWEEP_MINUTE=20 this is 09:20; at 09:20 or 09:41 it is 10:20.
 * "Strictly after" matters: at exactly the sweep minute the run happening right
 * now is not a future evaluation, and predicting it would be the same lie in a
 * smaller window.
 */
export function nextSweepAt(now: number): number {
  const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS + SWEEP_MINUTE * MINUTE_MS;
  return thisHour > now ? thisHour : thisHour + HOUR_MS;
}
