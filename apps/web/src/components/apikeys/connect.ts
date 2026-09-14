import { resolveConvexSiteUrl } from '~/lib/headshotUpload'

// The connect panel's text, derived rather than written down (D4).
//
// The MCP endpoint lives on the Convex HTTP-action origin, which is the
// deployment's `.convex.site` twin of `VITE_CONVEX_URL` — the SAME derivation
// the headshot upload already does, imported rather than repeated so a
// self-hosted origin (`VITE_CONVEX_SITE_URL`) is honoured in one place. A
// hardcoded URL here would silently point every preview deployment's connect
// command at the dev backend, which is exactly the kind of bug nobody notices
// until an agent reads the wrong org's data.

/** The server name we tell people to register. Short, lowercase, stable: it
 * becomes the tool prefix inside their agent (`stagestack__list_events`). */
export const MCP_SERVER_NAME = 'stagestack'

/** The env var the Codex command reads the key from. Named here so the panel's
 * prose and its command can never disagree. */
export const MCP_KEY_ENV_VAR = 'STAGESTACK_MCP_KEY'

/** The literal that stands in for the secret in a copyable command. */
export const KEY_PLACEHOLDER = 'YOUR_KEY'

/**
 * The full `/mcp` endpoint for this deployment, or null when the environment
 * cannot describe one (a build with no `VITE_CONVEX_URL`, a custom origin with
 * no `VITE_CONVEX_SITE_URL`). Null is rendered as a stated gap, never as a
 * command with a hole in it.
 */
export function mcpEndpointUrl(env: {
  convexUrl?: string | undefined
  convexSiteUrl?: string | undefined
}): string | null {
  const convexUrl = env.convexUrl?.trim() ?? ''
  const convexSiteUrl = env.convexSiteUrl?.trim()
  if (convexUrl === '' && (convexSiteUrl ?? '') === '') return null
  try {
    const site = resolveConvexSiteUrl({
      convexUrl,
      ...(convexSiteUrl === undefined || convexSiteUrl === ''
        ? {}
        : { convexSiteUrl }),
    })
    return `${site}/mcp`
  } catch {
    return null
  }
}

export type ConnectCommand = {
  id: 'claude-code' | 'codex' | 'generic'
  /** The client this line connects. */
  client: string
  /** One sentence: what the reader has to do besides pasting. */
  note: string
  command: string
}

/**
 * The three ways in, in the order a reader tries them.
 *
 * BOTH named clients read the key from `MCP_KEY_ENV_VAR` rather than taking it
 * inline, and that is a deliberate correction: a pasted secret lands in shell
 * history AND in the client's config file on disk, where it outlives every
 * decision the minting screen just made.
 *
 * The Claude Code line is SINGLE-QUOTED on purpose. Single quotes stop the
 * shell expanding `${…}` at add time, so what is written to the config is the
 * literal reference; Claude Code then resolves it from the environment when it
 * connects. Verified against the installed CLI (2.1.216): with the config
 * holding `Bearer ${VAR}`, the server received the expanded value while the
 * file on disk still held the reference. Double quotes here would defeat the
 * whole point by expanding in the shell and storing the secret.
 */
export function connectCommands(endpoint: string): Array<ConnectCommand> {
  return [
    {
      id: 'claude-code',
      client: 'Claude Code',
      note: `Export the key as ${MCP_KEY_ENV_VAR} first. The quotes matter: they keep the reference — not the key — in your shell history and in Claude Code's config, which reads the variable each time it connects.`,
      command: `claude mcp add --transport http ${MCP_SERVER_NAME} ${endpoint} --header 'Authorization: Bearer \${${MCP_KEY_ENV_VAR}}'`,
    },
    {
      id: 'codex',
      client: 'Codex',
      note: `Same variable: Codex reads ${MCP_KEY_ENV_VAR} from the environment at connect time, so the key is not written into its config either.`,
      command: `codex mcp add ${MCP_SERVER_NAME} --url ${endpoint} --bearer-token-env-var ${MCP_KEY_ENV_VAR}`,
    },
    {
      id: 'generic',
      client: 'Anything else',
      note: `Any client that speaks streamable HTTP MCP: point it at this URL and send the key as a bearer token. Prefer one that reads the token from the environment; if it only takes the key inline, ${KEY_PLACEHOLDER} is where it goes.`,
      command: `${endpoint}\nAuthorization: Bearer ${KEY_PLACEHOLDER}`,
    },
  ]
}

// ── Time, said in whole units ─────────────────────────────────────────────

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "Never used" · "Just now" · "4 hours ago". The backend writes `lastUsedAt`
 * at five-minute granularity on purpose (`LAST_USED_THROTTLE_MS`), so anything
 * finer than a minute here would be inventing precision the field does not
 * have — hence the floor at "Just now" rather than a seconds counter.
 */
export function lastUsedLabel(lastUsedAt: number | null, now: number): string {
  if (lastUsedAt === null) return 'Never used'
  const delta = Math.max(0, now - lastUsedAt)
  if (delta < 5 * MINUTE) return 'Just now'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} minutes ago`
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }
  const days = Math.floor(delta / DAY)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** What a key is allowed to reach, said once, in the words the backend
 * enforces (`assertCeilingAllows`). Both the create form and the list read
 * these, so the promise made at mint time is the promise the list repeats. */
export const CEILING_COPY = {
  read: {
    label: 'Read',
    sentence: 'Everything you can see, and no changes.',
  },
  organizer: {
    label: 'Organizer',
    sentence:
      'Can also make reversible changes — never more than your own live role allows.',
  },
} as const

export type Ceiling = keyof typeof CEILING_COPY
