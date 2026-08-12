import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import { notifyOrganizers, sendLoggedEmail, siteUrl } from "./comms";
import { renderTemplate } from "./templates";
import { assertEventActive, assertText, takeAll } from "./validation";
import {
  eventUserDisplayName,
  resolveEventUserDisplayName,
} from "./userDisplay";
import type { DisplayNameResolution } from "./userDisplay";

// ─────────────────────────────────────────────────────────────────────────
// Speaker ops: requirements & task instances (M4).
//
// A REQUIREMENT is the organizer's event-scoped definition ("everyone needs a
// headshot"); a TASK INSTANCE is one concrete obligation created from it. The
// two never merge: deactivating a requirement stops future instantiation and
// leaves historical work intact, and a per-instance due date override survives
// a later requirement-wide date change.
//
// Evidence is OBSERVED, never judged (MILESTONES M4): "Provided" means a file
// exists / a field is filled / someone ticked it. Quality is the optional
// review gate's business, and only an event organizer may operate that gate.
//
// Three people may submit work on a participant task: an organizer, the
// claimed speaker themself, and the session's primary manager. Whoever acts is
// recorded in `completedBy`, and the instance keeps its participant — "a
// participant task remains owed by its speaker even when the manager or an
// organizer completes it on their behalf".
//
// Every mutating capability re-checks its own authorization: the portal and
// the organizer console both call straight into this module.
// ─────────────────────────────────────────────────────────────────────────

/** One event's worth of rows. Bounded reads only — the organizer console
 * paginates long before an event reaches these numbers. */
const REQUIREMENT_SCAN = 200;
const SESSION_SCAN = 1000;
const PARTICIPANT_SCAN = 5000;
const INSTANCE_SCAN = 8000;
const CONTACT_SCAN = 2000;
const UPLOAD_SCAN = 200;
const FILE_LIBRARY_SCAN = 300;
const FILE_LIBRARY_CURRENT_LIMIT = 120;
const FILE_LIBRARY_HEADSHOT_CONTACT_LIMIT = 64;
const FILE_LIBRARY_TASK_CONTACT_LIMIT = 16;
const FILE_LIBRARY_SESSION_LIMIT = 64;
const FILE_LIBRARY_HEADSHOT_CONTACT_BYTES = 2 * 1024 * 1024;
const FILE_LIBRARY_HYDRATION_BYTES = 6 * 1024 * 1024;
const MAX_PARTICIPANTS_PER_SESSION = 100;

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const MAX_NOTE = 2000;
const MAX_FILENAME = 300;

export type Scope = Doc<"requirements">["scope"];
export type Evidence = Doc<"requirements">["evidence"];
export type TaskStatus = Doc<"taskInstances">["status"];

/** Snapshot fields a `profileField` requirement can observe. */
export const FIELD_KEYS = ["bio", "headshot", "tagline"] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

/** Statuses that count as satisfied: they stop reminders and let a session
 * read as Ready (MILESTONES M4 — Not Applicable "counts as satisfied"). */
const SETTLED: ReadonlySet<TaskStatus> = new Set([
  "approved",
  "complete",
  "notApplicable",
]);

/** True when this instance is still owed by someone. */
export function isOpen(instance: Doc<"taskInstances">): boolean {
  return !SETTLED.has(instance.status);
}

export function isOverdue(
  instance: Doc<"taskInstances">,
  now: number,
): boolean {
  return isOpen(instance) && instance.dueAt < now;
}

// ── Status rules ─────────────────────────────────────────────────────────

/**
 * What observing evidence means. Without review, "Provided" IS completion
 * ("Without review, Provided counts as complete"); with review enabled the
 * work parks at `provided` until an organizer approves it. Neither value
 * claims the content is any good.
 */
