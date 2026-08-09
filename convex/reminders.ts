import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { escapeHtml, sendLoggedEmail, siteUrl } from "./model/comms";
import { renderTemplate } from "./model/templates";
import { routeParticipant, type AudienceRecipient } from "./model/audiences";

// ─────────────────────────────────────────────────────────────────────────
// Scheduled reminders (M5). One hourly sweep, driven by crons.ts.
//
// The rules this file exists to enforce (MILESTONES M4/M5):
//  • Unconfirmed speakers get PARTICIPATION reminders, never task chasing.
//  • ONE consolidated message per recipient per event per sweep — never one per
//    task, and never a separate task email AND participation email to the same
//    recipient in a single run (MILESTONES M5:86).
//  • Routine task chasing routes to the primary manager whenever one exists;
//    claiming a portal never reroutes it (M4:87).
//  • Cadence = per-requirement override ?? event default; `remindersDisabled`
//    on a requirement silences it entirely.
//  • Overdue raises dashboard urgency, NOT email frequency: nothing here reads
//    `dueAt` to shorten a cadence.
//  • Reminders stop on completion, withdrawal and session cancellation, which
//    falls out of the status/state filters below.
//
// Idempotence inside a cadence window comes from `lastRemindedAt`, which is
// stamped at CREATION (so the first reminder waits a full cadence) and again on
// every included item after a send: a second sweep an hour later finds nothing
// eligible and sends zero emails.
// ─────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

// v1 bounds. An hourly full scan of `events` is fine at this size and keeps the
// sweep a single transaction; the moment this deployment has more than a few
// hundred events it wants an index on "has a cadence" instead.
const EVENT_SCAN = 500;
const REQUIREMENT_SCAN = 200;
const INSTANCE_SCAN = 4000;
const PARTICIPANT_SCAN = 5000;
const CONTACT_SCAN = 2000;
const SESSION_SCAN = 1000;
/** Never fan one sweep of one event out past this many addresses. */
const MAX_RECIPIENTS_PER_EVENT = 200;

/** Statuses that still need action from a speaker/manager. */
function isActionable(status: Doc<"taskInstances">["status"]): boolean {
  return status === "pending" || status === "changesRequested";
}

