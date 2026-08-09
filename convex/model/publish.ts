import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { requireOrganizer } from "../lib/functions";
import { assertEventActive } from "./validation";
import { logAudit } from "./audit";

// ─────────────────────────────────────────────────────────────────────────
// Public program (M7). StageStack stays authoritative; the public page, read
// API and embeds are read-only COPIES of one shared published projection
// (decision log #12). `publishProgram` recomputes the whole `program` blob
// from current publication flags + confirmed state and bumps the version.
// The public read path (convex/publicProgram.ts + convex/http.ts) serves that
// blob verbatim, so page/API/embed can never disagree, and it does zero
// authorization because the blob is already privacy-filtered here.
//
// Lineup and agenda publish INDEPENDENTLY (decision log #13):
//   * publishing the lineup exposes accepted sessions + confirmed speaker
//     profiles, no slots required;
//   * publishing the agenda exposes only released + slotted sessions and
//     agenda items.
// Only Confirmed participants appear by name/profile; everyone else is
// "speaker to be announced". Backstage/host links never enter the blob.
// ─────────────────────────────────────────────────────────────────────────

const SESSION_SCAN = 1000;
const PARTICIPANT_SCAN = 5000;
const AGENDA_SCAN = 500;
const FLAG_SCAN = 3000;

export type PublicSpeaker = {
  name: string;
  tagline?: string;
  bio?: string;
  headshotUrl?: string;
  links?: {
    website?: string;
    twitter?: string;
    linkedin?: string;
    github?: string;
  };
};

export type PublicSession = {
  sessionId: string;
  title: string;
  description?: string;
  format?: string;
  trackName?: string;
  /** Scheduling — present only when the session's slot is released. */
  startsAt?: number;
  endsAt?: number;
  roomName?: string;
  /** Named speakers are Confirmed only; `toBeAnnounced` covers the rest. */
  speakers: PublicSpeaker[];
  toBeAnnounced: boolean;
};

export type PublicAgendaItem = {
  itemId: string;
  title: string;
  startsAt: number;
  endsAt: number;
  roomName?: string;
  description?: string;
};

export type PublicProgram = {
  event: {
    name: string;
    slug: string;
    startsAt: number;
    endsAt: number;
    timezone: string;
    location?: string;
    description?: string;
    website?: string;
    logoUrl?: string;
  };
  lineupPublished: boolean;
  agendaPublished: boolean;
  /** Accepted sessions + confirmed speakers (lineup). Slot info is filled in
   * only for sessions whose slot is also released. */
  lineup: PublicSession[];
  /** Released+slotted sessions and agenda items, time-ordered (agenda grid). */
  agenda: Array<
    | ({ kind: "session" } & PublicSession)
    | ({ kind: "item" } & PublicAgendaItem)
  >;
};

const flagKey = (targetType: string, targetId: string) =>
  `${targetType}:${targetId}`;

