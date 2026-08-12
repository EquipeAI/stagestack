import { useCallback, useState } from 'react'
import { Link, createFileRoute, useBlocker } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { Doc } from '@convex/_generated/dataModel'
import type { FunctionReturnType } from 'convex/server'
import type {
  FieldDef,
  FieldKind,
  FormDef,
  SectionDef,
} from '@convex/shared/formDef'
import type * as React from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  StatusPill,
  Switch,
  Tag,
  Textarea,
  Toolbar,
} from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'
import { formatDateTime } from '~/lib/datetime'
import {
  KIND_LABEL,
  KIND_OPTIONS,
  collectIds,
  conditionCandidates,
  dropConditionsOn,
  emptySection,
  isChoiceKind,
  moved,
  newField,
  normalizeFormDef,
  sameForm,
  sectionHasSystemFields,
} from '~/lib/cfpForm'
import { ConditionEditor } from '~/components/cfp/ConditionEditor'
import { FormPreview } from '~/components/cfp/FormPreview'
import { ShareCallCard } from '~/components/cfp/ShareCallCard'

export const Route = createFileRoute('/app/e/$eventSlug/cfp')({
  component: CfpRoute,
})

type FormView = FunctionReturnType<typeof api.cfp.getForm>

function CfpRoute() {
  const { eventSlug } = Route.useParams()
  const data = useQuery(api.events.get, { eventSlug })

  if (data === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading the form…</p>
  }
  if (data.role !== 'organizer') {
    return (
      <Callout tone="blocked" title="The form builder is organizer-only">
        You have reviewer access to this event.
      </Callout>
    )
  }
  return <CfpLoader eventSlug={eventSlug} event={data.event} />
}

function CfpLoader({
  eventSlug,
  event,
}: {
  eventSlug: string
  event: Doc<'events'>
}) {
  const form = useQuery(api.cfp.getForm, { eventSlug })
  if (form === undefined) {
    return <p style={{ color: 'var(--text-tertiary)' }}>Loading the form…</p>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <Builder key={`builder-${event._id}`} eventSlug={eventSlug} event={event} form={form} />
      <ShareCallCard
        eventSlug={eventSlug}
        event={event}
        formPublished={form.published !== null}
      />
      <FormSettingsCard
        key={`settings-${event._id}`}
        eventSlug={eventSlug}
        form={form}
      />
    </div>
  )
}

// ── Builder ───────────────────────────────────────────────────────────────

/** Everything a section or field row needs to mutate the draft. */
type Ctl = {
  def: FormDef
  /** Format names from the event library, verbatim — what "Use the formats
   * library" writes into a choice question's options. Exact strings matter:
   * conditional logic compares answers to these literally. */
  formatNames: Array<string>
  openFieldId: string | null
  setOpenFieldId: (id: string | null) => void
  updateSection: (si: number, patch: Partial<SectionDef>) => void
  removeSection: (si: number) => void
  moveSection: (si: number, delta: number) => void
  addField: (si: number, kind: FieldKind) => void
  updateField: (si: number, fi: number, patch: Partial<FieldDef>) => void
  removeField: (si: number, fi: number) => void
  moveField: (si: number, fi: number, delta: number) => void
}