function providedStatus(requirement: Doc<"requirements">): TaskStatus {
  return requirement.reviewRequired ? "provided" : "complete";
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/** Objective presence check for `profileField` evidence. */
export function fieldPresent(
  contact: Doc<"eventContacts">,
  fieldKey: string | undefined,
): boolean {
  switch (fieldKey) {
    case "bio":
      return isPresent(contact.bio);
    case "tagline":
      return isPresent(contact.tagline);
    case "headshot":
      return contact.headshotId !== undefined;
    default:
      return false;
  }
}

// ── Validation ───────────────────────────────────────────────────────────

function optionalText(
  value: string | undefined,
  label: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = assertText(value, { label, max, min: 0 });
  return trimmed.length > 0 ? trimmed : undefined;
}

function assertDueAt(dueAt: number): number {
  if (!Number.isFinite(dueAt)) {
    throw new ConvexError({
      code: "invalid_due_date",
      message: "That due date isn't a valid time.",
    });
  }
  return dueAt;
}

function assertFieldKey(
  evidence: Evidence,
  fieldKey: string | undefined,
): string | undefined {
  if (evidence !== "profileField") {
    // A field key on file/manual evidence would silently do nothing; refuse it
    // rather than store a lie.
    if (fieldKey !== undefined) {
      throw new ConvexError({
        code: "invalid_field_key",
        message: "Only profile-field requirements name a profile field.",
      });
    }
    return undefined;
  }
  if (
    fieldKey === undefined ||
    !(FIELD_KEYS as ReadonlyArray<string>).includes(fieldKey)
  ) {
    throw new ConvexError({
      code: "invalid_field_key",
      message: `A profile-field requirement must observe one of: ${FIELD_KEYS.join(", ")}.`,
    });
  }
  return fieldKey;
}

// ── Instantiation ────────────────────────────────────────────────────────

/**
 * Identity of an obligation. Session scope: one per (requirement, session).
 * Participant scope: one per (requirement, event contact) — a speaker owes a
 * bio ONCE however many sessions they present (a per-session key here is the
 * eval-run bug that gave a two-session speaker duplicate speaker-level tasks).
 */
function sessionScopeKey(
  requirementId: Id<"requirements">,
  sessionId: Id<"sessions">,
): string {
  return `${requirementId}:session:${sessionId}`;
}

function participantScopeKey(
  requirementId: Id<"requirements">,
  eventContactId: Id<"eventContacts">,
): string {
  return `${requirementId}:contact:${eventContactId}`;
}

/** The key an already-stored instance occupies. Cross-scope collision is
 * impossible: a requirement is either session- or participant-scoped. */
function existingInstanceKey(instance: Doc<"taskInstances">): string {
  return instance.participantId !== undefined &&
    instance.eventContactId !== undefined
    ? participantScopeKey(instance.requirementId, instance.eventContactId)
    : sessionScopeKey(instance.requirementId, instance.sessionId);
}

type ContactCache = Map<Id<"eventContacts">, Doc<"eventContacts"> | null>;

async function cachedContact(
  ctx: QueryCtx,
  cache: ContactCache,
  eventContactId: Id<"eventContacts">,
): Promise<Doc<"eventContacts"> | null> {
  const hit = cache.get(eventContactId);
  if (hit !== undefined) return hit;
  const contact = await ctx.db.get("eventContacts", eventContactId);
  cache.set(eventContactId, contact);
  return contact;
}

/**
 * The status a brand-new instance starts in. Profile-field evidence is
 * evaluated immediately: a speaker who already has a bio must not be asked for
 * one the moment the organizer defines the requirement.
 */
async function initialStatus(
  ctx: QueryCtx,
  cache: ContactCache,
  requirement: Doc<"requirements">,
  eventContactId: Id<"eventContacts"> | undefined,
): Promise<TaskStatus> {
  if (requirement.evidence !== "profileField") return "pending";
  if (eventContactId === undefined) return "pending";
  const contact = await cachedContact(ctx, cache, eventContactId);
  if (contact === null) return "pending";
  return fieldPresent(contact, requirement.fieldKey)
    ? providedStatus(requirement)
    : "pending";
}

async function insertInstance(
  ctx: MutationCtx,
  cache: ContactCache,
  requirement: Doc<"requirements">,
  args: {
    sessionId: Id<"sessions">;
    participantId?: Id<"sessionParticipants">;
    eventContactId?: Id<"eventContacts">;
  },
): Promise<void> {
  const now = Date.now();
  await ctx.db.insert("taskInstances", {
    requirementId: requirement._id,
    eventId: requirement.eventId,
    sessionId: args.sessionId,
    participantId: args.participantId,
    eventContactId: args.eventContactId,
    status: await initialStatus(ctx, cache, requirement, args.eventContactId),
    dueAt: requirement.dueAt,
    // `lastRemindedAt` is reserved for a provider-accepted send. General
    // cadence uses `_creationTime` as its initial baseline, while due-soon
    // safety reminders intentionally run at the next hourly evaluation.
    updatedAt: now,
  });
}

/**
 * Backfill one requirement across everything that already exists (called when
 * the requirement is created). Cancelled sessions are skipped: they carry no
 * live obligations.
 */
async function instantiateRequirement(
  ctx: MutationCtx,
  event: Doc<"events">,
  requirement: Doc<"requirements">,
): Promise<number> {
  const [sessions, participants, existing] = await Promise.all([
    ctx.db
      .query("sessions")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .take(SESSION_SCAN),
    ctx.db
      .query("sessionParticipants")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .take(PARTICIPANT_SCAN),
    ctx.db
      .query("taskInstances")
      .withIndex("by_requirementId", (q) =>
        q.eq("requirementId", requirement._id),
      )
      .take(INSTANCE_SCAN),
  ]);
  const seen = new Set(existing.map(existingInstanceKey));
  const cache: ContactCache = new Map();
  let created = 0;
  for (const session of sessions) {
    if (session.status !== "planned") continue;
    created += await instantiateOne(
      ctx,
      cache,
      requirement,
      session._id,
      seen,
      {
        participants: participants.filter((p) => p.sessionId === session._id),
      },
    );
  }
  return created;
}

/**
 * A session-scope task is one shared obligation with one accountable assignee
 * (MILESTONES M4). Route it to the session's PRIMARY MANAGER when one exists
 * (a participant carrying a managerUserId); otherwise a self-managing direct
 * speaker owns it — default to the sole/first confirmed participant, else the
 * first still-live one. Stored as `eventContactId` (participantId stays
 * undefined, so instance identity — one per requirement+session — is
 * unchanged). Without an assignee the task would be invisible to a self-managed
 * speaker, unroutable, and dropped from the overdue audience.
 */
function sessionAssignee(
  participants: Array<Doc<"sessionParticipants">>,
): Id<"eventContacts"> | undefined {
  const live = participants.filter(
    (p) => p.state !== "withdrawn" && p.state !== "declined",
  );
  const managed = live.find((p) => p.managerUserId !== undefined);
  if (managed !== undefined) return managed.eventContactId;
  const confirmed = live.find((p) => p.state === "confirmed");
  return (confirmed ?? live[0])?.eventContactId;
}

/** The per-(requirement, session) half of instantiation, shared by both entry
 * points and idempotent through `seen`. */
async function instantiateOne(
  ctx: MutationCtx,
  cache: ContactCache,
  requirement: Doc<"requirements">,
  sessionId: Id<"sessions">,
  seen: Set<string>,
  args: { participants: Array<Doc<"sessionParticipants">> },
): Promise<number> {
  let created = 0;
  if (requirement.scope === "session") {
    const key = sessionScopeKey(requirement._id, sessionId);
    if (seen.has(key)) return 0;
    seen.add(key);
    await insertInstance(ctx, cache, requirement, {
      sessionId,
      eventContactId: sessionAssignee(args.participants),
    });
    return 1;
  }
  for (const participant of args.participants) {
    // A withdrawn speaker owes nothing (M4: reminders stop on withdrawal), so
    // they never get an instance in the first place.
    if (participant.state === "withdrawn") continue;
    // Once per unique speaker: a contact already owing this requirement on any
    // session (including this one) is skipped.
    const key = participantScopeKey(
      requirement._id,
      participant.eventContactId,
    );
    if (seen.has(key)) continue;
    seen.add(key);
    await insertInstance(ctx, cache, requirement, {
      sessionId,
      participantId: participant._id,
      eventContactId: participant.eventContactId,
    });
    created += 1;
  }
  return created;
}

/**
 * The instantiation seam (MILESTONES M4: "create and assign applicable
 * requirements when an acceptance or direct invitation is formally released").
 * Called from model/sessions.ts after a session and its participants exist,
 * and again after any participant change — it is idempotent per requirement
 * identity key (per session for session scope, per unique speaker for
 * participant scope), so a co-speaker added later gets their own obligations
 * without duplicating anyone else's.
 */
export async function instantiateForSession(
  ctx: MutationCtx,
  event: Doc<"events">,
  sessionId: Id<"sessions">,
): Promise<number> {
  const session = await ctx.db.get("sessions", sessionId);
  if (
    session === null ||
    session.eventId !== event._id ||
    session.status !== "planned"
  ) {
    return 0;
  }
  const requirementRows = await takeAll(
    ctx.db
      .query("requirements")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
    REQUIREMENT_SCAN,
    "requirements",
  );
  const requirements = requirementRows.filter((r) => r.active);
  if (requirements.length === 0) return 0;

  // Event-wide existing scan, not per-session: a participant-scope obligation
  // is owed once per speaker, so an instance on their OTHER session must
  // suppress creation here too.
  const [existing, participants] = await Promise.all([
    takeAll(
      ctx.db
        .query("taskInstances")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      INSTANCE_SCAN,
      "task instances",
    ),
    takeAll(
      ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId)),
      MAX_PARTICIPANTS_PER_SESSION,
      "participants on one session",
    ),
  ]);
  const seen = new Set(existing.map(existingInstanceKey));
  const cache: ContactCache = new Map();
  let created = 0;
  for (const requirement of requirements) {
    created += await instantiateOne(ctx, cache, requirement, sessionId, seen, {
      participants,
    });
  }
  return created;
}

// ── Requirements ─────────────────────────────────────────────────────────

export type RequirementInput = {
  title: string;
  description?: string;
  scope: Scope;
  evidence: Evidence;
  fieldKey?: string;
  reviewRequired: boolean;
  dueAt: number;
};

export async function createRequirement(
  ctx: MutationCtx,
  caller: EventCaller,
  args: RequirementInput,
): Promise<{ requirementId: Id<"requirements">; instances: number }> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const title = assertText(args.title, {
    label: "Requirement title",
    max: MAX_TITLE,
  });
  const description = optionalText(
    args.description,
    "Requirement description",
    MAX_DESCRIPTION,
  );
  const fieldKey = assertFieldKey(args.evidence, args.fieldKey);
  const dueAt = assertDueAt(args.dueAt);

  // Retry guard: a double-submit / network retry re-sends the identical
  // definition, and it must not mint a second requirement (the eval run turned
  // five intended types into seven this way). An identical active definition
  // is the same request — re-run the idempotent backfill and return it.
  const existingRequirements = await takeAll(
    ctx.db
      .query("requirements")
      .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id)),
    REQUIREMENT_SCAN,
    "requirements",
  );
  const duplicate = existingRequirements.find(
    (r) =>
      r.active &&
      r.title === title &&
      r.description === description &&
      r.scope === args.scope &&
      r.evidence === args.evidence &&
      r.fieldKey === fieldKey &&
      r.reviewRequired === args.reviewRequired &&
      r.dueAt === dueAt,
  );
  if (duplicate !== undefined) {
    const instances = await instantiateRequirement(
      ctx,
      caller.event,
      duplicate,
    );
    return { requirementId: duplicate._id, instances };
  }
  if (existingRequirements.length >= REQUIREMENT_SCAN) {
    throw new ConvexError({
      code: "event_too_large",
      message: `This event already has the ${REQUIREMENT_SCAN}-requirement maximum. Consolidate existing requirements or contact support before adding another.`,
    });
  }

  const requirementId = await ctx.db.insert("requirements", {
    eventId: caller.event._id,
    title,
    description,
    scope: args.scope,
    evidence: args.evidence,
    fieldKey,
    reviewRequired: args.reviewRequired,
    dueAt,
    active: true,
  });
  const requirement = await ctx.db.get("requirements", requirementId);
  if (requirement === null) notFound("requirement");
  const instances = await instantiateRequirement(
    ctx,
    caller.event,
    requirement,
  );

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "task.requirementCreate",
    targetType: "requirement",
    targetId: requirementId,
    meta: {
      title,
      scope: args.scope,
      evidence: args.evidence,
      fieldKey,
      reviewRequired: args.reviewRequired,
      instances,
    },
  });
  return { requirementId, instances };
}

export type RequirementPatch = {
  title?: string;
  description?: string;
  dueAt?: number;
  reviewRequired?: boolean;
  active?: boolean;
  /** M5 override of the event-wide cadence; null restores inheritance. */
  reminderCadenceDays?: number | null;
  /** M5: silence reminders for this requirement without deactivating it. */
  remindersDisabled?: boolean;
};

/**
 * Edit a requirement. Deactivating stops instantiation for future sessions and
 * deliberately leaves existing instances alone — active work is never rewritten
 * by a definition change (MILESTONES M4).
 *
 * A due-date change propagates only to instances that still sit on the OLD
 * requirement date. An instance whose date was overridden per speaker/session
 * has moved off it, and that override is the concrete deadline that counts.
 */
