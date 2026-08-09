import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import {
  escapeHtml,
  emailShell,
  notifyOrganizers,
  sendLoggedEmail,
  siteUrl,
} from "./comms";
import { slugify } from "./slugs";
import { assertText, isEmail, normalizeEmail } from "./validation";
import {
  allFields,
  visibleFields,
  type AnswerValue,
  type FieldDef,
  type FieldKind,
  type FormDef,
  type SystemKey,
} from "../shared/formDef";

// ─────────────────────────────────────────────────────────────────────────
// CFP (M1): the form builder (organizer-private working copy → published
// copy) and the public submission wizard (proposals + speakers).
//
// Two different callers live in this file:
//   * EventCaller — an organizer/reviewer of the event (form builder side).
//   * Doc<"users"> — any signed-in user (submitter side). Submitters are NOT
//     org or event members; ownership is `proposal.submitterUserId`.
// Owner checks throw code "not_found" rather than "forbidden" so a stranger
// cannot probe which proposal ids exist.
// ─────────────────────────────────────────────────────────────────────────

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/;
const MAX_SECTIONS = 30;
const MAX_FIELDS = 60;
const MAX_OPTIONS = 50;
const MAX_LABEL = 200;
const MAX_SPEAKERS = 10;
const LONG_TEXT_MAX = 20000;
const SHORT_TEXT_MAX = 500;

const CHOICE_KINDS: readonly FieldKind[] = ["dropdown", "multiselect", "radio"];
const LONG_TEXT_KINDS: readonly FieldKind[] = ["textarea", "wysiwyg"];

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

