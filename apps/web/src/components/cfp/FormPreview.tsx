import { useState } from 'react'
import { conditionMet } from '@convex/shared/formDef'
import type {
  AnswerValue,
  FieldDef,
  FieldKind,
  FormDef,
} from '@convex/shared/formDef'
import { Checkbox, Field, Input, RadioGroup, Select, Textarea } from '~/ds'

const INPUT_TYPE: Partial<Record<FieldKind, string>> = {
  email: 'email',
  phone: 'tel',
  url: 'url',
}

/**
 * A live playground for the working form: it honours conditional visibility so
 * an organizer can test the branches, and it never submits anything. The public
 * wizard renders the *published* form with its own component.
 */
export function FormPreview({ def }: { def: FormDef }) {
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({})
  const set = (id: string, value: AnswerValue) =>
    setAnswers((prev) => ({ ...prev, [id]: value }))

  const sections = def.sections.filter((s) => conditionMet(s.visibleIf, answers))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
      <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
        Answers here are not saved. Hidden questions are neither shown nor
        required.
      </p>
      {sections.map((section) => {
        const fields = section.fields.filter((f) => conditionMet(f.visibleIf, answers))
        return (
          <section
            key={section.id}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
          >
            <div>
              <h3 style={{ font: 'var(--type-title-3)', color: 'var(--text-primary)' }}>
                {section.title}
              </h3>
              {section.description !== undefined ? (
                <p
                  style={{
                    color: 'var(--text-secondary)',
                    font: 'var(--type-body)',
                  }}
                >
                  {section.description}
                </p>
              ) : null}
            </div>
            {fields.length === 0 ? (
              <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
                No questions are visible in this section.
              </p>
            ) : (
              fields.map((field) => (
                <PreviewField
                  key={field.id}
                  field={field}
                  value={answers[field.id] ?? null}
                  onChange={(value) => set(field.id, value)}
                />
              ))
            )}
          </section>
        )
      })}
      {sections.length === 0 ? (
        <p style={{ color: 'var(--text-tertiary)' }}>
          No sections are visible with these answers.
        </p>
      ) : null}
    </div>
  )
}

function PreviewField({
  field,
  value,
  onChange,
}: {
  field: FieldDef
  value: AnswerValue
  onChange: (value: AnswerValue) => void
}) {
  const id = `preview-${field.id}`
  const text = typeof value === 'string' ? value : ''
  const selected = Array.isArray(value) ? value : []

  // Same rule as the real renderer (CfpForm): a multiselect or file field is
  // a wrapper, not a labelable control, so <label for> would name nothing —
  // role="group" plus the id lets Field name it with aria-labelledby.
  const grouped = field.kind === 'multiselect' || field.kind === 'file'

  return (
    <Field
      label={field.label === '' ? 'Untitled question' : field.label}
      htmlFor={grouped ? undefined : id}
      required={field.required}
      hint={field.help}
    >
      {field.kind === 'textarea' || field.kind === 'wysiwyg' ? (
        <Textarea
          id={id}
          rows={4}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.kind === 'dropdown' ? (
        <Select
          id={id}
          value={text}
          options={[{ value: '', label: 'Choose…' }, ...(field.options ?? [])]}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.kind === 'radio' ? (
        <RadioGroup
          name={id}
          value={text}
          options={field.options ?? []}
          onChange={(next) => onChange(next)}
        />
      ) : field.kind === 'multiselect' ? (
        <div
          role="group"
          id={id}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
        >
          {(field.options ?? []).map((option) => (
            <Checkbox
              key={option}
              label={option}
              checked={selected.includes(option)}
              onChange={() =>
                onChange(
                  selected.includes(option)
                    ? selected.filter((o) => o !== option)
                    : [...selected, option],
                )
              }
            />
          ))}
        </div>
      ) : field.kind === 'file' ? (
        <div
          role="group"
          id={id}
          style={{
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-control)',
            border: 'var(--space-px) dashed var(--border-strong)',
            color: 'var(--text-tertiary)',
            font: 'var(--type-caption)',
          }}
        >
          File upload
          {field.accept !== undefined ? ` — accepts ${field.accept}` : null}. Uploads
          are disabled in preview.
        </div>
      ) : (
        <Input
          id={id}
          type={INPUT_TYPE[field.kind] ?? 'text'}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  )
}
