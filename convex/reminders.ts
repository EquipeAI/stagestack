import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { escapeHtml, sendLoggedEmail, siteUrl } from "./model/comms";
import { renderTemplate } from "./model/templates";
import { routeParticipant, type AudienceRecipient } from "./model/audiences";
import { takeAll } from "./model/validation";
import { eventMutation, eventQuery, requireOrganizer } from "./lib/functions";
import {
  CONTACT_SCAN,
  PARTICIPANT_SCAN,
  REQUIREMENT_SCAN,
  SESSION_SCAN,
} from "./lib/readCaps";
import { logAudit } from "./model/audit";
import {
  POST_EVENT_GRACE_DAYS,
  SAFETY_CADENCE_DAYS,
  SWEEP_INTERVAL_HOURS,
  SWEEP_MINUTE,
  automationQuietAfter,
  nextSweepAt,
} from "./shared/reminderSchedule";

// ─────────────────────────────────────────────────────────────────────────
// Scheduled reminders (M5). Hourly cron, driven by crons.ts.
//
// Shape (M8): the cron entry (`sweep`) is a cheap dispatcher — it scans the
// bounded event list and schedules ONE independent `sweepEvent` mutation per
// eligible event. Each event sweeps in its own transaction, so one oversized
// event or one failing render aborts only that event, never the whole sweep.
//
// The rules this file exists to enforce (MILESTONES M4/M5):
//  • Unconfirmed speakers normally get PARTICIPATION reminders, not task
//    chasing. The due-date fallback is the narrow exception: a dated task must
//    still reach an awaiting direct speaker when general cadence is off.
//  • ONE consolidated message per recipient per event per sweep — never one per
//    task, and never a separate task email AND participation email to the same
//    recipient in a single run (MILESTONES M5:86).
//  • Routine task chasing routes to the primary manager whenever one exists;
//    claiming a portal never reroutes it (M4:87).
//  • Cadence = per-requirement override ?? event default; `remindersDisabled`
//    on a requirement silences it entirely.
//  • Due-soon and overdue work has a daily safety cadence even when the event
//    has no general cadence. This is the actual due-date automation promised
//    to speakers, not an organizer-only "send now" shortcut.
//  • Reminders stop on completion, withdrawal and session cancellation, which
//    falls out of the status/state filters below.
//
// Idempotence inside a cadence window comes from `lastRemindedAt`, stamped only
// after a provider accepts the message. Configured cadence uses document
// creation as its initial baseline; due-date safety is eligible immediately
// upon entering the window, then respects the daily stamp.
// ─────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** A task enters fallback due-date chasing during the 48-hour window named by
 * the product rubric. When no cadence is configured, one attempt per day is
 * the anti-spam floor. */
const DUE_SOON_MS = 2 * DAY_MS;
const DUE_REMINDER_CADENCE_DAYS = SAFETY_CADENCE_DAYS;

/** How long past `endsAt` the sweep keeps chasing — defined in
 * shared/reminderSchedule so the UI can state the same window, re-exported here
 * because this is where the rule is enforced. */
export { POST_EVENT_GRACE_DAYS };

// The sweep reads an event's ENTIRE task graph — instances (each carrying up
// to a 2000-char reviewNote), participants, contacts, sessions, requirements —
// and patches instances, all inside one mutation whose read+write allowance is
// 16 MiB. The shared `INSTANCE_SCAN` (8000) is a document-count ceiling for
// reads that stand alone; at 8000 note-heavy instances this transaction could
// blow its BYTE budget and fail large valid events outright instead of
// refusing with `event_too_large`. So the sweep keeps its own lower ceiling.
const INSTANCE_SCAN = 4000;

// The other per-event read ceilings come from `lib/readCaps` (imported above).
// Every one is enforced here with `takeAll` (H5): a truncated read does not look like an
// error, it looks like a speaker who stopped being chased — and nothing would
// ever notice, because the sweep is idempotent and would simply never reach the
// dropped rows again. Refusing aborts one event's sweep loudly (each event runs
// in its own mutation, see below) instead of silently under-reminding forever.
/** Never fan one sweep of one event out past this many addresses. */
const MAX_RECIPIENTS_PER_EVENT = 200;
/** Each dispatcher transaction advances every discovery source by one bounded
 * page, then schedules a continuation. Historical overdue tasks therefore
 * cannot exhaust one mutation or permanently hide newer work behind them. */
