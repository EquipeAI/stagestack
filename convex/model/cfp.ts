import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import {
  LONG_TEXT_KINDS,
  LONG_TEXT_MAX,
  MAX_OPTIONS,
  MAX_SPEAKERS,
  SHORT_TEXT_MAX,
  assertWindowOpen,
  ensureForm,
  findForm,
  proposalLink,
  submissionWindowOpen,
  systemFieldId,
} from "./cfpForms";
import * as Sessions from "./sessions";
import {
  escapeHtml,
  emailShell,
  notifyOrganizers,
  sendLoggedEmail,
  siteUrl,
} from "./comms";
import { renderTemplate } from "./templates";
import { optionalHttpUrl } from "../lib/urls";
import {
  assertEventActive,
  assertText,
  isEmail,
  normalizeEmail,
  takeCapped,
} from "./validation";
import {
  allFields,
  visibleFields,
  type AnswerValue,
  type FieldDef,
  type FormDef,
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

function notFoundProposal(): never {
  notFound("proposal");
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

/**
 * Queue placement is an INTERNAL staged decision (MILESTONES M2): "it does not
 * notify the submitter or reveal the outcome". Every submitter-facing
 * projection therefore maps acceptQueue/declineQueue back to "pending" — the
 * last status the submitter was legitimately told about. Organizer-facing
 * reads (listProposals, reviewProgress, sessions.*) keep the true status.
 */
export function publicProposalStatus(status: ProposalStatus): ProposalStatus {
  return status === "acceptQueue" || status === "declineQueue"
    ? "pending"
    : status;
}

/** A proposal document with its status masked for the submitter. */
export function maskProposal(proposal: Doc<"proposals">): Doc<"proposals"> {
  return { ...proposal, status: publicProposalStatus(proposal.status) };
}

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
    contentVersion: 0,
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

/** Statuses a submitter may still edit. The decision queues are included on
 * purpose: staging is internal, so it must not silently lock the submitter out
 * — editing stays possible right up to the release. */
const EDITABLE_STATUSES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>([
  "draft",
  "pending",
  "acceptQueue",
  "declineQueue",
]);

function assertEditableStatus(proposal: Doc<"proposals">, now: number): void {
  if (EDITABLE_STATUSES.has(proposal.status)) return;
  // A released acceptance stays a released acceptance. It becomes editable
  // only through a current, proposal-specific organizer grant — reopening the
  // event's CFP globally must never make decided proposals writable again.
  if (
    proposal.status === "accepted" &&
    proposal.reopenedUntil !== undefined &&
    proposal.reopenedUntil > now
  ) {
    return;
  }
  throw new ConvexError({
    code: "not_editable",
    message: "This proposal can no longer be edited.",
  });
}

/**
 * An edit to a queued proposal invalidates the staged decision: the organizer
 * queued a verdict about a different version of it. Reset to "pending" (which
 * is what the submitter sees either way) and tell the organizers, so the
 * proposal reappears in the undecided pile instead of being released on the
 * strength of a stale read. Returns the status it was reset from, if any.
 */
async function unstageOnEdit(
  ctx: MutationCtx,
  proposal: Doc<"proposals">,
  event: Doc<"events">,
  title: string,
): Promise<ProposalStatus | null> {
  if (proposal.status !== "acceptQueue" && proposal.status !== "declineQueue") {
    return null;
  }
  const from = proposal.status;
  await ctx.db.patch("proposals", proposal._id, { status: "pending" });
  await notifyOrganizers(ctx, event, {
    kind: "cfp.adminNotification",
    subject: `Updated proposal for ${event.name}: ${title}`,
    html: emailShell(
      [
        `<p>A proposal you had staged for a decision was updated by its submitter, so it moved back to <strong>Pending</strong>.</p>`,
        `<p><strong>${escapeHtml(title)}</strong></p>`,
        `<p><a href="${eventConsoleLink(event.slug)}">Review it in StageStack</a></p>`,
      ].join("\n"),
    ),
    context: { proposalId: proposal._id, stagedDecisionCleared: true },
  });
  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: proposal.submitterUserId,
    action: "decision.unstaged",
    targetType: "proposal",
    targetId: proposal._id,
    meta: { from, reason: "submitter_edit" },
  });
  return from;
}

