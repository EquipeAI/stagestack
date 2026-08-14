import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import {
  CEILING_COPY,
  KEY_PLACEHOLDER,
  connectCommands,
  lastUsedLabel,
  mcpEndpointUrl,
} from './connect'
import type { Ceiling } from './connect'
import type { Doc, Id } from '@convex/_generated/dataModel'
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  RadioGroup,
  Select,
  Toolbar,
} from '~/ds'
import { pushToast } from '~/components/toast'
import { copyToClipboard } from '~/lib/clipboard'
import { usePending } from '~/lib/usePending'
import { useNow } from '~/lib/useNow'
import { browserTimezone, formatDate } from '~/lib/datetime'

// ─────────────────────────────────────────────────────────────────────────
// Agent access (D4) — the org-settings tab where an admin mints the credential
// an external agent presents to the hosted MCP endpoint, and the panel that
// turns that credential into a connected agent in one paste.
//
// Two rules shape the whole screen:
//
//   1. The plaintext exists exactly once, in the mint response. Everything
//      else in here reads the summary list, which carries a prefix and never
//      the secret — so the reveal dialog is the only place that can show it,
//      and it says so.
//   2. Every sentence about what a key can reach is the backend's rule said in
//      product words. The ceiling is a CEILING, not a grant: an organizer-
//      ceiling key held by someone who is only a reviewer today can still only
//      do reviewer things. That is stated where the choice is made, because it
//      is the fact that makes handing an agent a key safe.
// ─────────────────────────────────────────────────────────────────────────

