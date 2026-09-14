import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import { siteUrl } from "./comms";
import { slugify } from "./slugs";
import {
  allFields,
  type FieldDef,
  type FieldKind,
  type FormDef,
  type SystemKey,
} from "../shared/formDef";

// ─────────────────────────────────────────────────────────────────────────
// The CFP FORM itself (M1), moved verbatim out of `model/cfp.ts`: the starter
// definition, the organizer-private working copy and its published twin, the
// validator that guards both, and the submission window they open and close.
//
// This module is a LEAF on purpose. `model/sessions.ts` needs `findForm`,
// `proposalLink` and `proposalAbstract` when it materialises an accepted
// proposal; taking them from here instead of from `model/cfp.ts` (which calls
// back into sessions) is what removes the cfp↔sessions import cycle.
// ─────────────────────────────────────────────────────────────────────────

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/;
const MAX_SECTIONS = 30;
const MAX_FIELDS = 60;
export const MAX_OPTIONS = 50;
const MAX_LABEL = 200;
export const MAX_SPEAKERS = 10;
export const LONG_TEXT_MAX = 20000;
export const SHORT_TEXT_MAX = 500;

const CHOICE_KINDS: readonly FieldKind[] = ["dropdown", "multiselect", "radio"];
export const LONG_TEXT_KINDS: readonly FieldKind[] = ["textarea", "wysiwyg"];

const SYSTEM_KEYS: readonly SystemKey[] = [
  "talkTitle",
  "abstract",
  "firstName",
  "lastName",
  "email",
];

/** Kinds each locked system field is allowed to use. */
const SYSTEM_KEY_KINDS: Record<SystemKey, readonly FieldKind[]> = {
  talkTitle: ["text", "textarea"],
  abstract: ["text", "textarea"],
  firstName: ["text", "textarea"],
  lastName: ["text", "textarea"],
  email: ["email"],
};

function invalidForm(message: string): never {
  throw new ConvexError({ code: "invalid_form", message });
}

// ── Starter form ─────────────────────────────────────────────────────────

/**
 * Ids for organizer-authored fields: slugified label + a short suffix so two
 * fields with the same label never collide. System fields use their systemKey
 * as the id (the wizard and the proposal record both key off it).
 */
export function customFieldId(label: string, suffix: string): string {
  const base = slugify(label).slice(0, 30).replace(/-+$/, "");
  const safe = /^[a-zA-Z]/.test(base) ? base : `f${base}`;
  return `${safe}-${suffix}`;
}

/** The form every new event starts with (MILESTONES M0/M1). */
export function starterFormDef(): FormDef {
  return {
    sections: [
      {
        id: "about-you",
        title: "About you",
        description: "Who should we talk to about this proposal?",
        fields: [
          {
            id: "firstName",
            kind: "text",
            label: "First name",
            required: true,
            systemKey: "firstName",
          },
          {
            id: "lastName",
            kind: "text",
            label: "Last name",
            required: true,
            systemKey: "lastName",
          },
          {
            id: "email",
            kind: "email",
            label: "Email",
            help: "We'll use this for everything about your proposal.",
            required: true,
            systemKey: "email",
          },
        ],
      },
      {
        id: "your-session",
        title: "Your session",
        fields: [
          {
            id: "talkTitle",
            kind: "text",
            label: "Talk title",
            required: true,
            systemKey: "talkTitle",
          },
          {
            id: "abstract",
            kind: "textarea",
            label: "Abstract",
            help: "What will attendees learn?",
            required: true,
            systemKey: "abstract",
          },
          {
            id: customFieldId("Session format", "s1"),
            kind: "dropdown",
            label: "Session format",
            required: false,
            options: ["Talk", "Workshop", "Panel"],
          },
          {
            id: customFieldId("Anything else we should know?", "s2"),
            kind: "textarea",
            label: "Anything else we should know?",
            required: false,
          },
        ],
      },
    ],
  };
}

// ── Form storage ─────────────────────────────────────────────────────────