/**
 * The preamble every submitter *write* shares: own it, it's still editable,
 * its event exists and is active, and the submission window is open.
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
  const now = Date.now();
  assertEditableStatus(proposal, now);
  const event = await ctx.db.get("events", proposal.eventId);
  if (event === null) notFoundProposal();
  assertEventActive(event);
  assertWindowOpen(event, proposal, now);
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
    archivedAt?: number;
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
    // Staged decisions stay invisible to the submitter (see maskProposal).
    proposal: maskProposal(proposal),
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
      archivedAt: event.archivedAt,
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
    out.push({
      proposal: maskProposal(proposal),
      eventName: event.name,
      eventSlug: event.slug,
    });
  }
  return out;
}

// ── Answers ──────────────────────────────────────────────────────────────

function invalidAnswer(message: string): never {
  throw new ConvexError({ code: "invalid_answer", message });
}

function assertAnswerShape(
  ctx: QueryCtx,
  field: FieldDef,
  value: AnswerValue,
): void {
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
  // A file answer is dereferenced with ctx.storage.getUrl later (organizer and
  // reviewer views); anything that isn't a real storage id is refused here so
  // a malformed value can never take those reads down. Empty string stays
  // allowed as "cleared" — consumers already skip it.
  if (
    field.kind === "file" &&
    value.length > 0 &&
    ctx.db.system.normalizeId("_storage", value) === null
  ) {
    invalidAnswer(`"${field.label}" expects an uploaded file.`);
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

function titleFromAnswers(
  def: FormDef,
  answers: Record<string, AnswerValue>,
): string {
  const id = systemFieldId(def, "talkTitle") ?? "talkTitle";
  const value = answers[id];
  const title = typeof value === "string" ? value.trim() : "";
  return title.length > 0 ? title.slice(0, 200) : "Untitled proposal";
}

function prepareAnswers(
  ctx: QueryCtx,
  def: FormDef,
  answers: Record<string, AnswerValue>,
): { answers: Record<string, AnswerValue>; title: string } {
  const byId = new Map(allFields(def).map((field) => [field.id, field]));
  // Silently DROP answers whose field no longer exists: an organizer removing
  // a field must not brick drafts that still carry its answer (they resend
  // the full record on every autosave). Known fields still validate strictly.
  const kept: Record<string, AnswerValue> = {};
  for (const [key, value] of Object.entries(answers)) {
    const field = byId.get(key);
    if (field === undefined) continue;
    assertAnswerShape(ctx, field, value);
    kept[key] = value;
  }
  return { answers: kept, title: titleFromAnswers(def, kept) };
}

function requireStandaloneDraftWrite(proposal: Doc<"proposals">): void {
  if (proposal.status === "draft") return;
  throw new ConvexError({
    code: "client_upgrade_required",
    message:
      "This proposal editor is out of date and cannot safely update a submitted proposal. Refresh the page, then use Save & resubmit.",
  });
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
  requireStandaloneDraftWrite(proposal);
  const { def } = await requirePublishedForm(ctx, event);
  const prepared = prepareAnswers(ctx, def, answers);
  await ctx.db.patch("proposals", proposal._id, {
    answers: prepared.answers,
    title: prepared.title,
    updatedAt: Date.now(),
  });
  await unstageOnEdit(ctx, proposal, event, prepared.title);
}

// ── Speakers ─────────────────────────────────────────────────────────────

export type SpeakerInput = {
  /** Existing rows are reconciled in place. Absent means a new coauthor. */
  proposalSpeakerId?: Id<"proposalSpeakers">;
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
  /** Role label on this proposal (Co-speaker, Co-author, …). */
  role?: string;
};

type PreparedSpeaker = SpeakerInput & {
  firstName: string;
  lastName: string;
};

type SpeakerPlan = {
  existing: Array<Doc<"proposalSpeakers">>;
  speakers: PreparedSpeaker[];
  referencedIds: Set<string>;
};

function cleanSpeakerInput(speaker: SpeakerInput): PreparedSpeaker {
  const rawEmail = speaker.email?.trim();
  const links =
    speaker.links === undefined
      ? undefined
      : {
          website: optionalHttpUrl(
            speaker.links.website,
            "Speaker website link",
          ),
          twitter: optionalHttpUrl(
            speaker.links.twitter,
            "Speaker Twitter link",
          ),
          linkedin: optionalHttpUrl(
            speaker.links.linkedin,
            "Speaker LinkedIn link",
          ),
          github: optionalHttpUrl(speaker.links.github, "Speaker GitHub link"),
        };
  const hasLink =
    links !== undefined &&
    Object.values(links).some((value) => value !== undefined);
  return {
    ...speaker,
    firstName: assertText(speaker.firstName, {
      label: "Speaker first name",
      max: 80,
    }),
    lastName: assertText(speaker.lastName, {
      label: "Speaker last name",
      max: 80,
    }),
    email:
      rawEmail !== undefined && rawEmail.length > 0
        ? normalizeEmail(rawEmail)
        : undefined,
    links: hasLink ? links : undefined,
    role:
      speaker.role === undefined || speaker.role.trim() === ""
        ? undefined
        : assertText(speaker.role, { label: "Speaker role", max: 40 }),
  };
}

