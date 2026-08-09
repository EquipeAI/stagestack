import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouteContext,
} from '@tanstack/react-router'
import { ClerkProvider, useAuth } from '@clerk/tanstack-react-start'
import { auth } from '@clerk/tanstack-react-start/server'
import { createServerFn } from '@tanstack/react-start'
import { ConvexProviderWithClerk } from 'convex/react-clerk'
import * as React from 'react'
import type { ConvexQueryClient } from '@convex-dev/react-query'
import type { ConvexReactClient } from 'convex/react'
import type { QueryClient } from '@tanstack/react-query'
import { RouteNotFound } from '~/components/RouteBoundary'
import { useKeyboardInset } from '~/lib/useKeyboardInset'
import { preconnectOrigins } from '~/lib/preconnect'
import appCss from '~/styles/app.css?url'

const fetchClerkAuth = createServerFn({ method: 'GET' }).handler(async () => {
  const { userId, getToken } = await auth()
  const token = await getToken({ template: 'convex' })
  return { userId, token }
})

type ClerkAuth = { userId: string | null; token: string | null }

// `beforeLoad` runs on every navigation and — because the router preloads on
// intent — on every link hover, so calling fetchClerkAuth() straight through
// means a server round-trip per hover. One recent (or still in-flight) result
// is reused instead.
//
// Client-side only, on purpose: on the server this module is shared by every
// concurrent request, so a module-level cache would be a way to hand one
// visitor's token to another. `typeof window` is the SSR/browser split, and a
// browser cache is per tab, i.e. per signed-in user.
const AUTH_TTL_MS = 30_000
/** Never serve a cached token this close to its own `exp`. */
const EXPIRY_MARGIN_MS = 10_000

let cachedAuth: { promise: Promise<ClerkAuth>; expiresAt: number } | null = null

/** A JWT's `exp` in ms, or null when the token cannot be read. */
function tokenExpiry(token: string | null): number | null {
  const encoded = token?.split('.')[1]
  if (encoded === undefined || encoded === '') return null
  try {
    const json: unknown = JSON.parse(
      atob(encoded.replace(/-/g, '+').replace(/_/g, '/')),
    )
    const exp =
      json !== null && typeof json === 'object'
        ? (json as { exp?: unknown }).exp
        : undefined
    return typeof exp === 'number' ? exp * 1000 : null
  } catch {
    return null
  }
}

function clerkAuth(): Promise<ClerkAuth> {
  if (typeof window === 'undefined') return fetchClerkAuth()
  const now = Date.now()
  if (cachedAuth !== null && cachedAuth.expiresAt > now) return cachedAuth.promise
  const entry = { promise: fetchClerkAuth(), expiresAt: now + AUTH_TTL_MS }
  cachedAuth = entry
  void entry.promise.then(
    ({ token }) => {
      // Clerk's Convex template lives ~60s. When the token says when it dies,
      // that wins over the TTL — a cached token is never served past its own
      // lifetime, even if the clocks disagree by a few seconds.
      const exp = tokenExpiry(token)
      if (exp !== null) {
        entry.expiresAt = Math.min(entry.expiresAt, exp - EXPIRY_MARGIN_MS)
      }
    },
    () => {
      // A failed fetch must not be remembered: the next navigation retries.
      if (cachedAuth === entry) cachedAuth = null
    },
  )
  return entry.promise
}

/** Signing in or out must never be papered over by a cached token. */
function forgetClerkAuth() {
  cachedAuth = null
}

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
  convexClient: ConvexReactClient
  convexQueryClient: ConvexQueryClient
}>()({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        // `viewport-fit=cover` lets the page paint into the notch/home-indicator
        // area; the --safe-* tokens in layout.css keep content out of it.
        //
        // Deliberately NO `interactive-widget`: it is Chromium-Android and
        // Firefox-Android only (not Safari or Safari iOS as of 26.5), so it
        // cannot be the answer to keyboard occlusion, and `resizes-content`
        // buys Android-only layout-viewport reflow — i.e. relayout and possible
        // CLS on every keyboard open — for a fix that still needs a JS shim on
        // iPhone. The shim (useKeyboardInset) handles both platforms uniformly,
        // so the meta key would be cost without benefit.
        //
        // Also no `maximum-scale`/`user-scalable=no`: blocking pinch-zoom is an
        // accessibility failure, and iOS ignores it anyway.
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      {
        title: 'StageStack',
      },
      {
        name: 'theme-color',
        // eslint-disable-next-line no-restricted-syntax -- <meta> needs a literal; matches --gray-900
        content: '#131920',
      },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      // The two faces that paint first-viewport text. They are referenced from
      // inside app.css, so without these the browser cannot discover them until
      // the stylesheet has downloaded AND parsed — preloading starts both
      // fetches in the same round trip as the CSS itself.
      // `crossOrigin` is required on font preloads even same-origin: fonts are
      // fetched in CORS mode, and a preload whose mode does not match is
      // discarded and re-fetched.
      {
        rel: 'preload',
        as: 'font',
        type: 'font/woff2',
        href: '/fonts/geist-latin-wght-normal.woff2',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'preload',
        as: 'font',
        type: 'font/woff2',
        href: '/fonts/instrument-sans-latin-wght-normal.woff2',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/apple-touch-icon.png',
      },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/favicon-32x32.png',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '16x16',
        href: '/favicon-16x16.png',
      },
      { rel: 'manifest', href: '/site.webmanifest' },
      { rel: 'icon', sizes: '48x48', href: '/favicon.ico' },
      // Warm the two origins the app must reach before it can show anything
      // useful, neither of which is discoverable from the HTML: Clerk's script
      // is injected by ClerkProvider after hydration, and Convex is a WebSocket
      // opened by the client. Without these, DNS + TLS for both are serialised
      // after hydration instead of overlapping the initial page load.
      ...preconnectOrigins({
        clerkPublishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
        convexUrl: import.meta.env.VITE_CONVEX_URL,
      }).map((href) => ({
        rel: 'preconnect',
        href,
        // Both are CORS/credentialed fetches; a preconnect whose credentials
        // mode does not match the eventual request opens a second connection
        // and wastes the handshake it just paid for.
        crossOrigin: 'anonymous' as const,
      })),
    ],
  }),
  beforeLoad: async (ctx) => {
    const { userId, token } = await clerkAuth()
    // During SSR only (the only time serverHttpClient exists), set the auth
    // token for Convex HTTP queries so loaders render authenticated data.
    if (token) {
      ctx.context.convexQueryClient.serverHttpClient?.setAuth(token)
    }
    return { userId, token }
  },
  notFoundComponent: RouteNotFound,
  component: RootComponent,
})

function RootComponent() {
  const context = useRouteContext({ from: Route.id })
  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={context.convexClient} useAuth={useAuth}>
        <RootDocument>
          <Outlet />
        </RootDocument>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  )
}

/**
 * The safety net for the token cache above: whenever Clerk changes who is
 * signed in, the cached token is dropped at once rather than living out its
 * TTL under the new identity.
 */
function ClerkAuthCacheReset() {
  const { isSignedIn, userId } = useAuth()
  React.useEffect(() => {
    forgetClerkAuth()
  }, [isSignedIn, userId])
  return null
}

function RootDocument({ children }: { children: React.ReactNode }) {
  // Publishes --kb so bottom-anchored UI can sit above the on-screen keyboard
  // on iOS as well as Android. No-op on desktop.
  useKeyboardInset()
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        {/* Inside <body> so it renders nothing outside the document tree. */}
        <ClerkAuthCacheReset />
        <Scripts />
      </body>
    </html>
  )
}
