import { describe, expect, test } from 'vitest'
import {
  NO_ADDRESS_BLOCKED,
  ONE_OFF_CADENCE_COPY,
  audienceExclusions,
  missingAddressExclusion,
  overCapRefusal,
} from './model'

// The confirmation must describe what `convex/model/comms.ts sendOneOff`
// actually does, not a plausible-sounding version of it.

describe('one-off send audience statements', () => {
  test('unreachable speakers are an exclusion, stated with the reason', () => {
    expect(
      audienceExclusions({
        skipped: 2,
        totalKnown: 10,
        truncated: false,
        count: 10,
      }),
    ).toEqual([
      '2 speakers have no reachable address — neither their own nor a primary manager’s.',
    ])
    expect(
      audienceExclusions({
        skipped: 0,
        totalKnown: 3,
        truncated: false,
        count: 3,
      }),
    ).toEqual([])
  })

  test('an over-cap audience is a REFUSAL, never a partial send', () => {
    // `sendOneOff` throws `audience_too_large` on `truncated`; nothing is sent.
    const refusal = overCapRefusal({ totalKnown: 260, truncated: true }, 200)
    expect(refusal).toContain('will be refused')
    expect(refusal).toContain('260')
    expect(refusal).toContain('200')
    expect(refusal).not.toContain('will not be included')
    expect(overCapRefusal({ totalKnown: 12, truncated: false }, 200)).toBeNull()
    // The over-cap case is not reported as an ordinary exclusion.
    expect(
      audienceExclusions({
        skipped: 0,
        totalKnown: 260,
        truncated: true,
        count: 200,
      }),
    ).toEqual([])
  })

  test('selected speakers with no address are skipped, and said so', () => {
    expect(missingAddressExclusion(0)).toBeNull()
    expect(missingAddressExclusion(1)).toBe(
      '1 selected speaker has no email address on this event and will be skipped.',
    )
    expect(missingAddressExclusion(3)).toContain('3 selected speakers')
  })

  test('a single contact with no address is a hard stop, not a skip', () => {
    // `contactRecipient` throws `invalid_email` for this case.
    expect(NO_ADDRESS_BLOCKED).toContain('no email address')
  })

  test('a one-off send does not touch reminder cadence', () => {
    expect(ONE_OFF_CADENCE_COPY).toContain('does not reset')
  })
})