type KeySummary = {
  keyId: Id<'apiKeys'>
  name: string
  prefix: string
  ceiling: Ceiling
  eventSlug: string | null
  eventName: string | null
  createdAt: number
  createdByName: string | null
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

/** Live keys sort above dead ones; within each group, newest first — the key
 * you just minted is the one you are looking for. */
function ordered(keys: Array<KeySummary>): Array<KeySummary> {
  return [...keys].sort((a, b) => {
    const dead = Number(a.revokedAt !== null) - Number(b.revokedAt !== null)
    return dead !== 0 ? dead : b.createdAt - a.createdAt
  })
}

function scopeLabel(key: KeySummary): string {
  return key.eventSlug === null
    ? 'Whole organization'
    : (key.eventName ?? key.eventSlug)
}

export function ApiKeysTab({
  orgSlug,
  events,
}: {
  orgSlug: string
  events: Array<Doc<'events'>>
}) {
  const keys = useQuery(api.apiKeys.list, { orgSlug })
  const [creating, setCreating] = useState(false)
  const [minted, setMinted] = useState<{
    plaintext: string
    key: KeySummary
  } | null>(null)
  const [renaming, setRenaming] = useState<KeySummary | null>(null)
  const [revoking, setRevoking] = useState<KeySummary | null>(null)

  return (
    <div
      style={{
        display: 'flex',
        // Side by side while there is room, stacked when there is not — the
        // list gets the larger share because it is a table, and the panel
        // wraps under it below ~56rem. At 375px this is a plain stack, which
        // is the whole mobile requirement: nothing here needs two columns.
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: 'var(--space-6)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: '4 1 40rem',
          minWidth: 0,
          gap: 'var(--space-4)',
        }}
      >
        <Toolbar
          right={
            <Button
              variant="primary"
              iconLeft="plus"
              onClick={() => setCreating(true)}
            >
              New key
            </Button>
          }
        />
        <KeyList
          keys={keys}
          onCreate={() => setCreating(true)}
          onRename={setRenaming}
          onRevoke={setRevoking}
        />
      </div>

      <div style={{ flex: '1 1 20rem', minWidth: 0 }}>
        <ConnectPanel />
      </div>

      {creating ? (
        <NewKeyDialog
          orgSlug={orgSlug}
          events={events}
          onClose={() => setCreating(false)}
          onMinted={(result) => {
            setCreating(false)
            setMinted(result)
          }}
        />
      ) : null}
      {minted !== null ? (
        <RevealKeyDialog minted={minted} onClose={() => setMinted(null)} />
      ) : null}
      {renaming !== null ? (
        <RenameKeyDialog
          orgSlug={orgSlug}
          keyRow={renaming}
          onClose={() => setRenaming(null)}
        />
      ) : null}
      {revoking !== null ? (
        <RevokeKeyDialog
          orgSlug={orgSlug}
          keyRow={revoking}
          onClose={() => setRevoking(null)}
        />
      ) : null}
    </div>
  )
}

// ── The list ──────────────────────────────────────────────────────────────

const KEY_SKELETON_COLUMNS = [
  { key: 'name', header: 'Key' },
  { key: 'scope', header: 'Scope' },
  { key: 'ceiling', header: 'Ceiling' },
  { key: 'lastUsed', header: 'Last used' },
  { key: 'created', header: 'Created' },
  { key: 'actions', header: 'Actions' },
]

function KeyList({
  keys,
  onCreate,
  onRename,
  onRevoke,
}: {
  keys: Array<KeySummary> | undefined
  onCreate: () => void
  onRename: (key: KeySummary) => void
  onRevoke: (key: KeySummary) => void
}) {
  // Relative "last used" goes stale silently, so it ticks with the same
  // one-minute resolution the rest of the app uses.
  const now = useNow(60_000)
  const zone = browserTimezone()

  if (keys === undefined) {
    return (
      <Card padded={false}>
        <DataTable
          aria-label="API keys"
          loading
          loadingLabel="Loading API keys…"
          rows={[]}
          columns={KEY_SKELETON_COLUMNS}
        />
      </Card>
    )
  }

  if (keys.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="lock"
          title="No API keys yet"
          description="A key lets an agent read this organization on your behalf. Keys you mint appear here with their prefix, their scope and when they were last used."
          action={
            <Button variant="primary" iconLeft="plus" onClick={onCreate}>
              New key
            </Button>
          }
        />
      </Card>
    )
  }

  const rows = ordered(keys)

  // Live · Expired · Revoked. It rides in the name cell rather than a column
  // of its own: a revoked key is a fact ABOUT that key, and the table has more
  // useful things to spend a column on.
  const stateCell = (row: KeySummary) =>
    row.revokedAt !== null ? (
      <Badge tone="blocked" dot>
        Revoked
      </Badge>
    ) : row.expiresAt !== null && row.expiresAt <= now ? (
      <Badge tone="attention" dot>
        Expired
      </Badge>
    ) : (
      <Badge tone="success" dot>
        Active
      </Badge>
    )

  const nameCell = (row: KeySummary) => (
    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
        }}
      >
        <span
          style={{
            color:
              row.revokedAt === null
                ? 'var(--text-primary)'
                : 'var(--text-tertiary)',
            textDecoration: row.revokedAt === null ? 'none' : 'line-through',
          }}
        >
          {row.name}
        </span>
        {stateCell(row)}
      </span>
      <code
        style={{
          font: 'var(--type-mono)',
          color: 'var(--text-tertiary)',
        }}
      >
        {/* Already a complete fingerprint from the backend
            (`displayPrefix`: scheme + ellipsis + last four) — it is the only
            handle a reader has on a key they can no longer read. */}
        {row.prefix}
      </code>
    </span>
  )

  // Two visible buttons rather than an overflow menu: `.ss-table-scroll`
  // clips overflow-y, so a popup opened from the last row of a short table
  // loses its bottom item — and "Revoke" is the item that would be lost.
  const actionsCell = (row: KeySummary) => (
    <span
      style={{
        display: 'inline-flex',
        gap: 'var(--space-1)',
        justifyContent: 'flex-end',
      }}
    >
      <IconButton
        size="sm"
        icon="pencil"
        label={`Rename ${row.name}`}
        onClick={() => onRename(row)}
      />
      {row.revokedAt === null ? (
        <IconButton
          size="sm"
          icon="trash-2"
          label={`Revoke ${row.name}`}
          onClick={() => onRevoke(row)}
        />
      ) : null}
    </span>
  )

  return (
    <Card padded={false}>
      <DataTable
        aria-label="API keys"
        rowKey="keyId"
        rows={rows}
        cardRow={(row: KeySummary) => (
          <>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-3)',
              }}
            >
              {nameCell(row)}
              {actionsCell(row)}
            </span>
            <span
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 'var(--space-2)',
                font: 'var(--type-caption)',
                color: 'var(--text-secondary)',
              }}
            >
              <span>{CEILING_COPY[row.ceiling].label}</span>
              <span>·</span>
              <span>{scopeLabel(row)}</span>
              <span>·</span>
              <span>{lastUsedLabel(row.lastUsedAt, now)}</span>
            </span>
          </>
        )}
        columns={[
          // Widths, because the default share-it-out sizing wraps a two-word
          // key name into three lines next to four short columns.
          { key: 'name', header: 'Key', width: '13rem', cell: nameCell },
          { key: 'scope', header: 'Scope', width: '10rem', cell: scopeLabel },
          {
            key: 'ceiling',
            header: 'Ceiling',
            width: '6rem',
            cell: (row: KeySummary) => CEILING_COPY[row.ceiling].label,
          },
          {
            key: 'lastUsed',
            header: 'Last used',
            width: '8rem',
            cell: (row: KeySummary) => lastUsedLabel(row.lastUsedAt, now),
          },
          {
            key: 'created',
            header: 'Created',
            width: '7rem',
            cell: (row: KeySummary) => (
              <span
                title={
                  row.createdByName === null
                    ? undefined
                    : `Minted by ${row.createdByName}`
                }
              >
                {formatDate(row.createdAt, zone)}
              </span>
            ),
          },
          {
            key: 'actions',
            header: 'Actions',
            align: 'right' as const,
            width: '5.5rem',
            cell: actionsCell,
          },
        ]}
      />
    </Card>
  )
}

