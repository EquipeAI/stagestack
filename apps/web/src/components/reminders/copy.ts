// ─────────────────────────────────────────────────────────────────────────
// Every user-facing sentence about reminder automation, in one place (W1).
//
// The task page and the settings page used to tell different stories: one said
// daily safety reminders continue when the cadence is off, the other said an
// empty cadence sends none. convex/reminders.ts is the tiebreaker, and it says
// BOTH halves of a smaller truth:
//
//   • Task chasing cadence = requirement override ?? event cadence. With
//     neither, `reminderCadenceDays()` falls back to one reminder a day, but
//     ONLY for a task inside the 48-hour due-soon window or already overdue.
//   • Participation chasing ("please confirm") runs ONLY when the event cadence
//     is set and greater than zero — an empty cadence stops it completely.
//
// So an empty cadence is not "no reminders" and it is not "business as usual":
// routine chasing stops, the due-date safety net does not. That is the one
// model both surfaces now state, from the constants below.
//
// A third fact the copy has to carry: `reminderCadenceDays()` reads
// `requirement.reminderCadenceDays ?? eventCadence`, so ANY requirement can set
// its own cadence (or silence itself with `remindersDisabled`). The event
// cadence is therefore a default, never a guarantee — one clause says so
// without turning the sentence into an enumeration.
// ─────────────────────────────────────────────────────────────────────────

import { POST_EVENT_GRACE_DAYS } from '@convex/shared/reminderSchedule'

/** The due-soon window the safety net covers, in hours (DUE_SOON_MS). */
export const DUE_SOON_HOURS = 48

/** What the sweep is, and what it is not. */
export const REMINDER_EVALUATION_COPY =
  'StageStack evaluates reminders once an hour. An evaluation is not a send: it checks who is actually due.'

/** The safety net, stated identically wherever cadence is discussed. */
export const REMINDER_SAFETY_COPY = `Tasks due within ${DUE_SOON_HOURS} hours, or already overdue, get one safety reminder a day even when no cadence is set.`

/**
 * The one sentence about what this event's cadence setting does. `null` is an
 * empty cadence field.
 */
export function reminderCadenceCopy(cadenceDays: number | null): string {
  if (cadenceDays === null) {
    return `No event reminder cadence is set, so routine task chasing and "please confirm" chasing are off unless a requirement sets its own cadence. ${REMINDER_SAFETY_COPY}`
  }
  const days = `${cadenceDays} ${cadenceDays === 1 ? 'day' : 'days'}`
  return `Each speaker gets at most one consolidated message every ${days} — outstanding tasks and, for speakers who have not answered yet, a request to confirm — unless a requirement sets its own cadence. ${REMINDER_SAFETY_COPY}`
}

/** Short state label for a badge or pill. */
export function reminderCadenceBadge(cadenceDays: number | null): string {
  return cadenceDays === null
    ? 'Routine reminders off'
    : `Every ${cadenceDays} ${cadenceDays === 1 ? 'day' : 'days'}`
}

/** The settings field hint — same model, field-sized. */
export const REMINDER_CADENCE_HINT = `Days between reminders. Leave it empty to stop routine chasing; tasks due within ${DUE_SOON_HOURS} hours or already overdue still get a daily safety reminder.`

/** What saving the cadence changed, for the settings toast. */
export function reminderCadenceSavedCopy(cadenceDays: number | null): string {
  return cadenceDays === null
    ? `Routine chasing is off for this event. ${REMINDER_SAFETY_COPY}`
    : `Reminders go out every ${cadenceDays} ${cadenceDays === 1 ? 'day' : 'days'}.`
}

/** Why a manual send is not the same thing as the automation. */
export const REMINDER_MANUAL_COPY =
  'Manual sends are marked separately in the comms log and reset the cadence clock for the tasks they included, so the automation does not immediately repeat them.'

/** The archived case — automation is off for a reason worth naming. */
export const REMINDER_ARCHIVED_COPY =
  'Automatic reminders are off because this event is archived.'

/**
 * The other off-switch, and the one nothing used to mention: `sweepEligible`
 * stops chasing POST_EVENT_GRACE_DAYS after `endsAt`, archived or not, so an
 * old event was being shown a next evaluation that provably never runs.
 */
export const REMINDER_POST_EVENT_COPY = `Automatic reminders have stopped: StageStack chases for ${POST_EVENT_GRACE_DAYS} days after an event ends, to cover post-event collection, and then goes quiet. Manual sends still work.`

/** One producer for "why is automation off", used by every surface. */
export function reminderDisabledCopy(reason: 'archived' | 'postEvent'): string {
  return reason === 'archived'
    ? REMINDER_ARCHIVED_COPY
    : REMINDER_POST_EVENT_COPY
}