async function publicationFlags(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Map<string, boolean>> {
  const flags = await ctx.db
    .query("publicationFlags")
    .withIndex("by_eventId_and_target", (q) => q.eq("eventId", eventId))
    .take(FLAG_SCAN);
  const map = new Map<string, boolean>();
  for (const f of flags) map.set(flagKey(f.targetType, f.targetId), f.published);
  return map;
}

function isPublished(
  flags: Map<string, boolean>,
  targetType: string,
  targetId: string,
  fallback: boolean,
): boolean {
  return flags.get(flagKey(targetType, targetId)) ?? fallback;
}

/**
 * Compute the published projection from live state. Pure over reads: builds
 * exactly what the public should see given the current flags + confirmations,
 * with no private fields anywhere in the result.
 */
export async function computeProgram(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<PublicProgram> {
  const eventId = event._id;
  const flags = await publicationFlags(ctx, eventId);
  const lineupPublished = event.publicPageEnabled === true;
  const agendaPublished = isPublished(flags, "agenda", "event", false);

  const [sessions, agendaItems, tracks, rooms] = await Promise.all([
    ctx.db
      .query("sessions")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(SESSION_SCAN),
    ctx.db
      .query("agendaItems")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(AGENDA_SCAN),
    ctx.db
      .query("tracks")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(500),
    ctx.db
      .query("rooms")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(500),
  ]);
  const trackName = new Map(tracks.map((t) => [t._id, t.name]));
  const roomName = new Map(rooms.map((r) => [r._id, r.name]));

  const logoUrl =
    event.logoId === undefined
      ? undefined
      : ((await ctx.storage.getUrl(event.logoId)) ?? undefined);

  const lineup: PublicSession[] = [];
  const agenda: PublicProgram["agenda"] = [];

  for (const session of sessions) {
    if (session.status !== "planned") continue;
    // A session is in the public lineup only when explicitly published; its
    // per-session flag defaults to false so nothing leaks by accident.
    const sessionPublic = isPublished(flags, "session", session._id, false);
    if (!sessionPublic) continue;

    const participants = await ctx.db
      .query("sessionParticipants")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
      .take(PARTICIPANT_SCAN);
    const confirmed = participants.filter((p) => p.state === "confirmed");

    const speakers: PublicSpeaker[] = [];
    for (const p of confirmed) {
      const contact = await ctx.db.get("eventContacts", p.eventContactId);
      if (contact === null) continue;
      // A speaker's profile is only publishable when they've confirmed; the
      // organizer publishing the session is what makes it eligible (no
      // separate profile-approval state in v1).
      speakers.push({
        name: `${contact.firstName} ${contact.lastName}`.trim(),
        tagline: contact.tagline,
        bio: contact.bio,
        headshotUrl:
          contact.headshotId === undefined
            ? undefined
            : ((await ctx.storage.getUrl(contact.headshotId)) ?? undefined),
        links: contact.links,
      });
    }

    const released = session.releasedSlot;
    const publicSession: PublicSession = {
      sessionId: session._id,
      title: session.title,
      description: session.description,
      format: session.format,
      trackName:
        session.trackId === undefined
          ? undefined
          : trackName.get(session.trackId),
      startsAt: released?.startsAt,
      endsAt: released?.endsAt,
      roomName:
        released?.roomId === undefined
          ? undefined
          : roomName.get(released.roomId),
      speakers,
      // "a session may still publish with confirmed participants and a speaker
      // to be announced placeholder" — TBA when there's an unconfirmed slot.
      toBeAnnounced:
        confirmed.length === 0 ||
        participants.some((p) => p.state === "awaiting"),
    };
    lineup.push(publicSession);

    // The agenda grid only carries released + slotted sessions.
    if (agendaPublished && released !== undefined) {
      agenda.push({ kind: "session", ...publicSession });
    }
  }

  if (agendaPublished) {
    for (const item of agendaItems) {
      if (!isPublished(flags, "agendaItem", item._id, false)) continue;
      agenda.push({
        kind: "item",
        itemId: item._id,
        title: item.title,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        roomName:
          item.roomId === undefined ? undefined : roomName.get(item.roomId),
        description: item.description,
      });
    }
  }

  agenda.sort((a, b) => {
    const at = a.kind === "session" ? (a.startsAt ?? 0) : a.startsAt;
    const bt = b.kind === "session" ? (b.startsAt ?? 0) : b.startsAt;
    return at - bt;
  });
  lineup.sort((a, b) => a.title.localeCompare(b.title));

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
      logoUrl,
    },
    lineupPublished,
    agendaPublished,
    lineup: lineupPublished ? lineup : [],
    agenda: agendaPublished ? agenda : [],
  };
}

/** The program is one document (schema: publishedPrograms.program), so it must
 * stay under Convex's 1MiB document cap. Guard well below it: past this, an
 * explicit publish is refused with the largest sessions named, so the fix
 * (unpublish some of them) is obvious. Unpublishing always passes the guard —
 * the flag flip lands before the recompute in the same transaction, so the
 * recomputed blob no longer contains the unpublished content. */