export async function updateRequirement(
  ctx: MutationCtx,
  caller: EventCaller,
  requirementId: Id<"requirements">,
  patch: RequirementPatch,
): Promise<{ repropagated: number }> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const requirement = await ctx.db.get("requirements", requirementId);
  if (requirement === null || requirement.eventId !== caller.event._id) {
    notFound("requirement", "No such requirement on this event.");
  }

  const update: {
    title?: string;
    description?: string;
    dueAt?: number;
    reviewRequired?: boolean;
    active?: boolean;
  } = {};
  if (patch.title !== undefined) {
    update.title = assertText(patch.title, {
      label: "Requirement title",
      max: MAX_TITLE,
    });
  }
  if (patch.description !== undefined) {
    update.description = optionalText(
      patch.description,
      "Requirement description",
      MAX_DESCRIPTION,
    );
  }
  if (patch.dueAt !== undefined) update.dueAt = assertDueAt(patch.dueAt);
  if (patch.reviewRequired !== undefined) {
    update.reviewRequired = patch.reviewRequired;
  }
  if (patch.active !== undefined) update.active = patch.active;

  // M5 reminder controls. `null` cadence means "go back to inheriting the
  // event-wide default"; `remindersDisabled` silences this requirement without
  // deactivating it (deactivating would also stop future instantiation).
  const reminderUpdate: {
    reminderCadenceDays?: number | undefined;
    remindersDisabled?: boolean;
  } = {};
  if (patch.reminderCadenceDays !== undefined) {
    if (patch.reminderCadenceDays === null) {
      reminderUpdate.reminderCadenceDays = undefined;
    } else {
      if (
        !Number.isInteger(patch.reminderCadenceDays) ||
        patch.reminderCadenceDays < 1 ||
        patch.reminderCadenceDays > 90
      ) {
        throw new ConvexError({
          code: "invalid_cadence",
          message:
            "Reminder cadence must be a whole number of days between 1 and 90.",
        });
      }
      reminderUpdate.reminderCadenceDays = patch.reminderCadenceDays;
    }
  }
  if (patch.remindersDisabled !== undefined) {
    reminderUpdate.remindersDisabled = patch.remindersDisabled;
  }
  await ctx.db.patch("requirements", requirementId, {
    ...update,
    ...reminderUpdate,
  });

  let repropagated = 0;
  if (update.dueAt !== undefined && update.dueAt !== requirement.dueAt) {
    const instances = await ctx.db
      .query("taskInstances")
      .withIndex("by_requirementId", (q) =>
        q.eq("requirementId", requirementId),
      )
      .take(INSTANCE_SCAN);
    const now = Date.now();
    for (const instance of instances) {
      if (instance.dueAt !== requirement.dueAt) continue;
      await ctx.db.patch("taskInstances", instance._id, {
        dueAt: update.dueAt,
        updatedAt: now,
      });
      repropagated += 1;
    }
  }

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "task.requirementUpdate",
    targetType: "requirement",
    targetId: requirementId,
    meta: { fields: Object.keys(update), repropagated },
  });
  return { repropagated };
}

// ── Instance lookup & authorization ──────────────────────────────────────

async function loadInstance(
  ctx: QueryCtx,
  event: Doc<"events">,
  instanceId: Id<"taskInstances">,
): Promise<{
  instance: Doc<"taskInstances">;
  requirement: Doc<"requirements">;
}> {
  const instance = await ctx.db.get("taskInstances", instanceId);
  if (instance === null || instance.eventId !== event._id) {
    notFound("task", "No such task on this event.");
  }
  const requirement = await ctx.db.get("requirements", instance.requirementId);
  if (requirement === null) notFound("requirement");
  return { instance, requirement };
}

/** Organizer of this event — org owner/admins organize every event. */
async function isEventOrganizer(
  ctx: QueryCtx,
  user: Doc<"users">,
  event: Doc<"events">,
): Promise<boolean> {
  const orgMembership = await ctx.db
    .query("members")
    .withIndex("by_orgId_and_userId", (q) =>
      q.eq("orgId", event.orgId).eq("userId", user._id),
    )
    .unique();
  if (orgMembership !== null) return true;
  const eventMembership = await ctx.db
    .query("eventMembers")
    .withIndex("by_eventId_and_userId", (q) =>
      q.eq("eventId", event._id).eq("userId", user._id),
    )
    .unique();
  return eventMembership !== null && eventMembership.role === "organizer";
}

/**
 * The submission trio (MILESTONES M4): an organizer, the claimed speaker the
 * task is owed by, or the session's primary manager. A miss is `not_found`, not
 * `forbidden` — task ids must not be probeable.
 */
export async function requireTaskActor(
  ctx: QueryCtx,
  user: Doc<"users">,
  event: Doc<"events">,
  instance: Doc<"taskInstances">,
): Promise<void> {
  if (await isEventOrganizer(ctx, user, event)) return;
  if (instance.eventContactId !== undefined) {
    const contact = await ctx.db.get("eventContacts", instance.eventContactId);
    if (contact !== null && contact.userId === user._id) return;
  }
  const participants = await ctx.db
    .query("sessionParticipants")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", instance.sessionId))
    .take(MAX_PARTICIPANTS_PER_SESSION);
  if (participants.some((p) => p.managerUserId === user._id)) return;
  notFound("task", "No such task.");
}

/** Resolve + authorize in one step, for the portal's write paths. */
export async function requireTaskAccess(
  ctx: QueryCtx,
  user: Doc<"users">,
  event: Doc<"events">,
  instanceId: Id<"taskInstances">,
): Promise<{
  instance: Doc<"taskInstances">;
  requirement: Doc<"requirements">;
}> {
  const loaded = await loadInstance(ctx, event, instanceId);
  await requireTaskActor(ctx, user, event, loaded.instance);
  return loaded;
}

// ── Notifications ────────────────────────────────────────────────────────

function taskLink(eventSlug: string): string {
  return `${siteUrl()}/portal/${eventSlug}`;
}

/**
 * Reach whoever owes this task: the claimed speaker if they have an account,
 * otherwise the primary manager, otherwise the organizers (so a change request
 * is never silently swallowed). Best-effort — a missing address must not roll
 * back the review decision.
 */
export async function notifyResponsible(
  ctx: MutationCtx,
  event: Doc<"events">,
  instance: Doc<"taskInstances">,
  args: { kind: string; subject: string; html: string },
): Promise<void> {
  const send = async (toEmail: string): Promise<void> => {
    await sendLoggedEmail(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      toEmail,
      kind: args.kind,
      subject: args.subject,
      html: args.html,
      replyTo: event.replyTo,
      context: { taskInstanceId: instance._id },
    });
  };

  if (instance.eventContactId !== undefined) {
    const contact = await ctx.db.get("eventContacts", instance.eventContactId);
    if (contact !== null && contact.userId !== undefined) {
      const speaker = await ctx.db.get("users", contact.userId);
      const email = speaker?.email?.trim();
      if (email !== undefined && email.length > 0) {
        await send(email);
        return;
      }
    }
  }

  const participants = await ctx.db
    .query("sessionParticipants")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", instance.sessionId))
    .take(MAX_PARTICIPANTS_PER_SESSION);
  const managerId = participants.find(
    (p) => p.managerUserId !== undefined,
  )?.managerUserId;
  if (managerId !== undefined) {
    const manager = await ctx.db.get("users", managerId);
    const email = manager?.email?.trim();
    if (email !== undefined && email.length > 0) {
      await send(email);
      return;
    }
  }

  await notifyOrganizers(ctx, event, {
    kind: args.kind,
    subject: args.subject,
    html: args.html,
    context: { taskInstanceId: instance._id },
  });
}

// ── Submission (manual evidence) ─────────────────────────────────────────

/**
 * Tick a manual task. Open to the submission trio; the acting user is recorded
 * and the instance keeps its participant, so the obligation stays visibly owed
 * by the speaker even when someone else did the paperwork.
 */
