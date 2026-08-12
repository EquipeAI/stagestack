import { describe, expect, test } from 'vitest'
import {
  POST_EVENT_GRACE_DAYS,
  SAFETY_CADENCE_DAYS,
} from '@convex/shared/reminderSchedule'
import {
  DUE_SOON_HOURS,
  REMINDER_CADENCE_HINT,
  REMINDER_POST_EVENT_COPY,
  REMINDER_SAFETY_COPY,
  reminderCadenceBadge,
  reminderCadenceCopy,
  reminderCadenceSavedCopy,
  reminderDisabledCopy,
} from './copy'

// The bug this file exists to prevent: the tasks page said daily safety
// reminders continue with the cadence off while settings said an empty cadence
// sends none. convex/reminders.ts says routine chasing stops and the due-date
// safety net does not — one model, one producer, both surfaces.

describe('reminder cadence copy', () => {
  test('an empty cadence stops routine chasing but keeps the safety net', () => {
    const copy = reminderCadenceCopy(null)
    expect(copy).toContain('No event reminder cadence is set')
    expect(copy).toContain('routine task chasing')
    expect(copy).toContain(REMINDER_SAFETY_COPY)
    expect(copy).toContain(`${DUE_SOON_HOURS} hours`)
  })

  test('a configured cadence states the consolidated-message model', () => {
    expect(reminderCadenceCopy(7)).toContain('every 7 days')
    expect(reminderCadenceCopy(1)).toContain('every 1 day')
    // The safety net is stated on both branches, so neither surface can imply
    // that turning the cadence off silences due-date chasing.
    expect(reminderCadenceCopy(7)).toContain(REMINDER_SAFETY_COPY)
  })

  test('the safety net is a daily floor, matching the backend constant', () => {
    expect(SAFETY_CADENCE_DAYS).toBe(1)
    expect(REMINDER_SAFETY_COPY).toContain('one safety reminder a day')
  })

  test('both branches acknowledge per-requirement overrides', () => {
    // `reminderCadenceDays()` reads `requirement.reminderCadenceDays ??
    // eventCadence`, so the event cadence is a default, not a guarantee —
    // neither branch may state it as absolute.
    expect(reminderCadenceCopy(7)).toContain(
      'unless a requirement sets its own cadence',
    )
    expect(reminderCadenceCopy(null)).toContain(
      'unless a requirement sets its own cadence',
    )
  })

  test('the post-event quiet window is named, with the real grace period', () => {
    expect(REMINDER_POST_EVENT_COPY).toContain(`${POST_EVENT_GRACE_DAYS} days`)
    expect(reminderDisabledCopy('postEvent')).toBe(REMINDER_POST_EVENT_COPY)
    expect(reminderDisabledCopy('archived')).toContain('archived')
    // The two off-switches must not be worded as the same thing.
    expect(reminderDisabledCopy('postEvent')).not.toBe(
      reminderDisabledCopy('archived'),
    )
  })

  test('the badge and hint agree with the sentence', () => {
    expect(reminderCadenceBadge(null)).toBe('Routine reminders off')
    expect(reminderCadenceBadge(2)).toBe('Every 2 days')
    expect(REMINDER_CADENCE_HINT).toContain('stop routine chasing')
    expect(reminderCadenceSavedCopy(null)).toContain('Routine chasing is off')
    expect(reminderCadenceSavedCopy(3)).toContain('every 3 days')
  })
})