const MAX_PROGRAM_BYTES = 900 * 1024;

function assertProgramFits(program: PublicProgram): void {
  const bytes = new TextEncoder().encode(JSON.stringify(program)).length;
  if (bytes <= MAX_PROGRAM_BYTES) return;
  const largest = [...program.lineup]
    .map((s) => ({ title: s.title, bytes: JSON.stringify(s).length }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((s) => `"${s.title}" (~${Math.round(s.bytes / 1024)}KB)`);
  throw new ConvexError({
    code: "program_too_large",
    message:
      `The published program is too large to serve (${Math.round(bytes / 1024)}KB). ` +
      `Unpublish some sessions and try again — the largest are ${largest.join(", ")}.`,
  });
}

/** Recompute and persist the published projection. This is the primary writer
 * of publishedPrograms; every publish/unpublish action ends by calling it so
 * the served blob always matches the current flags. */
export async function republish(
  ctx: MutationCtx,
  caller: EventCaller,
): Promise<number> {
  requireOrganizer(caller);
  // Re-read the event: a publish action may have just patched it
  // (publicPageEnabled), and caller.event is the pre-mutation snapshot.
  const event = (await ctx.db.get("events", caller.event._id)) ?? caller.event;
  const program = await computeProgram(ctx, event);
  assertProgramFits(program);
  const existing = await ctx.db
    .query("publishedPrograms")
    .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
    .unique();
  const version = (existing?.version ?? 0) + 1;
  const doc = {
    eventId: caller.event._id,
    version,
    publishedAt: Date.now(),
    publishedBy: caller.user._id,
    program,
  };
  if (existing === null) {
    await ctx.db.insert("publishedPrograms", doc);
  } else {
    await ctx.db.replace("publishedPrograms", existing._id, doc);
  }
  return version;
}

/**
 * Rewrite the served blob IF one exists — the deliberate exception to the
 * "stored blob, explicit publish" design (decision log #12). Editorial changes
 * wait for the organizer's explicit republish, but a transition that revokes a
 * person's public presence (withdraw/decline) or the event's identity (slug/
 * name rename) must propagate immediately: the stale blob would keep serving a
 * name whose owner withdrew, or an identity that no longer exists. A never-
 * published event stays unpublished.
 *
 * No requireOrganizer — the actor may be a portal speaker withdrawing; the
 * caller has already authorized the underlying transition. No size guard —
 * suppressions only shrink the blob, and a rename's growth is bounded far
 * below the guard's headroom; a privacy transition must never be blocked.
 */
export async function republishIfPublished(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<void> {
  const existing = await ctx.db
    .query("publishedPrograms")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .unique();
  if (existing === null) return;
  const event = await ctx.db.get("events", eventId);
  if (event === null) return;
  const program = await computeProgram(ctx, event);
  await ctx.db.replace("publishedPrograms", existing._id, {
    eventId,
    version: existing.version + 1,
    publishedAt: Date.now(),
    // The last explicit publisher stays on record: this rewrite is a forced
    // privacy propagation, not a new editorial decision.
    publishedBy: existing.publishedBy,
    program,
  });
}

async function setFlag(
  ctx: MutationCtx,
  eventId: Id<"events">,
  targetType: string,
  targetId: string,
  published: boolean,
): Promise<void> {
  const existing = await ctx.db
    .query("publicationFlags")
    .withIndex("by_eventId_and_target", (q) =>
      q
        .eq("eventId", eventId)
        .eq("targetType", targetType)
        .eq("targetId", targetId),
    )
    .unique();
  if (existing === null) {
    await ctx.db.insert("publicationFlags", {
      eventId,
      targetType,
      targetId,
      published,
      updatedAt: Date.now(),
    });
  } else {
    await ctx.db.patch("publicationFlags", existing._id, {
      published,
      updatedAt: Date.now(),
    });
  }
}

export type PublishAction =
  | { kind: "lineup"; enabled: boolean }
  | { kind: "agenda"; enabled: boolean }
  | { kind: "session"; sessionId: Id<"sessions">; published: boolean }
  | { kind: "agendaItem"; itemId: Id<"agendaItems">; published: boolean };

/** Flip one publication control, then rewrite the served projection. */
export async function publish(
  ctx: MutationCtx,
  caller: EventCaller,
  action: PublishAction,
): Promise<number> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const eventId = caller.event._id;
  switch (action.kind) {
    case "lineup":
      // The public event page toggle also gates the lineup section.
      await ctx.db.patch("events", eventId, {
        publicPageEnabled: action.enabled,
      });
      break;
    case "agenda":
      await setFlag(ctx, eventId, "agenda", "event", action.enabled);
      break;
    case "session": {
      const session = await ctx.db.get("sessions", action.sessionId);
      if (session === null || session.eventId !== eventId) {
        throw new ConvexError({ code: "not_found", message: "No such session." });
      }
      await setFlag(ctx, eventId, "session", action.sessionId, action.published);
      break;
    }
    case "agendaItem": {
      const item = await ctx.db.get("agendaItems", action.itemId);
      if (item === null || item.eventId !== eventId) {
        throw new ConvexError({ code: "not_found", message: "No such item." });
      }
      await setFlag(ctx, eventId, "agendaItem", action.itemId, action.published);
      break;
    }
  }
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId,
    actorUserId: caller.user._id,
    action: "publish." + action.kind,
    meta: action,
  });
  // Republishing after every flag change keeps the served blob authoritative;
  // an unpublish is just a flag flip + rewrite (decision log #11).
  return await republish(ctx, caller);
}

