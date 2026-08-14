import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'

// Where this deployment thinks it lives. Every shareable link and every piece
// of link-preview metadata (og:url, canonical) has to name the origin the
// visitor actually reached, or a self-hosted install / Vercel preview
// advertises stagestack.dev and sends readers to someone else's data.

/**
 * The hosted product's own origin. Last-resort answer for the origin, and the
 * right link for the "Powered by StageStack" credit even on a self-host.
 */
export const PRODUCT_ORIGIN = 'https://stagestack.dev'

/**
 * hostname[:port] we are willing to paste into a URL — DNS label characters or
 * a bracketed IPv6 literal. `Host` is attacker-controlled, so it is validated
 * rather than trusted: anything carrying `/`, `?`, `@`, whitespace or a second
 * comma-separated hop is rejected instead of sanitised.
 */
const HOST_PATTERN =
  /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i

/** Hosts that are reached over plain http in practice (the dev server). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * A proxy chain appends rather than replaces: `x-forwarded-host: example.com,
 * internal.svc:8080`. The visitor-facing hop is the first entry.
 */
function firstHop(raw: string | undefined): string {
  return (raw ?? '').split(',')[0].trim()
}

/**
 * `SITE_URL`-style config value reduced to a bare origin, or null if unusable.
 *
 * An `http:` SITE_URL is accepted on purpose, and that is NOT the same gap the
 * `https` floor below closes: SITE_URL is operator-set deployment config, not
 * attacker-controlled request input, and a self-host serving a plain-http
 * internal origin is a legitimate deployment. The S3 threat was the
 * client-supplied `x-forwarded-proto` header only. Reviewed and ruled on
 * 2026-08-13 — please don't "fix" this into breaking self-hosters.
 */
function configuredOrigin(siteUrl: string | undefined): string | null {
  if (siteUrl === undefined || siteUrl.trim() === '') return null
  try {
    const url = new URL(siteUrl)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.origin
      : null
  } catch {
    return null
  }
}

/**
 * Resolve the origin from request headers, in order: the (forwarded) host the
 * visitor asked for, then the deployment's configured `SITE_URL`, then the
 * product origin.
 *
 * Reflecting `Host` is safe *here* because the value only ever reaches
 * metadata and copyable links — text rendered into the page for the same
 * visitor who sent the header. It must never reach a redirect `Location`, a
 * cookie domain, an email body or an allow-list check, where a forged Host
 * would move a real user (or a real secret) to the attacker's origin.
 *
 * Exported for tests; callers want `siteOrigin()`.
 */
export function resolveOrigin(opts: {
  header: (name: string) => string | undefined
  siteUrl?: string | undefined
}): string {
  const host = firstHop(
    // The proxy header wins: behind Vercel/Fly/nginx, `Host` is the internal
    // name and `X-Forwarded-Host` is the one the visitor typed.
    opts.header('x-forwarded-host') ?? opts.header('host'),
  )
  if (HOST_PATTERN.test(host)) {
    const forwardedProto = firstHop(opts.header('x-forwarded-proto'))
    const isLoopback = LOOPBACK_HOSTS.has(host.replace(/:\d+$/, ''))
    // `https` floor: the proto header is client-supplied, so it may only
    // *select* http for a loopback host (where there is no TLS to speak of).
    // Vercel's edge overwrites the header, but nothing here may depend on it —
    // otherwise a forged `x-forwarded-proto: http` downgrades every generated
    // link on any other deployment.
    const scheme = isLoopback
      ? forwardedProto === 'https'
        ? 'https'
        : 'http'
      : 'https'
    return `${scheme}://${host}`
  }
  return configuredOrigin(opts.siteUrl) ?? PRODUCT_ORIGIN
}

function serverOrigin(): string {
  // createIsomorphicFn is a compile-time split, and the Start compiler only
  // runs in the app build — under vitest this server branch is what executes,
  // in jsdom, where the browser answer is both available and correct.
  if (typeof window !== 'undefined') return window.location.origin
  try {
    return resolveOrigin({
      header: (name) => getRequestHeader(name),
      // Same env var convex/model/comms.ts uses to build emailed links, so a
      // self-host configures its origin in exactly one place.
      siteUrl: process.env.SITE_URL,
    })
  } catch {
    // getRequestHeader() throws outside a request (prerender, scripts, tests):
    // no request means no host to reflect.
    return configuredOrigin(process.env.SITE_URL) ?? PRODUCT_ORIGIN
  }
}

/**
 * The origin this app is being served from. On the client that is simply the
 * browser's own origin; on the server it is derived from the incoming request
 * so SSR'd metadata matches the host the crawler fetched.
 */
export const siteOrigin: () => string = createIsomorphicFn()
  .server(() => serverOrigin())
  .client(() => window.location.origin)
