import type * as React from 'react'
import type { CriterionDraft } from './launchFlow'
import { Checkbox, Field, IconButton, Input, Select } from '~/ds'

// One scorecard criterion, as the organizer edits it. Numeric bounds stay
// strings while typing; `fieldFromDraft` converts and complains on Next.

export function CriterionEditor({
  draft,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  draft: CriterionDraft
  index: number
  count: number
  onChange: (patch: Partial<CriterionDraft>) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-3)',
        border: 'var(--space-px) solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 2, minWidth: '10rem' }}>
          <Field label="Criterion" htmlFor={`crit-label-${index}`}>
            <Input
              id={`crit-label-${index}`}
              size="sm"
              value={draft.label}
              placeholder="Relevance"
              onChange={(e) => onChange({ label: e.target.value })}
            />
          </Field>
        </div>
        <div style={{ flex: 1, minWidth: '8rem' }}>
          <Field label="Kind" htmlFor={`crit-kind-${index}`}>
            <Select
              id={`crit-kind-${index}`}
              size="sm"
              value={draft.kind}
              options={[
                { value: 'numeric', label: 'Numeric' },
                { value: 'dropdown', label: 'Dropdown' },
                { value: 'text', label: 'Text' },
              ]}
              onChange={(e) =>
                onChange({
                  kind: e.target.value as CriterionDraft['kind'],
                })
              }
            />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          <IconButton
            icon="arrow-up"
            label="Move up"
            size="sm"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            icon="arrow-down"
            label="Move down"
            size="sm"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          />
          <IconButton
            icon="trash-2"
            label="Remove criterion"
            size="sm"
            onClick={onRemove}
          />
        </div>
      </div>

      {draft.kind === 'numeric' ? (
        <div style={threeCol}>
          <Field label="Min" htmlFor={`crit-min-${index}`}>
            <Input
              id={`crit-min-${index}`}
              size="sm"
              type="number"
              value={draft.min}
              onChange={(e) => onChange({ min: e.target.value })}
            />
          </Field>
          <Field label="Max" htmlFor={`crit-max-${index}`}>
            <Input
              id={`crit-max-${index}`}
              size="sm"
              type="number"
              value={draft.max}
              onChange={(e) => onChange({ max: e.target.value })}
            />
          </Field>
          <Field label="Weight" htmlFor={`crit-weight-${index}`}>
            <Input
              id={`crit-weight-${index}`}
              size="sm"
              type="number"
              value={draft.weight}
              onChange={(e) => onChange({ weight: e.target.value })}
            />
          </Field>
        </div>
      ) : null}

      {draft.kind === 'dropdown' ? (
        <Field
          label="Options"
          htmlFor={`crit-options-${index}`}
          hint="Comma separated, e.g. Accept, Maybe, Reject."
        >
          <Input
            id={`crit-options-${index}`}
            size="sm"
            value={draft.options}
            onChange={(e) => onChange({ options: e.target.value })}
          />
        </Field>
      ) : null}

      <Checkbox
        label="Required"
        checked={draft.required}
        onChange={(e) => onChange({ required: e.target.checked })}
      />
    </div>
  )
}

const threeCol: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 6rem), 1fr))',
  gap: 'var(--space-3)',
}
