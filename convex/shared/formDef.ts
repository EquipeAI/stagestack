import { v, type Infer } from "convex/values";

// CFP form definition (M1). One active form per event; the working copy is
// organizer-private, the published copy is what the public wizard renders.
// Bounded: ≤ ~20 sections × ~30 fields, well under document limits.

export const vFieldKind = v.union(
  v.literal("text"),
  v.literal("textarea"),
  v.literal("wysiwyg"),
  v.literal("dropdown"),
  v.literal("multiselect"),
  v.literal("radio"),
  v.literal("email"),
  v.literal("phone"),
  v.literal("url"),
  v.literal("file"),
);

// Locked system fields: present in every form, cannot be removed, feed
// proposal/contact records directly.
export const vSystemKey = v.union(
  v.literal("talkTitle"),
  v.literal("abstract"),
  v.literal("firstName"),
  v.literal("lastName"),
  v.literal("email"),
);

// Conditional show/hide (M1 requirement): a field/section is visible when the
// referenced field's answer matches. Fields with unmet conditions are neither
// shown nor required.
export const vCondition = v.object({
  fieldId: v.string(),
  op: v.union(v.literal("equals"), v.literal("notEquals"), v.literal("includes")),
  value: v.string(),
});

export const vFieldDef = v.object({
  id: v.string(),
  kind: vFieldKind,
  label: v.string(),
  help: v.optional(v.string()),
  required: v.boolean(),
  options: v.optional(v.array(v.string())),
  systemKey: v.optional(vSystemKey),
  visibleIf: v.optional(vCondition),
  // For file fields: accepted types hint (e.g. ".pdf,.key,.pptx").
  accept: v.optional(v.string()),
});

export const vSectionDef = v.object({
  id: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
  visibleIf: v.optional(vCondition),
  fields: v.array(vFieldDef),
});

export const vFormDef = v.object({
  sections: v.array(vSectionDef),
});

export type FieldKind = Infer<typeof vFieldKind>;
export type SystemKey = Infer<typeof vSystemKey>;
export type Condition = Infer<typeof vCondition>;
export type FieldDef = Infer<typeof vFieldDef>;
export type SectionDef = Infer<typeof vSectionDef>;
export type FormDef = Infer<typeof vFormDef>;

// Answer values keyed by field id. File fields store a storage id string;
// multiselect stores string[].
export const vAnswerValue = v.union(
  v.string(),
  v.number(),
  v.array(v.string()),
  v.null(),
);
export type AnswerValue = Infer<typeof vAnswerValue>;

export function allFields(def: FormDef): FieldDef[] {
  return def.sections.flatMap((s) => s.fields);
}

/** Evaluate a visibility condition against current answers. */
export function conditionMet(
  cond: Condition | undefined,
  answers: Record<string, AnswerValue>,
): boolean {
  if (cond === undefined) return true;
  const answer = answers[cond.fieldId];
  switch (cond.op) {
    case "equals":
      return answer === cond.value;
    case "notEquals":
      return answer !== cond.value;
    case "includes":
      return Array.isArray(answer) && answer.includes(cond.value);
  }
}

/** Fields currently visible (section condition AND field condition). */
export function visibleFields(
  def: FormDef,
  answers: Record<string, AnswerValue>,
): FieldDef[] {
  return def.sections
    .filter((s) => conditionMet(s.visibleIf, answers))
    .flatMap((s) => s.fields.filter((f) => conditionMet(f.visibleIf, answers)));
}
