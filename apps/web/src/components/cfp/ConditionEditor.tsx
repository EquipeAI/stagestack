import type { Condition, FieldDef } from '@convex/shared/formDef'
import { Button, IconButton, Input, Select } from '~/ds'
import { KIND_LABEL, OP_OPTIONS, isChoiceKind } from '~/lib/cfpForm'

/**
 * "Show this only when <field> <equals|does not equal|includes> <value>".
 * The value control follows the referenced field: its own options when it has
 * some, free text otherwise.
 */
export function ConditionEditor({
  value,
  candidates,
  onChange,
  subject,
}: {
  value: Condition | undefined
  candidates: Array<FieldDef>
  onChange: (next: Condition | undefined) => void
  subject: 'field' | 'section'
}) {
  const noun = subject === 'field' ? 'question' : 'section'

  if (candidates.length === 0) {
    return (
      <p style={{ color: 'var(--text-tertiary)', font: 'var(--type-caption)' }}>
        Conditions need another question to depend on.
      </p>
    )
  }

  if (value === undefined) {
    return (
      <div>
        <Button
          size="sm"
          variant="ghost"
          iconLeft="eye-off"
          onClick={() =>
            onChange({ fieldId: candidates[0].id, op: 'equals', value: '' })
          }
        >
          Show this {noun} conditionally
        </Button>
      </div>
    )
  }

  const target = candidates.find((f) => f.id === value.fieldId)
  const options = target !== undefined && isChoiceKind(target.kind) ? target.options : undefined

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 'var(--space-2)',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-sunken)',
        border: 'var(--space-px) solid var(--border-subtle)',
      }}
    >
      <span style={{ color: 'var(--text-secondary)', font: 'var(--type-caption)' }}>
        Show this {noun} only when
      </span>
      {/* The three controls only make sense as parts of the sentence above,
          which no label element can span — each is named on its own. */}
      <Select
        size="sm"
        aria-label="Condition question"
        value={value.fieldId}
        options={candidates.map((f) => ({
          value: f.id,
          label: `${f.label === '' ? 'Untitled question' : f.label} (${KIND_LABEL[f.kind]})`,
        }))}
        onChange={(e) => onChange({ ...value, fieldId: e.target.value, value: '' })}
      />
      <Select
        size="sm"
        aria-label="Condition operator"
        value={value.op}
        options={OP_OPTIONS}
        onChange={(e) =>
          onChange({ ...value, op: e.target.value as Condition['op'] })
        }
      />
      {options !== undefined && options.length > 0 ? (
        <Select
          size="sm"
          aria-label="Condition value"
          value={value.value}
          options={[{ value: '', label: 'Choose an answer…' }, ...options]}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
      ) : (
        <Input
          size="sm"
          aria-label="Condition value"
          value={value.value}
          placeholder="answer"
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
      )}
      <IconButton
        icon="x"
        label="Remove condition"
        size="sm"
        onClick={() => onChange(undefined)}
      />
    </div>
  )
}