const DISCOVERY_PAGE_SIZE = 100;

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
  // Read-only, so a QueryCtx is enough: the preview query builds the same graph
  // the sweep and the manual send do.
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<EventGraph> {
  const [participants, contacts, sessions] = await Promise.all([
    takeAll(
      ctx.db
        .query("sessionParticipants")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      PARTICIPANT_SCAN,
      "speaker participations",
    ),
    takeAll(
      ctx.db
        .query("eventContacts")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      CONTACT_SCAN,
      "speaker profiles",
    ),
    takeAll(
      ctx.db
        .query("sessions")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      SESSION_SCAN,
      "sessions",
    ),
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
  const participant = instanceParticipant(graph, instance);
  if (participant === undefined || participant.state !== "confirmed") {
    return undefined;
  }
  return participant;
}

/** Resolve the person accountable for a task without silently erasing an
 * awaiting speaker. Declined/withdrawn people are no longer chaseable. */
function instanceParticipant(
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
  if (
    participant === undefined ||
    participant.state === "declined" ||
    participant.state === "withdrawn"
  ) {
    return undefined;
  }
  return participant;
}

function dueDriven(instance: Doc<"taskInstances">, now: number): boolean {
  return instance.dueAt <= now + DUE_SOON_MS;
}

/** An explicit requirement/event cadence remains authoritative. When neither
 * exists, due-soon/overdue work gets the daily fallback instead of going dark. */
function reminderCadenceDays(
  instance: Doc<"taskInstances">,
  requirement: Doc<"requirements">,
  eventCadence: number | undefined,
  now: number,
): number | undefined {
  const configured = requirement.reminderCadenceDays ?? eventCadence;
  if (configured !== undefined) return configured;
  return dueDriven(instance, now) ? DUE_REMINDER_CADENCE_DAYS : undefined;
}

function usesDueDateFallback(
  instance: Doc<"taskInstances">,
  requirement: Doc<"requirements">,
  eventCadence: number | undefined,
  now: number,
): boolean {
  return (
    requirement.reminderCadenceDays === undefined &&
    eventCadence === undefined &&
    dueDriven(instance, now)
  );
}

async function providerAccepted(
  ctx: MutationCtx,
  messageId: Id<"messages">,
): Promise<boolean> {
  const logged = await ctx.db.get("messages", messageId);
  return logged !== null && logged.deliveryStatus !== "failed";
}

// ── The per-event sweep ────────────────────────────────────────────────────

type EventSweepResult = {
  /** Provider-accepted task messages. */
  taskEmails: number;
  /** Provider-accepted participation messages. */
  participationEmails: number;
  /** Attempts refused before they left StageStack. Failed buckets are not
   * stamped, so the next hourly evaluation retries them. */
  failedEmails: number;
  /** Distinct speakers/managers with no reachable address. */
  skippedRecipients: number;
  /** Distinct recipients dropped by MAX_RECIPIENTS_PER_EVENT this run —
   * visible in the result instead of silently truncated (M8). They are not
   * stamped, so the next sweep picks them up. */
  deferredRecipients: number;
};

const EMPTY_SWEEP: EventSweepResult = {
  taskEmails: 0,
  participationEmails: 0,
  failedEmails: 0,
  skippedRecipients: 0,
  deferredRecipients: 0,
};

async function runEventSweep(
  ctx: MutationCtx,
  event: Doc<"events">,
  graph: EventGraph,
  now: number,
): Promise<EventSweepResult> {
  const eventCadence = event.reminderCadenceDays;

  const [requirements, instances] = await Promise.all([
    takeAll(
      ctx.db
        .query("requirements")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      REQUIREMENT_SCAN,
      "requirements",
    ),
    takeAll(
      ctx.db
        .query("taskInstances")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      INSTANCE_SCAN,
      "tasks",
    ),
  ]);
  const requirementById = new Map(requirements.map((r) => [r._id, r]));

  const buckets = new Map<string, Bucket>();
  const deferred = new Set<string>();
  const skippedContacts = new Set<Id<"eventContacts">>();

  // ── (a) Task sections ──
  for (const instance of instances) {
    if (!isActionable(instance.status)) continue;
    const requirement = requirementById.get(instance.requirementId);
    if (requirement === undefined || !requirement.active) continue;
    if (requirement.remindersDisabled === true) continue;

    const cadenceDays = reminderCadenceDays(
      instance,
      requirement,
      eventCadence,
      now,
    );
    if (cadenceDays === undefined) continue;
    if (cadenceDays <= 0) continue;
    const dueDateSafety = dueDriven(instance, now);
    const dueDateFallback = usesDueDateFallback(
      instance,
      requirement,
      eventCadence,
      now,
    );
    // A configured cadence starts at assignment. Due-date safety is different:
    // once an incomplete task enters the 48-hour window, its first reminder is
    // eligible at the next hourly evaluation; only an accepted send starts the
    // daily anti-spam clock.
    const baseline =
      instance.lastRemindedAt ??
      (dueDateSafety ? Number.NEGATIVE_INFINITY : instance._creationTime);
    if (now - baseline < cadenceDays * DAY_MS) continue;

    const session = graph.sessionById.get(instance.sessionId);
    if (session === undefined || session.status !== "planned") continue;

    const participant = dueDateFallback
      ? instanceParticipant(graph, instance)
      : taskParticipant(graph, instance);
    if (participant === undefined) continue;

    // Ordinary task ownership follows the manager. In the due-date safety
    // window an awaiting direct speaker is still the legitimate addressee;
    // otherwise assigning them a dated task could never trigger SPK-16.
    const recipient = routeFor(
      graph,
      participant,
      dueDateFallback && participant.state !== "confirmed"
        ? "personal"
        : "task",
    );
    if (recipient === null) {
      skippedContacts.add(participant.eventContactId);
      continue;
    }
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
  if (eventCadence !== undefined && eventCadence > 0) {
    for (const participant of graph.participants) {
      if (participant.state !== "awaiting") continue;
      const session = graph.sessionById.get(participant.sessionId);
      if (session === undefined || session.status !== "planned") continue;
      const since = now - (participant.lastRemindedAt ?? 0);
      if (since < eventCadence * DAY_MS) continue;

      const recipient = routeFor(graph, participant, "personal");
      if (recipient === null) {
        skippedContacts.add(participant.eventContactId);
        continue;
      }
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
  let failedEmails = 0;
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

    const messageId = await sendLoggedEmail(ctx, {
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
        renderedSubject: subject,
        renderedBody: html,
      },
    });
    if (!(await providerAccepted(ctx, messageId))) {
      failedEmails += 1;
      continue;
    }
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
  return {
    taskEmails,
    participationEmails,
    failedEmails,
    skippedRecipients: skippedContacts.size,
    deferredRecipients: deferred.size,
  };
}

// ── The sweep: cheap dispatcher + one independent mutation per event ──────

/** Archived events stop automations entirely (MILESTONES M0), and the sweep
 * stops chasing POST_EVENT_GRACE_DAYS after the event ends whether or not
 * anyone remembered to archive it. A missing general cadence does NOT disable
 * the due-date safety automation. */
function sweepEligible(event: Doc<"events">, now: number): boolean {
  if (event.archivedAt !== undefined) return false;
  if (now > automationQuietAfter(event.endsAt)) return false;
  return true;
}

const vDiscoverySource = v.union(
  v.literal("eventCadence"),
  v.literal("requirementCadence"),
  v.literal("pendingDue"),
  v.literal("changesRequestedDue"),
);
type DiscoverySource =
  "eventCadence" | "requirementCadence" | "pendingDue" | "changesRequestedDue";
type DiscoveryResult = {
  eventIds: Array<Id<"events">>;
  dispatched: number;
};

async function dispatchEvents(
  ctx: MutationCtx,
  eventIds: Iterable<Id<"events">>,
  now: number,
): Promise<number> {
  let dispatched = 0;
  for (const eventId of eventIds) {
    const event = await ctx.db.get("events", eventId);
    if (event === null || !sweepEligible(event, now)) continue;
    const state = await ctx.db
      .query("reminderDispatchStates")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .unique();
    // Sources and their continuation pages run as independent transactions.
    // This indexed read + write is the durable serialization point: Convex
    // retries a concurrent contender, which then observes this run and skips.
    // `>=` also prevents a delayed old continuation from replacing a newer
    // run and making that newer run dispatchable twice.
    if (state !== null && state.lastRunAt >= now) continue;
    if (state === null) {
      await ctx.db.insert("reminderDispatchStates", {
        eventId,
        lastRunAt: now,
        dispatchCount: 1,
      });
    } else {
      await ctx.db.patch("reminderDispatchStates", state._id, {
        lastRunAt: now,
        dispatchCount: state.dispatchCount + 1,
      });
    }
    await ctx.scheduler.runAfter(0, internal.reminders.sweepEvent, {
      eventId,
      now,
    });
    dispatched += 1;
  }
  return dispatched;
}

/** One indexed source and one page per execution. Convex permits only one
 * paginated query in a function, so independent workers keep every source
 * bounded while allowing each to advance at its own pace. */
export const sweepSource = internalMutation({
  args: {
    source: vDiscoverySource,
    paginationOpts: paginationOptsValidator,
    now: v.number(),
    /** Initial calls return IDs to the root for cross-source deduplication;
     * continuation calls dispatch their own newly discovered events. */
    dispatch: v.boolean(),
  },
  returns: v.object({
    eventIds: v.array(v.id("events")),
    dispatched: v.number(),
  }),
  handler: async (ctx, args) => {
    const eventIds = new Set<Id<"events">>();
    let isDone: boolean;
    let continueCursor: string;
    if (args.source === "eventCadence") {
      const result = await ctx.db
        .query("events")
        .withIndex("by_reminderCadenceDays", (q) =>
          q.gte("reminderCadenceDays", 0),
        )
        .paginate(args.paginationOpts);
      for (const event of result.page) eventIds.add(event._id);
      isDone = result.isDone;
      continueCursor = result.continueCursor;
    } else if (args.source === "requirementCadence") {
      const result = await ctx.db
        .query("requirements")
        .withIndex("by_reminderCadenceDays", (q) =>
          q.gte("reminderCadenceDays", 0),
        )
        .paginate(args.paginationOpts);
      for (const requirement of result.page) {
        eventIds.add(requirement.eventId);
      }
      isDone = result.isDone;
      continueCursor = result.continueCursor;
    } else if (args.source === "pendingDue") {
      const result = await ctx.db
        .query("taskInstances")
        .withIndex("by_status_and_dueAt", (q) =>
          q.eq("status", "pending").lte("dueAt", args.now + DUE_SOON_MS),
        )
        .paginate(args.paginationOpts);
      for (const instance of result.page) eventIds.add(instance.eventId);
      isDone = result.isDone;
      continueCursor = result.continueCursor;
    } else {
      const result = await ctx.db
        .query("taskInstances")
        .withIndex("by_status_and_dueAt", (q) =>
          q
            .eq("status", "changesRequested")
            .lte("dueAt", args.now + DUE_SOON_MS),
        )
        .paginate(args.paginationOpts);
      for (const instance of result.page) eventIds.add(instance.eventId);
      isDone = result.isDone;
      continueCursor = result.continueCursor;
    }

    const dispatched = args.dispatch
      ? await dispatchEvents(ctx, eventIds, args.now)
      : 0;
    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.reminders.sweepSource, {
        source: args.source,
        paginationOpts: {
          cursor: continueCursor,
          numItems: DISCOVERY_PAGE_SIZE,
        },
        now: args.now,
        dispatch: true,
      });
    }
    return { eventIds: [...eventIds], dispatched };
  },
});

export const sweep = internalMutation({
  args: {
    /** Injectable clock so tests can walk a cadence window deterministically. */
    now: v.optional(v.number()),
  },
  returns: v.object({
    /** Eligible events dispatched from the first bounded page of each source. */
    events: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const eventIds = new Set<Id<"events">>();
    const sources: DiscoverySource[] = [
      "eventCadence",
      "requirementCadence",
      "pendingDue",
      "changesRequestedDue",
    ];
    for (const source of sources) {
      const result: DiscoveryResult = await ctx.runMutation(
        internal.reminders.sweepSource,
        {
          source,
          paginationOpts: {
            cursor: null,
            numItems: DISCOVERY_PAGE_SIZE,
          },
          now,
          dispatch: false,
        },
      );
      for (const eventId of result.eventIds) eventIds.add(eventId);
    }
    return { events: await dispatchEvents(ctx, eventIds, now) };
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
    failedEmails: v.number(),
    skippedRecipients: v.number(),
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


// ── The organizer's "send reminders now" audience ─────────────────────────

type OutstandingSet = {
  buckets: Map<string, Bucket>;
  skippedContacts: Set<Id<"eventContacts">>;
  /** True when a further distinct recipient would exceed the per-send cap —
   * the send refuses outright rather than reaching an arbitrary subset. */
  overCap: boolean;
};

/**
 * Who a manual "send reminders now" would reach, and which tasks it would
 * include. Read-only, and the single definition of that audience: both
 * `sendOutstandingNow` and `outstandingReminderPreview` call it, so the
 * confirmation an organizer reads and the mail that goes out can never
 * describe different sets.
 *
 * Unlike the sweep this ignores cadence entirely — a manual send is the
 * organizer overriding the cadence — but keeps every other rule: the
 * requirement must be active with reminders enabled, the session planned, and
 * the participant still chaseable.
 */
async function collectOutstanding(
  ctx: QueryCtx,
  event: Doc<"events">,
  graph: EventGraph,
): Promise<OutstandingSet> {
  const [requirements, instances] = await Promise.all([
    takeAll(
      ctx.db
        .query("requirements")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      REQUIREMENT_SCAN,
      "requirements",
    ),
    takeAll(
      ctx.db
        .query("taskInstances")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
      INSTANCE_SCAN,
      "tasks",
    ),
  ]);
  const requirementById = new Map(requirements.map((row) => [row._id, row]));
  const buckets = new Map<string, Bucket>();
  const skippedContacts = new Set<Id<"eventContacts">>();
  let overCap = false;

  for (const instance of instances) {
    if (!isActionable(instance.status)) continue;
    const requirement = requirementById.get(instance.requirementId);
    if (
      requirement === undefined ||
      !requirement.active ||
      requirement.remindersDisabled === true
    ) {
      continue;
    }
    const session = graph.sessionById.get(instance.sessionId);
    if (session === undefined || session.status !== "planned") continue;
    const participant = instanceParticipant(graph, instance);
    if (participant === undefined) continue;
    const recipient = routeFor(
      graph,
      participant,
      participant.state === "confirmed" ? "task" : "personal",
    );
    if (recipient === null) {
      skippedContacts.add(participant.eventContactId);
      continue;
    }
    let bucket = buckets.get(recipient.email);
    if (bucket === undefined) {
      if (buckets.size >= MAX_RECIPIENTS_PER_EVENT) {
        overCap = true;
        continue;
      }
      bucket = {
        recipient,
        taskInstanceIds: [],
        taskLines: [],
        participantIds: [],
        participationLines: [],
      };
      buckets.set(recipient.email, bucket);
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
  return { buckets, skippedContacts, overCap };
}

/** Organizer-triggered reminder for the outstanding task set. It deliberately
 * excludes participation reminders and uses a distinct kind/sender so the log
 * never presents a manual action as automation. */
export const sendOutstandingNow = eventMutation({
  args: {},
  returns: v.object({
    sent: v.number(),
    failed: v.number(),
    skipped: v.number(),
    includedTasks: v.number(),
  }),
  handler: async (ctx) => {
    requireOrganizer(ctx.caller);
    if (ctx.caller.event.archivedAt !== undefined) {
      throw new ConvexError({
        code: "event_archived",
        message: "Archived events cannot send reminders.",
      });
    }
    const event = ctx.caller.event;
    const graph = await loadGraph(ctx, event);
    const outstanding = await collectOutstanding(ctx, event, graph);
    // The preview query and this send agree by construction: both read the same
    // collector, so the confirmation cannot describe a different audience from
    // the one that receives the mail.
    if (outstanding.overCap) {
      throw new ConvexError({
        code: "audience_too_large",
        message: `This reminder would reach more than ${MAX_RECIPIENTS_PER_EVENT} recipients. Narrow the outstanding set first.`,
      });
    }
    const { buckets, skippedContacts } = outstanding;

    const now = Date.now();
    let sent = 0;
    let failed = 0;
    for (const bucket of buckets.values()) {
      const rendered = await renderTemplate(ctx, event, "reminder.tasks", {
        event: { name: event.name },
        speaker: {
          firstName: bucket.recipient.firstName,
          lastName: bucket.recipient.lastName,
        },
        link: `${siteUrl()}/portal/${event.slug}`,
        tasks: list(bucket.taskLines),
      });
      const messageId = await sendLoggedEmail(ctx, {
        orgId: event.orgId,
        eventId: event._id,
        toEmail: bucket.recipient.email,
        kind: "reminder.tasks.manual",
        subject: rendered.subject,
        html: rendered.html,
        sentByUserId: ctx.caller.user._id,
        replyTo: event.replyTo,
        context: {
          instanceIds: bucket.taskInstanceIds,
          manual: true,
          renderedSubject: rendered.subject,
          renderedBody: rendered.html,
        },
      });
      if (!(await providerAccepted(ctx, messageId))) {
        failed += 1;
        continue;
      }
      sent += 1;
      // Treat a manual reminder as the latest reminder for cadence purposes,
      // preventing the hourly automation from duplicating it immediately.
      for (const instanceId of bucket.taskInstanceIds) {
        await ctx.db.patch("taskInstances", instanceId, {
          lastRemindedAt: now,
        });
      }
    }
    const includedTasks = [...buckets.values()].reduce(
      (total, bucket) => total + bucket.taskInstanceIds.length,
      0,
    );
    const skipped = skippedContacts.size;
    await logAudit(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      actorUserId: ctx.caller.user._id,
      action: "reminders.sendOutstandingNow",
      targetType: "event",
      targetId: event._id,
      meta: { sent, failed, skipped, includedTasks },
    });
    return { sent, failed, skipped, includedTasks };
  },
});

/**
 * What a manual "send reminders now" would do, stated BEFORE it fires.
 *
 * Same collector as the mutation, so the numbers on the confirmation are the
 * numbers that will be acted on. Subscribe it only while the confirmation is
 * open (`useQuery(..., 'skip')` otherwise) — it reads the event graph, which is
 * not a cost worth paying on every render of the tasks page.
 */
export const outstandingReminderPreview = eventQuery({
  args: {},
  returns: v.object({
    /** Distinct addresses this send would reach. */
    recipients: v.number(),
    /** Outstanding tasks those messages would list. */
    tasks: v.number(),
    /** Speakers with an outstanding task and no reachable address — neither
     * their own nor a primary manager's. They are excluded. */
    unreachableSpeakers: v.number(),
    /** True when the audience exceeds the cap, in which case the send is
     * REFUSED outright rather than partially delivered. */
    overCap: v.boolean(),
    cap: v.number(),
    /** Archived events refuse the send entirely. */
    blocked: v.union(v.literal("archived"), v.null()),
  }),
  handler: async (ctx) => {
    requireOrganizer(ctx.caller);
    const event = ctx.caller.event;
    if (event.archivedAt !== undefined) {
      return {
        recipients: 0,
        tasks: 0,
        unreachableSpeakers: 0,
        overCap: false,
        cap: MAX_RECIPIENTS_PER_EVENT,
        blocked: "archived" as const,
      };
    }
    const graph = await loadGraph(ctx, event);
    const { buckets, skippedContacts, overCap } = await collectOutstanding(
      ctx,
      event,
      graph,
    );
    let tasks = 0;
    for (const bucket of buckets.values()) {
      tasks += bucket.taskInstanceIds.length;
    }
    return {
      recipients: buckets.size,
      tasks,
      unreachableSpeakers: skippedContacts.size,
      overCap,
      cap: MAX_RECIPIENTS_PER_EVENT,
      blocked: null,
    };
  },
});

/** Honest automation evidence for the task UI: this is the next scheduled
 * evaluation, not a promise that an email will be due at that instant.
 *
 * `nextEvaluationAt` is DERIVED from the cron schedule (shared/reminderSchedule
 * is the single source both this and convex/crons.ts read), so it can no longer
 * disagree with when the sweep actually runs. */
export const automationStatus = eventQuery({
  args: { now: v.number() },
  returns: v.object({
    enabled: v.boolean(),
    cadenceDays: v.union(v.number(), v.null()),
    nextEvaluationAt: v.union(v.number(), v.null()),
    /** Hours between sweeps — stated rather than assumed by the caller. */
    evaluationIntervalHours: v.number(),
    /** Minute past each UTC hour the sweep is anchored to. */
    sweepMinuteUtc: v.number(),
    /** Daily floor applied to due-soon/overdue work when no cadence is set. */
    safetyCadenceDays: v.number(),
    /** Why automation is off, when it is. `sweepEligible` has exactly these two
     * off-switches, and the UI must be able to name the one that applies. */
    disabledReason: v.union(
      v.literal("archived"),
      v.literal("postEvent"),
      v.null(),
    ),
    /** The instant chasing stops for this event (null once archived, because
     * archiving already stopped it earlier). */
    quietAfter: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    requireOrganizer(ctx.caller);
    const event = ctx.caller.event;
    const cadenceDays = event.reminderCadenceDays ?? null;
    const quietAfter =
      event.archivedAt === undefined ? automationQuietAfter(event.endsAt) : null;
    // Exactly `sweepEligible`'s two conditions, in its order: an archived event
    // is off whatever the date, and past the grace window the sweep skips the
    // event without anyone archiving it. Reporting `enabled: true` there was
    // the product predicting a run that provably never happens.
    const disabledReason =
      event.archivedAt !== undefined
        ? ("archived" as const)
        : args.now > (quietAfter ?? Number.POSITIVE_INFINITY)
          ? ("postEvent" as const)
          : null;
    const enabled = disabledReason === null;
    return {
      enabled,
      cadenceDays,
      nextEvaluationAt: enabled ? nextSweepAt(args.now) : null,
      evaluationIntervalHours: SWEEP_INTERVAL_HOURS,
      sweepMinuteUtc: SWEEP_MINUTE,
      safetyCadenceDays: SAFETY_CADENCE_DAYS,
      disabledReason,
      quietAfter,
    };
  },
});

/** How far back the manual-send lookup scans this event's audit log. Bounded
 * on purpose: the facts panel must not become an unbounded read. When the scan
 * hits the cap without finding a manual send, the caller is told the lookup was
 * truncated instead of being handed a confident "never". */
const AUDIT_LOOKBACK = 300;

/** `auditLog.meta` is `v.any()`. Read one number out of it defensively — an old
 * row written before the counters existed must read as "sent nothing", never as
 * an accidental send. */
function auditSentCount(meta: unknown): number {
  if (typeof meta !== "object" || meta === null) return 0;
  const sent = (meta as Record<string, unknown>).sent;
  return typeof sent === "number" ? sent : 0;
}

/**
 * The reminder facts panel's single producer (W1): everything both the tasks
 * page and the settings page state about reminder automation comes from here.
 *
 * Deliberately argument-free. `automationStatus` already carries the ticking
 * `now`; this query does the scanning, so keeping it out of the per-minute
 * re-subscribe means the scan re-runs when the DATA changes, not every minute.
 *
 * `nextEligibleAt` is the earliest instant at which some outstanding task's
 * cadence window will have elapsed. It is not a promise of a send: the sweep
 * additionally requires a reachable, still-chaseable recipient, which is a
 * judgement made at send time against state this query does not resolve.
 */
export const reminderFacts = eventQuery({
  args: {},
  returns: v.object({
    enabled: v.boolean(),
    cadenceDays: v.union(v.number(), v.null()),
    evaluationIntervalHours: v.number(),
    sweepMinuteUtc: v.number(),
    safetyCadenceDays: v.number(),
    /** Last time the sweep dispatched THIS event (an evaluation, not a send). */
    lastAutomaticAt: v.union(v.number(), v.null()),
    /** Last organizer-triggered "send reminders now" that actually got a
     * message accepted (`meta.sent > 0`). An attempt that reached nobody is
     * NOT a send, and reporting it as one was the same class of lie this
     * workstream exists to remove. */
    lastManualAt: v.union(v.number(), v.null()),
    /** Last manual attempt, accepted or not — so a run that sent nothing is
     * visible rather than silently absent. */
    lastManualAttemptAt: v.union(v.number(), v.null()),
    /** True when the bounded audit scan ended without reaching the beginning —
     * a null `lastManualAt` then means "none recently", not "none ever". */
    manualLookupTruncated: v.boolean(),
    /** Earliest moment an outstanding task's cadence window elapses. */
    nextEligibleAt: v.union(v.number(), v.null()),
    /** Outstanding, reminder-enabled tasks the automation is tracking. */
    trackedTasks: v.number(),
    /** The instant chasing stops for this event; null once archived. The
     * caller compares it with its own ticking clock, which is why this query
     * needs no `now` of its own. */
    quietAfter: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    requireOrganizer(ctx.caller);
    const event = ctx.caller.event;
    const enabled = event.archivedAt === undefined;
    const quietAfter = enabled ? automationQuietAfter(event.endsAt) : null;
    const cadenceDays = event.reminderCadenceDays ?? null;

    const dispatchState = await ctx.db
      .query("reminderDispatchStates")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .unique();

    const auditRows = await ctx.db
      .query("auditLog")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .order("desc")
      .take(AUDIT_LOOKBACK);
    const manualRows = auditRows.filter(
      (row) => row.action === "reminders.sendOutstandingNow",
    );
    // `logAudit` records `{ sent, failed, skipped, includedTasks }` for this
    // action (see sendOutstandingNow), so an attempt that accepted nothing is
    // distinguishable from a real send. `meta` is `v.any()`, so narrow it.
    const acceptedRow = manualRows.find((row) => auditSentCount(row.meta) > 0);

    const [requirements, instances, sessions] = await Promise.all([
      takeAll(
        ctx.db
          .query("requirements")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        REQUIREMENT_SCAN,
        "requirements",
      ),
      takeAll(
        ctx.db
          .query("taskInstances")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        INSTANCE_SCAN,
        "tasks",
      ),
      takeAll(
        ctx.db
          .query("sessions")
          .withIndex("by_eventId", (q) => q.eq("eventId", event._id)),
        SESSION_SCAN,
        "sessions",
      ),
    ]);
    const requirementById = new Map(requirements.map((r) => [r._id, r]));
    const plannedSessions = new Set(
      sessions.filter((s) => s.status === "planned").map((s) => s._id),
    );

    let trackedTasks = 0;
    let nextEligibleAt: number | null = null;
    for (const instance of instances) {
      if (!isActionable(instance.status)) continue;
      if (!plannedSessions.has(instance.sessionId)) continue;
      const requirement = requirementById.get(instance.requirementId);
      if (requirement === undefined || !requirement.active) continue;
      if (requirement.remindersDisabled === true) continue;
      const configured = requirement.reminderCadenceDays ?? cadenceDays ?? null;
      let eligibleAt: number;
      if (configured !== null && configured > 0) {
        eligibleAt =
          (instance.lastRemindedAt ?? instance._creationTime) +
          configured * DAY_MS;
      } else if (configured !== null) {
        // A configured cadence of zero silences the requirement entirely.
        continue;
      } else {
        // No cadence anywhere: only the due-date safety net applies, and it
        // starts when the task enters the due-soon window.
        const windowOpensAt = instance.dueAt - DUE_SOON_MS;
        eligibleAt =
          instance.lastRemindedAt === undefined
            ? windowOpensAt
            : Math.max(
                windowOpensAt,
                instance.lastRemindedAt + DUE_REMINDER_CADENCE_DAYS * DAY_MS,
              );
      }
      trackedTasks += 1;
      if (nextEligibleAt === null || eligibleAt < nextEligibleAt) {
        nextEligibleAt = eligibleAt;
      }
    }

    return {
      enabled,
      cadenceDays,
      evaluationIntervalHours: SWEEP_INTERVAL_HOURS,
      sweepMinuteUtc: SWEEP_MINUTE,
      safetyCadenceDays: SAFETY_CADENCE_DAYS,
      lastAutomaticAt: dispatchState?.lastRunAt ?? null,
      lastManualAt: acceptedRow?._creationTime ?? null,
      lastManualAttemptAt: manualRows[0]?._creationTime ?? null,
      manualLookupTruncated:
        acceptedRow === undefined && auditRows.length === AUDIT_LOOKBACK,
      nextEligibleAt: enabled ? nextEligibleAt : null,
      trackedTasks,
      quietAfter,
    };
  },
});