export async function markProvided(
  ctx: MutationCtx,
  actor: Doc<"users">,
  event: Doc<"events">,
  instanceId: Id<"taskInstances">,
): Promise<void> {
  const { instance, requirement } = await requireTaskAccess(
    ctx,
    actor,
    event,
    instanceId,
  );
  assertEventActive(event);
  if (requirement.evidence !== "manual") {
    throw new ConvexError({
      code: "invalid_evidence",
      message:
        requirement.evidence === "file"
          ? "This task is completed by uploading a file."
          : "This task completes itself when the profile field is filled in.",
    });
  }
  if (instance.status === "notApplicable") {
    throw new ConvexError({
      code: "invalid_status",
      message: "This task was marked not applicable.",
    });
  }
  const now = Date.now();
  await ctx.db.patch("taskInstances", instance._id, {
    status: providedStatus(requirement),
    reviewNote: undefined,
    completedBy: actor._id,
    completedAt: now,
    updatedAt: now,
  });
  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: actor._id,
    action: "task.markProvided",
    targetType: "taskInstance",
    targetId: instance._id,
    meta: {
      requirementId: requirement._id,
      to: providedStatus(requirement),
      onBehalf: instance.eventContactId !== undefined,
    },
  });
}

// ── Submission (file evidence) ───────────────────────────────────────────

/**
 * Attach a new version of the requested file. Prior versions, their approvals
 * and their actors are never erased (M4), and replacing an approved file drops
 * the instance back to Provided / Awaiting Review because approval is
 * version-specific.
 */
export async function attachUpload(
  ctx: MutationCtx,
  actor: Doc<"users">,
  event: Doc<"events">,
  args: {
    instanceId: Id<"taskInstances">;
    storageId: Id<"_storage">;
    filename: string;
  },
): Promise<{ uploadId: Id<"uploads">; version: number }> {
  const { instance, requirement } = await requireTaskAccess(
    ctx,
    actor,
    event,
    args.instanceId,
  );
  assertEventActive(event);
  if (requirement.evidence !== "file") {
    throw new ConvexError({
      code: "invalid_evidence",
      message: "This task doesn't take a file.",
    });
  }
  if (instance.status === "notApplicable") {
    throw new ConvexError({
      code: "invalid_status",
      message: "This task was marked not applicable.",
    });
  }
  const filename = assertText(args.filename, {
    label: "File name",
    max: MAX_FILENAME,
    code: "invalid_filename",
  });
  if (
    filename === "." ||
    filename === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw new ConvexError({
      code: "invalid_filename",
      message:
        "File names cannot contain path separators or control characters.",
    });
  }

  const latest = await ctx.db
    .query("uploads")
    .withIndex("by_taskInstanceId", (q) => q.eq("taskInstanceId", instance._id))
    .order("desc")
    .first();
  if (latest !== null && latest.version >= UPLOAD_SCAN) {
    throw new ConvexError({
      code: "upload_version_limit",
      message: `A task can keep at most ${UPLOAD_SCAN} file versions.`,
    });
  }
  // `by_taskInstanceId` is ordered by `_creationTime` after the indexed key.
  // Versions are append-only, so the newest row is the authoritative max.
  const version = (latest?.version ?? 0) + 1;
  const uploadId = await ctx.db.insert("uploads", {
    eventId: event._id,
    taskInstanceId: instance._id,
    storageId: args.storageId,
    filename,
    version,
    uploadedBy: actor._id,
  });

  const now = Date.now();
  await ctx.db.patch("taskInstances", instance._id, {
    status: providedStatus(requirement),
    reviewNote: undefined,
    completedBy: actor._id,
    completedAt: now,
    updatedAt: now,
  });
  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: actor._id,
    action: "task.upload",
    targetType: "taskInstance",
    targetId: instance._id,
    meta: { requirementId: requirement._id, version, filename },
  });
  return { uploadId, version };
}

export type UploadRow = {
  uploadId: Id<"uploads">;
  filename: string;
  version: number;
  uploadedBy: Id<"users">;
  uploadedAt: number;
  url: string | null;
  approvedAt?: number;
};

/** Versions of one task's evidence, newest first, with signed URLs. */
export async function listUploads(
  ctx: QueryCtx,
  user: Doc<"users">,
  event: Doc<"events">,
  instanceId: Id<"taskInstances">,
): Promise<UploadRow[]> {
  const { instance } = await requireTaskAccess(ctx, user, event, instanceId);
  const rows = await ctx.db
    .query("uploads")
    .withIndex("by_taskInstanceId", (q) => q.eq("taskInstanceId", instance._id))
    .order("desc")
    .take(UPLOAD_SCAN + 1);
  if (rows.length > UPLOAD_SCAN) {
    throw new ConvexError({
      code: "upload_version_limit",
      message: `This task has more than ${UPLOAD_SCAN} file versions. The history is refused rather than silently truncated.`,
    });
  }
  const out: UploadRow[] = [];
  for (const row of rows) {
    out.push({
      uploadId: row._id,
      filename: row.filename,
      version: row.version,
      uploadedBy: row.uploadedBy,
      uploadedAt: row._creationTime,
      url: await ctx.storage.getUrl(row.storageId),
      approvedAt: row.approvedAt,
    });
  }
  return out;
}

async function latestUpload(
  ctx: QueryCtx,
  instanceId: Id<"taskInstances">,
): Promise<Doc<"uploads"> | null> {
  return await ctx.db
    .query("uploads")
    .withIndex("by_taskInstanceId", (q) => q.eq("taskInstanceId", instanceId))
    .order("desc")
    .first();
}

// ── Review gate (organizer only) ─────────────────────────────────────────

export async function approveInstance(
  ctx: MutationCtx,
  caller: EventCaller,
  instanceId: Id<"taskInstances">,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const { instance, requirement } = await loadInstance(
    ctx,
    caller.event,
    instanceId,
  );
  if (instance.status !== "provided") {
    throw new ConvexError({
      code: "invalid_status",
      message: "Only submitted work awaiting review can be approved.",
    });
  }
  const now = Date.now();
  await ctx.db.patch("taskInstances", instance._id, {
    status: "approved",
    reviewNote: undefined,
    updatedAt: now,
  });
  // Approval is version-specific: stamp the file that was actually reviewed.
  const upload = await latestUpload(ctx, instance._id);
  if (upload !== null && upload.approvedAt === undefined) {
    await ctx.db.patch("uploads", upload._id, {
      approvedAt: now,
      approvedBy: caller.user._id,
    });
  }
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "task.approve",
    targetType: "taskInstance",
    targetId: instance._id,
    meta: {
      requirementId: requirement._id,
      uploadVersion: upload?.version,
    },
  });
}

export async function requestChanges(
  ctx: MutationCtx,
  caller: EventCaller,
  instanceId: Id<"taskInstances">,
  note: string,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  // "change requests require an explanatory note and notify the responsible
  // people" (MILESTONES M4) — the note is not optional.
  const reviewNote = assertText(note, {
    label: "Change request note",
    max: MAX_NOTE,
    code: "invalid_note",
  });
  const { instance, requirement } = await loadInstance(
    ctx,
    caller.event,
    instanceId,
  );
  if (
    instance.status !== "provided" &&
    instance.status !== "approved" &&
    instance.status !== "complete"
  ) {
    throw new ConvexError({
      code: "invalid_status",
      message: "There's nothing submitted to send back.",
    });
  }
  const now = Date.now();
  await ctx.db.patch("taskInstances", instance._id, {
    status: "changesRequested",
    reviewNote,
    updatedAt: now,
  });

  const rendered = await renderTemplate(
    ctx,
    caller.event,
    "task.changesRequested",
    {
      event: { name: caller.event.name },
      task: { title: requirement.title },
      note: reviewNote,
      link: taskLink(caller.event.slug),
    },
  );
  await notifyResponsible(ctx, caller.event, instance, {
    kind: "task.changesRequested",
    subject: rendered.subject,
    html: rendered.html,
  });

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "task.requestChanges",
    targetType: "taskInstance",
    targetId: instance._id,
    meta: { requirementId: requirement._id, note: reviewNote },
  });
}

/**
 * Waive one instance with a required reason (M4). It counts as satisfied and
 * stops reminders for that instance only — participation and schedule problems
 * are explicitly NOT waivable this way.
 */
export async function markNotApplicable(
  ctx: MutationCtx,
  caller: EventCaller,
  instanceId: Id<"taskInstances">,
  reason: string,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const naReason = assertText(reason, {
    label: "Reason",
    max: MAX_NOTE,
    code: "invalid_reason",
  });
  const { instance, requirement } = await loadInstance(
    ctx,
    caller.event,
    instanceId,
  );
  await ctx.db.patch("taskInstances", instance._id, {
    status: "notApplicable",
    naReason,
    updatedAt: Date.now(),
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "task.markNotApplicable",
    targetType: "taskInstance",
    targetId: instance._id,
    meta: { requirementId: requirement._id, reason: naReason },
  });
}

/** Organizer correction path: put an instance back to Pending. Uploads and
 * their history are untouched. */