function Builder({
  eventSlug,
  event,
  form,
}: {
  eventSlug: string
  event: Doc<'events'>
  form: FormView
}) {
  const saveForm = useMutation(api.cfp.updateWorkingForm)
  const publishForm = useMutation(api.cfp.publishForm)
  const library = useQuery(api.library.list, { eventSlug })
  const saving = usePending()
  const publishing = usePending()

  const [draft, setDraft] = useState<FormDef>(form.working)
  // The working copy this draft was seeded from. `form.working` moves when a
  // colleague saves; the baseline stays put, which is how "you edited" is told
  // apart from "the server moved" — dirty against the live copy would blame
  // their save on you (or silently rebase your save over theirs).
  const [baseline, setBaseline] = useState<FormDef>(form.working)
  // Last copy the subscription delivered. Re-seeding keys off a *new delivery*
  // rather than off disagreement with the baseline, so the stale copy still on
  // the wire right after our own save never overwrites the just-saved draft.
  const [lastServer, setLastServer] = useState<FormDef>(form.working)
  const [openFieldId, setOpenFieldId] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const dirty = !sameForm(draft, baseline)
  // A new working copy arrived (a colleague saved, or our save round-tripped).
  // Follow it while this screen is clean; when dirty, keep the draft and let
  // the conflict notice make the choice explicit. (State adjusted during
  // render, so the stale draft is never painted.)
  if (!sameForm(lastServer, form.working)) {
    setLastServer(form.working)
    if (!dirty) {
      setDraft(form.working)
      setBaseline(form.working)
    }
  }
  const conflicted = dirty && !sameForm(baseline, form.working)
  const diverged = !sameForm(form.working, form.published)
  const publishable = !dirty && diverged

  // Unsaved structure is easy to lose — the builder never autosaves. The
  // blocker covers in-app navigation with a dialog and (via its built-in
  // beforeunload registration) the tab close.
  const blocker = useBlocker({
    shouldBlockFn: useCallback(() => true, []),
    disabled: !dirty,
    withResolver: true,
  })

  const ctl: Ctl = {
    def: draft,
    formatNames: (library?.formats ?? []).map((f) => f.name),
    openFieldId,
    setOpenFieldId,
    updateSection: (si, patch) =>
      setDraft((d) => ({
        sections: d.sections.map((s, i) => (i === si ? { ...s, ...patch } : s)),
      })),
    removeSection: (si) =>
      setDraft((d) => {
        const section = d.sections[si]
        let next: FormDef = {
          sections: d.sections.filter((_, i) => i !== si),
        }
        for (const field of section.fields) next = dropConditionsOn(next, field.id)
        return next
      }),
    moveSection: (si, delta) =>
      setDraft((d) => ({ sections: moved(d.sections, si, delta) })),
    addField: (si, kind) => {
      // Id uniqueness reads the rendered snapshot (updaters must stay pure and
      // the id is needed for setOpenFieldId); the append itself is functional
      // like its siblings, so a batched sibling edit is never lost.
      const field = newField(kind, collectIds(draft))
      setDraft((d) => ({
        sections: d.sections.map((s, i) =>
          i === si ? { ...s, fields: [...s.fields, field] } : s,
        ),
      }))
      setOpenFieldId(field.id)
    },
    updateField: (si, fi, patch) =>
      setDraft((d) => ({
        sections: d.sections.map((s, i) =>
          i === si
            ? {
                ...s,
                fields: s.fields.map((f, j) => (j === fi ? { ...f, ...patch } : f)),
              }
            : s,
        ),
      })),
    removeField: (si, fi) =>
      setDraft((d) => {
        const field = d.sections[si].fields[fi]
        const next: FormDef = {
          sections: d.sections.map((s, i) =>
            i === si ? { ...s, fields: s.fields.filter((_, j) => j !== fi) } : s,
          ),
        }
        return dropConditionsOn(next, field.id)
      }),
    moveField: (si, fi, delta) =>
      setDraft((d) => ({
        sections: d.sections.map((s, i) =>
          i === si ? { ...s, fields: moved(s.fields, fi, delta) } : s,
        ),
      })),
  }

  const onSave = () => {
    void saving.run(async () => {
      const def = normalizeFormDef(draft)
      await saveForm({ eventSlug, def })
      setDraft(def)
      // The saved copy is the new baseline — this also clears a conflict,
      // because overwriting via Save is the explicit choice the notice offers.
      setBaseline(def)
      pushToast('Form saved', 'The working copy is stored. Publish to make it live.')
    })
  }

  const onPublish = () => {
    void publishing.run(async () => {
      const result = await publishForm({ eventSlug })
      setConfirmOpen(false)
      pushToast(
        'Form published',
        `Version ${result.version} is the live CFP form. Existing submissions are unchanged.`,
      )
    })
  }

  const fieldCount = draft.sections.reduce((n, s) => n + s.fields.length, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div
        style={{
          position: 'sticky',
          top: 'var(--topbar-height)',
          zIndex: 'var(--z-sticky)',
          background: 'var(--surface-canvas)',
          paddingTop: 'var(--space-2)',
        }}
      >
        <Toolbar
          left={
            <>
              <StatusPill
                status={form.published === null ? 'Unpublished' : 'Published'}
              />
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-tertiary)',
                }}
              >
                {form.published === null || form.publishedAt === null
                  ? 'never published'
                  : `v${form.version} · ${formatDateTime(form.publishedAt, event.timezone)}`}
              </span>
              {diverged && form.published !== null ? (
                <Badge tone="attention">Draft changes</Badge>
              ) : null}
              {dirty ? (
                <Badge tone="attention" dot>
                  Unsaved changes
                </Badge>
              ) : null}
            </>
          }
          right={
            <>
              <Button size="sm" iconLeft="eye" onClick={() => setPreviewOpen(true)}>
                Preview
              </Button>
              <Button size="sm" onClick={onSave} disabled={!dirty || saving.pending}>
                {saving.pending ? 'Saving…' : 'Save'}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setConfirmOpen(true)}
                disabled={!publishable || publishing.pending}
              >
                Publish form
              </Button>
            </>
          }
        />
      </div>

      {saving.error !== null ? (
        <Callout tone="blocked" title="The form was not saved">
          {saving.error}
        </Callout>
      ) : null}
      {publishing.error !== null ? (
        <Callout tone="blocked" title="The form was not published">
          {publishing.error}
        </Callout>
      ) : null}
      {conflicted ? (
        <Callout
          tone="blocked"
          title="Someone else saved this form while you were editing"
          actions={
            <Button
              size="sm"
              onClick={() => {
                setDraft(form.working)
                setBaseline(form.working)
              }}
            >
              Discard my changes and load theirs
            </Button>
          }
        >
          The working copy on the server is no longer the one you started from.
          Saving now replaces their version with yours.
        </Callout>
      ) : null}
      {/* Gating and the public link live in Share the call, below the builder.
          What stays here is the boundary people trip on: this screen owns the
          questions, Settings owns everything else about the call. */}
      <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
        "Publish form" decides which version submitters answer. The Opens/Closes
        window, tracks, tags, rooms and custom fields live in{' '}
        <Link to="/app/e/$eventSlug/settings" params={{ eventSlug }}>
          Settings
        </Link>
        , not in this builder.
      </p>

      {draft.sections.map((section, index) => (
        <SectionCard
          key={section.id}
          section={section}
          index={index}
          total={draft.sections.length}
          ctl={ctl}
        />
      ))}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <Button
          iconLeft="plus"
          onClick={() =>
            setDraft((d) => ({
              sections: [...d.sections, emptySection(collectIds(d))],
            }))
          }
        >
          Add section
        </Button>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-tertiary)',
          }}
        >
          {draft.sections.length}/30 sections · {fieldCount}/60 questions
        </span>
      </div>

      {previewOpen ? (
        <Dialog
          title="Preview"
          description="The working form, exactly as a submitter would branch through it."
          width={860}
          onClose={() => setPreviewOpen(false)}
          footer={
            <Button variant="primary" onClick={() => setPreviewOpen(false)}>
              Close preview
            </Button>
          }
        >
          <FormPreview def={normalizeFormDef(draft)} />
        </Dialog>
      ) : null}

      {blocker.status === 'blocked' ? (
        <Dialog
          title="Leave without saving?"
          description="This form has unsaved changes. They are lost if you leave now."
          onClose={blocker.reset}
          footer={
            <>
              <Button onClick={blocker.reset}>Keep editing</Button>
              <Button variant="danger" onClick={blocker.proceed}>
                Discard changes
              </Button>
            </>
          }
        >
          <p style={{ color: 'var(--text-secondary)' }}>
            Save first if you want to keep them — the builder never saves on
            its own.
          </p>
        </Dialog>
      ) : null}

      {confirmOpen ? (
        <Dialog
          title="Publish form?"
          description={`Publishing replaces the live form (v${form.version} → v${form.version + 1}). Existing submissions are not changed.`}
          onClose={() => setConfirmOpen(false)}
          footer={
            <>
              <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={onPublish}
                disabled={publishing.pending}
              >
                {publishing.pending ? 'Publishing…' : 'Publish form'}
              </Button>
            </>
          }
        >
          <p style={{ color: 'var(--text-secondary)' }}>
            Everyone opening the CFP page from now on answers the new form.
            Proposals already submitted keep the answers and the version they
            were validated against.
          </p>
        </Dialog>
      ) : null}
    </div>
  )
}