export async function findForm(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Doc<"cfpForms"> | null> {
  return await ctx.db
    .query("cfpForms")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .unique();
}

/** Get-or-create the event's CFP form row. Called at event creation and by
 * every form-writing accessor, so old events heal on first write. */
export async function ensureForm(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<Doc<"cfpForms">> {
  const existing = await findForm(ctx, eventId);
  if (existing !== null) return existing;
  const id = await ctx.db.insert("cfpForms", {
    eventId,
    working: starterFormDef(),
    version: 0,
    updatedAt: Date.now(),
  });
  const created = await ctx.db.get("cfpForms", id);
  if (created === null) throw new Error("unreachable: cfpForm just inserted");
  return created;
}

export type CfpFormView = {
  working: FormDef;
  published: FormDef | null;
  version: number;
  publishedAt: number | null;
  maxSubmissionsPerUser: number | null;
  successMessage: string | null;
};

function formView(row: Doc<"cfpForms"> | null): CfpFormView {
  if (row === null) {
    // Not yet materialised (event predates M1): show the starter form. The
    // first organizer write persists it via ensureForm.
    return {
      working: starterFormDef(),
      published: null,
      version: 0,
      publishedAt: null,
      maxSubmissionsPerUser: null,
      successMessage: null,
    };
  }
  return {
    working: row.working,
    published: row.published ?? null,
    version: row.version,
    publishedAt: row.publishedAt ?? null,
    maxSubmissionsPerUser: row.maxSubmissionsPerUser ?? null,
    successMessage: row.successMessage ?? null,
  };
}

/** Organizer view of the form builder: working + published + settings. */
export async function getForm(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<CfpFormView> {
  requireOrganizer(caller);
  return formView(await findForm(ctx, caller.event._id));
}

// ── Form validation ──────────────────────────────────────────────────────

/** Structural + semantic rules for an organizer-authored form. */
export function validateFormDef(def: FormDef): void {
  const sections = def.sections;
  if (sections.length === 0 || sections.length > MAX_SECTIONS) {
    invalidForm(`A form needs between 1 and ${MAX_SECTIONS} sections.`);
  }
  const fields = allFields(def);
  if (fields.length === 0 || fields.length > MAX_FIELDS) {
    invalidForm(`A form needs between 1 and ${MAX_FIELDS} fields.`);
  }

  // Ids are unique across the whole document (sections and fields share one
  // namespace so conditions can never be ambiguous).
  const seen = new Set<string>();
  const fieldIds = new Set<string>();
  for (const section of sections) {
    if (!ID_RE.test(section.id)) {
      invalidForm(
        `Section id "${section.id}" must start with a letter and use only letters, digits, "_" or "-" (max 41 chars).`,
      );
    }
    if (seen.has(section.id)) invalidForm(`Duplicate id "${section.id}".`);
    seen.add(section.id);
    if (section.title.trim().length === 0 || section.title.length > MAX_LABEL) {
      invalidForm(`Section titles must be 1-${MAX_LABEL} characters.`);
    }
    for (const field of section.fields) {
      if (!ID_RE.test(field.id)) {
        invalidForm(
          `Field id "${field.id}" must start with a letter and use only letters, digits, "_" or "-" (max 41 chars).`,
        );
      }
      if (seen.has(field.id)) invalidForm(`Duplicate id "${field.id}".`);
      seen.add(field.id);
      fieldIds.add(field.id);
      if (field.label.trim().length === 0 || field.label.length > MAX_LABEL) {
        invalidForm(`Field labels must be 1-${MAX_LABEL} characters.`);
      }
      if (CHOICE_KINDS.includes(field.kind)) {
        const options = field.options ?? [];
        if (options.length === 0 || options.length > MAX_OPTIONS) {
          invalidForm(
            `Field "${field.label}" is a ${field.kind} and needs 1-${MAX_OPTIONS} options.`,
          );
        }
        if (options.some((o) => o.trim().length === 0)) {
          invalidForm(`Field "${field.label}" has an empty option.`);
        }
      }
    }
  }

  // System fields: exactly one of each, always required, sane kind.
  const bySystemKey = new Map<SystemKey, FieldDef[]>();
  for (const field of fields) {
    if (field.systemKey === undefined) continue;
    const list = bySystemKey.get(field.systemKey) ?? [];
    list.push(field);
    bySystemKey.set(field.systemKey, list);
  }
  for (const key of SYSTEM_KEYS) {
    const matches = bySystemKey.get(key) ?? [];
    if (matches.length === 0) {
      invalidForm(`The "${key}" field is required and can't be removed.`);
    }
    if (matches.length > 1) {
      invalidForm(`The "${key}" field appears more than once.`);
    }
    const field = matches[0];
    if (!field.required) {
      invalidForm(`The "${key}" field must stay required.`);
    }
    if (!SYSTEM_KEY_KINDS[key].includes(field.kind)) {
      invalidForm(
        `The "${key}" field must be one of: ${SYSTEM_KEY_KINDS[key].join(", ")}.`,
      );
    }
  }

  // Conditions must point at a real field — and never at themselves. The
  // operator must make sense for the source field's kind, and locked system
  // fields (plus the sections carrying them) can never be conditional: a
  // hidden required field would let submissions through without it.
  const byId = new Map(fields.map((f) => [f.id, f]));
  const assertConditionSane = (
    cond: NonNullable<FieldDef["visibleIf"]>,
    subject: string,
  ) => {
    const source = byId.get(cond.fieldId);
    if (source === undefined) {
      invalidForm(
        `${subject} is shown conditionally on unknown field "${cond.fieldId}".`,
      );
    }
    if (cond.op === "includes" && source.kind !== "multiselect") {
      invalidForm(
        `${subject}: "includes" only works when the controlling field is a multi-select.`,
      );
    }
    if (cond.op !== "includes" && source.kind === "multiselect") {
      invalidForm(
        `${subject}: use "includes" when the controlling field is a multi-select.`,
      );
    }
  };
  for (const section of sections) {
    const hasSystemField = section.fields.some(
      (f) => f.systemKey !== undefined,
    );
    if (section.visibleIf !== undefined) {
      if (hasSystemField) {
        invalidForm(
          `Section "${section.title}" contains locked fields and can't be conditional.`,
        );
      }
      assertConditionSane(section.visibleIf, `Section "${section.title}"`);
    }
    for (const field of section.fields) {
      const cond = field.visibleIf;
      if (cond === undefined) continue;
      if (field.systemKey !== undefined) {
        invalidForm(`The "${field.systemKey}" field can't be conditional.`);
      }
      if (cond.fieldId === field.id) {
        invalidForm(`Field "${field.label}" can't depend on itself.`);
      }
      assertConditionSane(cond, `Field "${field.label}"`);
    }
  }
}

export async function updateWorkingForm(
  ctx: MutationCtx,
  caller: EventCaller,
  def: FormDef,
): Promise<void> {
  requireOrganizer(caller);
  validateFormDef(def);
  const form = await ensureForm(ctx, caller.event._id);
  await ctx.db.patch("cfpForms", form._id, {
    working: def,
    updatedAt: Date.now(),
  });
}

export type FormSettingsPatch = {
  maxSubmissionsPerUser?: number | null;
  successMessage?: string | null;
};

export async function updateFormSettings(
  ctx: MutationCtx,
  caller: EventCaller,
  patch: FormSettingsPatch,
): Promise<void> {
  requireOrganizer(caller);
  const form = await ensureForm(ctx, caller.event._id);
  const update: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.maxSubmissionsPerUser !== undefined) {
    if (patch.maxSubmissionsPerUser !== null) {
      const n = patch.maxSubmissionsPerUser;
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw new ConvexError({
          code: "invalid_settings",
          message:
            "Submissions per person must be a whole number from 1 to 100.",
        });
      }
    }
    update.maxSubmissionsPerUser = patch.maxSubmissionsPerUser ?? undefined;
  }
  if (patch.successMessage !== undefined) {
    const message = patch.successMessage?.trim();
    if (message !== undefined && message !== null && message.length > 2000) {
      throw new ConvexError({
        code: "invalid_settings",
        message: "The success message must be at most 2000 characters.",
      });
    }
    update.successMessage =
      message === undefined || message === null || message.length === 0
        ? undefined
        : message;
  }
  await ctx.db.patch("cfpForms", form._id, update);
}

/** Working → published (deep copy), bump version. This is what the public
 * wizard renders; in-flight proposals keep validating against the newest
 * published version. */
export async function publishForm(
  ctx: MutationCtx,
  caller: EventCaller,
): Promise<number> {
  requireOrganizer(caller);
  const form = await ensureForm(ctx, caller.event._id);
  validateFormDef(form.working);
  const version = form.version + 1;
  const now = Date.now();
  await ctx.db.patch("cfpForms", form._id, {
    // Structured clone: the published copy must never alias the working copy.
    published: JSON.parse(JSON.stringify(form.working)) as FormDef,
    version,
    publishedAt: now,
    updatedAt: now,
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "cfp.publishForm",
    targetType: "cfpForms",
    targetId: form._id,
    meta: { version },
  });
  return version;
}

// ── Submission window ────────────────────────────────────────────────────

/**
 * Open when now is inside [cfpOpenAt, cfpCloseAt] (both optional). An
 * organizer-granted reopen overrides both bounds for that one proposal — it
 * is an explicit, audited grant.
 */
export function submissionWindowOpen(
  event: Doc<"events">,
  now: number,
  proposal?: Doc<"proposals"> | null,
): boolean {
  if (proposal?.reopenedUntil !== undefined && proposal.reopenedUntil > now) {
    return true;
  }
  if (event.cfpOpenAt !== undefined && now < event.cfpOpenAt) return false;
  if (event.cfpCloseAt !== undefined && now > event.cfpCloseAt) return false;
  return true;
}

export function assertWindowOpen(
  event: Doc<"events">,
  proposal?: Doc<"proposals"> | null,
  now = Date.now(),
): void {
  if (!submissionWindowOpen(event, now, proposal)) {
    throw new ConvexError({
      code: "cfp_closed",
      message: "This call for proposals isn't accepting changes right now.",
    });
  }
}

export function systemFieldId(def: FormDef, key: SystemKey): string | undefined {
  return allFields(def).find((f) => f.systemKey === key)?.id;
}

/** Public link to a proposal's submitter-facing page. */
export function proposalLink(
  eventSlug: string,
  proposalId: Id<"proposals">,
): string {
  return `${siteUrl()}/cfp/${eventSlug}/proposal/${proposalId}`;
}

/** The proposal's abstract answer, resolved through the published form's
 * `abstract` system field. Used when accepting a proposal materialises its
 * session (M2). */
export async function proposalAbstract(
  ctx: QueryCtx,
  proposal: Doc<"proposals">,
): Promise<string | undefined> {
  const form = await findForm(ctx, proposal.eventId);
  const def = form?.published ?? form?.working;
  const id =
    def === undefined
      ? "abstract"
      : (systemFieldId(def, "abstract") ?? "abstract");
  const value = proposal.answers[id];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
