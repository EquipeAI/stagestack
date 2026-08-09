import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { requireOrganizer } from "../lib/functions";
import { isOpen, isOverdue } from "./tasks";

// ─────────────────────────────────────────────────────────────────────────
// Operational audiences (M5). Derived ONLY from event relationships and state —
// there is no imported-list concept anywhere in StageStack, and there must not
// be one (MILESTONES non-goals: imported mailing lists, newsletters).
//
// Routing follows the representation rule (M4/M5): routine task chasing goes to
// the primary manager WHENEVER one exists — claiming a portal never silently
// reroutes it to the speaker (MILESTONES M4:87). Only when there is no manager
// (a self-managing direct speaker) does task chasing reach the speaker.
// Personal-action messages (confirm your participation) go to the speaker
// directly, falling back to the manager when we have no address for them.
// ─────────────────────────────────────────────────────────────────────────

export const AUDIENCE_KINDS = [
  "allSpeakers",
  "confirmedSpeakers",
  "unconfirmedSpeakers",
  "overdueTasks",
  "assignedReviewers",
] as const;

export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

export type AudienceRecipient = {
  email: string;
  firstName: string;
  lastName: string;
  eventContactId?: Id<"eventContacts">;
  userId?: Id<"users">;
};

export type AudienceResult = {
  /** Deduped recipients, CAPPED at MAX_AUDIENCE. */
  recipients: AudienceRecipient[];
  /** Speakers we could not reach at all (no own address, no manager address). */
  skipped: number;
  /** Total distinct reachable recipients BEFORE the cap — the honest count. */
  totalKnown: number;
  /** True when totalKnown exceeded MAX_AUDIENCE and `recipients` was capped. */
  truncated: boolean;
};

const PARTICIPANT_SCAN = 5000;
const CONTACT_SCAN = 2000;
const SESSION_SCAN = 1000;
const INSTANCE_SCAN = 8000;
const REQUIREMENT_SCAN = 200;
const REVIEW_SCAN = 5000;
/** One send never fans out past this many addresses. */
export const MAX_AUDIENCE = 200;

/** "task-ish" chasing routes to the manager; "personal" reaches the speaker. */
export type RoutingMode = "task" | "personal";

function cleanEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export type ManagerLookup = Map<Id<"users">, Doc<"users"> | null>;

function splitName(name: string | undefined): {
  firstName: string;
  lastName: string;
} {
  const [first, ...rest] = (name ?? "").trim().split(/\s+/);
  return { firstName: first ?? "", lastName: rest.join(" ") };
}

/**
 * Pick the address for one participant.
 *
 * `task` mode: the primary manager owns routine chasing WHENEVER one exists —
 * a speaker claiming their portal never reroutes it (MILESTONES M4:87). The
 * recipient is greeted as the manager (or generically), never as an arbitrary
 * represented speaker; the speaker's name belongs in the digest LINE. Only a
 * self-managing speaker with no manager is chased directly.
 *
 * `personal` mode: always try the speaker first; the manager is the fallback so
 * a represented speaker with no address of their own still gets asked.
 */
export function routeParticipant(args: {
  contact: Doc<"eventContacts"> | undefined;
  managerUser: Doc<"users"> | null | undefined;
  mode: RoutingMode;
}): AudienceRecipient | null {
  const { contact, managerUser, mode } = args;
  const speakerEmail = cleanEmail(contact?.email);
  const managerEmail = cleanEmail(managerUser?.email ?? undefined);

  const toManager = mode === "task" && managerEmail !== undefined;
  if (toManager) {
    return {
      email: managerEmail,
      ...splitName(managerUser?.name ?? undefined),
      userId: managerUser?._id,
    };
  }

  const email = speakerEmail ?? managerEmail;
  if (email === undefined) return null;
  return {
    email,
    firstName: contact?.firstName ?? "",
    lastName: contact?.lastName ?? "",
    eventContactId: contact?._id,
    userId: contact?.userId ?? (email === managerEmail ? managerUser?._id : undefined),
  };
}

/** Dedupe by email — NO cap (the cap is applied once, in `finalize`, so the
 * honest total can still be reported). */
function dedupe(recipients: AudienceRecipient[]): AudienceRecipient[] {
  const byEmail = new Map<string, AudienceRecipient>();
  for (const recipient of recipients) {
    if (byEmail.has(recipient.email)) continue;
    byEmail.set(recipient.email, recipient);
  }
  return [...byEmail.values()];
}

/** Cap the deduped set at MAX_AUDIENCE while reporting the true total, so a
 * truncated audience is VISIBLE rather than silently presented as exact. */
function finalize(
  deduped: AudienceRecipient[],
  skipped: number,
): AudienceResult {
  return {
    recipients: deduped.slice(0, MAX_AUDIENCE),
    skipped,
    totalKnown: deduped.length,
    truncated: deduped.length > MAX_AUDIENCE,
  };
}

export type EventState = {
  participants: Array<Doc<"sessionParticipants">>;
  contactById: Map<Id<"eventContacts">, Doc<"eventContacts">>;
  sessionById: Map<Id<"sessions">, Doc<"sessions">>;
  managers: ManagerLookup;
};

/** One read of the participant graph, shared by every speaker-derived kind. */
export async function loadEventState(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<EventState> {
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
    contactById: new Map(contacts.map((c) => [c._id, c])),
    sessionById: new Map(sessions.map((s) => [s._id, s])),
    managers: new Map(managerIds.map((id, i) => [id, managerDocs[i]])),
  };
}

/** Participants that still count: their session is planned, and they have not
 * withdrawn or declined out of the event. */
