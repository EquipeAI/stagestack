import { describe, expect, it } from 'vitest'
import {
  CEILING_COPY,
  KEY_PLACEHOLDER,
  MCP_KEY_ENV_VAR,
  MCP_SERVER_NAME,
  connectCommands,
  lastUsedLabel,
  mcpEndpointUrl,
} from './connect'

// D4 — the connect panel's contract.
//
// The endpoint is DERIVED, and that derivation is the whole risk in this
// panel: a hardcoded (or mis-derived) URL hands every Vercel preview a command
// pointing at somebody else's backend, and it looks correct while doing it.
// So the deployment shapes we actually run on are pinned here.

describe('mcpEndpointUrl', () => {
  it('turns the deployment cloud URL into its .convex.site twin', () => {
    expect(
      mcpEndpointUrl({ convexUrl: 'https://marvelous-snail-907.convex.cloud' }),
    ).toBe('https://marvelous-snail-907.convex.site/mcp')
  })

  it('prefers an explicitly configured site origin (self-host)', () => {
    expect(
      mcpEndpointUrl({
        convexUrl: 'https://scintillating-heron-597.convex.cloud',
        convexSiteUrl: 'https://backend.example.org',
      }),
    ).toBe('https://backend.example.org/mcp')
  })

  it('follows the local convention of port + 1 for the HTTP actions origin', () => {
    expect(mcpEndpointUrl({ convexUrl: 'http://127.0.0.1:3210' })).toBe(
      'http://127.0.0.1:3211/mcp',
    )
  })

  it('is null rather than a broken command when the env cannot describe one', () => {
    expect(mcpEndpointUrl({})).toBeNull()
    expect(mcpEndpointUrl({ convexUrl: '' })).toBeNull()
    expect(mcpEndpointUrl({ convexUrl: 'not-a-url' })).toBeNull()
    // An https origin that is neither .convex.cloud nor loopback: the helper
    // refuses to guess an HTTP-actions host it cannot derive.
    expect(mcpEndpointUrl({ convexUrl: 'https://example.org' })).toBeNull()
  })
})

describe('connectCommands', () => {
  const commands = connectCommands('https://demo.convex.site/mcp')
  const byId = (id: string) => commands.find((c) => c.id === id)!

  it('gives Claude Code an add line that stores a reference, not the key', () => {
    // Single-quoted so the SHELL does not expand it at add time; Claude Code
    // resolves ${VAR} from the environment when it connects (verified against
    // the installed CLI, 2.1.216).
    expect(byId('claude-code').command).toBe(
      `claude mcp add --transport http ${MCP_SERVER_NAME} https://demo.convex.site/mcp --header 'Authorization: Bearer \${${MCP_KEY_ENV_VAR}}'`,
    )
    expect(byId('claude-code').command).not.toContain(KEY_PLACEHOLDER)
  })

  it('keeps the key out of the Codex command line, in an env var', () => {
    const codex = byId('codex').command
    expect(codex).toBe(
      `codex mcp add ${MCP_SERVER_NAME} --url https://demo.convex.site/mcp --bearer-token-env-var ${MCP_KEY_ENV_VAR}`,
    )
    expect(codex).not.toContain(KEY_PLACEHOLDER)
  })

  it('states the generic URL + bearer header for every other client', () => {
    expect(byId('generic').command).toBe(
      `https://demo.convex.site/mcp\nAuthorization: Bearer ${KEY_PLACEHOLDER}`,
    )
  })

  it('never emits a command containing a real secret placeholder gap', () => {
    for (const entry of commands) {
      expect(entry.command).toContain('https://demo.convex.site/mcp')
      expect(entry.command).not.toContain('undefined')
    }
  })

  it('routes both named clients through the same env var', () => {
    for (const id of ['claude-code', 'codex']) {
      expect(byId(id).command).toContain(MCP_KEY_ENV_VAR)
      expect(byId(id).command).not.toContain(KEY_PLACEHOLDER)
    }
  })
})

describe('lastUsedLabel', () => {
  const NOW = 1_760_000_000_000

  it('says so when a key has never been presented', () => {
    expect(lastUsedLabel(null, NOW)).toBe('Never used')
  })

  it('does not invent precision the throttled field does not have', () => {
    // lastUsedAt is written at five-minute granularity (LAST_USED_THROTTLE_MS).
    expect(lastUsedLabel(NOW - 1_000, NOW)).toBe('Just now')
    expect(lastUsedLabel(NOW - 4 * 60_000, NOW)).toBe('Just now')
  })

  it('counts in whole minutes, hours and days', () => {
    expect(lastUsedLabel(NOW - 20 * 60_000, NOW)).toBe('20 minutes ago')
    expect(lastUsedLabel(NOW - 3_600_000, NOW)).toBe('1 hour ago')
    expect(lastUsedLabel(NOW - 5 * 3_600_000, NOW)).toBe('5 hours ago')
    expect(lastUsedLabel(NOW - 86_400_000, NOW)).toBe('1 day ago')
    expect(lastUsedLabel(NOW - 9 * 86_400_000, NOW)).toBe('9 days ago')
  })

  it('never reads as the future when a clock skews', () => {
    expect(lastUsedLabel(NOW + 60_000, NOW)).toBe('Just now')
  })
})

describe('CEILING_COPY', () => {
  it('states both ceilings in one sentence each, and says read means no changes', () => {
    expect(CEILING_COPY.read.sentence).toMatch(/no changes/i)
    expect(CEILING_COPY.organizer.sentence).toMatch(/reversible/i)
    // The ceiling is a ceiling, not a grant — the sentence has to say it.
    expect(CEILING_COPY.organizer.sentence).toMatch(/never more than/i)
  })
})