async function prepareSpeakerPlan(
  ctx: QueryCtx,
  proposal: Doc<"proposals">,
  speakers: SpeakerInput[],
  preserveExisting: boolean,
): Promise<SpeakerPlan> {
  if (speakers.length > MAX_SPEAKERS) {
    throw new ConvexError({
      code: "too_many_speakers",
      message: `A proposal can list at most ${MAX_SPEAKERS} speakers.`,
    });
  }
  const existing = await listSpeakers(ctx, proposal._id);
  let cleaned = speakers.map(cleanSpeakerInput);
  // A brand-new draft starts with client-local cards, so its first autosave has
  // no ids to round-trip yet. Until the proposal is submitted, positional
  // reconciliation gives those cards stable rows across later autosaves. Once
  // any persisted id is present (and for every accepted revision), absence
  // unambiguously means a genuinely new coauthor.
  if (
    proposal.status === "draft" &&
    cleaned.every((speaker) => speaker.proposalSpeakerId === undefined)
  ) {
    cleaned = cleaned.map((speaker, order) => ({
      ...speaker,
      proposalSpeakerId: existing[order]?._id,
    }));
  }
  const existingIds = new Set(existing.map((row) => String(row._id)));
  const referencedIds = new Set<string>();
  for (const speaker of cleaned) {
    if (speaker.proposalSpeakerId === undefined) continue;
    const key = String(speaker.proposalSpeakerId);
    if (referencedIds.has(key)) {
      throw new ConvexError({
        code: "duplicate_speaker_id",
        message: "The same existing speaker cannot be submitted twice.",
      });
    }
    if (!existingIds.has(key)) {
      throw new ConvexError({
        code: "invalid_speaker_id",
        message: "That speaker does not belong to this proposal.",
      });
    }
    referencedIds.add(key);
  }
  if (
    preserveExisting &&
    existing.some((row) => !referencedIds.has(String(row._id)))
  ) {
    throw new ConvexError({
      code: "accepted_speaker_removal",
      message:
        "Existing speakers on an accepted proposal cannot be removed here. Ask an organizer to withdraw their participation.",
    });
  }
  return { existing, speakers: cleaned, referencedIds };
}

function speakerPatch(
  proposal: Doc<"proposals">,
  speaker: PreparedSpeaker,
  order: number,
): Omit<Doc<"proposalSpeakers">, "_id" | "_creationTime"> {
  return {
    proposalId: proposal._id,
    eventId: proposal.eventId,
    order,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    email: speaker.email,
    phone: speaker.phone,
    tagline: speaker.tagline,
    bio: speaker.bio,
    headshotId: speaker.headshotId,
    links: speaker.links,
    isPrimary: speaker.isPrimary,
    role: speaker.role,
  };
}

async function applySpeakerPlan(
  ctx: MutationCtx,
  proposal: Doc<"proposals">,
  plan: SpeakerPlan,
): Promise<void> {
  for (const [order, speaker] of plan.speakers.entries()) {
    const patch = speakerPatch(proposal, speaker, order);
    if (speaker.proposalSpeakerId === undefined) {
      await ctx.db.insert("proposalSpeakers", patch);
    } else {
      await ctx.db.patch("proposalSpeakers", speaker.proposalSpeakerId, patch);
    }
  }
  for (const row of plan.existing) {
    if (!plan.referencedIds.has(String(row._id))) {
      await ctx.db.delete("proposalSpeakers", row._id);
    }
  }
}

function speakerPlanChanged(
  plan: SpeakerPlan,
  proposal: Doc<"proposals">,
): boolean {
  if (plan.existing.length !== plan.speakers.length) return true;
  return plan.speakers.some((speaker, order) => {
    const existing = plan.existing[order];
    if (
      existing === undefined ||
      speaker.proposalSpeakerId === undefined ||
      existing._id !== speaker.proposalSpeakerId
    ) {
      return true;
    }
    return (
      JSON.stringify(speakerPatch(proposal, speaker, order)) !==
      JSON.stringify({
        proposalId: existing.proposalId,
        eventId: existing.eventId,
        order: existing.order,
        firstName: existing.firstName,
        lastName: existing.lastName,
        email: existing.email,
        phone: existing.phone,
        tagline: existing.tagline,
        bio: existing.bio,
        headshotId: existing.headshotId,
        links: existing.links,
        isPrimary: existing.isPrimary,
        role: existing.role,
      })
    );
  });
}

