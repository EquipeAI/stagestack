import { describe, expect, test } from 'vitest'
import { parseContactsCsv } from './CrmTools'

describe('contact CSV preview', () => {
  test('parses quoted fields and optional CRM columns', () => {
    const parsed = parseContactsCsv(
      'firstName,lastName,email,company,tags\nAda,Lovelace,ada@example.com,"Analytical, Inc","keynote;vip"\n',
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.rows).toEqual([
      {
        rowNumber: 2,
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        company: 'Analytical, Inc',
        jobTitle: undefined,
        tags: ['keynote', 'vip'],
      },
    ])
  })

  test('requires canonical name and email headers and detects unclosed quotes', () => {
    expect(
      parseContactsCsv('company,email\nAnalytical,ada@example.com').errors[0],
    ).toContain('Headers must include')
    expect(
      parseContactsCsv(
        'firstName,lastName,email\n"Ada,Lovelace,ada@example.com',
      ).errors[0],
    ).toContain('unclosed')
  })

  test('accepts the evaluation fixture shape with one name column', () => {
    const parsed = parseContactsCsv(
      'name,email,title,company,bio\nPriya Raman,priya@example.com,Principal Engineer,Latticework Systems,"Leads the build-tooling platform team."\n',
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.rows[0]).toMatchObject({
      firstName: 'Priya',
      lastName: 'Raman',
      email: 'priya@example.com',
      jobTitle: 'Principal Engineer',
      company: 'Latticework Systems',
      bio: 'Leads the build-tooling platform team.',
    })
  })
})