export type PublishState = {
  lineupPublished: boolean;
  agendaPublished: boolean;
  version: number | null;
  publishedAt: number | null;
  publishedSessionIds: string[];
  publishedAgendaItemIds: string[];
  /** Live counts to drive the organizer's publish console. */
  acceptedSessions: number;
  releasedSessions: number;
};

/** The organizer's view of what's public and what could be. */
export async function publishState(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<PublishState> {
  requireOrganizer(caller);
  const eventId = caller.event._id;
  const [flags, published, sessions] = await Promise.all([
    publicationFlags(ctx, eventId),
    ctx.db
      .query("publishedPrograms")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .unique(),
    ctx.db
      .query("sessions")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(SESSION_SCAN),
  ]);
  const planned = sessions.filter((s) => s.status === "planned");
  const publishedSessionIds: string[] = [];
  for (const [key, value] of flags) {
    if (value && key.startsWith("session:")) {
      publishedSessionIds.push(key.slice("session:".length));
    }
  }
  const publishedAgendaItemIds: string[] = [];
  for (const [key, value] of flags) {
    if (value && key.startsWith("agendaItem:")) {
      publishedAgendaItemIds.push(key.slice("agendaItem:".length));
    }
  }
  return {
    lineupPublished: caller.event.publicPageEnabled === true,
    agendaPublished: isPublished(flags, "agenda", "event", false),
    version: published?.version ?? null,
    publishedAt: published?.publishedAt ?? null,
    publishedSessionIds,
    publishedAgendaItemIds,
    acceptedSessions: planned.length,
    releasedSessions: planned.filter((s) => s.releasedSlot !== undefined).length,
  };
}

/** The served projection for the public read path. Null when nothing has ever
 * been published (or the event is archived). Serves the STORED blob, never a
 * live recompute — the last explicitly published version (decision log #12). */
export async function publicProgramBySlug(
  ctx: QueryCtx,
  slug: string,
): Promise<PublicProgram | null> {
  const event = await ctx.db
    .query("events")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  if (event === null || event.archivedAt !== undefined) return null;
  const published = await ctx.db
    .query("publishedPrograms")
    .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
    .unique();
  if (published === null) return null;
  const program = published.program as PublicProgram;
  // Respect a later "turn the whole page off": if the organizer disabled the
  // public page after publishing, serve nothing.
  if (!program.lineupPublished && !program.agendaPublished) return null;
  return program;
}