/** Full-list input, reconciled in place by stable proposal-speaker id. */
export async function setSpeakers(
  ctx: MutationCtx,
  user: Doc<"users">,
  proposalId: Id<"proposals">,
  speakers: SpeakerInput[],
): Promise<void> {
  const { proposal, event } = await loadEditableProposal(ctx, user, proposalId);
  requireStandaloneDraftWrite(proposal);
  const plan = await prepareSpeakerPlan(ctx, proposal, speakers, false);
  await applySpeakerPlan(ctx, proposal, plan);
  await ctx.db.patch("proposals", proposal._id, { updatedAt: Date.now() });
  await unstageOnEdit(ctx, proposal, event, proposal.title);
}

// ── Submit ───────────────────────────────────────────────────────────────

function eventConsoleLink(eventSlug: string): string {
  return `${siteUrl()}/app/e/${eventSlug}`;
}

function invalidSubmission(message: string): never {
  throw new ConvexError({ code: "invalid_submission", message });
}

function validateSubmission(
  def: FormDef,
  answers: Record<string, AnswerValue>,
  speakerCount: number,
): void {
  // Required-field check runs against the CURRENT published form and only over
  // fields that are actually visible — a hidden conditional field is never
  // required (M1 conditional-logic requirement).
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
  if (speakerCount === 0) {
    invalidSubmission("Add at least one speaker before submitting.");
  }
}

function answersEqual(
  left: Record<string, AnswerValue>,
  right: Record<string, AnswerValue>,
): boolean {
  const ordered = (answers: Record<string, AnswerValue>) =>
    Object.keys(answers)
      .sort()
      .map((key) => [key, answers[key]]);
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

const MAX_REVIEWS_PER_PROPOSAL = 500;

async function reviewsInvalidatedByRevision(
  ctx: QueryCtx,
  proposalId: Id<"proposals">,
): Promise<Array<Doc<"reviews">>> {
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId))
    .take(MAX_REVIEWS_PER_PROPOSAL + 1);
  if (reviews.length > MAX_REVIEWS_PER_PROPOSAL) {
    throw new ConvexError({
      code: "event_too_large",
      message: `This proposal has more than ${MAX_REVIEWS_PER_PROPOSAL} reviews. Its revision is refused rather than invalidating only part of the evaluation history.`,
    });
  }
  // Include pristine assignments too. A reviewer may have an autosave queued
  // against the old content even though the stored row is still `assigned`.
  return reviews;
}

async function invalidateReviewsForRevision(
  ctx: MutationCtx,
  event: Doc<"events">,
  proposal: Doc<"proposals">,
  actorUserId: Id<"users">,
  reviews: Array<Doc<"reviews">>,
  contentVersion: number,
): Promise<void> {
  if (reviews.length === 0) return;
  const now = Date.now();
  const fromStatuses: Record<string, number> = {};
  let invalidated = 0;
  let conflictsCarried = 0;
  for (const review of reviews) {
    fromStatuses[review.status] = (fromStatuses[review.status] ?? 0) + 1;
    // A conflict is tied to the reviewer/proposal relationship rather than a
    // particular draft of the talk. Preserve the recusal, but advance its
    // fence so every review row agrees with the proposal's current content.
    if (review.status === "conflict") {
      conflictsCarried += 1;
      await ctx.db.patch("reviews", review._id, {
        contentVersion,
        updatedAt: now,
      });
      continue;
    }
    invalidated += 1;
    await ctx.db.patch("reviews", review._id, {
      status: "assigned",
      answers: undefined,
      contentVersion,
      weightedScore: undefined,
      score: undefined,
      recommendation: undefined,
      comments: undefined,
      submittedAt: undefined,
      updatedAt: now,
    });
  }
  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId,
    action: "review.invalidateForProposalRevision",
    targetType: "proposal",
    targetId: proposal._id,
    meta: {
      count: invalidated,
      conflictsCarried,
      contentVersion,
      fromStatuses,
    },
  });
}