export async function reopenInstance(
  ctx: MutationCtx,
  caller: EventCaller,
  instanceId: Id<"taskInstances">,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const { instance, requirement } = await loadInstance(
    ctx,
    caller.event,
    instanceId,
  );
  await ctx.db.patch("taskInstances", instance._id, {
    status: "pending",
    naReason: undefined,
    reviewNote: undefined,
    completedBy: undefined,
    completedAt: undefined,
    updatedAt: Date.now(),
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "task.reopen",
    targetType: "taskInstance",
    targetId: instance._id,
    meta: { requirementId: requirement._id, from: instance.status },
  });
}

/** Per-participant/per-session due date override (M4). The instance moves off
 * the requirement's date, which is what later shields it from a requirement-wide
 * date change. */
export async function setInstanceDue(
  ctx: MutationCtx,
  caller: EventCaller,
  instanceId: Id<"taskInstances">,
  dueAt: number,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const due = assertDueAt(dueAt);
  const { instance } = await loadInstance(ctx, caller.event, instanceId);
  await ctx.db.patch("taskInstances", instance._id, {
    dueAt: due,
    updatedAt: Date.now(),
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "task.setInstanceDue",
    targetType: "taskInstance",
    targetId: instance._id,
    meta: { from: instance.dueAt, to: due },
  });
}

// ── Profile-field evidence ───────────────────────────────────────────────

/**
 * Re-evaluate every profile-field task owed by one speaker. Called after a
 * portal profile edit, so filling in a bio silently satisfies the "bio"
 * requirement and clearing it puts the task back.
 *
 * Only observation moves here. An organizer's approval survives an unrelated
 * profile edit, and only genuine REMOVAL of the field reopens it; a change
 * request stands until the speaker actually re-provides the field.
 */
export async function recomputeProfileEvidence(
  ctx: MutationCtx,
  eventContactId: Id<"eventContacts">,
): Promise<number> {
  const contact = await ctx.db.get("eventContacts", eventContactId);
  if (contact === null) return 0;
  const instances = await ctx.db
    .query("taskInstances")
    .withIndex("by_eventContactId", (q) =>
      q.eq("eventContactId", eventContactId),
    )
    .take(INSTANCE_SCAN);

  const now = Date.now();
  let changed = 0;
  for (const instance of instances) {
    const requirement = await ctx.db.get(
      "requirements",
      instance.requirementId,
    );
    if (requirement === null || requirement.evidence !== "profileField") {
      continue;
    }
    // A waiver is a deliberate organizer decision; presence never overrides it.
    if (instance.status === "notApplicable") continue;
    const present = fieldPresent(contact, requirement.fieldKey);
    const next: TaskStatus | null = present
      ? instance.status === "pending" || instance.status === "changesRequested"
        ? providedStatus(requirement)
        : null
      : instance.status === "changesRequested"
        ? null
        : instance.status === "pending"
          ? null
          : "pending";
    if (next === null || next === instance.status) continue;
    await ctx.db.patch("taskInstances", instance._id, {
      status: next,
      reviewNote: next === "pending" ? undefined : instance.reviewNote,
      updatedAt: now,
    });
    changed += 1;
  }
  return changed;
}

// ── Organizer reads ──────────────────────────────────────────────────────

export type RequirementRow = {
  requirementId: Id<"requirements">;
  title: string;
  description?: string;
  scope: Scope;
  evidence: Evidence;
  fieldKey?: string;
  reviewRequired: boolean;
  dueAt: number;
  active: boolean;
  reminderCadenceDays?: number;
  remindersDisabled?: boolean;
  instanceCount: number;
  openCount: number;
};

export async function listRequirements(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<RequirementRow[]> {
  requireOrganizer(caller);
  const [requirements, instances] = await Promise.all([
    ctx.db
      .query("requirements")
      .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
      .take(REQUIREMENT_SCAN),
    ctx.db
      .query("taskInstances")
      .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
      .take(INSTANCE_SCAN),
  ]);
  const counts = new Map<Id<"requirements">, { all: number; open: number }>();
  for (const instance of instances) {
    const bucket = counts.get(instance.requirementId) ?? { all: 0, open: 0 };
    bucket.all += 1;
    if (isOpen(instance)) bucket.open += 1;
    counts.set(instance.requirementId, bucket);
  }
  return requirements.map((r) => ({
    requirementId: r._id,
    title: r.title,
    description: r.description,
    scope: r.scope,
    evidence: r.evidence,
    fieldKey: r.fieldKey,
    reviewRequired: r.reviewRequired,
    dueAt: r.dueAt,
    active: r.active,
    reminderCadenceDays: r.reminderCadenceDays,
    remindersDisabled: r.remindersDisabled,
    instanceCount: counts.get(r._id)?.all ?? 0,
    openCount: counts.get(r._id)?.open ?? 0,
  }));
}

export type InstanceRow = {
  instanceId: Id<"taskInstances">;
  requirementId: Id<"requirements">;
  requirementTitle: string;
  scope: Scope;
  evidence: Evidence;
  reviewRequired: boolean;
  sessionId: Id<"sessions">;
  sessionTitle: string;
  participantId?: Id<"sessionParticipants">;
  eventContactId?: Id<"eventContacts">;
  speakerName?: string;
  participantState?: Doc<"sessionParticipants">["state"];
  status: TaskStatus;
  dueAt: number;
  naReason?: string;
  reviewNote?: string;
  uploadCount: number;
  completedBy?: Id<"users">;
  completedAt?: number;
};

/** The organizer's "who owes what" table. Organizer-only: task evidence is
 * operational data reviewers must not see. */
export async function listInstances(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<InstanceRow[]> {
  requireOrganizer(caller);
  const eventId = caller.event._id;
  const [requirements, instances, sessions, participants, contacts] =
    await Promise.all([
      ctx.db
        .query("requirements")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .take(REQUIREMENT_SCAN),
      ctx.db
        .query("taskInstances")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .take(INSTANCE_SCAN),
      ctx.db
        .query("sessions")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .take(SESSION_SCAN),
      ctx.db
        .query("sessionParticipants")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .take(PARTICIPANT_SCAN),
      ctx.db
        .query("eventContacts")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .take(CONTACT_SCAN),
    ]);
  const requirementById = new Map(requirements.map((r) => [r._id, r]));
  const sessionById = new Map(sessions.map((s) => [s._id, s]));
  const participantById = new Map(participants.map((p) => [p._id, p]));
  const contactById = new Map(contacts.map((c) => [c._id, c]));

  // Upload counts are only meaningful for file evidence, and `uploads` has no
  // event-wide index — so this indexed read happens once per file task rather
  // than once per instance or once over the whole table.
  const uploadCounts = new Map<Id<"taskInstances">, number>();
  for (const instance of instances) {
    if (requirementById.get(instance.requirementId)?.evidence !== "file") {
      continue;
    }
    const uploads = await ctx.db
      .query("uploads")
      .withIndex("by_taskInstanceId", (q) =>
        q.eq("taskInstanceId", instance._id),
      )
      .take(UPLOAD_SCAN);
    uploadCounts.set(instance._id, uploads.length);
  }

  const rows: InstanceRow[] = [];
  for (const instance of instances) {
    const requirement = requirementById.get(instance.requirementId);
    if (requirement === undefined) continue;
    const contact =
      instance.eventContactId === undefined
        ? undefined
        : contactById.get(instance.eventContactId);
    const participant =
      instance.participantId === undefined
        ? undefined
        : participantById.get(instance.participantId);
    rows.push({
      instanceId: instance._id,
      requirementId: requirement._id,
      requirementTitle: requirement.title,
      scope: requirement.scope,
      evidence: requirement.evidence,
      reviewRequired: requirement.reviewRequired,
      sessionId: instance.sessionId,
      sessionTitle: sessionById.get(instance.sessionId)?.title ?? "",
      participantId: instance.participantId,
      eventContactId: instance.eventContactId,
      speakerName:
        contact === undefined
          ? undefined
          : `${contact.firstName} ${contact.lastName}`.trim(),
      participantState: participant?.state,
      status: instance.status,
      dueAt: instance.dueAt,
      naReason: instance.naReason,
      reviewNote: instance.reviewNote,
      uploadCount: uploadCounts.get(instance._id) ?? 0,
      completedBy: instance.completedBy,
      completedAt: instance.completedAt,
    });
  }
  return rows;
}

// ── File comments (W5: CNT-05) ───────────────────────────────────────────

const MAX_COMMENT = 2000;
const COMMENT_SCAN = 200;

export type TaskCommentRow = {
  commentId: Id<"uploadComments">;
  authorName: string | null;
  authorEmail: string | null;
  body: string;
  createdAt: number;
  mine: boolean;
};

/** Comment on a task's uploaded evidence. Same access rule as the uploads
 * themselves: organizers and the task's own speaker/manager. */
export async function addTaskComment(
  ctx: MutationCtx,
  actor: Doc<"users">,
  event: Doc<"events">,
  instanceId: Id<"taskInstances">,
  body: string,
): Promise<void> {
  const { instance } = await requireTaskAccess(ctx, actor, event, instanceId);
  assertEventActive(event);
  const text = assertText(body, { label: "Comment", max: MAX_COMMENT });
  await ctx.db.insert("uploadComments", {
    eventId: event._id,
    instanceId: instance._id,
    authorUserId: actor._id,
    body: text,
    createdAt: Date.now(),
  });
  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: actor._id,
    action: "task.comment",
    targetType: "taskInstance",
    targetId: instance._id,
    meta: {},
  });
}