function notFoundProposal(): never {
  notFound("proposal");
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

  // Conditions must point at a real field — and never at themselves.
  for (const section of sections) {
    if (section.visibleIf !== undefined) {
      if (!fieldIds.has(section.visibleIf.fieldId)) {
        invalidForm(
          `Section "${section.title}" is shown conditionally on unknown field "${section.visibleIf.fieldId}".`,
        );
      }
    }
    for (const field of section.fields) {
      const cond = field.visibleIf;
      if (cond === undefined) continue;
      if (cond.fieldId === field.id) {
        invalidForm(`Field "${field.label}" can't depend on itself.`);
      }
      if (!fieldIds.has(cond.fieldId)) {
        invalidForm(
          `Field "${field.label}" is shown conditionally on unknown field "${cond.fieldId}".`,
        );
      }
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
          message: "Submissions per person must be a whole number from 1 to 100.",
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

function assertWindowOpen(
  event: Doc<"events">,
  proposal?: Doc<"proposals"> | null,
): void {
  if (!submissionWindowOpen(event, Date.now(), proposal)) {
    throw new ConvexError({
      code: "cfp_closed",
      message: "This call for proposals isn't accepting changes right now.",
    });
  }
}

// ── Public CFP page ──────────────────────────────────────────────────────

async function findEventBySlug(
  ctx: QueryCtx,
  eventSlug: string,
): Promise<Doc<"events"> | null> {
  return await ctx.db
    .query("events")
    .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
    .unique();
}

async function eventBySlug(
  ctx: QueryCtx,
  eventSlug: string,
): Promise<Doc<"events">> {
  const event = await findEventBySlug(ctx, eventSlug);
  if (event === null) notFound("event");
  return event;
}

export type PublicCfp = {
  event: {
    name: string;
    slug: string;
    startsAt: number;
    endsAt: number;
    timezone: string;
    location?: string;
    description?: string;
    website?: string;
  };
  form: FormDef;
  version: number;
  cfpOpenAt?: number;
  cfpCloseAt?: number;
  successMessage?: string;
};

/** What the unauthenticated /cfp/<slug> page renders. Null (not an error) when
 * the CFP isn't published — the route 404s gracefully. */
export async function getPublicCfp(
  ctx: QueryCtx,
  eventSlug: string,
): Promise<PublicCfp | null> {
  const event = await findEventBySlug(ctx, eventSlug);
  if (event === null) return null;
  if (!event.cfpPublished || event.archivedAt !== undefined) return null;
  const form = await findForm(ctx, event._id);
  if (form === null || form.published === undefined) return null;
  return {
    event: {
      name: event.name,
      slug: event.slug,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timezone: event.timezone,
      location: event.location,
      description: event.description,
      website: event.website,
    },
    form: form.published,
    version: form.version,
    cfpOpenAt: event.cfpOpenAt,
    cfpCloseAt: event.cfpCloseAt,
    successMessage: form.successMessage,
  };
}

/** The published form + its version, or a thrown error when there is none. */
async function requirePublishedForm(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<{ def: FormDef; version: number; row: Doc<"cfpForms"> }> {
  const form = await findForm(ctx, event._id);
  if (form === null || form.published === undefined) {
    throw new ConvexError({
      code: "cfp_not_published",
      message: "This call for proposals isn't open yet.",
    });
  }
  return { def: form.published, version: form.version, row: form };
}

// ── Proposals: submitter side ────────────────────────────────────────────

export async function startProposal(
  ctx: MutationCtx,
  user: Doc<"users">,
  eventSlug: string,
): Promise<Id<"proposals">> {
  const event = await eventBySlug(ctx, eventSlug);
  if (!event.cfpPublished) {
    throw new ConvexError({
      code: "cfp_not_published",
      message: "This call for proposals isn't open yet.",
    });
  }
  const { version, row } = await requirePublishedForm(ctx, event);
  assertWindowOpen(event);

  if (row.maxSubmissionsPerUser !== undefined) {
    // Bounded by the cap itself (max 100), so take(100) can never truncate a
    // count that would have been under the limit.
    const mine = await ctx.db
      .query("proposals")
      .withIndex("by_submitterUserId_and_eventId", (q) =>
        q.eq("submitterUserId", user._id).eq("eventId", event._id),
      )
      .take(100);
    const active = mine.filter((p) => p.status !== "withdrawn");
    if (active.length >= row.maxSubmissionsPerUser) {
      throw new ConvexError({
        code: "submission_limit",
        message: `This event accepts at most ${row.maxSubmissionsPerUser} proposal(s) per person.`,
      });
    }
  }

  return await ctx.db.insert("proposals", {
    eventId: event._id,
    submitterUserId: user._id,
    status: "draft",
    title: "Untitled proposal",
    answers: {},
    formVersion: version,
    updatedAt: Date.now(),
  });
}

/** Load a proposal the caller owns. Non-owners get "not_found", never
 * "forbidden": proposal ids must not be probeable. */
export async function requireOwnProposal(
  ctx: QueryCtx,
  user: Doc<"users">,
  proposalId: Id<"proposals">,
): Promise<Doc<"proposals">> {
  const proposal = await ctx.db.get("proposals", proposalId);
  if (proposal === null || proposal.submitterUserId !== user._id) {
    notFoundProposal();
  }
  return proposal;
}

function assertEditableStatus(proposal: Doc<"proposals">): void {
  if (proposal.status !== "draft" && proposal.status !== "pending") {
    throw new ConvexError({
      code: "not_editable",
      message: "This proposal can no longer be edited.",
    });
  }
}

/**
 * The preamble every submitter *write* shares: own it, it's still editable,
 * its event exists, and the submission window is open.
 * withdrawProposal deliberately does NOT use this — withdrawing must stay
 * possible after the CFP closes, so it runs its own status checks with no
 * window check at all.
 */
async function loadEditableProposal(
  ctx: MutationCtx,
  user: Doc<"users">,
  proposalId: Id<"proposals">,
): Promise<{ proposal: Doc<"proposals">; event: Doc<"events"> }> {
  const proposal = await requireOwnProposal(ctx, user, proposalId);
  assertEditableStatus(proposal);
  const event = await ctx.db.get("events", proposal.eventId);
  if (event === null) notFoundProposal();
  assertWindowOpen(event, proposal);
  return { proposal, event };
}

export type MyProposalView = {
  proposal: Doc<"proposals">;
  speakers: Array<Doc<"proposalSpeakers">>;
  form: FormDef;
  formVersion: number;
  event: {
    name: string;
    slug: string;
    timezone: string;
    cfpOpenAt?: number;
    cfpCloseAt?: number;
    cfpPublished: boolean;
  };
  windowOpen: boolean;
};

export async function getMyProposal(
  ctx: QueryCtx,
  user: Doc<"users">,
  proposalId: Id<"proposals">,
): Promise<MyProposalView> {
  const proposal = await requireOwnProposal(ctx, user, proposalId);
  const event = await ctx.db.get("events", proposal.eventId);
  if (event === null) notFoundProposal();
  const { def, version } = await requirePublishedForm(ctx, event);
  const speakers = await listSpeakers(ctx, proposal._id);
  return {
    proposal,
    speakers,
    form: def,
    formVersion: version,
    event: {
      name: event.name,
      slug: event.slug,
      timezone: event.timezone,
      cfpOpenAt: event.cfpOpenAt,
      cfpCloseAt: event.cfpCloseAt,
      cfpPublished: event.cfpPublished,
    },
    // Wall clock in a query: the wizard re-reads on every mutation anyway and
    // the server re-checks the window on every write, so a stale `true` here
    // only means a friendlier error one click later.
    windowOpen: submissionWindowOpen(event, Date.now(), proposal),
  };
}

async function listSpeakers(
  ctx: QueryCtx,
  proposalId: Id<"proposals">,
): Promise<Array<Doc<"proposalSpeakers">>> {
  const rows = await ctx.db
    .query("proposalSpeakers")
    .withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId))
    .take(MAX_SPEAKERS * 4);
  return rows.sort((a, b) => a.order - b.order);
}

export type MyProposalRow = {
  proposal: Doc<"proposals">;
  eventName: string;
  eventSlug: string;
};

/** "My StageStack": every proposal this user manages, newest first. */
export async function myProposals(
  ctx: QueryCtx,
  user: Doc<"users">,
): Promise<MyProposalRow[]> {
  const rows = await ctx.db
    .query("proposals")
    .withIndex("by_submitterUserId", (q) => q.eq("submitterUserId", user._id))
    .order("desc")
    .take(200);
  const out: MyProposalRow[] = [];
  for (const proposal of rows) {
    const event = await ctx.db.get("events", proposal.eventId);
    if (event === null) continue;
    out.push({ proposal, eventName: event.name, eventSlug: event.slug });
  }
  return out;
}

// ── Answers ──────────────────────────────────────────────────────────────

function invalidAnswer(message: string): never {
  throw new ConvexError({ code: "invalid_answer", message });
}

function assertAnswerShape(field: FieldDef, value: AnswerValue): void {
  // null is the canonical "cleared" value; drafts save partial answers.
  if (value === null) return;
  if (field.kind === "multiselect") {
    if (!Array.isArray(value)) {
      invalidAnswer(`"${field.label}" expects a list of choices.`);
    }
    if (value.length > MAX_OPTIONS) {
      invalidAnswer(`"${field.label}" has too many selections.`);
    }
    for (const entry of value) {
      if (typeof entry !== "string" || entry.length > SHORT_TEXT_MAX) {
        invalidAnswer(`"${field.label}" has an invalid choice.`);
      }
    }
    return;
  }
  if (typeof value !== "string") {
    invalidAnswer(`"${field.label}" expects text.`);
  }
  const max = LONG_TEXT_KINDS.includes(field.kind)
    ? LONG_TEXT_MAX
    : SHORT_TEXT_MAX;
  if (value.length > max) {
    invalidAnswer(`"${field.label}" must be at most ${max} characters.`);
  }
}

function isBlank(value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

function systemFieldId(def: FormDef, key: SystemKey): string | undefined {
  return allFields(def).find((f) => f.systemKey === key)?.id;
}

function titleFromAnswers(
  def: FormDef,
  answers: Record<string, AnswerValue>,
): string {
  const id = systemFieldId(def, "talkTitle") ?? "talkTitle";
  const value = answers[id];
  const title = typeof value === "string" ? value.trim() : "";
  return title.length > 0 ? title.slice(0, 200) : "Untitled proposal";
}

/** Full replace of the proposal's answers (the wizard always sends the whole
 * set). Required fields are NOT enforced here — drafts are partial. */
export async function saveAnswers(
  ctx: MutationCtx,
  user: Doc<"users">,
  proposalId: Id<"proposals">,
  answers: Record<string, AnswerValue>,
): Promise<void> {
  const { proposal, event } = await loadEditableProposal(ctx, user, proposalId);
  const { def } = await requirePublishedForm(ctx, event);

  const byId = new Map(allFields(def).map((f) => [f.id, f]));
  for (const [key, value] of Object.entries(answers)) {
    const field = byId.get(key);
    if (field === undefined) {
      invalidAnswer(`"${key}" isn't a field on this form.`);
    }
    assertAnswerShape(field, value);
  }

  await ctx.db.patch("proposals", proposal._id, {
    answers,
    title: titleFromAnswers(def, answers),
    updatedAt: Date.now(),
  });
}

// ── Speakers ─────────────────────────────────────────────────────────────

export type SpeakerInput = {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  tagline?: string;
  bio?: string;
  headshotId?: Id<"_storage">;
  links?: {
    website?: string;
    twitter?: string;
    linkedin?: string;
    github?: string;
  };
  isPrimary: boolean;
};

/** Replace-all: the wizard owns the whole speaker list for a proposal. */
export async function setSpeakers(
  ctx: MutationCtx,
  user: Doc<"users">,
  proposalId: Id<"proposals">,
  speakers: SpeakerInput[],
): Promise<void> {
  const { proposal } = await loadEditableProposal(ctx, user, proposalId);

  if (speakers.length > MAX_SPEAKERS) {
    throw new ConvexError({
      code: "too_many_speakers",
      message: `A proposal can list at most ${MAX_SPEAKERS} speakers.`,
    });
  }
  const cleaned = speakers.map((s) => {
    const rawEmail = s.email?.trim();
    return {
      ...s,
      firstName: assertText(s.firstName, {
        label: "Speaker first name",
        max: 80,
      }),
      lastName: assertText(s.lastName, { label: "Speaker last name", max: 80 }),
      email:
        rawEmail !== undefined && rawEmail.length > 0
          ? normalizeEmail(rawEmail)
          : undefined,
    };
  });

  const existing = await listSpeakers(ctx, proposal._id);
  for (const row of existing) {
    await ctx.db.delete("proposalSpeakers", row._id);
  }
  for (const [index, speaker] of cleaned.entries()) {
    await ctx.db.insert("proposalSpeakers", {
      proposalId: proposal._id,
      eventId: proposal.eventId,
      order: index,
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      email: speaker.email,
      phone: speaker.phone,
      tagline: speaker.tagline,
      bio: speaker.bio,
      headshotId: speaker.headshotId,
      links: speaker.links,
      isPrimary: speaker.isPrimary,
    });
  }
  await ctx.db.patch("proposals", proposal._id, { updatedAt: Date.now() });
}

// ── Submit ───────────────────────────────────────────────────────────────

function proposalLink(eventSlug: string, proposalId: Id<"proposals">): string {
  return `${siteUrl()}/cfp/${eventSlug}/proposal/${proposalId}`;
}

function eventConsoleLink(eventSlug: string): string {
  return `${siteUrl()}/app/e/${eventSlug}`;
}

function invalidSubmission(message: string): never {
  throw new ConvexError({ code: "invalid_submission", message });
}

export async function submitProposal(
  ctx: MutationCtx,
  user: Doc<"users">,
  proposalId: Id<"proposals">,
): Promise<{ successMessage: string | null }> {
  const { proposal, event } = await loadEditableProposal(ctx, user, proposalId);
  const { def, version, row } = await requirePublishedForm(ctx, event);

  // Required-field check runs against the CURRENT published form and only over
  // fields that are actually visible — a hidden conditional field is never
  // required (M1 conditional-logic requirement).
  const answers = proposal.answers;
  for (const field of visibleFields(def, answers)) {
    const value = answers[field.id];
    if (field.required && isBlank(value)) {
      invalidSubmission(`"${field.label}" is required.`);
    }
    if (field.kind === "email" && typeof value === "string" && value.trim()) {
      if (!isEmail(value.trim())) {
        invalidSubmission(`"${field.label}" isn't a valid email address.`);
      }
    }
  }
  const speakers = await listSpeakers(ctx, proposal._id);
  if (speakers.length === 0) {
    invalidSubmission("Add at least one speaker before submitting.");
  }

  const now = Date.now();
  const isResubmit = proposal.status === "pending";
  await ctx.db.patch("proposals", proposal._id, {
    status: "pending",
    // First submission time is the record; resubmits move updatedAt only.
    submittedAt: proposal.submittedAt ?? now,
    formVersion: version,
    updatedAt: now,
  });

  const title = proposal.title;
  const submitterEmail = user.email?.trim();
  if (submitterEmail !== undefined && submitterEmail.length > 0) {
    await sendLoggedEmail(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      toEmail: submitterEmail,
      kind: "cfp.confirmation",
      subject: isResubmit
        ? `Your updated proposal: ${title}`
        : `We received your proposal: ${title}`,
      html: emailShell(
        [
          `<p>${isResubmit ? "Your updated proposal has been received" : "Thanks for submitting to"} <strong>${escapeHtml(event.name)}</strong>.</p>`,
          `<p><strong>${escapeHtml(title)}</strong></p>`,
          `<p><a href="${proposalLink(event.slug, proposal._id)}">View or edit your proposal</a></p>`,
        ].join("\n"),
      ),
      sentByUserId: user._id,
      context: { proposalId: proposal._id, isResubmit },
    });
  }

  await notifyOrganizers(ctx, event, {
    kind: "cfp.adminNotification",
    subject: isResubmit
      ? `Updated proposal for ${event.name}: ${title}`
      : `New proposal for ${event.name}: ${title}`,
    html: emailShell(
      [
        `<p>${isResubmit ? "A proposal was updated" : "A new proposal arrived"} for <strong>${escapeHtml(event.name)}</strong>.</p>`,
        `<p><strong>${escapeHtml(title)}</strong><br />by ${escapeHtml(
          speakers.map((s) => `${s.firstName} ${s.lastName}`).join(", "),
        )}</p>`,
        `<p><a href="${eventConsoleLink(event.slug)}">Open the event in StageStack</a></p>`,
      ].join("\n"),
    ),
    context: { proposalId: proposal._id, isResubmit },
  });

  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: user._id,
    action: "cfp.submit",
    targetType: "proposal",
    targetId: proposal._id,
    meta: { isResubmit },
  });

  return { successMessage: row.successMessage ?? null };
}

