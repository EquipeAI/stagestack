import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { conditionMet } from '@convex/shared/formDef'
import {
  answerList,
  answerString,
  answerSummary,
  fieldDomId,
  isBlankAnswer,
  isEmailLike,
  isUrlLike,
} from './model'
import type { AnswerValue, FieldDef, FormDef } from '@convex/shared/formDef'
import type { Id } from '@convex/_generated/dataModel'
import type { Answers, UploadedNames } from './model'
import {
  Button,
  Card,
  Checkbox,
  DescriptionList,
  Field,
  Input,
  RadioGroup,
  Select,
  Textarea,
} from '~/ds'
import { FileButton } from '~/components/FileButton'
import { errorMessage } from '~/lib/errors'

// The CFP form renderer, shared by the submission wizard and the manage page.
// Conditional visibility is evaluated live on every keystroke, so hiding a
// field also stops it being required — the same rule the server enforces.

export function CfpForm({
  form,
  answers,
  onChange,
  proposalId,
  disabled = false,
  flagged,
  uploadedNames,
  onUploaded,
}: {
  form: FormDef
  answers: Answers
  onChange: (fieldId: string, value: AnswerValue) => void
  proposalId: Id<'proposals'>
  disabled?: boolean
  /** Field ids to surface inline — set once the submitter tried to submit. */
  flagged?: ReadonlySet<string>
  /** Filenames for file answers uploaded in this session. */
  uploadedNames?: UploadedNames
  onUploaded?: (fieldId: string, filename: string) => void
}) {
  const sections = form.sections.filter((s) => conditionMet(s.visibleIf, answers))

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
    >
      {sections.map((section) => {
        const fields = section.fields.filter((f) =>
          conditionMet(f.visibleIf, answers),
        )
        if (fields.length === 0) return null
        return (
          <Card
            key={section.id}
            title={section.title}
            subtitle={section.description}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-5)',
              }}
            >
              {fields.map((field) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  value={answers[field.id]}
                  onChange={(next) => {
                    onChange(field.id, next)
                  }}
                  proposalId={proposalId}
                  disabled={disabled}
                  flagged={flagged?.has(field.id) ?? false}
                  uploadedName={uploadedNames?.[field.id]}
                  onUploaded={(name) => onUploaded?.(field.id, name)}
                />
              ))}
            </div>
          </Card>
        )
      })}
    </div>
  )
}

/** Read-only rendering of the same form — Review step and closed proposals. */
export function CfpAnswersSummary({
  form,
  answers,
  uploadedNames,
}: {
  form: FormDef
  answers: Answers
  uploadedNames?: UploadedNames
}) {
  const sections = form.sections.filter((s) => conditionMet(s.visibleIf, answers))
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
    >
      {sections.map((section) => {
        const fields = section.fields.filter((f) =>
          conditionMet(f.visibleIf, answers),
        )
        if (fields.length === 0) return null
        return (
          <Card key={section.id} title={section.title}>
            <DescriptionList
              stacked
              items={fields.map((field) => ({
                term: field.label,
                value: (
                  <span
                    style={{
                      whiteSpace: 'pre-wrap',
                      color: isBlankAnswer(answers[field.id])
                        ? 'var(--text-tertiary)'
                        : 'var(--text-primary)',
                    }}
                  >
                    {answerSummary(
                      field,
                      answers[field.id],
                      uploadedNames?.[field.id],
                    )}
                  </span>
                ),
              }))}
            />
          </Card>
        )
      })}
    </div>
  )
}

function FieldRow({
  field,
  value,
  onChange,
  proposalId,
  disabled,
  flagged,
  uploadedName,
  onUploaded,
}: {
  field: FieldDef
  value: AnswerValue | undefined
  onChange: (value: AnswerValue) => void
  proposalId: Id<'proposals'>
  disabled: boolean
  flagged: boolean
  uploadedName?: string
  onUploaded: (filename: string) => void
}) {
  const id = fieldDomId(field.id)
  const text = answerString(value).trim()
  const blank = isBlankAnswer(value)

  let error: string | null = null
  if (flagged && field.required && blank) {
    error = 'This question is required.'
  } else if (text.length > 0 && field.kind === 'email' && !isEmailLike(text)) {
    error = 'Enter a valid email address.'
  } else if (text.length > 0 && field.kind === 'url' && !isUrlLike(text)) {
    error = 'Enter a full URL, starting with https://'
  }

  const invalid = error !== null
  const hint =
    field.kind === 'wysiwyg'
      ? [field.help, 'Plain text for now — formatting is not preserved.']
          .filter(Boolean)
          .join(' ')
      : field.help

  // `radio` and `multiselect` render a group of inputs rather than one
  // labelable element, so a <label for> aimed at them names nothing; Field
  // names the group with aria-labelledby instead, and the group keeps `id` so
  // the Review step's error-jump still has somewhere to land.
  const grouped = field.kind === 'radio' || field.kind === 'multiselect'

  return (
    <Field
      label={field.label}
      htmlFor={grouped ? undefined : id}
      required={field.required}
      hint={hint}
      error={error ?? undefined}
    >
      {/* Called, not rendered as <Control>: Field wires aria-describedby by
          cloning its child, so the child has to be the control itself and not
          a wrapper component that would swallow the attribute. */}
      {renderControl({
        id,
        field,
        value,
        onChange,
        proposalId,
        disabled,
        invalid,
        uploadedName,
        onUploaded,
      })}
    </Field>
  )
}

