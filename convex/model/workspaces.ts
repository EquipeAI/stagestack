import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { publicationState, type Publication } from "./readiness";
import { takeAll, takeCapped } from "./validation";

// ─────────────────────────────────────────────────────────────────────────
// Per-record workspaces (W9).
//
// The speaker roster and the session list are BATCH views: they read every
// contact and every participation on the event so a table can be sorted and
// filtered. A workspace is the opposite shape — one record, everything about
// it — and asking the batch query for it would read the whole event to throw
// away all but one row.
//
// So these two queries exist, and they COMPOSE rather than duplicate:
//   · the publication sentences come from `publicationState`, the same
//     producer `readiness.publication` calls, so a session's workspace and the
//     sessions table can never word the same blocker differently;
//   · tasks, files, comments, snapshots and the comms log stay on their own
//     existing queries (`tasks.listInstances`, `tasks.listUploads`,
//     `tasks.taskComments`, `sessions.listSnapshots`, `comms.contactLog`) —
//     the workspace composes them client-side rather than re-deriving them.
//
// ── Event scoping ────────────────────────────────────────────────────────
// These are the first surfaces that take a record id straight from the URL,
// and they then FOLLOW EDGES out of that record — a participation to its
// session, a session to its room and its proposal, a participation to its
// contact. Every one of those joined documents is re-checked against
// `caller.event._id` before it is included. The primary record refuses
// (`not_found`); a joined record that does not belong to this event is
// DROPPED, because a malformed edge is a data error and rendering it would
// leak another event's title or name through a link nobody audited.
//
// ── Cost ─────────────────────────────────────────────────────────────────
// Every read is keyed to the one record: participations come off
// `by_eventContactId` / `by_sessionId`, and the publication flags are two
// point reads on `by_eventId_and_target`. The joins are BATCHED — ids are
// collected, deduped, then read once in parallel — so a speaker on N sessions
// costs one indexed range read plus one parallel batch, never N serial round
// trips.
// ─────────────────────────────────────────────────────────────────────────

/**
 * How many of a speaker's participations the workspace lists.
 *
 * Capped, NOT refused. Nothing in the domain limits how many sessions one
 * person can be on — a track host or an MC is legitimately on dozens — so a
 * hard ceiling here would make a real person's workspace permanently
 * unopenable, and every other tab with it. The list says when it is showing a
 * prefix; the sections that are complete stay assertions.
 */
const PARTICIPATION_LIST = 200;

/**
 * How many participants of one session the workspace reads.
 *
 * Refusing IS right here, because the domain has the matching rule:
 * `MAX_PARTICIPANTS_PER_SESSION` is 100 in model/sessions.ts and model/portal.ts,
 * so a session holding more than that is already outside what the product
 * writes. The ceiling sits above the enforced cap so a session AT the cap
 * renders, and only genuinely impossible data refuses.
 */
const SESSION_PARTICIPANT_SCAN = 150;

export type SpeakerWorkspaceSession = {
  participantId: Id<"sessionParticipants">;
  sessionId: Id<"sessions">;
  title: string;
  format?: string;
  role: string;
  state: Doc<"sessionParticipants">["state"];
  ack?: Doc<"sessionParticipants">["ack"];
  status: Doc<"sessions">["status"];
  contentStatus: "draft" | "approved";
  startsAt?: number;
  endsAt?: number;
  released: boolean;
};

export type SpeakerWorkspace = {
  eventContactId: Id<"eventContacts">;
  firstName: string;
  lastName: string;
  email?: string;
  tagline?: string;
  jobTitle?: string;
  company?: string;
  bio?: string;
  links?: Doc<"eventContacts">["links"];
  headshotUrl: string | null;
  claimed: boolean;
  customValues: Record<string, string | Array<string>>;
  sessions: SpeakerWorkspaceSession[];
  /** True when this speaker has more participations than the list shows. */
  sessionsTruncated: boolean;
  /** Derived, never stored — the same shape the tracking dashboard reports. */
  readiness: {
    missingBio: boolean;
    missingHeadshot: boolean;
    missingTagline: boolean;
    /** Sentences, composed here so every surface prints the same words. */
    reasons: string[];
  };
};

/**
 * One speaker's event snapshot, their participations, and the profile gaps
 * that hold publication back.
 *
 * Deliberately NOT the task counts: those live on `tasks.listInstances`, which
 * the workspace's Tasks tab already subscribes to, and duplicating them here
 * would let a count disagree with the list under it.
 */