export async function submitProposal(
  ctx: MutationCtx,
  user: Doc<"users">,
  proposalId: Id<"proposals">,
): Promise<{ successMessage: string | null }> {
  const { proposal, event } = await loadEditableProposal(ctx, user, proposalId);
  requireStandaloneDraftWrite(proposal);
  const { def, version, row } = await requirePublishedForm(ctx, event);
  const speakers = await listSpeakers(ctx, proposal._id);
  validateSubmission(def, proposal.answers, speakers.length);

  const now = Date.now();
  const isResubmit = proposal.status !== "draft";
  // Resubmitting a queued proposal invalidates the staged decision exactly as
  // an edit does; the organizer notification below already reads as an update,
  // so only the audit row is added here.
  if (proposal.status === "acceptQueue" || proposal.status === "declineQueue") {
    await logAudit(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      actorUserId: user._id,
      action: "decision.unstaged",
      targetType: "proposal",
      targetId: proposal._id,
      meta: { from: proposal.status, reason: "submitter_resubmit" },
    });
  }
  await ctx.db.patch("proposals", proposal._id, {
    status: "pending",
    // First submission time is the record; resubmits move updatedAt only.
    submittedAt: proposal.submittedAt ?? now,
    formVersion: version,
    updatedAt: now,
  });
  // Emails go out AFTER this transaction commits (scheduled internal
  // mutation): a template or delivery failure must never roll back the
  // submission itself (this bit the eval run — Resend test mode + a real
  // address unwound the whole submit).
  await ctx.scheduler.runAfter(0, internal.cfp.sendSubmissionEmails, {
    proposalId: proposal._id,
    submittedByUserId: user._id,
    isResubmit,
  });

  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: user._id,
    action: "cfp.submit",
    targetType: "proposal",
    targetId: proposal._id,
    meta: {
      isResubmit,
    },
  });

  return { successMessage: row.successMessage ?? null };
}

/**
 * Atomically replace every editable part of an already-submitted proposal and
 * resubmit it. Validation and identity reconciliation finish before the first
 * write; any later failure (including accepted-session synchronization) rolls
 * the entire mutation back, so organizers can never observe half a revision.
 */
export async function resubmitProposal(
  ctx: MutationCtx,
  user: Doc<"users">,
  proposalId: Id<"proposals">,
  expectedContentVersion: number,
  answers: Record<string, AnswerValue>,
  speakers: SpeakerInput[],
): Promise<{ successMessage: string | null }> {
  const { proposal, event } = await loadEditableProposal(ctx, user, proposalId);
  if (
    !Number.isSafeInteger(expectedContentVersion) ||
    expectedContentVersion < 0
  ) {
    throw new ConvexError({
      code: "invalid_content_version",
      message: "Refresh this proposal before resubmitting it.",
    });
  }
  if ((proposal.contentVersion ?? 0) !== expectedContentVersion) {
    throw new ConvexError({
      code: "stale_proposal_content",
      message:
        "This proposal changed in another tab. Refresh the page before resubmitting so newer changes are not overwritten.",
    });
  }
  if (proposal.status === "draft") {
    throw new ConvexError({
      code: "invalid_status",
      message: "Use the initial submission action for a draft proposal.",
    });
  }
  const { def, version, row } = await requirePublishedForm(ctx, event);
  const preparedAnswers = prepareAnswers(ctx, def, answers);
  const speakerPlan = await prepareSpeakerPlan(
    ctx,
    proposal,
    speakers,
    proposal.status === "accepted",
  );
  validateSubmission(def, preparedAnswers.answers, speakerPlan.speakers.length);

  const contentChanged =
    !answersEqual(proposal.answers, preparedAnswers.answers) ||
    speakerPlanChanged(speakerPlan, proposal);
  // Read and cap the complete affected set before any writes. A partial review
  // reset would be worse than rejecting the revision.
  const invalidatedReviews = contentChanged
    ? await reviewsInvalidatedByRevision(ctx, proposal._id)
    : [];
  const contentVersion =
    (proposal.contentVersion ?? 0) + (contentChanged ? 1 : 0);
  const now = Date.now();
  const preservesReleasedAcceptance = proposal.status === "accepted";

  await applySpeakerPlan(ctx, proposal, speakerPlan);
  await ctx.db.patch("proposals", proposal._id, {
    answers: preparedAnswers.answers,
    title: preparedAnswers.title,
    status: preservesReleasedAcceptance ? "accepted" : "pending",
    submittedAt: proposal.submittedAt ?? now,
    formVersion: version,
    contentVersion,
    updatedAt: now,
  });

  if (proposal.status === "acceptQueue" || proposal.status === "declineQueue") {
    await logAudit(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      actorUserId: user._id,
      action: "decision.unstaged",
      targetType: "proposal",
      targetId: proposal._id,
      meta: { from: proposal.status, reason: "submitter_resubmit" },
    });
  }
  await invalidateReviewsForRevision(
    ctx,
    event,
    proposal,
    user._id,
    invalidatedReviews,
    contentVersion,
  );

  if (preservesReleasedAcceptance) {
    // Direct model call, not a nested `runMutation`. Same mutation ctx, so the
    // transactional outcome is identical (this caller never catches, and an
    // uncaught throw rolls the whole mutation back either way) — the round trip
    // through an internal wrapper only re-read the event and proposal rows this
    // function already holds.
    const revised = await ctx.db.get("proposals", proposal._id);
    if (revised === null) {
      throw new ConvexError({
        code: "not_found",
        message: "The accepted proposal no longer exists.",
      });
    }
    await Sessions.syncAcceptedProposalRevision(ctx, event, revised, user._id);
  }
  await ctx.scheduler.runAfter(0, internal.cfp.sendSubmissionEmails, {
    proposalId: proposal._id,
    submittedByUserId: user._id,
    isResubmit: true,
  });
  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: user._id,
    action: "cfp.submit",
    targetType: "proposal",
    targetId: proposal._id,
    meta: {
      isResubmit: true,
      contentChanged,
      ...(preservesReleasedAcceptance
        ? { releasedDecisionPreserved: true }
        : {}),
    },
  });
  return { successMessage: row.successMessage ?? null };
}

