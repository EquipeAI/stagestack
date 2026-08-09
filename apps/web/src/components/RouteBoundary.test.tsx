import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type * as React from 'react'

// These are the router's default boundaries, so they are what a stranger sees
// when a shared /e/<slug> or /invite/<token> link hits a backend outage: it has
// to look like the product, and it must never leak a stack trace in a
// production build.

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
}))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { RouteError, RouteNotFound } from './RouteBoundary'

const boom = () => {
  const error = new Error('Convex is unreachable')
  error.stack = 'Error: Convex is unreachable\n    at internals/secret.ts:12'
  return error
}

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('RouteError', () => {
  it('renders the design-system error surface with a retry', () => {
    const reset = vi.fn()
    render(<RouteError error={boom()} reset={reset} />)

    expect(
      document.querySelector('.ss-callout--blocked'),
    ).not.toBeNull()
    expect(screen.getByText('This page could not be loaded')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('shows the stack in development only', () => {
    // Stubbed rather than inherited: `import.meta.env.DEV` follows Vite's mode,
    // which an ambient NODE_ENV=production would flip (as CI images set), and a
    // test that silently inverts its own premise is worse than no test.
    vi.stubEnv('DEV', true)
    render(<RouteError error={boom()} reset={() => {}} />)
    expect(document.body.textContent).toContain('internals/secret.ts')
  })

  it('renders neither the stack nor the raw message in production', () => {
    vi.stubEnv('DEV', false)
    render(<RouteError error={boom()} reset={() => {}} />)

    const text = document.body.textContent
    expect(text).not.toContain('internals/secret.ts')
    expect(text).not.toContain('Convex is unreachable')
    expect(text).toContain('Something went wrong while loading this page')
  })
})

describe('RouteNotFound', () => {
  it('states what happened and offers a way out', () => {
    render(<RouteNotFound />)
    expect(screen.getByText('This page does not exist')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to StageStack' })).toBeTruthy()
  })
})
