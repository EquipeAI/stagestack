import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { getFunctionName } from 'convex/server'
import type * as Connect from './connect'

// D4 — the API keys tab.
//
// Three things are asserted because three things can silently go wrong:
//   1. the plaintext is shown ONCE and the dialog says so — a reveal that
//      reads like a detail view invites the reader to come back for it;
//   2. a revoked key still appears, marked dead, because `apiKeys.list`
//      returns revoked rows and a list that hid them would be lying about what
//      exists;
//   3. the connect commands carry the DERIVED endpoint, not a hardcoded one.

const { state, mint, rename, revoke } = vi.hoisted(() => ({
  state: {
    keys: [] as Array<Record<string, unknown>>,
  },
  mint: vi.fn(),
  rename: vi.fn(() => Promise.resolve(null)),
  revoke: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('convex/react', () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref)
    if (name === 'apiKeys:list') return state.keys
    return undefined
  },
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref)
    if (name === 'apiKeys:mint') return mint
    if (name === 'apiKeys:rename') return rename
    if (name === 'apiKeys:revoke') return revoke
    throw new Error(`unexpected mutation ${name}`)
  },
}))

const copied: Array<string> = []
vi.mock('~/lib/clipboard', () => ({
  copyToClipboard: (text: string) => {
    copied.push(text)
    return Promise.resolve(true)
  },
}))

// The endpoint derivation is unit-tested in connect.test.ts; here the panel is
// pinned to a known deployment so the rendered command can be asserted whole.
let endpointOverride: string | null = 'https://demo.convex.site/mcp'
vi.mock('./connect', async () => {
  const actual = await vi.importActual<typeof Connect>('./connect')
  return {
    ...actual,
    mcpEndpointUrl: () => endpointOverride,
  }
})

const { ApiKeysTab } = await import('./ApiKeysTab')

const EVENTS = [
  { _id: 'e1', _creationTime: 1, slug: 'wf26', name: "World's Fair 2026" },
  { _id: 'e2', _creationTime: 2, slug: 'devconf', name: 'DevConf' },
] as never

const NOW = 1_760_000_000_000

function key(over: Record<string, unknown> = {}) {
  return {
    keyId: 'k1',
    name: 'Laptop — Claude Code',
    prefix: 'ssk_…ab12',
    ceiling: 'read',
    eventSlug: null,
    eventName: null,
    createdAt: NOW - 86_400_000,
    createdByName: 'Alvaro',
    lastUsedAt: NOW - 2 * 3_600_000,
    expiresAt: null,
    revokedAt: null,
    ...over,
  }
}