/** Post-commit half of submit/resubmit — runs in its own transaction so an
 * email failure can't unwind the submission. */
export async function sendSubmissionEmails(
  ctx: MutationCtx,
  args: {
    proposalId: Id<"proposals">;
    submittedByUserId: Id<"users">;
    isResubmit: boolean;
  },
): Promise<void> {
  const proposal = await ctx.db.get("proposals", args.proposalId);
  if (proposal === null) return;
  // A withdrawal (or a reopen back to draft) that lands between the commit
  // and this job must win: no "we received your proposal" mail for a
  // proposal that is no longer submitted.
  if (proposal.status === "withdrawn" || proposal.status === "draft") return;
  const event = await ctx.db.get("events", proposal.eventId);
  if (event === null) return;
  const user = await ctx.db.get("users", args.submittedByUserId);
  const speakers = await listSpeakers(ctx, proposal._id);
  const { isResubmit } = args;

  const title = proposal.title;
  const submitterEmail = user?.email?.trim();
  if (submitterEmail !== undefined && submitterEmail.length > 0) {
    const rendered = await renderTemplate(ctx, event, "cfp.confirmation", {
      event: { name: event.name },
      proposal: { title },
      subjectLead: isResubmit
        ? "Your updated proposal"
        : "We received your proposal",
      intro: isResubmit
        ? "Your updated proposal has been received"
        : "Thanks for submitting to",
      link: proposalLink(event.slug, proposal._id),
    });
    await sendLoggedEmail(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      toEmail: submitterEmail,
      kind: "cfp.confirmation",
      subject: rendered.subject,
      html: rendered.html,
      sentByUserId: args.submittedByUserId,
      replyTo: event.replyTo,
      context: { proposalId: proposal._id, isResubmit },
    });
  }

  const adminNotice = await renderTemplate(
    ctx,
    event,
    "cfp.adminNotification",
    {
      event: { name: event.name },
      proposal: {
        title,
        speakers: speakers
          .map((s) => `${s.firstName} ${s.lastName}`)
          .join(", "),
      },
      subjectLead: isResubmit ? "Updated proposal" : "New proposal",
      intro: isResubmit ? "A proposal was updated" : "A new proposal arrived",
      link: eventConsoleLink(event.slug),
    },
  );
  await notifyOrganizers(ctx, event, {
    kind: "cfp.adminNotification",
    subject: adminNotice.subject,
    html: adminNotice.html,
    context: { proposalId: proposal._id, isResubmit },
  });
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
    const notice = await renderTemplate(ctx, event, "cfp.withdrawn", {
      event: { name: event.name },
      proposal: { title },
      link: eventConsoleLink(event.slug),
    });
    await notifyOrganizers(ctx, event, {
      kind: "cfp.withdrawn",
      subject: notice.subject,
      html: notice.html,
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

export type ProposalList = {
  rows: ProposalRow[];
  /** True when the event has more proposals than PROPOSAL_LIST_CAP, so the UI
   * must say so instead of implying "700 of 700". */
  capped: boolean;
};

/** Newest-first proposals per organizer list read. */
const PROPOSAL_LIST_CAP = 500;
/** 500 proposals × 10 speakers is the hard ceiling, so this covers the counts
 * for a full page. */
const PROPOSAL_SPEAKER_CAP = 5000;

/**
 * M1 sanity list for organizers; M2 builds the real review table (and decides
 * what reviewers may see, which is why they're excluded here).
 *
 * REPORTS `capped` rather than refusing (H5): this is a listing, the rows are
 * newest-first, and an organizer working the newest 500 of 700 proposals is
 * doing useful work — as long as the surface admits the other 200 exist. The
 * previous version dropped them silently and the route rendered
 * "Showing 500 of 500", which is the actual bug: invisible data loss on the
 * organizer's primary CFP surface.
 */
export async function listProposals(
  ctx: QueryCtx,
  caller: EventCaller,
  filters?: { status?: ProposalStatus },
): Promise<ProposalList> {
  requireOrganizer(caller);
  const eventId = caller.event._id;
  const status = filters?.status;
  const [proposals, speakerRows] = await Promise.all([
    // Unfiltered lists use the plain by-event index: the status-first index
    // ordered desc would keep a status-skewed slice once past the cap.
    takeCapped(
      status === undefined
        ? ctx.db
            .query("proposals")
            .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
            .order("desc")
        : ctx.db
            .query("proposals")
            .withIndex("by_eventId_and_status", (q) =>
              q.eq("eventId", eventId).eq("status", status),
            )
            .order("desc"),
      PROPOSAL_LIST_CAP,
    ),
    // One event-wide read instead of a speaker query per proposal.
    takeCapped(
      ctx.db
        .query("proposalSpeakers")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      PROPOSAL_SPEAKER_CAP,
    ),
  ]);
  const counts = new Map<Id<"proposals">, number>();
  for (const row of speakerRows.rows) {
    counts.set(row.proposalId, (counts.get(row.proposalId) ?? 0) + 1);
  }
  // Both index reads are newest-first already (creation time is the trailing
  // index column in each case).
  return {
    rows: proposals.rows.map((proposal) => ({
      proposal,
      speakerCount: counts.get(proposal._id) ?? 0,
    })),
    // A truncated speaker read understates speakerCount on the oldest
    // proposals, so it is the same "this page isn't the whole story" warning.
    capped: proposals.capped || speakerRows.capped,
  };
}

export type ProposalDetail = {
  proposal: Doc<"proposals">;
  speakers: Array<Doc<"proposalSpeakers">>;
  submitter: { name: string | null; email: string | null };
  /** Signed download URLs for file-kind answers, keyed by storage id. */
  fileUrls: Record<string, string | null>;
};

/** Organizer view of one proposal: full answers, speakers, submitter, and
 * download URLs for uploaded files. True (unmasked) status. */
export async function getProposalDetail(
  ctx: QueryCtx,
  caller: EventCaller,
  proposalId: Id<"proposals">,
): Promise<ProposalDetail> {
  requireOrganizer(caller);
  const proposal = await ctx.db.get("proposals", proposalId);
  if (proposal === null || proposal.eventId !== caller.event._id) {
    notFound("proposal", "No such proposal on this event.");
  }
  const [speakers, submitterUser, form] = await Promise.all([
    ctx.db
      .query("proposalSpeakers")
      .withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId))
      .take(20),
    ctx.db.get("users", proposal.submitterUserId),
    findForm(ctx, caller.event._id),
  ]);
  const def = form?.published ?? form?.working;
  const fileUrls: Record<string, string | null> = {};
  if (def !== undefined) {
    const fileFields = allFields(def).filter((f) => f.kind === "file");
    await Promise.all(
      fileFields.map(async (f) => {
        const answer = proposal.answers[f.id];
        if (typeof answer === "string" && answer.length > 0) {
          // Never hand a raw answer to storage: a malformed value would throw
          // and take the whole detail view down. Malformed → null URL.
          const storageId = ctx.db.system.normalizeId("_storage", answer);
          fileUrls[answer] =
            storageId === null ? null : await ctx.storage.getUrl(storageId);
        }
      }),
    );
  }
  return {
    proposal,
    speakers: speakers.sort((a, b) => a.order - b.order),
    submitter: {
      name: submitterUser?.name ?? null,
      email: submitterUser?.email ?? null,
    },
    fileUrls,
  };
}