export async function speakerWorkspace(
  ctx: QueryCtx,
  caller: EventCaller,
  eventContactId: Id<"eventContacts">,
): Promise<SpeakerWorkspace> {
  requireOrganizer(caller);
  const eventId = caller.event._id;
  const contact = await ctx.db.get("eventContacts", eventContactId);
  if (contact === null || contact.eventId !== eventId) {
    notFound("speaker", "No such speaker on this event.");
  }

  const { rows: participants, capped } = await takeCapped(
    ctx.db
      .query("sessionParticipants")
      .withIndex("by_eventContactId", (q) =>
        q.eq("eventContactId", eventContactId),
      ),
    PARTICIPATION_LIST,
  );

  // The index is keyed by contact, not by event, so a participation on another
  // event's session would arrive here. Drop it before its session is even read.
  const mine = participants.filter((p) => p.eventId === eventId);

  // One batched read for every distinct session, rather than a `get` per
  // participation inside the loop. Duplicates are real: a co-host can hold two
  // participations on the same session.
  const sessions = await getManyById(ctx, "sessions", [
    ...new Set(mine.map((p) => p.sessionId)),
  ]);

  const rows: SpeakerWorkspaceSession[] = [];
  for (const participant of mine) {
    const session = sessions.get(participant.sessionId);
    // A session on another event is a malformed edge — dropped, never shown:
    // its title would otherwise cross the event boundary through this list.
    if (session === undefined || session.eventId !== eventId) continue;
    rows.push({
      participantId: participant._id,
      sessionId: session._id,
      title: session.title,
      format: session.format,
      role: participant.role,
      state: participant.state,
      ack: participant.ack,
      status: session.status,
      // Absent means approved: rows that predate content approval were always
      // being served. Same fallback as the sessions table and computeProgram.
      contentStatus: session.contentStatus === "draft" ? "draft" : "approved",
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      released: session.releasedSlot !== undefined,
    });
  }
  rows.sort((a, b) => a.title.localeCompare(b.title));

  const missingBio = blank(contact.bio);
  const missingTagline = blank(contact.tagline);
  const missingHeadshot = contact.headshotId === undefined;
  const reasons: string[] = [];
  if (missingBio) {
    reasons.push("No bio — the public program prints an empty entry.");
  }
  if (missingHeadshot) {
    reasons.push("No headshot — the program falls back to initials.");
  }
  if (missingTagline) {
    reasons.push("No tagline — the line under their name would be blank.");
  }
  if (blank(contact.email)) {
    reasons.push("No email address — nothing StageStack sends can reach them.");
  }
  if (contact.userId === undefined) {
    reasons.push(
      "The speaker portal has not been claimed — they cannot fill anything in themselves yet.",
    );
  }

  return {
    eventContactId: contact._id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    tagline: contact.tagline,
    jobTitle: contact.jobTitle,
    company: contact.company,
    bio: contact.bio,
    links: contact.links,
    headshotUrl:
      contact.headshotId === undefined
        ? null
        : await ctx.storage.getUrl(contact.headshotId),
    claimed: contact.userId !== undefined,
    customValues: contact.customValues ?? {},
    sessions: rows,
    sessionsTruncated: capped,
    readiness: { missingBio, missingHeadshot, missingTagline, reasons },
  };
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

export type SessionWorkspaceParticipant = {
  participantId: Id<"sessionParticipants">;
  eventContactId: Id<"eventContacts">;
  firstName: string;
  lastName: string;
  email?: string;
  tagline?: string;
  headshotUrl: string | null;
  role: string;
  state: Doc<"sessionParticipants">["state"];
  ack?: Doc<"sessionParticipants">["ack"];
};

export type SessionWorkspace = {
  session: Doc<"sessions">;
  roomName: string | null;
  participants: SessionWorkspaceParticipant[];
  /** The proposal this session was materialized from, when it came from a CFP. */
  proposal: {
    proposalId: Id<"proposals">;
    title: string;
    status: string;
    submittedAt?: number;
    submitterName: string | null;
    submitterEmail: string | null;
  } | null;
  /** Verbatim from `publicationState` — the same producer the table prints. */
  publication: Publication;
};

export async function sessionWorkspace(
  ctx: QueryCtx,
  caller: EventCaller,
  sessionId: Id<"sessions">,
): Promise<SessionWorkspace> {
  requireOrganizer(caller);
  const eventId = caller.event._id;
  const session = await ctx.db.get("sessions", sessionId);
  if (session === null || session.eventId !== eventId) {
    notFound("session", "No such session on this event.");
  }

  const participantDocs = (
    await takeAll(
      ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId)),
      SESSION_PARTICIPANT_SCAN,
      "participants on one session",
    )
  ).filter((p) => p.eventId === eventId);

  // Contacts, room, proposal and the storage URLs all in one parallel pass.
  const [contacts, room, proposal] = await Promise.all([
    getManyById(ctx, "eventContacts", [
      ...new Set(participantDocs.map((p) => p.eventContactId)),
    ]),
    session.roomId === undefined
      ? Promise.resolve(null)
      : ctx.db.get("rooms", session.roomId),
    loadSourceProposal(ctx, eventId, session.proposalId),
  ]);

  // One `getUrl` per DISTINCT headshot, resolved in parallel rather than
  // awaited inside the participant loop.
  const headshotIds = [
    ...new Set(
      [...contacts.values()]
        .filter((c) => c.eventId === eventId && c.headshotId !== undefined)
        .map((c) => c.headshotId as Id<"_storage">),
    ),
  ];
  const headshotUrls = new Map(
    await Promise.all(
      headshotIds.map(
        async (id) => [id, await ctx.storage.getUrl(id)] as const,
      ),
    ),
  );

  const participants: SessionWorkspaceParticipant[] = [];
  for (const participant of participantDocs) {
    const contact = contacts.get(participant.eventContactId);
    // A contact belonging to another event is a malformed edge; the
    // participation is dropped rather than rendered with a borrowed name.
    if (contact === undefined || contact.eventId !== eventId) continue;
    participants.push({
      participantId: participant._id,
      eventContactId: participant.eventContactId,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      tagline: contact.tagline,
      headshotUrl:
        contact.headshotId === undefined
          ? null
          : (headshotUrls.get(contact.headshotId) ?? null),
      role: participant.role,
      state: participant.state,
      ack: participant.ack,
    });
  }

  return {
    session,
    // A room from another event would be a data error; refuse to name it.
    roomName: room !== null && room.eventId === eventId ? room.name : null,
    participants,
    proposal,
    publication: publicationState(session, {
      lineupPublished: caller.event.publicPageEnabled === true,
      agendaPublished: await flagFor(ctx, eventId, "agenda", "event"),
      sessionPublished: await flagFor(ctx, eventId, "session", session._id),
      // The publication rule counts the session's REAL participations, so it
      // gets the event-scoped docs — not the display rows above, which also
      // drop anyone whose contact went missing.
      participants: participantDocs,
    }),
  };
}

