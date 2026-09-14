import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type * as React from 'react'

// The signed-in topbar (W1). One rule, and it is an accessibility one: every
// control in this bar keeps its accessible NAME at every width. The bar
// collapses on a phone — the wordmark becomes the mark, the search button
// becomes its icon — and a name that collapses with the pixels is a control
// that only exists on a desktop.

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Link: ({
    children,
    to,
    ...rest
  }: { children?: React.ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  Outlet: () => <div data-testid="outlet" />,
}))

vi.mock('@clerk/tanstack-react-start', () => ({
  Show: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  UserButton: () => <button type="button">Account</button>,
}))

vi.mock('~/components/AuthGate', () => ({
  AuthGate: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
vi.mock('~/components/EventSwitcher', () => ({
  EventSwitcher: () => <div data-testid="switcher" />,
}))
vi.mock('~/components/shell/GlobalSearch', () => ({
  GlobalSearch: () => (
    <button type="button" aria-label="Search StageStack">
      <span className="topbar__search-label">Search</span>
    </button>
  ),
}))
vi.mock('~/components/toast', () => ({ ToastViewport: () => null }))

// eslint-disable-next-line import/first, import/order -- vi.mock is hoisted above this
import { Route } from './app'

afterEach(cleanup)

function mount() {
  const Layout = (Route as unknown as { component: React.ComponentType })
    .component
  render(<Layout />)
}

describe('the signed-in topbar', () => {
  it('names the home link on the link itself, so the name survives the collapse', () => {
    // REGRESSION (codex, W1 round 3): below 640px `.topbar__logo--full` is
    // display:none and the mark that remains is aria-hidden — so on a phone,
    // and only on a phone, this link had no accessible name at all. The label
    // is on the anchor, which no breakpoint can touch.
    mount()
    const home = screen.getByRole('link', { name: 'StageStack home' })
    expect(home.getAttribute('aria-label')).toBe('StageStack home')
    expect(home.getAttribute('href')).toBe('/app')
    // The word is decoration under that label: it is the element the phone
    // hides, and the one that remains says nothing to a screen reader.
    expect(home.querySelector('.topbar__logo--full')?.textContent).toContain(
      'StageStack',
    )
    expect(
      home.querySelector('.topbar__logo--mark')?.getAttribute('aria-hidden'),
    ).toBe('true')
  })

  it('keeps the search button named while its word collapses', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Search StageStack' })).toBeTruthy()
  })
})
