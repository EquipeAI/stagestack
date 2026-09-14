import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The security headers (C3/S1) ship as `apps/web/vercel.json`, applied by
// Vercel's CDN rather than by any code in this repo — see the long rationale
// comment at the top of `vite.config.ts` for why that mechanism and not
// nitro route rules or Start middleware.
//
// Nothing in a local run can prove Vercel honours the file (that needs a
// preview deploy and a `curl -I`), so what IS pinned here is the part a future
// edit could silently get wrong: the SHAPE the docs require, and — the one
// with product consequences — the framing decision. `/embed/*` is the surface
// organizers paste into their own sites as an `<iframe>` (see
// `app.e.$eventSlug.publish.tsx` `embedUrls` and `ProgramView`), so a
// well-meaning "deny framing everywhere" would break a shipped feature on
// somebody else's website, where we would never see the error.

type HeaderEntry = { key: string; value: string }
type Rule = { source: string; headers: Array<HeaderEntry> }

const config = JSON.parse(
  readFileSync(`${process.cwd()}/vercel.json`, 'utf8'),
) as { headers: Array<Rule> }

/** Every header applied to `path`, later rules overriding earlier ones —
 * the same last-one-wins ordering Vercel gives entries in this array. */
function headersFor(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rule of config.headers) {
    if (!new RegExp(`^${rule.source}$`).test(path)) continue
    for (const { key, value } of rule.headers) out[key] = value
  }
  return out
}

/** `frame-ancestors` from a CSP string. */
function frameAncestors(csp: string): string | undefined {
  return csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('frame-ancestors '))
    ?.slice('frame-ancestors '.length)
}

describe('vercel.json security headers', () => {
  it('uses the high-level `headers` form, not legacy `routes`', () => {
    // The two are mutually exclusive in vercel.json; `routes` would also lose
    // the `continue: true` that keeps these from short-circuiting nitro's own
    // asset routing.
    expect(Object.keys(config)).not.toContain('routes')
    expect(Array.isArray(config.headers)).toBe(true)
  })

  it('ships CSP in report-only mode, never enforcing', () => {
    // Deliberate: an over-tight CSP breaks the app for real users with no
    // warning. Report-only surfaces the violations first; enforcing is a
    // later, separate flip.
    for (const rule of config.headers) {
      for (const { key } of rule.headers) {
        expect(key).not.toBe('Content-Security-Policy')
      }
    }
    expect(
      headersFor('/app/e/devconf')['Content-Security-Policy-Report-Only'],
    ).toBeDefined()
  })

  it('applies the transport and sniffing headers to every path', () => {
    for (const path of ['/', '/app/e/devconf', '/e/devconf', '/embed/devconf']) {
      const h = headersFor(path)
      expect(h['X-Content-Type-Options']).toBe('nosniff')
      expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
      expect(h['Strict-Transport-Security']).toMatch(/^max-age=\d+/)
    }
  })

  it('does not preload HSTS', () => {
    // `preload` is a one-way door for stagestack.dev AND every subdomain.
    // Not something to ship in the same change that first sets the header.
    expect(headersFor('/')['Strict-Transport-Security']).not.toContain(
      'preload',
    )
  })

  it('refuses framing of the app itself', () => {
    for (const path of ['/', '/app/e/devconf', '/portal/devconf', '/e/devconf']) {
      const h = headersFor(path)
      expect(h['X-Frame-Options']).toBe('DENY')
      expect(frameAncestors(h['Content-Security-Policy-Report-Only'])).toBe(
        "'none'",
      )
    }
  })

  it('lets any site frame /embed/* — that is the whole feature', () => {
    for (const path of ['/embed/devconf', '/embed/w/abc123']) {
      const h = headersFor(path)
      expect(h['X-Frame-Options']).toBeUndefined()
      expect(frameAncestors(h['Content-Security-Policy-Report-Only'])).toBe('*')
    }
  })

  it('allows the origins the app actually talks to', () => {
    const csp = headersFor('/app/e/devconf')['Content-Security-Policy-Report-Only']
    // Convex: the reactive websocket plus the HTTP-action origin.
    expect(csp).toContain('wss://*.convex.cloud')
    expect(csp).toContain('https://*.convex.site')
    // Clerk: the frontend API host is derived from the publishable key at
    // runtime (lib/preconnect.ts), so both the dev and the custom-domain
    // shapes have to be allowed by a static file.
    expect(csp).toContain('https://*.clerk.accounts.dev')
    expect(csp).toContain('https://clerk.stagestack.dev')
  })

  it("satisfies Clerk's six required directives", () => {
    // Per https://clerk.com/docs/guides/secure/best-practices/csp-headers.
    // Pinned per-directive rather than as a substring of the whole policy,
    // because the bug this replaces was exactly that: `*.protect.clerk.com`
    // present in script-src and absent from frame-src still "contains" it.
    const csp = headersFor('/app/e/devconf')['Content-Security-Policy-Report-Only']
    const directive = (name: string) =>
      csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `)) ?? ''

    // Clerk's abuse/fraud-protection embed ships on every plan, so it is
    // required in all three of these — not optional.
    expect(directive('script-src')).toContain('https://*.protect.clerk.com')
    expect(directive('connect-src')).toContain('https://*.protect.clerk.com')
    expect(directive('frame-src')).toContain('https://*.protect.clerk.com')
    // Cloudflare Turnstile, used by Clerk's bot protection.
    expect(directive('script-src')).toContain('https://challenges.cloudflare.com')
    expect(directive('frame-src')).toContain('https://challenges.cloudflare.com')
    expect(directive('worker-src')).toContain('blob:')
    expect(directive('style-src')).toContain("'unsafe-inline'")
    expect(directive('form-action')).toContain("'self'")
  })

  it("does not copy Clerk's wide-open script-src recommendation", () => {
    // Clerk's own recommended policy is `script-src 'self' 'unsafe-inline'
    // https: http:`, which restricts nothing. We allow named hosts instead.
    const csp = headersFor('/')['Content-Security-Policy-Report-Only']
    // A BARE scheme source (`https:` as its own token), not the `https:`
    // that begins every real host — hence the lookahead for a delimiter.
    expect(csp).not.toMatch(/script-src[^;]*\shttps:(?=[\s;]|$)/)
    expect(csp).not.toMatch(/script-src[^;]*\shttp:(?=[\s;]|$)/)
    // 'unsafe-eval' is Clerk's DEVELOPMENT-only addition. This one file also
    // covers production, so it must never appear here.
    expect(csp).not.toContain("'unsafe-eval'")
  })

  it('keeps /embed/* free of Clerk origins, as the target state', () => {
    // Deliberately stricter than the main policy: an embed renders anonymous
    // published data and should never need an identity provider.
    //
    // It is NOT yet enforceable — ClerkProvider is mounted in __root.tsx's
    // RootComponent and wraps every route, /embed/* included, so ClerkJS load
    // attempts on embed views WILL report violations against this policy.
    // Those reports are expected noise, and the fix is a root-layout split,
    // not a wider policy. See the comment block in vite.config.ts.
    const csp = headersFor('/embed/w/abc123')['Content-Security-Policy-Report-Only']
    expect(csp).not.toContain('clerk')
    expect(csp).not.toContain('cloudflare')
    // Still reaches Convex — that is where the published program comes from.
    expect(csp).toContain('https://*.convex.cloud')
  })

  it('keeps the always-on hardening directives', () => {
    const csp = headersFor('/')['Content-Security-Policy-Report-Only']
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("default-src 'self'")
  })
})
