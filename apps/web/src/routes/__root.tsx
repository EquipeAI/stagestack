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
        content: 'width=device-width, initial-scale=1',
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
