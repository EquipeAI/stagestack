/**
 * The third-party origins the app connects to on its very first interaction,
 * so they can be `preconnect`ed from the SSR'd <head>.
 *
 * Both are on the critical path but neither is discoverable from the HTML:
 *
 *  - Clerk's Frontend API. `ClerkProvider` injects `clerk.browser.js` (~90KB
 *    brotli) from this host at runtime, so the browser cannot even begin the
 *    DNS lookup until React has mounted and run — three round trips (DNS, TLS,
 *    fetch) serialised after hydration starts.
 *  - Convex. Every route's data comes over a WebSocket to this host, opened by
 *    the client after hydration.
 *
 * `preconnect` does the DNS + TCP + TLS work in parallel with the rest of the
 * page load, so by the time the script/socket is actually requested the
 * connection is already warm. Two origins is within the budget where this is a
 * win rather than contention.
 */

/**
 * Clerk's Frontend API host, decoded from the publishable key.
 *
 * A publishable key is `pk_(test|live)_<base64 of "host$">`, which is how the
 * Clerk SDK itself derives the script URL — deriving it the same way means a
 * self-hoster's own Clerk instance gets preconnected too, instead of us
 * hardcoding the hosted product's domain and mispointing every fork.
 */
export function clerkFapiOrigin(
  publishableKey: string | undefined,
): string | null {
  if (publishableKey === undefined || publishableKey === '') return null
  const encoded = publishableKey.replace(/^pk_(test|live)_/, '')
  if (encoded === publishableKey) return null
  try {
    // The key's payload is the host with a `$` sentinel appended.
    const decoded = atob(encoded)
    const host = decoded.endsWith('$') ? decoded.slice(0, -1) : decoded
    // Guard against a malformed key turning into a bogus <link>.
    if (host === '' || /[^a-zA-Z0-9.-]/.test(host)) return null
    return `https://${host}`
  } catch {
    return null
  }
}

/** Origin of the Convex deployment, or null when the URL is unusable. */
export function convexOrigin(convexUrl: string | undefined): string | null {
  if (convexUrl === undefined || convexUrl === '') return null
  try {
    return new URL(convexUrl).origin
  } catch {
    return null
  }
}

/** `<link rel=preconnect>` descriptors for every known critical third origin. */
export function preconnectOrigins(env: {
  clerkPublishableKey: string | undefined
  convexUrl: string | undefined
}): Array<string> {
  return [
    clerkFapiOrigin(env.clerkPublishableKey),
    convexOrigin(env.convexUrl),
  ].filter((o): o is string => o !== null)
}