// ── Create ────────────────────────────────────────────────────────────────

function NewKeyDialog({
  orgSlug,
  events,
  onClose,
  onMinted,
}: {
  orgSlug: string
  events: Array<Doc<'events'>>
  onClose: () => void
  onMinted: (result: { plaintext: string; key: KeySummary }) => void
}) {
  const mint = useMutation(api.apiKeys.mint)
  const { pending, error, setError, run } = usePending()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'org' | 'event'>('org')
  const [eventSlug, setEventSlug] = useState(events[0]?.slug ?? '')
  const [ceiling, setCeiling] = useState<Ceiling>('read')

  const submit = () => {
    if (name.trim() === '') return setError('Name the key.')
    if (scope === 'event' && eventSlug === '') {
      return setError('Pick the event this key may read.')
    }
    void run(async () => {
      const result = await mint({
        orgSlug,
        name: name.trim(),
        ceiling,
        ...(scope === 'event' ? { eventSlug } : {}),
      })
      onMinted(result)
    })
  }

  return (
    <Dialog
      open
      width={640}
      title="New API key"
      description="The key is shown once, when it is created. It acts as you, and never with more access than you have at the moment it is used."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Creating…' : 'Create key'}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        <Field
          label="Name"
          htmlFor="key-name"
          hint="Where this key lives, so you know what you are turning off later."
        >
          <Input
            id="key-name"
            value={name}
            autoFocus
            placeholder="Laptop — Claude Code"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Scope">
          {/* `role` is passed explicitly even though RadioGroup renders it
              anyway: Field reads `children.props.role` to decide whether to
              point the group back at its label with aria-labelledby, and props
              the child sets internally are invisible to that check. Without
              this the group has no accessible name. */}
          <RadioGroup
            role="radiogroup"
            name="key-scope"
            value={scope}
            onChange={(value) => setScope(value as 'org' | 'event')}
            options={[
              {
                value: 'org',
                label: 'Whole organization',
                description: 'Every event you can reach, now and in future.',
              },
              {
                value: 'event',
                label: 'One event',
                description: 'The key sees nothing outside the event you pick.',
              },
            ]}
          />
        </Field>
        {scope === 'event' ? (
          <Field label="Event" htmlFor="key-event">
            <Select
              id="key-event"
              value={eventSlug}
              onChange={(e) => setEventSlug(e.target.value)}
              options={events.map((event) => ({
                value: event.slug,
                label: event.name,
              }))}
            />
          </Field>
        ) : null}
        <Field label="Ceiling">
          <RadioGroup
            role="radiogroup"
            name="key-ceiling"
            value={ceiling}
            onChange={(value) => setCeiling(value as Ceiling)}
            options={[
              {
                value: 'read',
                label: CEILING_COPY.read.label,
                description: CEILING_COPY.read.sentence,
              },
              {
                value: 'organizer',
                label: CEILING_COPY.organizer.label,
                description: CEILING_COPY.organizer.sentence,
              },
            ]}
          />
        </Field>
      </div>
    </Dialog>
  )
}

