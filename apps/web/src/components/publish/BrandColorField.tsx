/* eslint-disable no-restricted-syntax --
 * Hex literals are the SUBJECT of this field, not styling choices: the two
 * preview surfaces deliberately simulate an external light/dark host page (a
 * DS token would follow the organizer's own theme and preview nothing), and
 * the rest are example values in copy the rule itself demands. */
import { checkBrandColor } from '@convex/shared/brandColor'
import { Field, Input, Tag } from '~/ds'

// W5: the embed console used to invite "Any CSS color, e.g. rebeccapurple"
// into a backend that has only ever accepted hex — the rule was learnable only
// by being refused. This field states the rule, checks it with the SAME
// predicate the backend enforces (`convex/shared/brandColor.ts`), warns
// honestly about contrast without blocking, and shows the accent where it will
// actually land: on a chip, over both a light and a dark host page.
//
// It lives in its own component, outside the publish route's 1100 lines, so
// W10's Publish Center rebuild inherits it by import rather than by copy.

/** The two backgrounds the preview (and the contrast check) assume. */
const PREVIEW_SURFACES: Array<{ label: string; background: string; text: string }> = [
  { label: 'Light host page', background: '#FFFFFF', text: '#131920' },
  { label: 'Dark host page', background: '#12161C', text: '#F5F8FA' },
]

export function BrandColorField({
  value,
  onChange,
  id = 'embed-brand-color',
}: {
  value: string
  onChange: (next: string) => void
  id?: string
}) {
  const check = checkBrandColor(value)
  // The native picker only speaks #rrggbb; a shorthand or alpha value is kept
  // in the text field and the picker just shows the nearest thing it can.
  const swatch = /^#[0-9a-fA-F]{6}$/.test(value.trim())
    ? value.trim()
    : '#7C5CFF'
  const accent = check.error === null && value.trim() !== '' ? value.trim() : undefined

  return (
    <Field
      label="Brand color"
      optional
      htmlFor={id}
      hint="Hex only — #7c5cff or #7c5cffcc. It accents tags, chips and highlights."
      error={check.error ?? undefined}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
          }}
        >
          <input
            type="color"
            aria-label="Pick a brand color"
            value={swatch}
            onChange={(e) => onChange(e.target.value)}
            style={{
              width: '2.5rem',
              height: '2.5rem',
              flex: 'none',
              padding: 0,
              border: 'var(--space-px) solid var(--border-default)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-card)',
              cursor: 'pointer',
            }}
          />
          <Input
            id={id}
            value={value}
            placeholder="#7c5cff"
            onChange={(e) => onChange(e.target.value)}
          />
        </div>

        {check.warning === null ? null : (
          <p
            role="status"
            style={{
              margin: 'var(--space-0)',
              font: 'var(--type-caption)',
              color: 'var(--status-attention-fg)',
            }}
          >
            {check.warning}
          </p>
        )}

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
          }}
        >
          {PREVIEW_SURFACES.map((surface) => (
            <div
              key={surface.label}
              style={{
                flex: '1 1 10rem',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                padding: 'var(--space-3)',
                background: surface.background,
                color: surface.text,
                border: 'var(--space-px) solid var(--border-default)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <span style={{ font: 'var(--type-caption)', opacity: 0.7 }}>
                {surface.label}
              </span>
              <span>
                <Tag color={accent ?? 'var(--amber-400)'}>Main stage</Tag>
              </span>
              <span
                style={{
                  font: 'var(--type-caption)',
                  color: accent ?? 'var(--amber-400)',
                }}
              >
                {accent === undefined
                  ? 'Default accent'
                  : `${accent}${check.ratio === null ? '' : ` · ${check.ratio}:1`}`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Field>
  )
}