// ── Section ───────────────────────────────────────────────────────────────

function SectionCard({
  section,
  index,
  total,
  ctl,
}: {
  section: SectionDef
  index: number
  total: number
  ctl: Ctl
}) {
  const [kindToAdd, setKindToAdd] = useState<FieldKind>('text')
  const locked = sectionHasSystemFields(section)

  const remove = () => {
    if (total === 1) {
      pushToast('Section kept', 'A form needs at least one section.')
      return
    }
    if (locked) {
      pushToast(
        'Section kept',
        'It holds locked questions. Move them to another section first.',
      )
      return
    }
    ctl.removeSection(index)
  }

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-tertiary)',
            }}
          >
            {index + 1}
          </span>
          <div style={{ flex: '1 1 16rem' }}>
            <Input
              value={section.title}
              placeholder="Section title"
              onChange={(e) => ctl.updateSection(index, { title: e.target.value })}
            />
          </div>
          <MoveButtons
            what="section"
            upDisabled={index === 0}
            downDisabled={index === total - 1}
            onUp={() => ctl.moveSection(index, -1)}
            onDown={() => ctl.moveSection(index, 1)}
          />
          <IconButton
            icon="trash-2"
            label="Remove section"
            size="sm"
            onClick={remove}
          />
        </div>

        <Input
          value={section.description ?? ''}
          placeholder="Description (optional)"
          onChange={(e) => ctl.updateSection(index, { description: e.target.value })}
        />

        <ConditionEditor
          subject="section"
          value={section.visibleIf}
          candidates={conditionCandidates(ctl.def, { sectionId: section.id })}
          onChange={(visibleIf) => ctl.updateSection(index, { visibleIf })}
        />

        {section.fields.length === 0 ? (
          <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
            No questions in this section yet.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {section.fields.map((field, fieldIndex) => (
              <FieldRow
                key={field.id}
                field={field}
                sectionIndex={index}
                fieldIndex={fieldIndex}
                total={section.fields.length}
                ctl={ctl}
              />
            ))}
          </ul>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          <Select
            size="sm"
            value={kindToAdd}
            options={KIND_OPTIONS}
            onChange={(e) => setKindToAdd(e.target.value as FieldKind)}
          />
          <Button
            size="sm"
            iconLeft="plus"
            onClick={() => ctl.addField(index, kindToAdd)}
          >
            Add question
          </Button>
        </div>
      </div>
    </Card>
  )
}