// ── Reveal, once ──────────────────────────────────────────────────────────

function RevealKeyDialog({
  minted,
  onClose,
}: {
  minted: { plaintext: string; key: KeySummary }
  onClose: () => void
}) {
  return (
    <Dialog
      open
      width={640}
      title="Copy your key now"
      description="This is the only time StageStack will show it. Close this dialog and the key is gone — mint a new one if you lose it."
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <CopyBlock
          label={minted.key.name}
          value={minted.plaintext}
          copyLabel="Copy API key"
          toast="API key copied"
        />
        <p
          style={{
            font: 'var(--type-caption)',
            color: 'var(--text-tertiary)',
            margin: 0,
          }}
        >
          Scope: {scopeLabel(minted.key)}. Ceiling:{' '}
          {CEILING_COPY[minted.key.ceiling].label} —{' '}
          {CEILING_COPY[minted.key.ceiling].sentence} Revoke it from this list
          at any time; an agent mid-session stops on its next call.
        </p>
      </div>
    </Dialog>
  )
}

// ── Rename / revoke ───────────────────────────────────────────────────────

function RenameKeyDialog({
  orgSlug,
  keyRow,
  onClose,
}: {
  orgSlug: string
  keyRow: KeySummary
  onClose: () => void
}) {
  const rename = useMutation(api.apiKeys.rename)
  const { pending, error, setError, run } = usePending()
  const [name, setName] = useState(keyRow.name)

  const submit = () => {
    if (name.trim() === '') return setError('Name the key.')
    void run(async () => {
      await rename({ orgSlug, keyId: keyRow.keyId, name: name.trim() })
      pushToast('Key renamed', name.trim())
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={480}
      title="Rename key"
      description="The name is a label in this list. The key itself does not change."
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Rename key'}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        <Field label="Name" htmlFor="key-rename">
          <Input
            id="key-rename"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  )
}

function RevokeKeyDialog({
  orgSlug,
  keyRow,
  onClose,
}: {
  orgSlug: string
  keyRow: KeySummary
  onClose: () => void
}) {
  const revoke = useMutation(api.apiKeys.revoke)
  const { pending, error, run } = usePending()

  const submit = () => {
    void run(async () => {
      await revoke({ orgSlug, keyId: keyRow.keyId })
      pushToast('Key revoked', `${keyRow.name} can no longer be used.`)
      onClose()
    })
  }

  return (
    <Dialog
      open
      width={480}
      title="Revoke key?"
      description={`Any agent still holding ${keyRow.name} (${keyRow.prefix}) stops on its next call. This cannot be undone — reconnecting means minting a new key.`}
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} disabled={pending}>
            {pending ? 'Revoking…' : 'Revoke key'}
          </Button>
        </>
      }
    >
      {error === null ? null : <Callout tone="blocked">{error}</Callout>}
    </Dialog>
  )
}

