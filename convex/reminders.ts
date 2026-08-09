import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { escapeHtml, sendLoggedEmail, siteUrl } from "./model/comms";
import { renderTemplate } from "./model/templates";
import { routeParticipant, type AudienceRecipient } from "./model/audiences";

// ─────────────────────────────────────────────────────────────────────────
// Scheduled reminders (M5). Hourly cron, driven by crons.ts.
//
// Shape (M8): the cron entry (`sweep`) is a cheap dispatcher — it scans the
// bounded event list and schedules ONE independent `sweepEvent` mutation per
// eligible event. Each event sweeps in its own transaction, so one oversized
// event or one failing render aborts only that event, never the whole sweep.
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

/** How long past `endsAt` the sweep keeps chasing. A week covers post-event
 * collection (slides, recordings); after that, silence — an event that never
 * gets archived must not be chased forever. */
export const POST_EVENT_GRACE_DAYS = 7;

// v1 bounds. An hourly full scan of `events` is fine at this size and keeps the
// dispatcher a single cheap transaction; the moment this deployment has more
// than a few hundred events it wants an index on "has a cadence" instead.
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

/** Date-only, in the event's timezone — every outbound date is event time
 * (M6 rule; matches describeSlot in model/agenda.ts). */
function due(ms: number, timezone: string): string {
  try {
    // en-CA renders YYYY-MM-DD, the format these digests always used.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  } catch {
    // A bad IANA zone must degrade the wording, never break a send.
    return new Date(ms).toISOString().slice(0, 10);
  }
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

type EventSweepResult = {
  taskEmails: number;
  participationEmails: number;
  /** Distinct recipients dropped by MAX_RECIPIENTS_PER_EVENT this run —
   * visible in the result instead of silently truncated (M8). They are not
   * stamped, so the next sweep picks them up. */
  deferredRecipients: number;
};

const EMPTY_SWEEP: EventSweepResult = {
  taskEmails: 0,
  participationEmails: 0,
  deferredRecipients: 0,
};

async function runEventSweep(
  ctx: MutationCtx,
  event: Doc<"events">,
  graph: EventGraph,
  now: number,
): Promise<EventSweepResult> {
  const eventCadence = event.reminderCadenceDays;
  if (eventCadence === undefined) {
    return EMPTY_SWEEP;
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
  const deferred = new Set<string>();

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
    if (bucket === null) {
      deferred.add(recipient.email);
      continue;
    }
    bucket.taskInstanceIds.push(instance._id);
    const who = speakerLabel(graph, participant);
    bucket.taskLines.push(
      `<strong>${escapeHtml(requirement.title)}</strong>${
        who ? ` for ${escapeHtml(who)}` : ""
      } — ${escapeHtml(session.title)} (due ${escapeHtml(
        due(instance.dueAt, event.timezone),
      )})`,
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
      if (bucket === null) {
        deferred.add(recipient.email);
        continue;
      }
      bucket.participantIds.push(participant._id);
      bucket.participationLines.push(
        `<strong>${escapeHtml(session.title)}</strong>`,
      );
    }
  }

  // ── One combined email per recipient, then stamp everything it covered ──
  // Counters count EMAILS, not sections: a combined send (tasks template with
  // a folded-in participation section) is one taskEmail, so the two counters
  // always sum to the number of messages actually sent (M8).
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
    else participationEmails += 1;
  }
  if (deferred.size > 0) {
    console.warn(
      `reminders: event ${event._id} deferred ${deferred.size} recipients past MAX_RECIPIENTS_PER_EVENT=${MAX_RECIPIENTS_PER_EVENT}`,
    );
  }
  return { taskEmails, participationEmails, deferredRecipients: deferred.size };
}

// ── The sweep: cheap dispatcher + one independent mutation per event ──────

/** Archived events stop automations entirely (MILESTONES M0); no cadence
 * means reminders are off; and the sweep stops chasing POST_EVENT_GRACE_DAYS
 * after the event ends, whether or not anyone remembered to archive it. */
function sweepEligible(event: Doc<"events">, now: number): boolean {
  if (event.archivedAt !== undefined) return false;
  if (event.reminderCadenceDays === undefined) return false;
  if (now > event.endsAt + POST_EVENT_GRACE_DAYS * DAY_MS) return false;
  return true;
}

export const sweep = internalMutation({
  args: {
    /** Injectable clock so tests can walk a cadence window deterministically. */
    now: v.optional(v.number()),
  },
  returns: v.object({
    /** Eligible events dispatched, each as its own scheduled mutation. */
    events: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    // v1: full bounded scan; only eligible events are dispatched at all. Each
    // event sweeps in its OWN scheduled mutation, so a failure in one event's
    // sweep (oversized graph, template render throw) cannot starve the rest.
    const events = await ctx.db.query("events").take(EVENT_SCAN);
    let dispatched = 0;
    for (const event of events) {
      if (!sweepEligible(event, now)) continue;
      await ctx.scheduler.runAfter(0, internal.reminders.sweepEvent, {
        eventId: event._id,
        now,
      });
      dispatched += 1;
    }
    return { events: dispatched };
  },
});

export const sweepEvent = internalMutation({
  args: {
    eventId: v.id("events"),
    /** The dispatcher's clock, so one sweep is a single consistent instant. */
    now: v.number(),
  },
  returns: v.object({
    taskEmails: v.number(),
    participationEmails: v.number(),
    deferredRecipients: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await ctx.db.get("events", args.eventId);
    // Re-check eligibility: the event may have been archived or deleted
    // between dispatch and this run.
    if (event === null || !sweepEligible(event, args.now)) {
      return EMPTY_SWEEP;
    }
    const graph = await loadGraph(ctx, event);
    return await runEventSweep(ctx, event, graph, args.now);
  },
});
