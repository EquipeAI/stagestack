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
//  • One consolidated message per recipient per event — never one per task.
//  • Cadence = per-requirement override ?? event default; `remindersDisabled`
//    on a requirement silences it entirely.
//  • Overdue raises dashboard urgency, NOT email frequency: nothing here reads
//    `dueAt` to shorten a cadence.
//  • Reminders stop on completion, withdrawal and session cancellation, which
//    falls out of the status/state filters below.
//
// Idempotence inside a cadence window comes from `lastRemindedAt`: a second
// sweep an hour later finds nothing eligible and sends zero emails.
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

type Bucket = {
  recipient: AudienceRecipient;
  instanceIds: Array<Id<"taskInstances">>;
  participantIds: Array<Id<"sessionParticipants">>;
  lines: string[];
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
    instanceIds: [],
    participantIds: [],
    lines: [],
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

// ── (a) Task reminders ───────────────────────────────────────────────────

async function sweepTasks(
  ctx: MutationCtx,
  event: Doc<"events">,
  graph: EventGraph,
  now: number,
): Promise<number> {
  const eventCadence = event.reminderCadenceDays;
  if (eventCadence === undefined) return 0;

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
  for (const instance of instances) {
    if (!isActionable(instance.status)) continue;
    const requirement = requirementById.get(instance.requirementId);
    if (requirement === undefined) continue;
    if (!requirement.active) continue;
    if (requirement.remindersDisabled === true) continue;

    const cadenceDays = requirement.reminderCadenceDays ?? eventCadence;
    if (cadenceDays <= 0) continue;
    const since = now - (instance.lastRemindedAt ?? 0);
    if (since < cadenceDays * DAY_MS) continue;

    const session = graph.sessionById.get(instance.sessionId);
    if (session === undefined || session.status !== "planned") continue;

    // Participant-scope work: chase only a CONFIRMED speaker. An unconfirmed
    // one is getting the participation reminder below instead — task chasing
    // before confirmation is explicitly forbidden (MILESTONES M4).
    let participant: Doc<"sessionParticipants"> | undefined;
    if (instance.participantId !== undefined) {
      participant = graph.participantById.get(instance.participantId);
      if (participant === undefined || participant.state !== "confirmed") {
        continue;
      }
    } else {
      // Session-scope work has one accountable assignee (the primary manager)
      // rather than a participant of its own. It becomes chaseable once the
      // session actually has a confirmed speaker.
      participant = graph.participants.find(
        (p) => p.sessionId === instance.sessionId && p.state === "confirmed",
      );
      if (participant === undefined) continue;
    }

    const recipient = routeFor(graph, participant, "task");
    if (recipient === null) continue;
    const bucket = bucketFor(buckets, recipient);
    if (bucket === null) continue;
    bucket.instanceIds.push(instance._id);
    bucket.lines.push(
      `<strong>${escapeHtml(requirement.title)}</strong> — ${escapeHtml(
        session.title,
      )} (due ${escapeHtml(due(instance.dueAt))})`,
    );
  }

  let sent = 0;
  for (const bucket of buckets.values()) {
    const { subject, html } = await renderTemplate(
      ctx,
      event,
      "reminder.tasks",
      {
        event: { name: event.name },
        speaker: {
          firstName: bucket.recipient.firstName,
          lastName: bucket.recipient.lastName,
        },
        link: `${siteUrl()}/portal/${event.slug}`,
        tasks: list(bucket.lines),
      },
    );
    await sendLoggedEmail(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      toEmail: bucket.recipient.email,
      kind: "reminder.tasks",
      subject,
      html,
      // No sentByUserId: this is a system send, not an organizer's action.
      replyTo: event.replyTo,
      context: { instanceIds: bucket.instanceIds },
    });
    for (const instanceId of bucket.instanceIds) {
      await ctx.db.patch("taskInstances", instanceId, {
        lastRemindedAt: now,
      });
    }
    sent += 1;
  }
  return sent;
}

// ── (b) Participation reminders ──────────────────────────────────────────

async function sweepParticipation(
  ctx: MutationCtx,
  event: Doc<"events">,
  graph: EventGraph,
  now: number,
): Promise<number> {
  const cadenceDays = event.reminderCadenceDays;
  if (cadenceDays === undefined || cadenceDays <= 0) return 0;

  const buckets = new Map<string, Bucket>();
  for (const participant of graph.participants) {
    if (participant.state !== "awaiting") continue;
    const session = graph.sessionById.get(participant.sessionId);
    if (session === undefined || session.status !== "planned") continue;
    const since = now - (participant.lastRemindedAt ?? 0);
    if (since < cadenceDays * DAY_MS) continue;

    const recipient = routeFor(graph, participant, "personal");
    if (recipient === null) continue;
    const bucket = bucketFor(buckets, recipient);
    if (bucket === null) continue;
    bucket.participantIds.push(participant._id);
    bucket.lines.push(`<strong>${escapeHtml(session.title)}</strong>`);
  }

  let sent = 0;
  for (const bucket of buckets.values()) {
    const { subject, html } = await renderTemplate(
      ctx,
      event,
      "reminder.participation",
      {
        event: { name: event.name },
        speaker: {
          firstName: bucket.recipient.firstName,
          lastName: bucket.recipient.lastName,
        },
        link: `${siteUrl()}/portal/${event.slug}`,
        body: list(bucket.lines),
      },
    );
    await sendLoggedEmail(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      toEmail: bucket.recipient.email,
      kind: "reminder.participation",
      subject,
      html,
      replyTo: event.replyTo,
      context: { participantIds: bucket.participantIds },
    });
    for (const participantId of bucket.participantIds) {
      await ctx.db.patch("sessionParticipants", participantId, {
        lastRemindedAt: now,
      });
    }
    sent += 1;
  }
  return sent;
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
      taskEmails += await sweepTasks(ctx, event, graph, now);
      participationEmails += await sweepParticipation(ctx, event, graph, now);
    }
    return { events: swept, taskEmails, participationEmails };
  },
});