// ── Connect your agent ────────────────────────────────────────────────────

export function ConnectPanel() {
  const endpoint = mcpEndpointUrl({
    convexUrl: import.meta.env.VITE_CONVEX_URL,
    convexSiteUrl: import.meta.env.VITE_CONVEX_SITE_URL,
  })

  return (
    <Card
      title="Connect your agent"
      subtitle="One paste, and your agent can read this organization."
    >
      {endpoint === null ? (
        <Callout tone="attention" title="This deployment has no MCP address">
          The connect commands are built from VITE_CONVEX_URL (or
          VITE_CONVEX_SITE_URL for a custom origin). Vite reads it at build
          time, so setting it is not enough on its own: restart the dev server
          locally, or rebuild and redeploy in production.
        </Callout>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-5)',
          }}
        >
          <p
            style={{
              color: 'var(--text-secondary)',
              margin: 0,
            }}
          >
            Mint a key above, then run the line for your client. Your agent
            gains the StageStack tools — proposals, sessions, speakers, tasks,
            the agenda — under the key&rsquo;s ceiling, and nothing beyond it.
          </p>
          {connectCommands(endpoint).map((entry) => (
            <div
              key={entry.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
              }}
            >
              <span
                style={{
                  font: 'var(--type-eyebrow)',
                  letterSpacing: 'var(--tracking-caps)',
                  textTransform: 'uppercase',
                  color: 'var(--text-tertiary)',
                }}
              >
                {entry.client}
              </span>
              <CopyBlock
                value={entry.command}
                copyLabel={`Copy ${entry.client} command`}
                toast={`${entry.client} command copied`}
              />
              <span
                style={{
                  font: 'var(--type-caption)',
                  color: 'var(--text-tertiary)',
                }}
              >
                {entry.note}
              </span>
            </div>
          ))}
          <p
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-tertiary)',
              margin: 0,
            }}
          >
            Connecting stores the key outside StageStack — in your
            client&rsquo;s config or your shell environment. StageStack cannot
            reach it there, so revoking here is what stops it; deleting it from
            your machine is yours to do. {KEY_PLACEHOLDER} is a placeholder: a
            key is only ever readable at the moment you mint it.
          </p>
        </div>
      )}
    </Card>
  )
}

/**
 * A block of text somebody has to copy: mono, selectable, wrapping rather than
 * scrolling sideways (a command that scrolls off a 375px screen is a command
 * nobody copies correctly), with its own copy button.
 */
function CopyBlock({
  label,
  value,
  copyLabel,
  toast,
}: {
  label?: string
  value: string
  /** The button's accessible name. Four "Copy" buttons share this screen, so
   * each says what it copies — the visible word stays "Copy". */
  copyLabel: string
  toast: string
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        background: 'var(--surface-sunken)',
        border: 'var(--space-px) solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3)',
        minWidth: 0,
      }}
    >
      {label === undefined ? null : (
        <span
          style={{
            font: 'var(--type-caption)',
            color: 'var(--text-tertiary)',
          }}
        >
          {label}
        </span>
      )}
      <code
        style={{
          font: 'var(--type-mono)',
          color: 'var(--text-primary)',
          // The two properties that keep a long command inside its box on a
          // phone: wrap at any point, and preserve the newline the generic
          // entry uses to separate URL from header.
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          minWidth: 0,
        }}
      >
        {value}
      </code>
      <div>
        <Button
          size="sm"
          variant="secondary"
          iconLeft="copy"
          aria-label={copyLabel}
          onClick={() => void copyToClipboard(value, toast)}
        >
          Copy
        </Button>
      </div>
    </div>
  )
}
