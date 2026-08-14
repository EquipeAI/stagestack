import { describe, expect, it } from 'vitest'
import { PRODUCT_ORIGIN, resolveOrigin, siteOrigin } from './origin'

/** resolveOrigin() takes a header lookup, so a request can be faked as a map. */
function headersOf(map: Record<string, string>) {
  return (name: string) => map[name.toLowerCase()]
}

describe('resolveOrigin', () => {
  it('uses the request Host, https by default', () => {
    expect(
      resolveOrigin({ header: headersOf({ host: 'events.acme.com' }) }),
    ).toBe('https://events.acme.com')
  })

  it('keeps the port, and localhost stays http', () => {
    expect(
      resolveOrigin({ header: headersOf({ host: 'localhost:3000' }) }),
    ).toBe('http://localhost:3000')
    expect(
      resolveOrigin({ header: headersOf({ host: '127.0.0.1:3000' }) }),
    ).toBe('http://127.0.0.1:3000')
  })

  it('lets the forwarded host beat Host', () => {
    expect(
      resolveOrigin({
        header: headersOf({
          host: 'internal.svc:8080',
          'x-forwarded-host': 'program.acme.com',
          'x-forwarded-proto': 'https',
        }),
      }),
    ).toBe('https://program.acme.com')
  })

  it('floors non-loopback hosts at https, whatever the proto header says', () => {
    // `x-forwarded-proto` is client-supplied. The edge overwrites it in
    // practice, but a forged `http` must never downgrade a generated link.
    expect(
      resolveOrigin({
        header: headersOf({
          host: 'internal.svc:8080',
          'x-forwarded-host': 'staging.internal',
          'x-forwarded-proto': 'http',
        }),
      }),
    ).toBe('https://staging.internal')
    expect(
      resolveOrigin({
        header: headersOf({
          host: 'events.acme.com',
          'x-forwarded-proto': 'http',
        }),
      }),
    ).toBe('https://events.acme.com')
    // Only a loopback host may still select http — and may still opt into
    // https when it is genuinely served over TLS.
    expect(
      resolveOrigin({
        header: headersOf({
          host: 'localhost:3000',
          'x-forwarded-proto': 'http',
        }),
      }),
    ).toBe('http://localhost:3000')
    expect(
      resolveOrigin({
        header: headersOf({
          host: 'localhost:3000',
          'x-forwarded-proto': 'https',
        }),
      }),
    ).toBe('https://localhost:3000')
  })

  it('takes the visitor-facing hop when a proxy chain appended', () => {
    expect(
      resolveOrigin({
        header: headersOf({
          'x-forwarded-host': 'program.acme.com, internal.svc:8080',
          'x-forwarded-proto': 'https, http',
        }),
      }),
    ).toBe('https://program.acme.com')
  })

  it('ignores a Host that is not a bare hostname', () => {
    // A forged Host must not be able to smuggle a path or a second origin into
    // og:url; the configured origin is used instead of sanitising it.
    for (const host of [
      'acme.com/evil',
      'acme.com evil.com',
      'user@evil.com',
      'acme.com?x=1',
      '',
    ]) {
      expect(
        resolveOrigin({
          header: headersOf({ host }),
          siteUrl: 'https://self.host',
        }),
      ).toBe('https://self.host')
    }
  })

  it('falls back to SITE_URL, then to the product origin', () => {
    const noHeaders = () => undefined
    expect(
      resolveOrigin({ header: noHeaders, siteUrl: 'https://self.host/' }),
    ).toBe('https://self.host')
    // A path or query on SITE_URL is dropped: an origin has neither.
    expect(
      resolveOrigin({
        header: noHeaders,
        siteUrl: 'http://self.host:8080/base?x=1',
      }),
    ).toBe('http://self.host:8080')
    expect(resolveOrigin({ header: noHeaders })).toBe(PRODUCT_ORIGIN)
    for (const siteUrl of ['', '   ', 'not a url', 'ftp://self.host']) {
      expect(resolveOrigin({ header: noHeaders, siteUrl })).toBe(PRODUCT_ORIGIN)
    }
  })

  it('accepts a bracketed IPv6 literal', () => {
    expect(resolveOrigin({ header: headersOf({ host: '[::1]:3000' }) })).toBe(
      'http://[::1]:3000',
    )
  })
})

describe('siteOrigin', () => {
  it('answers with the browser origin when a window exists', () => {
    // The real build compiles the client/server split away; in a browser (and
    // in jsdom, which runs the uncompiled server branch) the browser's own
    // origin has to win — never the hosted product's.
    expect(siteOrigin()).toBe(window.location.origin)
    expect(siteOrigin()).not.toBe(PRODUCT_ORIGIN)
  })
})
