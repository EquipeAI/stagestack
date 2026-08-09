import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { isOpen, isOverdue } from "./tasks";

// ─────────────────────────────────────────────────────────────────────────
// Operational audiences (M5). Derived ONLY from event relationships and state —
// there is no imported-list concept anywhere in StageStack, and there must not
// be one (MILESTONES non-goals: imported mailing lists, newsletters).
//
// Routing follows the representation rule (M4/M5): routine task chasing goes to
// the primary manager while the speaker has not claimed their own portal
// access; personal-action messages (confirm your participation) go to the
// speaker directly, falling back to the manager when we have no address for
// them. Claiming portal access flips task routing to the speaker — that is the
// deliberate "claiming never SILENTLY changes routing" boundary: it changes
// because the speaker took the action themselves.
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
  recipients: AudienceRecipient[];
  /** Speakers we could not reach at all (no own address, no manager address). */
  skipped: number;
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

/**
 * Pick the address for one participant.
 *
 * `task` mode: the manager owns routine chasing UNLESS the speaker has claimed
 * their own portal access (`eventContact.userId` set), in which case the person
 * who owes the work hears about it directly.
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
  const claimed = contact?.userId !== undefined;

  const preferManager = mode === "task" && !claimed && managerEmail !== undefined;
  const email = preferManager ? managerEmail : (speakerEmail ?? managerEmail);
  if (email === undefined) return null;

  return {
    email,
    firstName: contact?.firstName ?? "",
    lastName: contact?.lastName ?? "",
    eventContactId: contact?._id,
    userId: contact?.userId ?? (email === managerEmail ? managerUser?._id : undefined),
  };
}

function dedupe(recipients: AudienceRecipient[]): AudienceRecipient[] {
  const byEmail = new Map<string, AudienceRecipient>();
  for (const recipient of recipients) {
    if (byEmail.has(recipient.email)) continue;
    byEmail.set(recipient.email, recipient);
    if (byEmail.size >= MAX_AUDIENCE) break;
  }
  return [...byEmail.values()];
}

type EventState = {
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
  const deduped = dedupe(recipients);
  return { recipients: deduped, skipped };
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
    if (instance.participantId === undefined) continue;
    if (seen.has(instance.participantId)) continue;
    const participant = participantById.get(instance.participantId);
    if (participant === undefined) continue;
    const session = state.sessionById.get(participant.sessionId);
    if (session === undefined || session.status !== "planned") continue;
    if (participant.state === "withdrawn" || participant.state === "declined") {
      continue;
    }
    seen.add(instance.participantId);
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
  return { recipients: dedupe(recipients), skipped };
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
): Promise<AudienceResult> {
  if (kind === "assignedReviewers") {
    return await reviewerAudience(ctx, event);
  }
  const state = await loadEventState(ctx, event);
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
  count: number;
  skipped: number;
};

export async function audienceCounts(
  ctx: QueryCtx,
  event: Doc<"events">,
  now: number,
): Promise<AudienceCount[]> {
  const counts: AudienceCount[] = [];
  for (const kind of AUDIENCE_KINDS) {
    const { recipients, skipped } = await resolveAudience(
      ctx,
      event,
      kind,
      now,
    );
    counts.push({ kind, count: recipients.length, skipped });
  }
  return counts;
}