beforeEach(() => {
  vi.setSystemTime(NOW)
  endpointOverride = 'https://demo.convex.site/mcp'
  state.keys = []
  copied.length = 0
  mint.mockReset()
  rename.mockClear()
  revoke.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

const renderTab = () => render(<ApiKeysTab orgSlug="equipe" events={EVENTS} />)

describe('the key list', () => {
  it('describes what a key is for before any key exists', () => {
    renderTab()
    expect(screen.getByText('No API keys yet')).toBeTruthy()
  })

  it('shows prefix, scope, ceiling and a relative last-used', () => {
    state.keys = [
      key({
        eventSlug: 'wf26',
        eventName: "World's Fair 2026",
        ceiling: 'organizer',
      }),
    ]
    renderTab()
    expect(screen.getAllByText('ssk_…ab12').length).toBeGreaterThan(0)
    expect(screen.getAllByText("World's Fair 2026").length).toBeGreaterThan(0)
    expect(screen.getAllByText('Organizer').length).toBeGreaterThan(0)
    expect(screen.getAllByText('2 hours ago').length).toBeGreaterThan(0)
  })

  it('keeps a revoked key visible and marked dead, with no revoke action', () => {
    state.keys = [key({ revokedAt: NOW - 3_600_000 })]
    renderTab()
    expect(screen.getAllByText('Revoked').length).toBeGreaterThan(0)
    expect(
      screen.queryByRole('button', { name: 'Revoke Laptop — Claude Code' }),
    ).toBeNull()
    expect(
      screen.getAllByRole('button', { name: 'Rename Laptop — Claude Code' })
        .length,
    ).toBeGreaterThan(0)
  })

  it('sorts live keys above revoked ones', () => {
    state.keys = [
      key({ keyId: 'dead', name: 'Old key', revokedAt: NOW - 10 }),
      key({ keyId: 'live', name: 'Current key' }),
    ]
    renderTab()
    const text = document.body.textContent
    expect(text.indexOf('Current key')).toBeLessThan(text.indexOf('Old key'))
  })
})

describe('minting', () => {
  it('reveals the plaintext once, says it will not be shown again, and copies it', async () => {
    mint.mockResolvedValue({
      plaintext: 'ssk_live_ab12_secretsecret',
      key: key(),
    })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: 'New key' })[0])
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Laptop — Claude Code' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByText('Copy your key now')

    expect(mint).toHaveBeenCalledWith({
      orgSlug: 'equipe',
      name: 'Laptop — Claude Code',
      ceiling: 'read',
    })
    expect(screen.getByText(/only time StageStack will show it/i)).toBeTruthy()
    expect(screen.getByText('ssk_live_ab12_secretsecret')).toBeTruthy()

    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: 'Copy API key' }))
    expect(copied[0]).toBe('ssk_live_ab12_secretsecret')

    // Closing is the end of it: the secret is not recoverable from the list.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText('ssk_live_ab12_secretsecret')).toBeNull()
  })

  it('sends the picked event when the scope is one event', async () => {
    mint.mockResolvedValue({
      plaintext: 'ssk_live_x',
      key: key({ eventSlug: 'devconf', eventName: 'DevConf' }),
    })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: 'New key' })[0])
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Agenda bot' },
    })
    fireEvent.click(screen.getByRole('radio', { name: /One event/ }))
    fireEvent.change(screen.getByLabelText('Event'), {
      target: { value: 'devconf' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByText('Copy your key now')

    expect(mint).toHaveBeenCalledWith({
      orgSlug: 'equipe',
      name: 'Agenda bot',
      ceiling: 'read',
      eventSlug: 'devconf',
    })
  })

  it('names both choice groups for a screen reader', () => {
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: 'New key' })[0])
    // Field only wires aria-labelledby when it can SEE role on the child's
    // props, so this is the assertion that catches the regression.
    expect(screen.getByRole('radiogroup', { name: 'Scope' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Ceiling' })).toBeTruthy()
  })

  it('sends the organizer ceiling when it is chosen', async () => {
    mint.mockResolvedValue({
      plaintext: 'ssk_live_o',
      key: key({ ceiling: 'organizer' }),
    })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: 'New key' })[0])
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Review bot' },
    })
    fireEvent.click(screen.getByRole('radio', { name: /Organizer/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByText('Copy your key now')

    expect(mint).toHaveBeenCalledWith({
      orgSlug: 'equipe',
      name: 'Review bot',
      ceiling: 'organizer',
    })
  })

  it('cannot resurface the key once the reveal dialog is closed', async () => {
    mint.mockResolvedValue({
      plaintext: 'ssk_live_never_again',
      key: key(),
    })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: 'New key' })[0])
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Laptop — Claude Code' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByText('Copy your key now')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    // The list now holds the minted key, as the backend returns it.
    state.keys = [key()]
    cleanup()
    renderTab()
    // Reopening the create dialog is the only route back to a plaintext, and
    // it mints a NEW key rather than showing the old one.
    fireEvent.click(screen.getAllByRole('button', { name: 'New key' })[0])
    expect(screen.queryByText('Copy your key now')).toBeNull()
    expect(screen.queryByText('ssk_live_never_again')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy API key' })).toBeNull()
  })

  it('refuses to mint an unnamed key without calling the backend', () => {
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: 'New key' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    expect(mint).not.toHaveBeenCalled()
    expect(screen.getByText('Name the key.')).toBeTruthy()
  })
})