// ── Field ─────────────────────────────────────────────────────────────────

function FieldRow({
  field,
  sectionIndex,
  fieldIndex,
  total,
  ctl,
}: {
  field: FieldDef
  sectionIndex: number
  fieldIndex: number
  total: number
  ctl: Ctl
}) {
  const locked = field.systemKey !== undefined
  const open = ctl.openFieldId === field.id
  const patch = (next: Partial<FieldDef>) =>
    ctl.updateField(sectionIndex, fieldIndex, next)

  const remove = () => {
    if (locked) {
      pushToast(
        'Question kept',
        `"${field.label}" feeds the proposal record and can't be removed.`,
      )
      return
    }
    if (open) ctl.setOpenFieldId(null)
    ctl.removeField(sectionIndex, fieldIndex)
  }

  return (
    <li style={{ borderBottom: 'var(--space-px) solid var(--border-subtle)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          minHeight: 'var(--row-height-lg)',
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => ctl.setOpenFieldId(open ? null : field.id)}
          style={{
            flex: '1 1 12rem',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            textAlign: 'left',
            padding: 'var(--space-2) 0',
            background: 'none',
            border: 0,
            cursor: 'pointer',
            font: 'var(--type-body)',
            color: 'var(--text-primary)',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              color: 'var(--text-tertiary)',
              transform: open ? undefined : 'rotate(-90deg)',
            }}
          >
            <Icon name="chevron-down" size={14} />
          </span>
          <span>{field.label.trim() === '' ? 'Untitled question' : field.label}</span>
        </button>
        <Tag>{KIND_LABEL[field.kind]}</Tag>
        {locked ? <Badge tone="neutral">Locked</Badge> : null}
        {field.visibleIf !== undefined ? (
          <Badge tone="info">Conditional</Badge>
        ) : null}
        <Switch
          label="Required"
          checked={field.required}
          disabled={locked}
          onChange={(e) => patch({ required: e.target.checked })}
        />
        <MoveButtons
          what="question"
          upDisabled={fieldIndex === 0}
          downDisabled={fieldIndex === total - 1}
          onUp={() => ctl.moveField(sectionIndex, fieldIndex, -1)}
          onDown={() => ctl.moveField(sectionIndex, fieldIndex, 1)}
        />
        <IconButton
          icon="trash-2"
          label="Remove question"
          size="sm"
          onClick={remove}
        />
      </div>

      {open ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
            padding: 'var(--space-2) 0 var(--space-5) var(--space-6)',
          }}
        >
          <div style={twoCol}>
            <Field
              label="Label"
              htmlFor={`f-${field.id}-label`}
              hint={
                locked
                  ? 'Rename freely — answers keep feeding the proposal record.'
                  : undefined
              }
            >
              <Input
                id={`f-${field.id}-label`}
                value={field.label}
                placeholder="What are you asking?"
                onChange={(e) => patch({ label: e.target.value })}
              />
            </Field>
            <Field
              label="Type"
              htmlFor={`f-${field.id}-kind`}
              hint={locked ? 'Locked questions keep their type.' : undefined}
            >
              <Select
                id={`f-${field.id}-kind`}
                disabled={locked}
                value={field.kind}
                options={KIND_OPTIONS}
                onChange={(e) => {
                  const kind = e.target.value as FieldKind
                  patch(
                    isChoiceKind(kind) && (field.options ?? []).length === 0
                      ? { kind, options: ['Option 1'] }
                      : { kind },
                  )
                }}
              />
            </Field>
          </div>

          <Field
            label="Help text"
            htmlFor={`f-${field.id}-help`}
            optional
            hint="Shown under the question on the CFP page."
          >
            <Input
              id={`f-${field.id}-help`}
              value={field.help ?? ''}
              onChange={(e) => patch({ help: e.target.value })}
            />
          </Field>

          {isChoiceKind(field.kind) ? (
            <Field
              label="Options"
              htmlFor={`f-${field.id}-options`}
              hint="One per line. Blank lines are dropped when you save."
            >
              <Textarea
                id={`f-${field.id}-options`}
                rows={4}
                value={(field.options ?? []).join('\n')}
                onChange={(e) => patch({ options: e.target.value.split('\n') })}
              />
            </Field>
          ) : null}

          {isChoiceKind(field.kind) && ctl.formatNames.length > 0 ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                flexWrap: 'wrap',
              }}
            >
              <Button
                size="sm"
                iconLeft="list-checks"
                onClick={() => patch({ options: ctl.formatNames })}
              >
                Use the formats library
              </Button>
              <span
                style={{
                  font: 'var(--type-caption)',
                  color: 'var(--text-tertiary)',
                }}
              >
                Replaces the options above with {ctl.formatNames.join(' · ')} —
                exactly as named in Settings, so answers keep matching the
                library and any conditional logic that reads them.
              </span>
            </div>
          ) : null}

          {field.kind === 'file' ? (
            <Field
              label="Accepted file types"
              htmlFor={`f-${field.id}-accept`}
              optional
              hint="A browser hint, e.g. .pdf,.key,.pptx"
            >
              <Input
                id={`f-${field.id}-accept`}
                value={field.accept ?? ''}
                onChange={(e) => patch({ accept: e.target.value })}
              />
            </Field>
          ) : null}

          <ConditionEditor
            subject="field"
            value={field.visibleIf}
            candidates={conditionCandidates(ctl.def, { fieldId: field.id })}
            onChange={(visibleIf) => patch({ visibleIf })}
          />

          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-tertiary)',
            }}
          >
            id {field.id}
            {locked ? ' · answers key off this id' : null}
          </span>
        </div>
      ) : null}
    </li>
  )
}