// ── Withdraw ─────────────────────────────────────────────────────────────

export async function withdrawProposal(
  ctx: MutationCtx,
  user: Doc<"users">,
  proposalId: Id<"proposals">,
): Promise<void> {
  // Deliberately NOT loadEditableProposal: withdrawing stays available after
  // the CFP closes, so there is no submission-window check here — only the
  // status rules below.
  const proposal = await requireOwnProposal(ctx, user, proposalId);
  const event = await ctx.db.get("events", proposal.eventId);
  if (event === null) notFoundProposal();

  if (proposal.status === "accepted" || proposal.status === "declined") {
    throw new ConvexError({
      code: "decision_released",
      message:
        "A decision has already been released for this proposal — contact the organizers to withdraw your participation.",
    });
  }
  if (proposal.status === "withdrawn") {
    throw new ConvexError({
      code: "invalid_status",
      message: "This proposal is already withdrawn.",
    });
  }

  const wasDraft = proposal.status === "draft";
  const title = proposal.title;
  const speakers = await listSpeakers(ctx, proposal._id);

  if (wasDraft) {
    // A never-submitted draft leaves nothing behind — nobody has seen it.
    for (const row of speakers) {
      await ctx.db.delete("proposalSpeakers", row._id);
    }
    await ctx.db.delete("proposals", proposal._id);
  } else {
    await ctx.db.patch("proposals", proposal._id, {
      status: "withdrawn",
      withdrawnAt: Date.now(),
      updatedAt: Date.now(),
    });
    await notifyOrganizers(ctx, event, {
      kind: "cfp.withdrawn",
      subject: `Proposal withdrawn for ${event.name}: ${title}`,
      html: emailShell(
        [
          `<p>A proposal for <strong>${escapeHtml(event.name)}</strong> was withdrawn by its submitter.</p>`,
          `<p><strong>${escapeHtml(title)}</strong></p>`,
          `<p><a href="${eventConsoleLink(event.slug)}">Open the event in StageStack</a></p>`,
        ].join("\n"),
      ),
      context: { proposalId: proposal._id },
    });
  }

  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: user._id,
    action: "cfp.withdraw",
    targetType: "proposal",
    targetId: proposal._id,
    meta: { deleted: wasDraft },
  });
}