describe('renaming', () => {
  it('sends the trimmed new name and closes', async () => {
    state.keys = [key()]
    renderTab()
    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'Rename Laptop — Claude Code',
      })[0],
    )
    const field = screen.getByLabelText('Name')
    // The dialog opens on the CURRENT name — a rename is an edit, not a
    // re-entry.
    expect((field as HTMLInputElement).value).toBe('Laptop — Claude Code')

    fireEvent.change(field, { target: { value: '  Desktop — Codex  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename key' }))
    expect(rename).toHaveBeenCalledWith({
      orgSlug: 'equipe',
      keyId: 'k1',
      name: 'Desktop — Codex',
    })
    await waitFor(() => {
      expect(screen.queryByText('Rename key')).toBeNull()
    })
  })

  it('refuses an empty name without calling the backend', () => {
    state.keys = [key()]
    renderTab()
    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'Rename Laptop — Claude Code',
      })[0],
    )
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename key' }))
    expect(rename).not.toHaveBeenCalled()
    expect(screen.getByText('Name the key.')).toBeTruthy()
  })
})

describe('revoking', () => {
  it('states the consequence before doing it', () => {
    state.keys = [key()]
    renderTab()
    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'Revoke Laptop — Claude Code',
      })[0],
    )
    expect(screen.getByText('Revoke key?')).toBeTruthy()
    expect(screen.getByText(/stops on its next call/i)).toBeTruthy()
    expect(revoke).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }))
    expect(revoke).toHaveBeenCalledWith({ orgSlug: 'equipe', keyId: 'k1' })
  })
})

describe('the connect panel', () => {
  it('carries the derived endpoint in every command, and copies them', () => {
    renderTab()
    expect(
      screen.getByText(
        "claude mcp add --transport http stagestack https://demo.convex.site/mcp --header 'Authorization: Bearer ${STAGESTACK_MCP_KEY}'",
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'codex mcp add stagestack --url https://demo.convex.site/mcp --bearer-token-env-var STAGESTACK_MCP_KEY',
      ),
    ).toBeTruthy()

    // Named, not positional: four buttons on this screen say "Copy".
    fireEvent.click(screen.getByRole('button', { name: 'Copy Codex command' }))
    expect(copied[0]).toContain('https://demo.convex.site/mcp')
    expect(copied[0]).toContain('codex mcp add')
  })

  it('keeps the secret out of both named clients commands', () => {
    renderTab()
    const claude = screen.getByText(/^claude mcp add/).textContent
    // Single quotes, so the shell does not expand it at add time and the
    // stored config holds the reference rather than the key.
    expect(claude).toContain("'Authorization: Bearer ${STAGESTACK_MCP_KEY}'")
    expect(claude).not.toContain('YOUR_KEY')
    expect(screen.getByText(/^codex mcp add/).textContent).not.toContain(
      'YOUR_KEY',
    )
  })

  it('says plainly that connecting puts the key outside StageStack', () => {
    renderTab()
    expect(
      screen.getByText(/Connecting stores the key outside StageStack/),
    ).toBeTruthy()
    expect(screen.getByText(/revoking here is what stops it/)).toBeTruthy()
  })

  it('names each copy button by what it copies', () => {
    renderTab()
    for (const name of [
      'Copy Claude Code command',
      'Copy Codex command',
      'Copy Anything else command',
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
  })

  it('explains the rebuild/restart when the deployment has no MCP address', async () => {
    // The real derivation, given an environment that cannot describe one.
    const connect = await vi.importActual<typeof Connect>('./connect')
    expect(connect.mcpEndpointUrl({})).toBeNull()

    endpointOverride = null
    renderTab()
    expect(screen.getByText('This deployment has no MCP address')).toBeTruthy()
    expect(screen.getByText(/read[s]? it at build time/)).toBeTruthy()
    expect(screen.getByText(/restart the dev server/)).toBeTruthy()
    // No half-written command is offered in place of the missing address.
    expect(screen.queryByText(/^claude mcp add/)).toBeNull()
  })
})