function renderControl({
  id,
  field,
  value,
  onChange,
  proposalId,
  disabled,
  invalid,
  uploadedName,
  onUploaded,
}: {
  id: string
  field: FieldDef
  value: AnswerValue | undefined
  onChange: (value: AnswerValue) => void
  proposalId: Id<'proposals'>
  disabled: boolean
  invalid: boolean
  uploadedName?: string
  onUploaded: (filename: string) => void
}) {
  const text = answerString(value)
  const options = field.options ?? []

  switch (field.kind) {
    case 'textarea':
    case 'wysiwyg':
      return (
        <Textarea
          id={id}
          value={text}
          rows={field.kind === 'wysiwyg' ? 10 : 6}
          disabled={disabled}
          invalid={invalid}
          onChange={(e) => {
            onChange(e.target.value)
          }}
        />
      )
    case 'dropdown':
      return (
        <Select
          id={id}
          value={text}
          disabled={disabled}
          // Select has no `invalid` prop; it spreads unknown props onto its
          // <select>, so the state is stated as the ARIA attribute directly.
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            onChange(e.target.value)
          }}
        >
          <option value="">Select an option</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      )
    case 'radio':
      return (
        <RadioGroup
          name={id}
          // The group is the control here: it carries the id the error-jump
          // resolves, and tabIndex -1 makes that jump able to focus it without
          // adding a stop to the tab order the radios already provide.
          id={id}
          tabIndex={-1}
          // Restating the role RadioGroup renders is what lets <Field> see a
          // group rather than a labelable control from the outside, and so name
          // it with aria-labelledby instead of an inert <label for>.
          role="radiogroup"
          options={options}
          value={text}
          aria-invalid={invalid || undefined}
          onChange={(next) => {
            if (!disabled) onChange(next)
          }}
        />
      )
    case 'multiselect': {
      const selected = answerList(value)
      return (
        // role="group" is what makes the description <Field> attaches to this
        // wrapper reachable: aria-describedby is ignored on a bare <div>. The
        // id and tabIndex are there for the same reason as in the radio case.
        <div
          role="group"
          id={id}
          tabIndex={-1}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {options.map((option) => (
            <Checkbox
              key={option}
              label={option}
              disabled={disabled}
              checked={selected.includes(option)}
              // <Field> can only mark the wrapper, so each box states it
              // itself. Checkbox spreads unknown props onto its <input>.
              aria-invalid={invalid || undefined}
              onChange={(e) => {
                onChange(
                  e.target.checked
                    ? [...selected, option]
                    : selected.filter((o) => o !== option),
                )
              }}
            />
          ))}
        </div>
      )
    }
    case 'file':
      return (
        <FileControl
          field={field}
          value={text}
          onChange={onChange}
          proposalId={proposalId}
          disabled={disabled}
          uploadedName={uploadedName}
          onUploaded={onUploaded}
        />
      )
    case 'email':
    case 'phone':
    case 'url':
    case 'text':
      return (
        <Input
          id={id}
          type={
            field.kind === 'email'
              ? 'email'
              : field.kind === 'phone'
                ? 'tel'
                : field.kind === 'url'
                  ? 'url'
                  : 'text'
          }
          value={text}
          disabled={disabled}
          invalid={invalid}
          autoComplete={
            field.systemKey === 'email'
              ? 'email'
              : field.systemKey === 'firstName'
                ? 'given-name'
                : field.systemKey === 'lastName'
                  ? 'family-name'
                  : 'off'
          }
          placeholder={field.kind === 'url' ? 'https://' : undefined}
          onChange={(e) => {
            onChange(e.target.value)
          }}
        />
      )
  }
}

function FileControl({
  field,
  value,
  onChange,
  proposalId,
  disabled,
  uploadedName,
  onUploaded,
}: {
  field: FieldDef
  value: string
  onChange: (value: AnswerValue) => void
  proposalId: Id<'proposals'>
  disabled: boolean
  uploadedName?: string
  onUploaded: (filename: string) => void
}) {
  const generateUploadUrl = useMutation(api.cfp.generateUploadUrl)
  const [uploading, setUploading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const upload = async (file: File) => {
    setUploading(true)
    setFailure(null)
    try {
      const url = await generateUploadUrl({ proposalId })
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!res.ok) throw new Error('Upload failed.')
      const { storageId } = (await res.json()) as { storageId: string }
      onUploaded(file.name)
      onChange(storageId)
    } catch (err) {
      setFailure(errorMessage(err, 'That file could not be uploaded.'))
    } finally {
      setUploading(false)
    }
  }

  const hasFile = value.length > 0
  const label = uploading
    ? 'Uploading…'
    : hasFile
      ? 'Replace file'
      : 'Choose file'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        alignItems: 'flex-start',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        {disabled || uploading ? (
          <Button size="sm" iconLeft="upload" disabled>
            {label}
          </Button>
        ) : (
          <FileButton
            size="sm"
            accept={field.accept}
            onFile={(file) => {
              void upload(file)
            }}
          >
            {label}
          </FileButton>
        )}
        {hasFile ? (
          <span
            style={{
              font: 'var(--type-caption)',
              color: 'var(--text-success)',
            }}
          >
            {uploadedName ?? 'Uploaded file'} · attached
          </span>
        ) : null}
        {hasFile && !disabled ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(null)
            }}
          >
            Remove
          </Button>
        ) : null}
      </div>
      {field.accept !== undefined ? (
        <span style={{ font: 'var(--type-caption)', color: 'var(--text-tertiary)' }}>
          Accepted: {field.accept}
        </span>
      ) : null}
      {failure !== null ? (
        <span style={{ font: 'var(--type-caption)', color: 'var(--text-danger)' }}>
          {failure}
        </span>
      ) : null}
    </div>
  )
}