/** The icon set has no "up" glyph — the down chevron is rotated for it. */
function MoveButtons({
  what,
  upDisabled,
  downDisabled,
  onUp,
  onDown,
}: {
  what: string
  upDisabled: boolean
  downDisabled: boolean
  onUp: () => void
  onDown: () => void
}) {
  return (
    <>
      <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
        <IconButton
          icon="chevron-down"
          label={`Move ${what} up`}
          size="sm"
          disabled={upDisabled}
          onClick={onUp}
        />
      </span>
      <IconButton
        icon="chevron-down"
        label={`Move ${what} down`}
        size="sm"
        disabled={downDisabled}
        onClick={onDown}
      />
    </>
  )
}

// ── Form settings ─────────────────────────────────────────────────────────

function FormSettingsCard({
  eventSlug,
  form,
}: {
  eventSlug: string
  form: FormView
}) {
  const update = useMutation(api.cfp.updateFormSettings)
  const { pending, error, setError, run } = usePending()
  const [max, setMax] = useState(
    form.maxSubmissionsPerUser === null ? '' : String(form.maxSubmissionsPerUser),
  )
  const [message, setMessage] = useState(form.successMessage ?? '')

  const save = () => {
    const trimmed = max.trim()
    let parsed: number | null = null
    if (trimmed !== '') {
      const value = Number(trimmed)
      if (!Number.isInteger(value) || value < 1) {
        return setError('Proposals per person must be a whole number, 1 or more.')
      }
      parsed = value
    }
    void run(async () => {
      await update({
        eventSlug,
        maxSubmissionsPerUser: parsed,
        successMessage: message.trim() === '' ? null : message.trim(),
      })
      pushToast(
        'Form settings saved',
        parsed === null
          ? 'Submitters can send any number of proposals.'
          : `Each submitter can send ${parsed} proposal${parsed === 1 ? '' : 's'}.`,
      )
    })
  }

  return (
    <Card
      title="Submission settings"
      subtitle="These apply the moment you save — they are not part of the published form version."
      footer={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            justifyContent: 'flex-end',
          }}
        >
          {error !== null ? (
            <span style={{ color: 'var(--text-danger)', font: 'var(--type-caption)' }}>
              {error}
            </span>
          ) : null}
          <Button variant="primary" onClick={save} disabled={pending}>
            {pending ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Field
          label="Proposals per person"
          htmlFor="cfp-max"
          optional
          hint="Leave empty for no limit."
        >
          <Input
            id="cfp-max"
            type="number"
            value={max}
            placeholder="No limit"
            onChange={(e) => setMax(e.target.value)}
          />
        </Field>
        <Field
          label="Message after submitting"
          htmlFor="cfp-success"
          optional
          hint="Shown on the confirmation screen. Say when decisions go out."
        >
          <Textarea
            id="cfp-success"
            rows={3}
            value={message}
            placeholder="Thanks — we review proposals weekly and decide by 14 Apr."
            onChange={(e) => setMessage(e.target.value)}
          />
        </Field>
      </div>
    </Card>
  )
}

const twoCol: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
  gap: 'var(--space-4)',
}