function due(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * One recipient's consolidated digest for this event: an optional task section
 * and an optional participation section. Both are stamped after the single
 * send, so a manager who owes a chased task AND is the fallback for an awaiting
 * speaker gets exactly one email — never two.
 */
type Bucket = {
  recipient: AudienceRecipient;
  taskInstanceIds: Array<Id<"taskInstances">>;
  taskLines: string[];
  participantIds: Array<Id<"sessionParticipants">>;
  participationLines: string[];
};

function bucketFor(
  buckets: Map<string, Bucket>,
  recipient: AudienceRecipient,
): Bucket | null {
  const existing = buckets.get(recipient.email);
  if (existing !== undefined) return existing;
  if (buckets.size >= MAX_RECIPIENTS_PER_EVENT) return null;
  const created: Bucket = {
    recipient,
    taskInstanceIds: [],
    taskLines: [],
    participantIds: [],
    participationLines: [],
  };
  buckets.set(recipient.email, created);
  return created;
}

function list(lines: string[]): string {
  return ["<ul>", ...lines.map((line) => `<li>${line}</li>`), "</ul>"].join(
    "\n",
  );
}

type EventGraph = {
  participants: Array<Doc<"sessionParticipants">>;
  participantById: Map<Id<"sessionParticipants">, Doc<"sessionParticipants">>;
  contactById: Map<Id<"eventContacts">, Doc<"eventContacts">>;
  sessionById: Map<Id<"sessions">, Doc<"sessions">>;
  managers: Map<Id<"users">, Doc<"users"> | null>;
};

async function loadGraph(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<EventGraph> {
  const [participants, contacts, sessions] = await Promise.all([
    ctx.db
      .query("sessionParticipants")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .take(PARTICIPANT_SCAN),
    ctx.db
      .query("eventContacts")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .take(CONTACT_SCAN),
    ctx.db
      .query("sessions")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .take(SESSION_SCAN),
  ]);
  const managerIds = [
    ...new Set(
      participants
        .map((p) => p.managerUserId)
        .filter((id): id is Id<"users"> => id !== undefined),
    ),
  ];
  const managerDocs = await Promise.all(
    managerIds.map((id) => ctx.db.get("users", id)),
  );
  return {
    participants,
    participantById: new Map(participants.map((p) => [p._id, p])),
    contactById: new Map(contacts.map((c) => [c._id, c])),
    sessionById: new Map(sessions.map((s) => [s._id, s])),
    managers: new Map(managerIds.map((id, i) => [id, managerDocs[i]])),
  };
}

function routeFor(
  graph: EventGraph,
  participant: Doc<"sessionParticipants">,
  mode: "task" | "personal",
): AudienceRecipient | null {
  return routeParticipant({
    contact: graph.contactById.get(participant.eventContactId),
    managerUser:
      participant.managerUserId === undefined
        ? undefined
        : graph.managers.get(participant.managerUserId),
    mode,
  });
}

/** The represented speaker's name, for the digest LINE — a manager-routed
 * digest must name each speaker so it is unambiguous (fix 4). */
function speakerLabel(
  graph: EventGraph,
  participant: Doc<"sessionParticipants">,
): string {
  const contact = graph.contactById.get(participant.eventContactId);
  if (contact === undefined) return "";
  return `${contact.firstName} ${contact.lastName}`.trim();
}

/**
 * Resolve the participant that a task instance is chased through.
 *
 * Participant-scope work names its participant directly; a session-scope task
 * carries an eventContactId assignee instead (M4: one accountable assignee).
 * Either way the task is chaseable only once that participant has CONFIRMED —
 * an unconfirmed speaker gets participation chasing, never task chasing.
 */
function taskParticipant(
  graph: EventGraph,
  instance: Doc<"taskInstances">,
): Doc<"sessionParticipants"> | undefined {
  let participant: Doc<"sessionParticipants"> | undefined;
  if (instance.participantId !== undefined) {
    participant = graph.participantById.get(instance.participantId);
  } else if (instance.eventContactId !== undefined) {
    participant = graph.participants.find(
      (p) =>
        p.sessionId === instance.sessionId &&
        p.eventContactId === instance.eventContactId,
    );
  }
  if (participant === undefined || participant.state !== "confirmed") {
    return undefined;
  }
  return participant;
}

// ── The per-event sweep ────────────────────────────────────────────────────

async function sweepEvent(
  ctx: MutationCtx,
  event: Doc<"events">,
  graph: EventGraph,
  now: number,
): Promise<{ taskEmails: number; participationEmails: number }> {
  const eventCadence = event.reminderCadenceDays;
  if (eventCadence === undefined) {
    return { taskEmails: 0, participationEmails: 0 };
  }

  const [requirements, instances] = await Promise.all([
    ctx.db
      .query("requirements")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .take(REQUIREMENT_SCAN),
    ctx.db
      .query("taskInstances")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .take(INSTANCE_SCAN),
  ]);
  const requirementById = new Map(requirements.map((r) => [r._id, r]));

  const buckets = new Map<string, Bucket>();

  // ── (a) Task sections ──
  for (const instance of instances) {
    if (!isActionable(instance.status)) continue;
    const requirement = requirementById.get(instance.requirementId);
    if (requirement === undefined || !requirement.active) continue;
    if (requirement.remindersDisabled === true) continue;

    const cadenceDays = requirement.reminderCadenceDays ?? eventCadence;
    if (cadenceDays <= 0) continue;
    const since = now - (instance.lastRemindedAt ?? 0);
    if (since < cadenceDays * DAY_MS) continue;

    const session = graph.sessionById.get(instance.sessionId);
    if (session === undefined || session.status !== "planned") continue;

    const participant = taskParticipant(graph, instance);
    if (participant === undefined) continue;

    const recipient = routeFor(graph, participant, "task");
    if (recipient === null) continue;
    const bucket = bucketFor(buckets, recipient);
    if (bucket === null) continue;
    bucket.taskInstanceIds.push(instance._id);
    const who = speakerLabel(graph, participant);
    bucket.taskLines.push(
      `<strong>${escapeHtml(requirement.title)}</strong>${
        who ? ` for ${escapeHtml(who)}` : ""
      } — ${escapeHtml(session.title)} (due ${escapeHtml(due(instance.dueAt))})`,
    );
  }

  // ── (b) Participation sections ──
  if (eventCadence > 0) {
    for (const participant of graph.participants) {
      if (participant.state !== "awaiting") continue;
      const session = graph.sessionById.get(participant.sessionId);
      if (session === undefined || session.status !== "planned") continue;
      const since = now - (participant.lastRemindedAt ?? 0);
      if (since < eventCadence * DAY_MS) continue;

      const recipient = routeFor(graph, participant, "personal");
      if (recipient === null) continue;
      const bucket = bucketFor(buckets, recipient);
      if (bucket === null) continue;
      bucket.participantIds.push(participant._id);
      bucket.participationLines.push(
        `<strong>${escapeHtml(session.title)}</strong>`,
      );
    }
  }

  // ── One combined email per recipient, then stamp everything it covered ──
  let taskEmails = 0;
  let participationEmails = 0;
  for (const bucket of buckets.values()) {
    const hasTasks = bucket.taskLines.length > 0;
    const hasParticipation = bucket.participationLines.length > 0;
    if (!hasTasks && !hasParticipation) continue;

    const speaker = {
      firstName: bucket.recipient.firstName,
      lastName: bucket.recipient.lastName,
    };
    const link = `${siteUrl()}/portal/${event.slug}`;

    let subject: string;
    let html: string;
    let kind: string;
    if (hasTasks) {
      // Tasks drive the primary template. When the SAME recipient (a manager
      // acting as an awaiting speaker's fallback) also owes participation, that
      // section is folded in so it stays ONE email (M5:86).
      const tasksHtml = hasParticipation
        ? [
            list(bucket.taskLines),
            "<p>Also awaiting confirmation:</p>",
            list(bucket.participationLines),
          ].join("\n")
        : list(bucket.taskLines);
      const rendered = await renderTemplate(ctx, event, "reminder.tasks", {
        event: { name: event.name },
        speaker,
        link,
        tasks: tasksHtml,
      });
      subject = rendered.subject;
      html = rendered.html;
      kind = "reminder.tasks";
    } else {
      const rendered = await renderTemplate(
        ctx,
        event,
        "reminder.participation",
        {
          event: { name: event.name },
          speaker,
          link,
          body: list(bucket.participationLines),
        },
      );
      subject = rendered.subject;
      html = rendered.html;
      kind = "reminder.participation";
    }

    await sendLoggedEmail(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      toEmail: bucket.recipient.email,
      kind,
      subject,
      html,
      // No sentByUserId: this is a system send, not an organizer's action.
      replyTo: event.replyTo,
      context: {
        instanceIds: bucket.taskInstanceIds,
        participantIds: bucket.participantIds,
      },
    });
    for (const instanceId of bucket.taskInstanceIds) {
      await ctx.db.patch("taskInstances", instanceId, { lastRemindedAt: now });
    }
    for (const participantId of bucket.participantIds) {
      await ctx.db.patch("sessionParticipants", participantId, {
        lastRemindedAt: now,
      });
    }
    if (hasTasks) taskEmails += 1;
    if (hasParticipation) participationEmails += 1;
  }
  return { taskEmails, participationEmails };
}

// ── The sweep ────────────────────────────────────────────────────────────

export const sweep = internalMutation({
  args: {
    /** Injectable clock so tests can walk a cadence window deterministically. */
    now: v.optional(v.number()),
  },
  returns: v.object({
    events: v.number(),
    taskEmails: v.number(),
    participationEmails: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    // v1: full bounded scan. Only events with a cadence configured do any work,
    // and archived events stop automations entirely (MILESTONES M0).
    const events = await ctx.db.query("events").take(EVENT_SCAN);

    let swept = 0;
    let taskEmails = 0;
    let participationEmails = 0;
    for (const event of events) {
      if (event.archivedAt !== undefined) continue;
      if (event.reminderCadenceDays === undefined) continue;
      const graph = await loadGraph(ctx, event);
      swept += 1;
      const result = await sweepEvent(ctx, event, graph, now);
      taskEmails += result.taskEmails;
      participationEmails += result.participationEmails;
    }
    return { events: swept, taskEmails, participationEmails };
  },
});
