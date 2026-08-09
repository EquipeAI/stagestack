import { createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { ConvexQueryClient } from '@convex-dev/react-query'
import { ConvexProvider } from 'convex/react'
import { routeTree } from './routeTree.gen'
import { RouteError, RouteNotFound } from '~/components/RouteBoundary'

export function getRouter() {
  // Fail loud at boot — continuing with an undefined URL fails obscurely
  // downstream on the first query.
  const CONVEX_URL = import.meta.env.VITE_CONVEX_URL
  if (!CONVEX_URL) {
    throw new Error('missing env var VITE_CONVEX_URL')
  }
  const convexQueryClient = new ConvexQueryClient(CONVEX_URL)

  const queryClient: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
        gcTime: 5000,
      },
    },
  })
  convexQueryClient.connect(queryClient)

  const router = createRouter({
    routeTree,
    defaultPreload: 'intent',
    context: {
      queryClient,
      convexClient: convexQueryClient.convexClient,
      convexQueryClient,
    },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0, // Let React Query handle all caching
    // Every route inherits these unless it declares its own. Public links
    // (/e, /embed, /invite, the portal) rely on them, so they are styled —
    // and stack traces stay dev-only, never rendered to end users in prod.
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
    Wrap: ({ children }) => (
      <ConvexProvider client={convexQueryClient.convexClient}>
        {children}
      </ConvexProvider>
    ),
  })

  setupRouterSsrQueryIntegration({ router, queryClient })

  return router
}