export async function listTaskComments(
  ctx: QueryCtx,
  actor: Doc<"users">,
  event: Doc<"events">,
  instanceId: Id<"taskInstances">,
): Promise<TaskCommentRow[]> {
  const { instance } = await requireTaskAccess(ctx, actor, event, instanceId);
  const taskContact =
    instance.eventContactId === undefined
      ? null
      : await ctx.db.get("eventContacts", instance.eventContactId);
  const participants = await ctx.db
    .query("sessionParticipants")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", instance.sessionId))
    .take(MAX_PARTICIPANTS_PER_SESSION);
  const managerUserIds = new Set(
    participants.flatMap((participant) =>
      participant.managerUserId === undefined
        ? []
        : [participant.managerUserId],
    ),
  );
  const rows = await ctx.db
    .query("uploadComments")
    .withIndex("by_instanceId", (q) => q.eq("instanceId", instance._id))
    .take(COMMENT_SCAN);
  const out: TaskCommentRow[] = [];
  const authors = new Map<
    Id<"users">,
    {
      personName: string | null;
      organizer: boolean;
      speaker: boolean;
      manager: boolean;
    }
  >();
  for (const row of rows.sort((a, b) => a.createdAt - b.createdAt)) {
    let authorDetails = authors.get(row.authorUserId);
    if (authorDetails === undefined) {
      const author = await ctx.db.get("users", row.authorUserId);
      authorDetails = {
        personName: await eventUserDisplayName(
          ctx,
          event._id,
          author,
          instance.eventContactId,
        ),
        organizer:
          author !== null && (await isEventOrganizer(ctx, author, event)),
        speaker:
          author !== null &&
          taskContact !== null &&
          taskContact.eventId === event._id &&
          taskContact.userId === author._id,
        manager: author !== null && managerUserIds.has(author._id),
      };
      authors.set(row.authorUserId, authorDetails);
    }
    out.push({
      commentId: row._id,
      authorName:
        authorDetails.personName ??
        (authorDetails.organizer
          ? "Organizer"
          : authorDetails.speaker
            ? "Speaker"
            : authorDetails.manager
              ? "Session manager"
              : "Someone"),
      // The shared thread identifies people by a human name or scoped role.
      // Login/delivery email is not part of either audience's comment surface.
      authorEmail: null,
      body: row.body,
      createdAt: row.createdAt,
      mine: row.authorUserId === actor._id,
    });
  }
  return out;
}

// ── Files library & bulk export (W5: CNT-13/CNT-14) ──────────────────────

export type LibraryFileRow = {
  fileId: string;
  kind: "task" | "headshot";
  instanceId: Id<"taskInstances"> | null;
  requirementTitle: string;
  sessionId: Id<"sessions"> | null;
  sessionTitle: string;
  speakerName: string | null;
  /** Original browser basename retained as provenance; null for task uploads
   * (whose stored/download filename is already the original) and legacy
   * headshots created before provenance capture. */
  sourceFilename: string | null;
  /** MIME-correct filename used for view/download and bundle export. */
  filename: string;
  version: number | null;
  versionCount: number | null;
  uploadedByName: string | null;
  /** Why `uploadedByName` is null, in the words the surface should show.
   * Null whenever a name resolved. One producer: never re-worded in TSX. */
  uploadedByNote: string | null;
  uploadedAt: number | null;
  url: string | null;
  commentCount: number;
};

/** Original files-library contract kept for clients deployed before headshots
 * became first-class rows. It is intentionally task-only and contains no
 * nullable task/session/version fields. */
export type LegacyLibraryFileRow = {
  instanceId: Id<"taskInstances">;
  requirementTitle: string;
  sessionId: Id<"sessions">;
  sessionTitle: string;
  speakerName: string | null;
  filename: string;
  version: number;
  versionCount: number;
  uploadedAt: number;
  url: string | null;
  commentCount: number;
};

export function legacyLibraryFileRows(
  rows: ReadonlyArray<LibraryFileRow>,
): LegacyLibraryFileRow[] {
  return rows.flatMap((row) => {
    if (
      row.kind !== "task" ||
      row.instanceId === null ||
      row.sessionId === null ||
      row.version === null ||
      row.versionCount === null ||
      row.uploadedAt === null
    ) {
      return [];
    }
    return [
      {
        instanceId: row.instanceId,
        requirementTitle: row.requirementTitle,
        sessionId: row.sessionId,
        sessionTitle: row.sessionTitle,
        speakerName: row.speakerName,
        filename: row.filename,
        version: row.version,
        versionCount: row.versionCount,
        uploadedAt: row.uploadedAt,
        url: row.url,
        commentCount: row.commentCount,
      },
    ];
  });
}

function headshotDownloadFilename(
  originalFilename: string | undefined,
): string {
  if (originalFilename === undefined) return "headshot.webp";
  const dot = originalFilename.lastIndexOf(".");
  const rawStem = dot <= 0 ? originalFilename : originalFilename.slice(0, dot);
  const stem = rawStem.trim().replace(/[. ]+$/g, "");
  return `${stem.length === 0 ? "headshot" : stem}.webp`;
}

function genericHeadshotDownloadFilename(
  contentType: string | null | undefined,
): string | null {
  switch (contentType?.split(";", 1)[0]?.trim().toLowerCase()) {
    case "image/webp":
      return "headshot.webp";
    case "image/png":
      return "headshot.png";
    case "image/jpeg":
    case "image/jpg":
      return "headshot.jpg";
    default:
      return null;
  }
}

const FILE_LIBRARY_IO_BATCH = 100;
const fileLibraryEncoder = new TextEncoder();

function encodedDocumentBytes(value: unknown): number {
  return fileLibraryEncoder.encode(JSON.stringify(value)).length;
}

export function completeHeadshotContactPage(page: {
  page: unknown[];
  isDone: boolean;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
}): boolean {
  return (
    page.isDone &&
    page.pageStatus !== "SplitRequired" &&
    page.page.length <= FILE_LIBRARY_HEADSHOT_CONTACT_LIMIT &&
    encodedDocumentBytes(page.page) <= FILE_LIBRARY_HEADSHOT_CONTACT_BYTES
  );
}

async function mapInBatches<Input, Output>(
  rows: ReadonlyArray<Input>,
  operation: (row: Input) => Promise<Output>,
): Promise<Output[]> {
  const out: Output[] = [];
  for (let offset = 0; offset < rows.length; offset += FILE_LIBRARY_IO_BATCH) {
    out.push(
      ...(await Promise.all(
        rows.slice(offset, offset + FILE_LIBRARY_IO_BATCH).map(operation),
      )),
    );
  }
  return out;
}

/** Every current uploaded deliverable on the event — latest version per task
 * plus every current headshot referenced by an event-contact snapshot.
 *
 * The contact is the source of truth for whether a headshot is current. A
 * same-event, currently-attached secure-upload ticket may enrich that row with
 * provenance, but a copied directory/other-event/legacy blob still remains a
 * downloadable current file. In that fallback case we deliberately expose no
 * source actor, filename, timestamp, or history from another context. */
