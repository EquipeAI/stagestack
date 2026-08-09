import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { customKeyFromName, isCustomKey } from './model'
import { MonoText } from './primitives'
import { TemplateEditorDialog } from './TemplateEditorDialog'
import type * as React from 'react'
import type { TemplateRow } from './model'
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Toolbar,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'

// Every lifecycle email StageStack sends, listed whether or not this event has
// touched it. A row that says nothing about being customized is the built-in
// default — that is the honest reading, so the badge marks the exception.

export function TemplatesPanel({
  eventSlug,
  eventName,
}: {
  eventSlug: string
  eventName: string
}) {
  const templates = useQuery(api.templates.list, { eventSlug })
  const [editorKey, setEditorKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<TemplateRow | null>(null)
  const [resetting, setResetting] = useState<TemplateRow | null>(null)
  const [creating, setCreating] = useState(false)

  if (templates === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading templates…</p>
  }

  // A template saved for the first time arrives in the list; until then the
  // editor works off the draft row the create dialog handed over.
  const editing =
    editorKey === null
      ? null
      : (templates.find((row) => row.key === editorKey) ??
        (draft?.key === editorKey ? draft : null))

  const builtIn = templates.filter((row) => !isCustomKey(row.key))
  const custom = templates.filter((row) => isCustomKey(row.key))
  const customizedCount = templates.filter((row) => row.customized).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <Toolbar
        left={
          <span
            style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}
          >
            {customizedCount === 0
              ? 'Every template is the StageStack default.'
              : `${customizedCount} of ${templates.length} customized for this event.`}
          </span>
        }
        right={
          <Button
            iconLeft="plus"
            onClick={() => {
              setCreating(true)
            }}
          >
            New custom template
          </Button>
        }
      />

      <Card
        title="Lifecycle templates"
        subtitle="Sent automatically at the moment the state changes."
        padded={false}
      >
        <ul style={list}>
          {builtIn.map((row) => (
            <TemplateItem
              key={row.key}
              row={row}
              onOpen={() => {
                setEditorKey(row.key)
              }}
            />
          ))}
        </ul>
      </Card>

      <Card
        title="Custom templates"
        subtitle="Your own wording, addressed by key. Nothing sends these automatically — they are for one-off use."
        padded={false}
      >
        {custom.length === 0 ? (
          <div style={{ padding: 'var(--space-5)' }}>
            <EmptyState
              icon="mail"
              title="No custom templates"
              description="Wording you reuse but StageStack does not send on its own — a sponsor note, a green-room briefing — lives here."
              action={
                <Button
                  iconLeft="plus"
                  onClick={() => {
                    setCreating(true)
                  }}
                >
                  New custom template
                </Button>
              }
            />
          </div>
        ) : (
          <ul style={list}>
            {custom.map((row) => (
              <TemplateItem
                key={row.key}
                row={row}
                onOpen={() => {
                  setEditorKey(row.key)
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      {editing === null ? null : (
        <TemplateEditorDialog
          key={editing.key}
          eventSlug={eventSlug}
          eventName={eventName}
          template={editing}
          onRequestReset={setResetting}
          onClose={() => {
            setEditorKey(null)
            setDraft(null)
          }}
        />
      )}

      {/* Rendered as a sibling, not nested: two scrims at the same z-index
          stack in DOM order, so the confirm sits above the editor. */}
      {resetting === null ? null : (
        <ResetDialog
          eventSlug={eventSlug}
          template={resetting}
          onClose={() => {
            setResetting(null)
          }}
          onDone={() => {
            setResetting(null)
            setEditorKey(null)
          }}
        />
      )}

      {creating ? (
        <NewTemplateDialog
          existingKeys={templates.map((row) => row.key)}
          onClose={() => {
            setCreating(false)
          }}
          onCreated={(row) => {
            setDraft(row)
            setEditorKey(row.key)
            setCreating(false)
          }}
        />
      ) : null}
    </div>
  )
}

function TemplateItem({
  row,
  onOpen,
}: {
  row: TemplateRow
  onOpen: () => void
}) {
  return (
    <li style={itemRow}>
      <button type="button" onClick={onOpen} style={itemButton}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0 }}>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ font: 'var(--type-label)' }}>{row.name}</span>
            {row.customized ? <Badge tone="brand">Customized</Badge> : null}
          </span>
          <MonoText>{row.key}</MonoText>
          <span
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.subject}
          </span>
        </span>
      </button>
      <Button size="sm" iconLeft="pencil" onClick={onOpen}>
        Edit
      </Button>
    </li>
  )
}

function ResetDialog({
  eventSlug,
  template,
  onClose,
  onDone,
}: {
  eventSlug: string
  template: TemplateRow
  onClose: () => void
  onDone: () => void
}) {
  const reset = useMutation(api.templates.reset)
  const { pending, error, run } = usePending()

  const submit = () => {
    void run(async () => {
      await reset({ eventSlug, key: template.key })
      pushToast(
        'Template reset',
        `${template.name} uses StageStack's default wording again.`,
      )
      onDone()
    })
  }

  return (
    <Dialog
      open
      width={480}
      title="Reset to default?"
      description={`Your wording for ${template.name} is discarded, and every future send of this email uses StageStack's built-in copy. Emails already sent are unaffected.`}
      onClose={pending ? undefined : onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={pending} onClick={submit}>
            {pending ? 'Resetting…' : 'Reset to default'}
          </Button>
        </>
      }
    >
      {error === null ? null : <Callout tone="blocked">{error}</Callout>}
    </Dialog>
  )
}

function NewTemplateDialog({
  existingKeys,
  onClose,
  onCreated,
}: {
  existingKeys: Array<string>
  onClose: () => void
  onCreated: (row: TemplateRow) => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const key = customKeyFromName(name)

  const submit = () => {
    if (name.trim() === '') return setError('Name the template.')
    if (key === '') {
      return setError('The name needs at least one letter or digit.')
    }
    if (existingKeys.includes(key)) {
      return setError(`${key} already exists.`)
    }
    onCreated({
      key,
      name: name.trim(),
      subject: '',
      html: '<p>Hi {{speaker.firstName}},</p>\n<p></p>',
      customized: false,
    })
  }

  return (
    <Dialog
      open
      width={480}
      title="New custom template"
      description="Nothing is stored until you save the subject and body in the editor."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            Continue
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {error === null ? null : <Callout tone="blocked">{error}</Callout>}
        <Field
          label="Name"
          htmlFor="tpl-new-name"
          required
          hint={key === '' ? 'The key is derived from the name.' : undefined}
        >
          <Input
            id="tpl-new-name"
            value={name}
            placeholder="Green room briefing"
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
        </Field>
        {key === '' ? null : (
          <p style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
            Key: <MonoText>{key}</MonoText>
          </p>
        )}
      </div>
    </Dialog>
  )
}

const list: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
}

const itemRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  padding: 'var(--space-3) var(--space-5)',
  borderTop: 'var(--space-px) solid var(--border-subtle)',
}

const itemButton: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'block',
  textAlign: 'left',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'inherit',
  font: 'inherit',
}
