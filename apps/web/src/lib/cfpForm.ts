import type {
  Condition,
  FieldDef,
  FieldKind,
  FormDef,
  SectionDef,
} from '@convex/shared/formDef'

// Client-side helpers for the CFP form builder. Everything here mirrors a rule
// the server enforces in convex/model/cfp.ts — the builder's job is to make an
// invalid form hard to produce, not to replace that validation.

/** Mirrors ID_RE in convex/model/cfp.ts. */
const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/

export const FIELD_KINDS = [
  'text',
  'textarea',
  'wysiwyg',
  'dropdown',
  'multiselect',
  'radio',
  'email',
  'phone',
  'url',
  'file',
] as const satisfies ReadonlyArray<FieldKind>

/** Kind names as an organizer reads them. The stored value stays the kind id. */
export const KIND_LABEL: Record<FieldKind, string> = {
  text: 'Short text',
  textarea: 'Long text',
  wysiwyg: 'Rich text',
  dropdown: 'Dropdown',
  multiselect: 'Multi-select',
  radio: 'Radio',
  email: 'Email',
  phone: 'Phone',
  url: 'URL',
  file: 'File upload',
}

const CHOICE_KINDS: ReadonlyArray<FieldKind> = ['dropdown', 'multiselect', 'radio']

export function isChoiceKind(kind: FieldKind) {
  return CHOICE_KINDS.includes(kind)
}

export const KIND_OPTIONS = FIELD_KINDS.map((kind) => ({
  value: kind,
  label: KIND_LABEL[kind],
}))

export const OP_OPTIONS = [
  { value: 'equals', label: 'equals' },
  { value: 'notEquals', label: 'does not equal' },
  { value: 'includes', label: 'includes' },
]

// ── Ids ───────────────────────────────────────────────────────────────────

function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Every id in the document — sections and fields share one namespace. */
export function collectIds(def: FormDef): Set<string> {
  const ids = new Set<string>()
  for (const section of def.sections) {
    ids.add(section.id)
    for (const field of section.fields) ids.add(field.id)
  }
  return ids
}

/**
 * A stable, slug-ish id derived from the label plus a short suffix, so two
 * fields sharing a label never collide. Ids are answer keys: once created they
 * are never regenerated from a renamed label.
 */
export function newId(label: string, taken: Set<string>): string {
  const base = slugify(label).slice(0, 30).replace(/-+$/, '')
  const stem = /^[a-z]/.test(base) ? base : `f${base === '' ? '' : `-${base}`}`
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = `${stem}-${Math.random().toString(36).slice(2, 6)}`
    if (!taken.has(id) && ID_RE.test(id)) return id
  }
  return `f-${Date.now().toString(36)}`
}

// ── Normalisation ─────────────────────────────────────────────────────────

function normalizeField(field: FieldDef): FieldDef {
  const out: FieldDef = {
    id: field.id,
    kind: field.kind,
    label: field.label.trim(),
    required: field.required,
  }
  const help = field.help?.trim()
  if (help !== undefined && help !== '') out.help = help
  if (isChoiceKind(field.kind)) {
    out.options = (field.options ?? []).map((o) => o.trim()).filter((o) => o !== '')
  }
  if (field.systemKey !== undefined) out.systemKey = field.systemKey
  if (field.visibleIf !== undefined) out.visibleIf = field.visibleIf
  const accept = field.accept?.trim()
  if (field.kind === 'file' && accept !== undefined && accept !== '') {
    out.accept = accept
  }
  return out
}

/**
 * Drops the optional keys the builder carries around while editing (empty help
 * text, options on a kind that no longer has any). Applied both before saving
 * and before the dirty comparison, so the two always agree.
 */
export function normalizeFormDef(def: FormDef): FormDef {
  return {
    sections: def.sections.map((section) => {
      const out: SectionDef = {
        id: section.id,
        title: section.title.trim(),
        fields: section.fields.map(normalizeField),
      }
      const description = section.description?.trim()
      if (description !== undefined && description !== '') {
        out.description = description
      }
      if (section.visibleIf !== undefined) out.visibleIf = section.visibleIf
      return out
    }),
  }
}

// ── Comparison ────────────────────────────────────────────────────────────

/** Structural equality for plain JSON values — key order is irrelevant. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => key in right && deepEqual(left[key], right[key]))
}

/** True when the two form definitions would render identically. */
export function sameForm(a: FormDef, b: FormDef | null): boolean {
  if (b === null) return false
  return deepEqual(normalizeFormDef(a), normalizeFormDef(b))
}

// ── Structure edits ───────────────────────────────────────────────────────

export function allFields(def: FormDef): Array<FieldDef> {
  return def.sections.flatMap((s) => s.fields)
}

export function sectionHasSystemFields(section: SectionDef): boolean {
  return section.fields.some((f) => f.systemKey !== undefined)
}

/**
 * Fields a condition may reference: any other field in the form. A section
 * never depends on a field it contains — hiding the section would hide the
 * answer that decides it.
 */
export function conditionCandidates(
  def: FormDef,
  exclude: { fieldId?: string; sectionId?: string },
): Array<FieldDef> {
  return def.sections
    .filter((s) => s.id !== exclude.sectionId)
    .flatMap((s) => s.fields)
    .filter((f) => f.id !== exclude.fieldId)
}

/** Move an item within an array; returns the same array when it cannot move. */
export function moved<T>(items: Array<T>, index: number, delta: number): Array<T> {
  const target = index + delta
  if (target < 0 || target >= items.length) return items
  const next = [...items]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  return next
}

/** Remove every condition — on any field or section — pointing at `fieldId`. */
export function dropConditionsOn(def: FormDef, fieldId: string): FormDef {
  const clear = (cond: Condition | undefined) =>
    cond !== undefined && cond.fieldId === fieldId ? undefined : cond
  return {
    sections: def.sections.map((section) => ({
      ...section,
      visibleIf: clear(section.visibleIf),
      fields: section.fields.map((field) => ({
        ...field,
        visibleIf: clear(field.visibleIf),
      })),
    })),
  }
}

export function emptySection(taken: Set<string>): SectionDef {
  return { id: newId('section', taken), title: 'New section', fields: [] }
}

export function newField(kind: FieldKind, taken: Set<string>): FieldDef {
  const field: FieldDef = {
    id: newId('question', taken),
    kind,
    label: '',
    required: false,
  }
  if (isChoiceKind(kind)) field.options = ['Option 1']
  return field
}