// ── Organizer: proposals + reopen ────────────────────────────────────────

export type ProposalStatus = Doc<"proposals">["status"];

export type ProposalRow = {
  proposal: Doc<"proposals">;
  speakerCount: number;
};

/** M1 sanity list for organizers; M2 builds the real review table (and
 * decides what reviewers may see, which is why they're excluded here). */
export async function listProposals(
  ctx: QueryCtx,
  caller: EventCaller,
  filters?: { status?: ProposalStatus },
): Promise<ProposalRow[]> {
  requireOrganizer(caller);
  const eventId = caller.event._id;
  const status = filters?.status;
  const [proposals, speakerRows] = await Promise.all([
    ctx.db
      .query("proposals")
      .withIndex("by_eventId_and_status", (q) =>
        status === undefined
          ? q.eq("eventId", eventId)
          : q.eq("eventId", eventId).eq("status", status),
      )
      .order("desc")
      .take(500),
    // One event-wide read instead of a speaker query per proposal. 500
    // proposals × 10 speakers is the hard ceiling, so 2000 is generous.
    ctx.db
      .query("proposalSpeakers")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(2000),
  ]);
  const counts = new Map<Id<"proposals">, number>();
  for (const row of speakerRows) {
    counts.set(row.proposalId, (counts.get(row.proposalId) ?? 0) + 1);
  }
  const out: ProposalRow[] = proposals.map((proposal) => ({
    proposal,
    speakerCount: counts.get(proposal._id) ?? 0,
  }));
  // by_eventId_and_status orders by status first; present newest-first overall.
  return out.sort((a, b) => b.proposal._creationTime - a.proposal._creationTime);
}

/** Organizer grants one submitter an edit window past cfpCloseAt. */
export async function reopenProposal(
  ctx: MutationCtx,
  caller: EventCaller,
  proposalId: Id<"proposals">,
  until: number,
): Promise<void> {
  requireOrganizer(caller);
  const proposal = await ctx.db.get("proposals", proposalId);
  if (proposal === null || proposal.eventId !== caller.event._id) {
    notFound("proposal", "No such proposal on this event.");
  }
  if (!Number.isFinite(until) || until <= Date.now()) {
    throw new ConvexError({
      code: "invalid_until",
      message: "The reopen deadline must be in the future.",
    });
  }
  await ctx.db.patch("proposals", proposalId, { reopenedUntil: until });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "cfp.reopenProposal",
    targetType: "proposal",
    targetId: proposalId,
    meta: { until },
  });
}