/** Abstracts-table "manual add" (M2): an organizer records a proposal that
 * arrived outside the CFP. The organizer becomes its manager. */
export async function createManualProposal(
  ctx: MutationCtx,
  caller: EventCaller,
  args: {
    title: string;
    abstract?: string;
    speakers: Array<{ firstName: string; lastName: string; email?: string }>;
  },
): Promise<Id<"proposals">> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const title = assertText(args.title, {
    label: "Title",
    max: 200,
    code: "invalid_name",
  });
  if (args.speakers.length === 0 || args.speakers.length > 10) {
    throw new ConvexError({
      code: "invalid_submission",
      message: "List between 1 and 10 speakers.",
    });
  }
  const form = await ensureForm(ctx, caller.event._id);
  const def = form.published ?? form.working;
  const answers: Record<string, AnswerValue> = {};
  const titleId = systemFieldId(def, "talkTitle");
  if (titleId !== undefined) answers[titleId] = title;
  const abstractId = systemFieldId(def, "abstract");
  if (abstractId !== undefined && args.abstract !== undefined) {
    answers[abstractId] = args.abstract;
  }
  const first = args.speakers[0];
  const firstNameId = systemFieldId(def, "firstName");
  if (firstNameId !== undefined) answers[firstNameId] = first.firstName;
  const lastNameId = systemFieldId(def, "lastName");
  if (lastNameId !== undefined) answers[lastNameId] = first.lastName;
  const emailId = systemFieldId(def, "email");
  if (emailId !== undefined && first.email !== undefined) {
    answers[emailId] = first.email.trim().toLowerCase();
  }
  const now = Date.now();
  const proposalId = await ctx.db.insert("proposals", {
    eventId: caller.event._id,
    submitterUserId: caller.user._id,
    status: "pending",
    title,
    answers,
    formVersion: form.version,
    contentVersion: 0,
    submittedAt: now,
    updatedAt: now,
  });
  await Promise.all(
    args.speakers.map((s, i) =>
      ctx.db.insert("proposalSpeakers", {
        proposalId,
        eventId: caller.event._id,
        order: i,
        firstName: assertText(s.firstName, { label: "First name", max: 80 }),
        lastName: assertText(s.lastName, { label: "Last name", max: 80 }),
        email: s.email?.trim().toLowerCase() || undefined,
        isPrimary: i === 0,
      }),
    ),
  );
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "cfp.manualAdd",
    targetType: "proposal",
    targetId: proposalId,
    meta: { title },
  });
  return proposalId;
}

