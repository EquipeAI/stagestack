import { useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import {
  TEMPLATE_VARS,
  UNIVERSAL_VARS,
  isCustomKey,
  isKnownVar,
  renderDraftHtml,
  renderDraftSubject,
  sampleVars,
  variablesIn,
} from './model'
import { MonoText, VariableChip } from './primitives'
import type * as React from 'react'
import type { TemplateRow } from './model'
import { Button, Callout, Dialog, Field, Input, Textarea } from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'

// The editor for one email template. Two things the organizer has to be able
// to see at once: the source they are editing, and what it turns into.
//
// `templates.preview` takes only a key — it renders what is SAVED. So the
// preview pane has two modes, and says which one it is showing: the server's
// authoritative rendering (branded shell included) while the draft is clean,
// and a local rendering of the body while it is not.

export function TemplateEditorDialog({
  eventSlug,
  eventName,
  template,
  onRequestReset,
  onClose,
}: {
  eventSlug: string
  eventName: string
  template: TemplateRow
  onRequestReset: (template: TemplateRow) => void
  onClose: () => void
}) {
  const upsert = useMutation(api.templates.upsert)
  const { pending, error, setError, run } = usePending()
  const custom = isCustomKey(template.key)

  const [name, setName] = useState(template.name)
  const [subject, setSubject] = useState(template.subject)
  const [html, setHtml] = useState(template.html)

  const dirty =
    subject !== template.subject ||
    html !== template.html ||
    (custom && name !== template.name)

  // A custom key with no override yet has nothing on the server to render.
  const previewable = !custom || template.customized
  const saved = useQuery(
    api.templates.preview,
    previewable ? { eventSlug, key: template.key } : 'skip',
  )

  const vars = useMemo(() => sampleVars(eventName), [eventName])
  const draftSubject = renderDraftSubject(subject, vars)
  const draftHtml = renderDraftHtml(html, vars)

  const available = useMemo(() => {
    const own = TEMPLATE_VARS[template.key] ?? []
    return [...own, ...UNIVERSAL_VARS.filter((v) => !own.includes(v))]
  }, [template.key])

  const unknown = useMemo(
    () => [...variablesIn(subject), ...variablesIn(html)].filter((v) => !isKnownVar(v)),
    [subject, html],
  )

  const save = () => {
    if (subject.trim() === '') return setError('The subject cannot be empty.')
    if (html.trim() === '') return setError('The body cannot be empty.')
    if (custom && name.trim() === '') return setError('Name the template.')
    void run(async () => {
      await upsert({
        eventSlug,
        key: template.key,
        // Built-in templates keep their canonical name so the list stays
        // readable against the key; only custom ones are the organizer's to
        // name.
        name: custom ? name.trim() : undefined,
        subject: subject.trim(),
        html: html.trim(),
      })
      pushToast(
        'Template saved',
        `Every ${template.key} email for this event now uses your wording.`,
      )
    })
  }

  return (
    <Dialog
      open
      width={980}
      title={custom ? name || 'Custom template' : template.name}
      description={
        template.customized
          ? 'This event uses your wording. Reset returns it to the StageStack default.'
          : 'This is the StageStack default. Saving stores an override for this event only.'
      }
      onClose={pending ? undefined : onClose}
      footer={
        <>
          {template.customized ? (
            <Button
              variant="danger"
              disabled={pending}
              onClick={() => {
                onRequestReset(template)
              }}
            >
              Reset to default
            </Button>
          ) : null}
          <span style={{ marginRight: 'auto' }} />
          <Button disabled={pending} onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={pending || !dirty}
            onClick={save}
          >
            {pending ? 'Saving…' : 'Save template'}
          </Button>
        </>
      }
    >
      <div style={editorGrid}>
        <div style={column}>
          {error === null ? null : <Callout tone="blocked">{error}</Callout>}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
            }}
          >
            <MonoText>{template.key}</MonoText>
          </div>

          {custom ? (
            <Field label="Name" htmlFor="tpl-name" required>
              <Input
                id="tpl-name"
                value={name}
                disabled={pending}
                onChange={(e) => {
                  setName(e.target.value)
                }}
              />
            </Field>
          ) : null}

          <Field label="Subject" htmlFor="tpl-subject" required>
            <Input
              id="tpl-subject"
              value={subject}
              disabled={pending}
              onChange={(e) => {
                setSubject(e.target.value)
              }}
            />
          </Field>

          <Field
            label="Body"
            htmlFor="tpl-html"
            required
            hint="HTML. StageStack wraps it in the branded shell — write the message, not the page."
          >
            <Textarea
              id="tpl-html"
              rows={16}
              value={html}
              disabled={pending}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
              }}
              onChange={(e) => {
                setHtml(e.target.value)
              }}
            />
          </Field>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <span
              style={{ font: 'var(--type-label)', color: 'var(--text-secondary)' }}
            >
              Variables
            </span>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--space-2)',
              }}
            >
              {available.map((path) => (
                <VariableChip key={path} path={path} />
              ))}
            </div>
            <p
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
              }}
            >
              Values are escaped before they are substituted, so a speaker
              called <MonoText>&lt;script&gt;</MonoText> is text, never markup.
              A name StageStack does not recognise renders as nothing.
            </p>
          </div>

          {unknown.length === 0 ? null : (
            <Callout tone="attention" title="These render as empty">
              {unknown.map((path) => `{{${path}}}`).join(', ')}
            </Callout>
          )}
        </div>

        <div style={column}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
            }}
          >
            <span
              style={{ font: 'var(--type-label)', color: 'var(--text-secondary)' }}
            >
              Preview
            </span>
            <span
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
                textAlign: 'right',
              }}
            >
              {dirty
                ? 'Unsaved draft — body only'
                : previewable
                  ? 'Saved template, rendered by StageStack'
                  : 'Nothing saved yet'}
            </span>
          </div>

          <div style={previewSubject}>
            <span
              style={{
                font: 'var(--type-caption)',
                color: 'var(--text-tertiary)',
              }}
            >
              Subject
            </span>
            <span style={{ font: 'var(--type-label)' }}>
              {dirty ? draftSubject : (saved?.subject ?? '—')}
            </span>
          </div>

          <PreviewFrame
            html={dirty ? draftHtml : (saved?.html ?? '')}
            empty={
              dirty
                ? 'Nothing to preview yet.'
                : previewable
                  ? 'Rendering…'
                  : 'Save the template to see it as StageStack sends it.'
            }
          />

          <p
            style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}
          >
            Rendered against sample data through the same substitution a real
            send uses. Saving refreshes this with StageStack&rsquo;s own
            rendering, branded shell included.
          </p>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * Email HTML is somebody else's document: it renders in a sandboxed frame so
 * no stray `<style>` can reach the app, and on a forced-light surface because
 * that is the only way an inbox ever shows it.
 */
function PreviewFrame({ html, empty }: { html: string; empty: string }) {
  if (html.trim() === '') {
    return (
      <div style={{ ...frameShell, padding: 'var(--space-5)' }}>
        <span
          style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}
        >
          {empty}
        </span>
      </div>
    )
  }
  return (
    <div className="ss-theme-light" style={frameShell}>
      <iframe
        title="Email preview"
        sandbox=""
        srcDoc={html}
        style={{
          display: 'block',
          width: '100%',
          height: '24rem',
          border: 'none',
          background: 'var(--gray-0)',
        }}
      />
    </div>
  )
}

const editorGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))',
  gap: 'var(--space-5)',
  alignItems: 'start',
}

const column: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-4)',
  minWidth: 0,
}

const frameShell: React.CSSProperties = {
  border: 'var(--space-px) solid var(--border-default)',
  borderRadius: 'var(--radius-control)',
  overflow: 'hidden',
  background: 'var(--gray-0)',
}

const previewSubject: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
  padding: 'var(--space-3)',
  background: 'var(--surface-sunken)',
  borderRadius: 'var(--radius-control)',
  minWidth: 0,
  overflowWrap: 'anywhere',
}