function livingParticipants(
  state: EventState,
): Array<Doc<"sessionParticipants">> {
  return state.participants.filter((p) => {
    const session = state.sessionById.get(p.sessionId);
    if (session === undefined || session.status !== "planned") return false;
    return p.state !== "withdrawn" && p.state !== "declined";
  });
}

function collect(
  state: EventState,
  participants: Array<Doc<"sessionParticipants">>,
  mode: RoutingMode,
): AudienceResult {
  const recipients: AudienceRecipient[] = [];
  let skipped = 0;
  for (const participant of participants) {
    const routed = routeParticipant({
      contact: state.contactById.get(participant.eventContactId),
      managerUser:
        participant.managerUserId === undefined
          ? undefined
          : state.managers.get(participant.managerUserId),
      mode,
    });
    if (routed === null) {
      skipped += 1;
      continue;
    }
    recipients.push(routed);
  }
  return finalize(dedupe(recipients), skipped);
}

async function overdueTaskAudience(
  ctx: QueryCtx,
  event: Doc<"events">,
  state: EventState,
  now: number,
): Promise<AudienceResult> {
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
  const participantById = new Map(state.participants.map((p) => [p._id, p]));

  const owing: Array<Doc<"sessionParticipants">> = [];
  const seen = new Set<Id<"sessionParticipants">>();
  for (const instance of instances) {
    if (!isOpen(instance) || !isOverdue(instance, now)) continue;
    const requirement = requirementById.get(instance.requirementId);
    if (requirement === undefined || !requirement.active) continue;

    // Resolve the accountable participant. Participant-scope tasks name it
    // directly; a session-scope task carries an eventContactId assignee
    // instead (M4: session tasks have one accountable assignee), so it is no
    // longer dropped from the overdue audience.
    let participant: Doc<"sessionParticipants"> | undefined;
    if (instance.participantId !== undefined) {
      participant = participantById.get(instance.participantId);
    } else if (instance.eventContactId !== undefined) {
      participant = state.participants.find(
        (p) =>
          p.sessionId === instance.sessionId &&
          p.eventContactId === instance.eventContactId,
      );
    }
    if (participant === undefined) continue;
    if (seen.has(participant._id)) continue;
    const session = state.sessionById.get(participant.sessionId);
    if (session === undefined || session.status !== "planned") continue;
    if (participant.state === "withdrawn" || participant.state === "declined") {
      continue;
    }
    seen.add(participant._id);
    owing.push(participant);
  }
  return collect(state, owing, "task");
}

async function reviewerAudience(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<AudienceResult> {
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_eventId_and_reviewerUserId", (q) =>
      q.eq("eventId", event._id),
    )
    .take(REVIEW_SCAN);
  const reviewerIds = [...new Set(reviews.map((r) => r.reviewerUserId))];
  const users = await Promise.all(
    reviewerIds.map((id) => ctx.db.get("users", id)),
  );
  const recipients: AudienceRecipient[] = [];
  let skipped = 0;
  for (const user of users) {
    const email = cleanEmail(user?.email);
    if (user === null || email === undefined) {
      skipped += 1;
      continue;
    }
    const [firstName, ...rest] = (user.name ?? "").trim().split(/\s+/);
    recipients.push({
      email,
      firstName: firstName ?? "",
      lastName: rest.join(" "),
      userId: user._id,
    });
  }
  return finalize(dedupe(recipients), skipped);
}

/**
 * Resolve one audience to concrete, deduped, bounded recipients.
 *
 * `now` is an argument rather than a clock read so overdue membership is
 * honest inside a reactive query (Convex does not re-run a query because time
 * passed).
 */
export async function resolveAudience(
  ctx: QueryCtx,
  event: Doc<"events">,
  kind: AudienceKind,
  now: number,
  /** Preloaded participant graph — pass it when resolving several kinds of
   * the same event so the graph is read once, not once per kind. */
  preloaded?: EventState,
): Promise<AudienceResult> {
  if (kind === "assignedReviewers") {
    return await reviewerAudience(ctx, event);
  }
  const state = preloaded ?? (await loadEventState(ctx, event));
  const living = livingParticipants(state);

  switch (kind) {
    case "allSpeakers":
      return collect(state, living, "personal");
    case "confirmedSpeakers":
      return collect(
        state,
        living.filter((p) => p.state === "confirmed"),
        "personal",
      );
    case "unconfirmedSpeakers":
      // Personal action: "confirm your participation" is the speaker's own
      // decision, so it goes to them when we can reach them at all.
      return collect(
        state,
        living.filter((p) => p.state === "awaiting"),
        "personal",
      );
    case "overdueTasks":
      return await overdueTaskAudience(ctx, event, state, now);
  }
}

export type AudienceCount = {
  kind: AudienceKind;
  /** Reachable recipients in this send, capped at MAX_AUDIENCE. */
  count: number;
  skipped: number;
  /** True total before the cap, and whether the cap bit. */
  totalKnown: number;
  truncated: boolean;
};

export async function audienceCounts(
  ctx: QueryCtx,
  caller: EventCaller,
  now: number,
): Promise<AudienceCount[]> {
  // Organizer-only: audiences expose who is reachable on this event.
  requireOrganizer(caller);
  // One graph read shared by every speaker-derived kind (M8) — counting five
  // audiences must not load the participant graph five times.
  const state = await loadEventState(ctx, caller.event);
  const counts: AudienceCount[] = [];
  for (const kind of AUDIENCE_KINDS) {
    const { recipients, skipped, totalKnown, truncated } =
      await resolveAudience(ctx, caller.event, kind, now, state);
    counts.push({
      kind,
      count: recipients.length,
      skipped,
      totalKnown,
      truncated,
    });
  }
  return counts;
}