export type FileAnswerRow = {
  proposalId: Id<"proposals">;
  proposalTitle: string;
  fieldLabel: string;
  storageId: string;
  url: string | null;
};

/** Every uploaded file across the event's proposals (file-bundle download). */
export async function listFileAnswers(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<FileAnswerRow[]> {
  requireOrganizer(caller);
  const form = await findForm(ctx, caller.event._id);
  const def = form?.published ?? form?.working;
  if (def === undefined) return [];
  const fileFields = allFields(def).filter((f) => f.kind === "file");
  if (fileFields.length === 0) return [];
  const proposals = await ctx.db
    .query("proposals")
    .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
    .order("desc")
    .take(500);
  const rows: FileAnswerRow[] = [];
  await Promise.all(
    proposals.flatMap((p) =>
      fileFields.map(async (f) => {
        const answer = p.answers[f.id];
        if (typeof answer === "string" && answer.length > 0) {
          // Malformed values must not throw the whole bundle away (see
          // getProposalDetail): they surface as a null URL instead.
          const storageId = ctx.db.system.normalizeId("_storage", answer);
          rows.push({
            proposalId: p._id,
            proposalTitle: p.title,
            fieldLabel: f.label,
            storageId: answer,
            url:
              storageId === null ? null : await ctx.storage.getUrl(storageId),
          });
        }
      }),
    ),
  );
  return rows;
}

/** Organizer grants one submitter an edit window past cfpCloseAt. */
export async function reopenProposal(
  ctx: MutationCtx,
  caller: EventCaller,
  proposalId: Id<"proposals">,
  until: number,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const proposal = await ctx.db.get("proposals", proposalId);
  if (proposal === null || proposal.eventId !== caller.event._id) {
    notFound("proposal", "No such proposal on this event.");
  }
  if (
    proposal.status !== "accepted" &&
    !EDITABLE_STATUSES.has(proposal.status)
  ) {
    throw new ConvexError({
      code: "invalid_status",
      message:
        "Only undecided or accepted proposals can be reopened for editing.",
    });
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
    meta: {
      until,
      statusAtReopen: proposal.status,
      ...(proposal.status === "accepted"
        ? { releasedDecisionPreserved: true }
        : {}),
    },
  });
}

// The form builder capability lives in `./cfpForms` (see the note above). Its
// organizer-facing entry points are re-exported here so the public wrappers in
// `convex/cfp.ts` keep reaching them through `Cfp.*`.
export {
  customFieldId,
  starterFormDef,
  getForm,
  updateWorkingForm,
  updateFormSettings,
  publishForm,
  submissionWindowOpen,
  validateFormDef,
} from "./cfpForms";
export type { CfpFormView, FormSettingsPatch } from "./cfpForms";