async function loadSourceProposal(
  ctx: QueryCtx,
  eventId: Id<"events">,
  proposalId: Id<"proposals"> | undefined,
): Promise<SessionWorkspace["proposal"]> {
  if (proposalId === undefined) return null;
  const doc = await ctx.db.get("proposals", proposalId);
  // A proposal from another event would be a data error; refuse to show it
  // rather than leak a title across the event boundary.
  if (doc === null || doc.eventId !== eventId) return null;
  const submitter = await ctx.db.get("users", doc.submitterUserId);
  return {
    proposalId: doc._id,
    title: doc.title,
    status: doc.status,
    submittedAt: doc.submittedAt,
    submitterName: submitter?.name ?? null,
    submitterEmail: submitter?.email ?? null,
  };
}

/**
 * Read a deduped set of ids in one parallel batch.
 *
 * The alternative — `await ctx.db.get(...)` inside the render loop — is a
 * serial round trip per row, and the row count is attacker-adjacent (it is
 * however many participations a record happens to have). The caller has
 * already bounded the id list; this just stops it being sequential.
 */
async function getManyById<
  T extends "sessions" | "eventContacts",
>(
  ctx: QueryCtx,
  table: T,
  ids: Array<Id<T>>,
): Promise<Map<Id<T>, Doc<T>>> {
  const docs = await Promise.all(ids.map((id) => ctx.db.get(table, id)));
  const map = new Map<Id<T>, Doc<T>>();
  for (const doc of docs) {
    if (doc !== null) map.set(doc._id as Id<T>, doc as Doc<T>);
  }
  return map;
}

/**
 * One publication flag, by point read.
 *
 * `publicationFlags` in model/publish.ts builds the whole event's map because
 * its callers need every flag; a workspace needs exactly two, and reading the
 * event's flag table to answer one question would be the N+1 in reverse.
 */
async function flagFor(
  ctx: QueryCtx,
  eventId: Id<"events">,
  targetType: string,
  targetId: string,
): Promise<boolean> {
  const flag = await ctx.db
    .query("publicationFlags")
    .withIndex("by_eventId_and_target", (q) =>
      q
        .eq("eventId", eventId)
        .eq("targetType", targetType)
        .eq("targetId", targetId),
    )
    .unique();
  return flag?.published ?? false;
}
