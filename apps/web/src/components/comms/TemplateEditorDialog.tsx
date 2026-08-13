import { useEffect, useId, useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { varWarning } from '@convex/shared/templateVars'
import { isCustomKey } from './model'
import { MonoText } from './primitives'
import { TokenPalette, fieldById, insertAtCursor } from './TokenPalette'
import type * as React from 'react'
import type { Id } from '@convex/_generated/dataModel'
import type { TemplateRow } from './model'
import { Button, Callout, Dialog, Field, Input, Select, Textarea } from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'

// The editor for one email template. Two things the organizer has to be able
// to see at once: the source they are editing, and what it turns into.
//
// The preview is rendered by the SERVER, draft and all (W3). The editor used
// to mirror the substitution locally so it could show an unsaved draft, and
// the mirror drifted — it substituted a speaker name into decision emails,
// which pass no speaker. Now the draft goes to `templates.preview` and comes
// back rendered by the code the send itself calls: same substitution, same
// escaping, same branded shell, personalised against a real speaker.

/** Keystrokes settle before the preview re-queries. */
const PREVIEW_DEBOUNCE_MS = 300

const SUBJECT_ID = 'tpl-subject'
const BODY_ID = 'tpl-html'

type FieldName = 'subject' | 'body'

export function TemplateEditorDialog({
  eventSlug,
  template,
  onRequestReset,
  onClose,
}: {
  eventSlug: string
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
  const [recipientId, setRecipientId] = useState<Id<'eventContacts'> | ''>('')
  const [activeField, setActiveField] = useState<FieldName>('body')

  const previewLabelId = useId()

  const dirty =
    subject !== template.subject ||
    html !== template.html ||
    (custom && name !== template.name)

  const recipients = useQuery(api.templates.previewRecipients, { eventSlug })

  // The draft is debounced so a preview is one query per pause, not one per
  // keystroke; `undefined` means "preview what is stored".
  const [debounced, setDebounced] = useState<{
    subject: string
    html: string
  } | null>(null)
  useEffect(() => {
    if (!dirty) {
      setDebounced(null)
      return
    }
    const timer = setTimeout(() => {
      setDebounced({ subject, html })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [dirty, subject, html])

  // A custom key with nothing saved and no draft yet has nothing to render.
  const previewable = debounced !== null || !custom || template.customized
  const preview = useQuery(
    api.templates.preview,
    previewable
      ? {
          eventSlug,
          key: template.key,
          ...(debounced === null ? {} : { draft: debounced }),
          ...(recipientId === '' ? {} : { eventContactId: recipientId }),
        }
      : 'skip',
  )

  // Against THIS template's own context, not the global catalog: a real
  // variable the send site never passes renders as nothing just as surely as a
  // misspelled one, and the sentence says which of the two it is.
  const warning = useMemo(
    () => varWarning(template.key, [subject, html]),
    [template.key, subject, html],
  )

  const insert = (path: string) => {
    const token = `{{${path}}}`
    if (activeField === 'subject') {
      insertAtCursor(fieldById(SUBJECT_ID), token, setSubject)
    } else {
      insertAtCursor(fieldById(BODY_ID), token, setHtml)
    }
  }

  const previewStatus =
    preview === undefined
      ? previewable
        ? 'Rendering the preview…'
        : 'Save the template to see it as StageStack sends it.'
      : preview.recipient.sample
        ? `Sample recipient — ${preview.recipient.name} is not a real speaker on this event.`
        : `As ${preview.recipient.name} would receive it.`

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
          <Button variant="primary" disabled={pending || !dirty} onClick={save}>
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

          <Field label="Subject" htmlFor={SUBJECT_ID} required>
            <Input
              id={SUBJECT_ID}
              value={subject}
              disabled={pending}
              onFocus={() => {
                setActiveField('subject')
              }}
              onChange={(e) => {
                setSubject(e.target.value)
              }}
            />
          </Field>

          <Field
            label="Body"
            htmlFor={BODY_ID}
            required
            hint="HTML. StageStack wraps it in the branded shell — write the message, not the page."
          >
            <Textarea
              id={BODY_ID}
              rows={16}
              value={html}
              disabled={pending}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
              }}
              onFocus={() => {
                setActiveField('body')
              }}
              onChange={(e) => {
                setHtml(e.target.value)
              }}
            />
          </Field>

          <TokenPalette
            contextKey={template.key}
            targetLabel={activeField === 'subject' ? 'subject' : 'body'}
            disabled={pending}
            onInsert={insert}
          />

          {warning === null ? null : (
            <Callout tone="attention" title="These render as empty">
              {warning.sentence}
            </Callout>
          )}
        </div>

        <section style={column} aria-labelledby={previewLabelId}>
          <span
            id={previewLabelId}
            style={{ font: 'var(--type-label)', color: 'var(--text-secondary)' }}
          >
            Preview
          </span>

          <Field
            label="Preview as"
            htmlFor="tpl-preview-recipient"
            hint="Rendered against this speaker's own details, by the same code the send runs."
          >
            <Select
              id="tpl-preview-recipient"
              value={recipientId}
              disabled={pending || recipients === undefined}
              options={[
                {
                  value: '',
                  label:
                    recipients !== undefined && recipients.length === 0
                      ? 'Sample speaker (no speakers on this event yet)'
                      : 'Sample speaker',
                },
                ...(recipients ?? []).map((recipient) => ({
                  value: recipient.eventContactId ?? '',
                  label: recipient.name,
                })),
              ]}
              onChange={(e) => {
                setRecipientId(e.target.value as Id<'eventContacts'>)
              }}
            />
          </Field>

          {/* Async: the preview arrives after the query settles, so the
              sentence that says whose copy this is has to be spoken. */}
          <p
            role="status"
            aria-live="polite"
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-tertiary)',
            }}
          >
            {previewStatus}
          </p>

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
              {preview?.subject ?? '—'}
            </span>
          </div>

          <PreviewFrame
            html={preview?.html ?? ''}
            empty={
              previewable
                ? 'Rendering…'
                : 'Save the template to see it as StageStack sends it.'
            }
          />
        </section>
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

// Editor above, preview below on a phone; side by side once there is room.
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