export async function filesLibrary(
  ctx: QueryCtx,
  caller: EventCaller,
  options?: { includeHeadshots?: boolean },
): Promise<LibraryFileRow[]> {
  requireOrganizer(caller);
  const includeHeadshots = options?.includeHeadshots ?? true;
  const [uploads, headshotContactPage, headshotUploads, comments] =
    await Promise.all([
      ctx.db
        .query("uploads")
        .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
        .take(FILE_LIBRARY_SCAN + 1),
      includeHeadshots
        ? ctx.db
            .query("eventContacts")
            .withIndex("by_eventId_and_headshotId", (q) =>
              q.eq("eventId", caller.event._id).gt("headshotId", undefined),
            )
            // Convex permits one paginated range per function. Spend it on
            // the only source whose legacy rows may contain hundreds of KiB
            // of custom profile values. A byte split is an explicit refusal,
            // never a partial files view.
            .paginate({
              cursor: null,
              numItems: FILE_LIBRARY_HEADSHOT_CONTACT_LIMIT + 1,
              maximumRowsRead: FILE_LIBRARY_HEADSHOT_CONTACT_LIMIT + 1,
              maximumBytesRead: FILE_LIBRARY_HEADSHOT_CONTACT_BYTES,
            })
        : Promise.resolve({
            page: [] as Array<Doc<"eventContacts">>,
            isDone: true,
            pageStatus: null,
          }),
      includeHeadshots
        ? ctx.db
            .query("headshotUploads")
            .withIndex("by_eventId_and_attachedAt", (q) =>
              q.eq("eventId", caller.event._id).gt("attachedAt", undefined),
            )
            .take(FILE_LIBRARY_SCAN + 1)
        : Promise.resolve([] as Array<Doc<"headshotUploads">>),
      ctx.db
        .query("uploadComments")
        .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
        .take(FILE_LIBRARY_SCAN + 1),
    ]);
  const headshotContacts = headshotContactPage.page;
  if (uploads.length > FILE_LIBRARY_SCAN) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event has more than 300 uploaded file versions. The files library refuses a partial version history.",
    });
  }
  if (!completeHeadshotContactPage(headshotContactPage)) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event has more than 64 current headshots or its headshot profiles exceed the 2 MiB safe read budget. The files library refuses a partial view.",
    });
  }
  if (headshotUploads.length > FILE_LIBRARY_SCAN) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event has more than 300 attached headshot versions. The files library cannot report complete same-event history safely.",
    });
  }
  if (comments.length > FILE_LIBRARY_SCAN) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event has more than 300 file comments. The files library cannot report complete counts safely.",
    });
  }

  const byInstance = new Map<Id<"taskInstances">, Array<Doc<"uploads">>>();
  for (const upload of uploads) {
    const list = byInstance.get(upload.taskInstanceId) ?? [];
    list.push(upload);
    byInstance.set(upload.taskInstanceId, list);
  }
  const commentCount = new Map<Id<"taskInstances">, number>();
  for (const comment of comments) {
    commentCount.set(
      comment.instanceId,
      (commentCount.get(comment.instanceId) ?? 0) + 1,
    );
  }

  if (byInstance.size + headshotContacts.length > FILE_LIBRARY_CURRENT_LIMIT) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event has more than 120 current files. Select a smaller event before opening Files or building a bundle.",
    });
  }

  // Hydrate only relationships referenced by current file rows. The three
  // `.take` sources above have compact, write-bounded strings. Contacts are
  // different: legacy custom values can make one row approach the database's
  // document limit. Their indexed range has its own byte ceiling, and every
  // targeted get below is sequential and charged to this shared budget. At
  // most one max-size document can cross the soft ceiling before we refuse,
  // leaving ample room below Convex's 16 MiB transaction read limit.
  let hydrationBytes = encodedDocumentBytes(headshotContacts);
  function trackHydratedDocument<T>(document: T): T {
    if (document !== null && document !== undefined) {
      hydrationBytes += encodedDocumentBytes(document);
      if (hydrationBytes > FILE_LIBRARY_HYDRATION_BYTES) {
        throw new ConvexError({
          code: "files_export_too_large",
          message:
            "This event's file relationships exceed the 6 MiB safe read budget. The files library refuses a partial view.",
        });
      }
    }
    return document;
  }

  const instanceDocs: Array<Doc<"taskInstances"> | null> = [];
  for (const instanceId of byInstance.keys()) {
    instanceDocs.push(
      trackHydratedDocument(await ctx.db.get("taskInstances", instanceId)),
    );
  }
  const instanceById = new Map<Id<"taskInstances">, Doc<"taskInstances">>();
  for (const instance of instanceDocs) {
    if (instance !== null && instance.eventId === caller.event._id) {
      instanceById.set(instance._id, instance);
    }
  }

  const taskCandidates = [...byInstance].flatMap(([instanceId, list]) => {
    const instance = instanceById.get(instanceId);
    if (instance === undefined) return [];
    const latest = list.reduce((a, b) => (a.version >= b.version ? a : b));
    return [{ instance, latest, versionCount: list.length }];
  });
  const requirementIds = new Set(
    taskCandidates.map(({ instance }) => instance.requirementId),
  );
  const sessionIds = new Set(
    taskCandidates.map(({ instance }) => instance.sessionId),
  );
  const taskContactIds = new Set(
    taskCandidates.flatMap(({ instance }) =>
      instance.eventContactId === undefined ? [] : [instance.eventContactId],
    ),
  );
  if (sessionIds.size > FILE_LIBRARY_SESSION_LIMIT) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event's current files span more than 64 sessions. The files library refuses a partial view.",
    });
  }
  const headshotContactIds = new Set(
    headshotContacts.map((contact) => contact._id),
  );
  const additionalTaskContactIds = [...taskContactIds].filter(
    (eventContactId) => !headshotContactIds.has(eventContactId),
  );
  if (additionalTaskContactIds.length > FILE_LIBRARY_TASK_CONTACT_LIMIT) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event's task files span more than 16 additional speaker profiles. The files library refuses a partial view.",
    });
  }

  const contactById = new Map<Id<"eventContacts">, Doc<"eventContacts">>(
    headshotContacts.map((contact) => [contact._id, contact]),
  );
  for (const eventContactId of additionalTaskContactIds) {
    const contact = trackHydratedDocument(
      await ctx.db.get("eventContacts", eventContactId),
    );
    if (contact !== null && contact.eventId === caller.event._id) {
      contactById.set(contact._id, contact);
    }
  }
  const requirementById = new Map<Id<"requirements">, Doc<"requirements">>();
  for (const requirementId of requirementIds) {
    const requirement = trackHydratedDocument(
      await ctx.db.get("requirements", requirementId),
    );
    if (requirement !== null && requirement.eventId === caller.event._id) {
      requirementById.set(requirement._id, requirement);
    }
  }
  const sessionById = new Map<Id<"sessions">, Doc<"sessions">>();
  for (const sessionId of sessionIds) {
    const session = trackHydratedDocument(
      await ctx.db.get("sessions", sessionId),
    );
    if (session !== null && session.eventId === caller.event._id) {
      sessionById.set(session._id, session);
    }
  }

  const headshotVersions = new Map<
    Id<"eventContacts">,
    Array<Doc<"headshotUploads">>
  >();
  for (const upload of headshotUploads) {
    const versions = headshotVersions.get(upload.eventContactId) ?? [];
    versions.push(upload);
    headshotVersions.set(upload.eventContactId, versions);
  }
  for (const versions of headshotVersions.values()) {
    versions.sort(
      (a, b) =>
        (a.attachedAt ?? 0) - (b.attachedAt ?? 0) ||
        a._creationTime - b._creationTime,
    );
  }
  const headshotCandidates = headshotContacts.flatMap((contact) => {
    const storageId = contact.headshotId;
    if (storageId === undefined) return [];
    const versions = headshotVersions.get(contact._id) ?? [];
    // Replaced/retained/corrupt duplicate tickets must not be presented as
    // the current upload's provenance. Ambiguity falls back to an honest
    // generic row instead of choosing a potentially unrelated actor.
    const matches = versions.filter(
      (upload) =>
        upload.status === "attached" && upload.storageId === storageId,
    );
    const provenance = matches.length === 1 ? matches[0] : undefined;
    const version =
      provenance === undefined
        ? null
        : versions.findIndex((row) => row._id === provenance._id) + 1;
    return [{ contact, storageId, versions, provenance, version }];
  });

  // Only non-exact actors require user-row hydration. Reads are deduplicated,
  // sequential, and charged to the same byte budget as other relationships.
  const uploaderUserIds = new Set<Id<"users">>();
  const addUploaderIfNeeded = (
    userId: Id<"users">,
    eventContactId: Id<"eventContacts"> | undefined,
  ) => {
    if (
      eventContactId === undefined ||
      contactById.get(eventContactId)?.userId !== userId
    ) {
      uploaderUserIds.add(userId);
    }
  };
  for (const candidate of taskCandidates) {
    addUploaderIfNeeded(
      candidate.latest.uploadedBy,
      candidate.instance.eventContactId,
    );
  }
  for (const candidate of headshotCandidates) {
    if (candidate.provenance !== undefined) {
      addUploaderIfNeeded(
        candidate.provenance.uploadedByUserId,
        candidate.contact._id,
      );
    }
  }
  // W5: a file whose uploader IS recorded must name that person. The generic
  // "Event contributor" placeholder this used to emit was the worst of both
  // worlds — it read like a resolved actor while naming nobody, and it fired
  // whenever the account's own profile carried no name even though the event
  // knew exactly who they were. Resolve through the SAME chain every other
  // attribution surface uses (`eventUserDisplayName`: exact contact snapshot →
  // auth profile → the event's own unambiguous snapshot), and when that chain
  // genuinely resolves nothing, say so instead of inventing a label.
  const stableUploaders = new Map<Id<"users">, DisplayNameResolution>();
  for (const userId of uploaderUserIds) {
    const user = trackHydratedDocument(await ctx.db.get("users", userId));
    stableUploaders.set(
      userId,
      await resolveEventUserDisplayName(ctx, caller.event._id, user),
    );
  }
  const uploaderResolution = (
    userId: Id<"users">,
    eventContactId: Id<"eventContacts"> | undefined,
  ): DisplayNameResolution => {
    const exact =
      eventContactId === undefined
        ? undefined
        : contactById.get(eventContactId);
    if (exact?.userId === userId) {
      const exactName = `${exact.firstName} ${exact.lastName}`
        .trim()
        .replace(/\s+/g, " ");
      if (exactName !== "") return { name: exactName, reason: "resolved" };
    }
    return (
      stableUploaders.get(userId) ?? { name: null, reason: "no_user" as const }
    );
  };
  /**
   * Honest copy for each distinct way a name can be missing — produced here so
   * no route has to guess which kind of blank it is looking at, and so the
   * three are never collapsed into one flattering sentence:
   *   • no provenance row at all — nobody was ever recorded;
   *   • the account exists and has set no display name;
   *   • the account record is gone, or the event holds conflicting names for
   *     it, so this upload cannot be attributed to a person at all.
   */
  const uploaderNote = (
    resolution: DisplayNameResolution | null,
  ): string | null => {
    if (resolution === null) {
      return "The uploader was not recorded for this file.";
    }
    switch (resolution.reason) {
      case "resolved":
        return null;
      case "unnamed_account":
        return "Uploaded by an account that has not set a display name.";
      case "no_user":
      case "ambiguous":
        return "Not attributable: the uploading account's record is missing, or this event holds more than one name for it.";
    }
  };

  // A provenance-less headshot may predate normalization or may be copied
  // from another event. Read only target storage metadata: never source-event
  // tickets. Unsupported/unknown bytes remain listed but receive no URL or
  // misleading extension.
  const genericStorageIds = new Set<Id<"_storage">>();
  for (const candidate of headshotCandidates) {
    if (candidate.provenance === undefined) {
      genericStorageIds.add(candidate.storageId);
    }
  }
  const metadataEntries = await mapInBatches(
    [...genericStorageIds],
    async (storageId) =>
      [storageId, await ctx.db.system.get(storageId)] as const,
  );
  const metadataByStorageId = new Map(metadataEntries);
  const genericFilenameByStorageId = new Map<Id<"_storage">, string | null>();
  for (const storageId of genericStorageIds) {
    genericFilenameByStorageId.set(
      storageId,
      genericHeadshotDownloadFilename(
        metadataByStorageId.get(storageId)?.contentType,
      ),
    );
  }

  const downloadableStorageIds = new Set<Id<"_storage">>();
  for (const candidate of taskCandidates) {
    downloadableStorageIds.add(candidate.latest.storageId);
  }
  for (const candidate of headshotCandidates) {
    if (
      candidate.provenance !== undefined ||
      genericFilenameByStorageId.get(candidate.storageId) !== null
    ) {
      downloadableStorageIds.add(candidate.storageId);
    }
  }
  const urlEntries = await mapInBatches(
    [...downloadableStorageIds],
    async (storageId) =>
      [storageId, await ctx.storage.getUrl(storageId)] as const,
  );
  const urlByStorageId = new Map(urlEntries);

  const taskRows: LibraryFileRow[] = taskCandidates.map(
    ({ instance, latest, versionCount }) => {
      const requirement = requirementById.get(instance.requirementId);
      const session = sessionById.get(instance.sessionId);
      const contact =
        instance.eventContactId === undefined
          ? null
          : (contactById.get(instance.eventContactId) ?? null);
      const taskUploader = uploaderResolution(
        latest.uploadedBy,
        instance.eventContactId,
      );
      return {
        fileId: `task:${instance._id}`,
        kind: "task",
        instanceId: instance._id,
        requirementTitle: requirement?.title ?? "(deleted requirement)",
        sessionId: instance.sessionId,
        sessionTitle: session?.title ?? "(deleted session)",
        speakerName:
          contact === null
            ? null
            : `${contact.firstName} ${contact.lastName}`.trim(),
        sourceFilename: null,
        filename: latest.filename,
        version: latest.version,
        versionCount,
        uploadedByName: taskUploader.name,
        uploadedByNote: uploaderNote(taskUploader),
        uploadedAt: latest._creationTime,
        url: urlByStorageId.get(latest.storageId) ?? null,
        commentCount: commentCount.get(instance._id) ?? 0,
      };
    },
  );
  const headshotRows: LibraryFileRow[] = headshotCandidates.map(
    ({ contact, storageId, versions, provenance, version }) => {
      const genericFilename = genericFilenameByStorageId.get(storageId) ?? null;
      // No provenance row means nobody was recorded — a different fact from
      // "recorded, but we cannot name them".
      const headshotUploader =
        provenance === undefined
          ? null
          : uploaderResolution(provenance.uploadedByUserId, contact._id);
      return {
        fileId: `headshot:${contact._id}`,
        kind: "headshot",
        instanceId: null,
        requirementTitle: "Speaker headshot",
        sessionId: null,
        sessionTitle: "Speaker profile",
        speakerName: `${contact.firstName} ${contact.lastName}`.trim(),
        sourceFilename: provenance?.originalFilename ?? null,
        filename:
          provenance === undefined
            ? (genericFilename ?? "headshot")
            : headshotDownloadFilename(provenance.originalFilename),
        version: provenance === undefined || version === 0 ? null : version,
        versionCount: provenance === undefined ? null : versions.length,
        uploadedByName: headshotUploader?.name ?? null,
        uploadedByNote: uploaderNote(headshotUploader),
        uploadedAt: provenance?.attachedAt ?? null,
        url:
          provenance === undefined && genericFilename === null
            ? null
            : (urlByStorageId.get(storageId) ?? null),
        commentCount: 0,
      };
    },
  );

  const out = [...taskRows, ...headshotRows];
  return out.sort((a, b) => {
    if (a.uploadedAt === null && b.uploadedAt !== null) return 1;
    if (a.uploadedAt !== null && b.uploadedAt === null) return -1;
    if (a.uploadedAt !== null && b.uploadedAt !== null) {
      const newestFirst = b.uploadedAt - a.uploadedAt;
      if (newestFirst !== 0) return newestFirst;
    }
    return (
      (a.speakerName ?? a.sessionTitle).localeCompare(
        b.speakerName ?? b.sessionTitle,
      ) || a.fileId.localeCompare(b.fileId)
    );
  });
}

export type BundleFile = {
  filename: string;
  url: string | null;
  sessionTitle: string;
  speakerName: string | null;
  requirementTitle: string;
};

/** The latest version of each selected deliverable, for the client-side ZIP
 * (CNT-14). `fileIds` empty means every current file, except the legacy
 * `instanceIds: []` compatibility path, which still means every task upload. */
export async function exportBundle(
  ctx: QueryCtx,
  caller: EventCaller,
  fileIds: string[],
  legacyTaskOnly = false,
): Promise<BundleFile[]> {
  requireOrganizer(caller);
  if (!legacyTaskOnly && fileIds.length > FILE_LIBRARY_CURRENT_LIMIT) {
    throw new ConvexError({
      code: "too_many",
      message: `Select at most ${FILE_LIBRARY_CURRENT_LIMIT} files at a time.`,
    });
  }
  const all = await filesLibrary(ctx, caller, {
    includeHeadshots: !legacyTaskOnly,
  });
  const eligible = legacyTaskOnly
    ? all.filter((row) => row.kind === "task")
    : all;
  const selected = new Set(fileIds);
  const wanted =
    selected.size === 0
      ? eligible
      : eligible.filter((row) => selected.has(row.fileId));
  return wanted.map((row) => ({
    filename: row.filename,
    url: row.url,
    sessionTitle: row.sessionTitle,
    speakerName: row.speakerName,
    requirementTitle: row.requirementTitle,
  }));
}
