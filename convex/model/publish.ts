import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { requireOrganizer } from "../lib/functions";
import { assertEventActive, takeAll } from "./validation";
import { logAudit } from "./audit";
import { formatLabel, formatsById } from "./library";

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
const CONTACT_SCAN = 2000;
const AGENDA_SCAN = 500;
const FLAG_SCAN = 3000;
const LIBRARY_SCAN = 500;

// Every read feeding the published projection goes through `takeAll` (shared
// with the rest of the backend, ./validation): a plain `.take(cap)` would
// silently drop the overflow and the public program would quietly lose
// sessions — worse than a loud failure, the same judgment `comms.sendOneOff`
// applies to a capped audience. NB `takeAll` throws `event_too_large`;
// `takeCapped` from the same module RETURNS a `capped` flag instead. Publishing
// must never be the fail-silent one, so this file wants `takeAll`.

export type PublicSpeaker = {
  /** Opaque stable id (the event-contact id) so widgets can group one
   * person's sessions across the blob. Carries no access. */
  speakerId: string;
  name: string;
  tagline?: string;
  jobTitle?: string;
  company?: string;
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

/** The event's publication flags, keyed `targetType:targetId`. Exported for
 * model/readiness.ts, which derives the publication VOCABULARY from the same
 * rows this file publishes from — the two must never read different state. */
export async function publicationFlags(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Map<string, boolean>> {
  const flags = await takeAll(
    ctx.db
      .query("publicationFlags")
      .withIndex("by_eventId_and_target", (q) => q.eq("eventId", eventId)),
    FLAG_SCAN,
    "publication flags",
  );
  const map = new Map<string, boolean>();
  for (const f of flags)
    map.set(flagKey(f.targetType, f.targetId), f.published);
  return map;
}

export function isPublished(
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
  /**
   * Answer for a HYPOTHETICAL flag state instead of the stored one (W10, the
   * diff preview only — nothing that writes the blob passes this).
   *
   * The publish center's channel action is "publish this channel with
   * everything currently eligible", and its confirmation has to say what that
   * will do BEFORE it happens. Read from the stored flags the answer is always
   * "nothing changes": the channel's master switch is off, or the new session's
   * own toggle is, right up until the click. So the would-be projection assumes
   * the action's own effects — the master switch on, and every per-entry flag
   * on — and lets the REST of the gates (planned, content approved, slot
   * released) decide what actually lands. Those gates are the eligibility rule,
   * which is why `model/publishBulk.ts` can derive the same set from
   * `whyNotPublic` and land on the same rows.
   */
  assume?: Partial<{
    lineupPublished: boolean;
    agendaPublished: boolean;
    /** Treat every session/agenda-item publication flag as on. */
    everyEligibleEntry: boolean;
  }>,
): Promise<PublicProgram> {
  const eventId = event._id;
  const flags = await publicationFlags(ctx, eventId);
  const lineupPublished =
    assume?.lineupPublished ?? event.publicPageEnabled === true;
  const agendaPublished =
    assume?.agendaPublished ?? isPublished(flags, "agenda", "event", false);
  const entryPublished = (targetType: string, targetId: string): boolean =>
    assume?.everyEligibleEntry === true ||
    isPublished(flags, targetType, targetId, false);

  // ONE read per table, grouped in memory (the shape audiences.loadEventState
  // uses). Reading participants per session and contacts per participant made
  // the rebuild an N+1: a 500-session event issued ~500 queries plus a `get`
  // per speaker slot, and the same contact was fetched once per session they
  // speak in — all inside a single transaction.
  const [sessions, agendaItems, tracks, rooms, participants, contacts] =
    await Promise.all([
      takeAll(
        ctx.db
          .query("sessions")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        SESSION_SCAN,
        "sessions",
      ),
      takeAll(
        ctx.db
          .query("agendaItems")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        AGENDA_SCAN,
        "agenda items",
      ),
      takeAll(
        ctx.db
          .query("tracks")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        LIBRARY_SCAN,
        "tracks",
      ),
      takeAll(
        ctx.db
          .query("rooms")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        LIBRARY_SCAN,
        "rooms",
      ),
      takeAll(
        ctx.db
          .query("sessionParticipants")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        PARTICIPANT_SCAN,
        "participations",
      ),
      takeAll(
        ctx.db
          .query("eventContacts")
          .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
        CONTACT_SCAN,
        "speaker profiles",
      ),
    ]);
  const trackName = new Map(tracks.map((t) => [t._id, t.name]));
  const roomName = new Map(rooms.map((r) => [r._id, r.name]));
  // The public blob carries the RENDERED format label — the library row's name
  // when the session is linked, the free text otherwise — so every widget goes
  // on reading one `format` string and a library rename reaches the public
  // page without touching the sessions.
  const formatById = await formatsById(ctx, eventId);
  const contactById = new Map(contacts.map((c) => [c._id, c]));
  // `by_eventId` and `by_sessionId` both order by `_creationTime` within their
  // prefix, so grouping the event-wide read preserves the per-session order the
  // old per-session query returned — the projection stays byte-identical.
  const participantsBySession = new Map<
    Id<"sessions">,
    Array<Doc<"sessionParticipants">>
  >();
  for (const participant of participants) {
    const group = participantsBySession.get(participant.sessionId);
    if (group === undefined) {
      participantsBySession.set(participant.sessionId, [participant]);
    } else {
      group.push(participant);
    }
  }

  // One signed URL per storage id: the same speaker headshot appears in every
  // session they speak in, and each `getUrl` is a round trip.
  const urlCache = new Map<Id<"_storage">, string | undefined>();
  const storageUrl = async (
    id: Id<"_storage">,
  ): Promise<string | undefined> => {
    const cached = urlCache.get(id);
    if (cached !== undefined || urlCache.has(id)) return cached;
    const url = (await ctx.storage.getUrl(id)) ?? undefined;
    urlCache.set(id, url);
    return url;
  };

  const logoUrl =
    event.logoId === undefined ? undefined : await storageUrl(event.logoId);

  const lineup: PublicSession[] = [];
  const agenda: PublicProgram["agenda"] = [];

  for (const session of sessions) {
    if (session.status !== "planned") continue;
    // Content approval (W5, CNT-12): a session whose content is still draft
    // never reaches public output, whatever its publish flag says. Legacy
    // rows (no contentStatus) count as approved.
    if (session.contentStatus === "draft") continue;
    // A session is in the public lineup only when explicitly published; its
    // per-session flag defaults to false so nothing leaks by accident.
    const sessionPublic = entryPublished("session", session._id);
    if (!sessionPublic) continue;

    const sessionParticipants = participantsBySession.get(session._id) ?? [];
    const confirmed = sessionParticipants.filter(
      (p) => p.state === "confirmed",
    );

    const speakers: PublicSpeaker[] = [];
    for (const p of confirmed) {
      const contact = contactById.get(p.eventContactId);
      if (contact === undefined) continue;
      // A speaker's profile is only publishable when they've confirmed; the
      // organizer publishing the session is what makes it eligible (no
      // separate profile-approval state in v1).
      speakers.push({
        speakerId: contact._id,
        name: `${contact.firstName} ${contact.lastName}`.trim(),
        tagline: contact.tagline,
        jobTitle: contact.jobTitle,
        company: contact.company,
        bio: contact.bio,
        headshotUrl:
          contact.headshotId === undefined
            ? undefined
            : await storageUrl(contact.headshotId),
        links: contact.links,
      });
    }

    const released = session.releasedSlot;
    const publicSession: PublicSession = {
      sessionId: session._id,
      title: session.title,
      description: session.description,
      format: formatLabel(session, formatById),
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
        sessionParticipants.some((p) => p.state === "awaiting"),
    };
    lineup.push(publicSession);

    // The agenda grid only carries released + slotted sessions.
    if (agendaPublished && released !== undefined) {
      agenda.push({ kind: "session", ...publicSession });
    }
  }

  if (agendaPublished) {
    for (const item of agendaItems) {
      if (!entryPublished("agendaItem", item._id)) continue;
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
 * (unpublish some of them) is obvious. A strict reduction always passes, even
 * when a legacy projection remains above the soft limit, so removal can never
 * be trapped behind the guard. */
const MAX_PROGRAM_BYTES = 900 * 1024;

function programBytes(program: PublicProgram): number {
  return new TextEncoder().encode(JSON.stringify(program)).length;
}

export function assertProgramFits(
  program: PublicProgram,
  existing?: PublicProgram,
): void {
  const bytes = programBytes(program);
  // A legacy projection may predate the 900KiB soft guard while still fitting
  // under Convex's 1MiB document cap. Never let the soft guard trap privacy
  // removal: an oversized replacement may land only when it is a strict byte
  // reduction. Equal-size and growing oversized replacements remain refused.
  if (
    bytes <= MAX_PROGRAM_BYTES ||
    (existing !== undefined && bytes < programBytes(existing))
  ) {
    return;
  }
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

/** Order-independent serialization, used only to answer "would this rebuild
 * change the served bytes?" — the database is free to hand object fields back
 * in a different order than we built them, and that must not read as a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Recompute and persist the published projection — the ONLY writer of
 * publishedPrograms. Runs in its own transaction, scheduled by whatever changed
 * the underlying state (see `requestRebuild`), because a rebuild reads the whole
 * event graph and must not be charged to the mutation that flipped one flag.
 *
 * `publishedBy` set  = an explicit organizer publish: it CREATES the row for a
 *   never-published event, records the publisher, and enforces the size guard.
 * `publishedBy` unset = a forced propagation (withdraw/decline/rename/profile):
 *   it only rewrites an EXISTING blob and keeps the last explicit publisher on
 *   record. The size guard still refuses oversized growth and equal-size
 *   replacements, while strict reductions remain possible so privacy removal
 *   cannot leave the previous projection stale.
 *
 * Idempotent by construction: it recomputes from current state rather than
 * applying a delta, so running it twice — or out of order with another rebuild —
 * converges on the same bytes. Returns the version now served, or null when
 * there was nothing to publish.
 */
export async function rebuildProgram(
  ctx: MutationCtx,
  eventId: Id<"events">,
  publishedBy?: Id<"users">,
): Promise<number | null> {
  const event = await ctx.db.get("events", eventId);
  if (event === null) return null;
  const existing = await ctx.db
    .query("publishedPrograms")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .unique();

  if (existing === null) {
    // A never-published event stays unpublished: only an explicit publish
    // (which carries the publisher) may create the row.
    if (publishedBy === undefined) return null;
    const program = await computeProgram(ctx, event);
    assertProgramFits(program);
    await ctx.db.insert("publishedPrograms", {
      eventId,
      version: 1,
      publishedAt: Date.now(),
      publishedBy,
      program,
    });
    return 1;
  }

  const program = await computeProgram(ctx, event);
  assertProgramFits(program, existing.program as PublicProgram);
  // Coalescing: several flag flips in quick succession each schedule a rebuild,
  // and every rebuild after the first recomputes the same bytes. Skipping the
  // write there costs nothing (the served blob is already right) and avoids both
  // a meaningless version bump and OCC contention on this single row.
  if (canonical(existing.program) === canonical(program))
    return existing.version;
  const version = existing.version + 1;
  await ctx.db.replace("publishedPrograms", existing._id, {
    eventId,
    version,
    publishedAt: Date.now(),
    // On a forced propagation the last explicit publisher stays on record: the
    // rewrite is a privacy/identity consequence, not a new editorial decision.
    publishedBy: publishedBy ?? existing.publishedBy,
    program,
  });
  return version;
}

/**
 * Ask for a rebuild instead of doing one inline. `ctx.scheduler.runAfter(0, …)`
 * only runs the job once THIS transaction commits, so the rebuild scheduled by
 * the last state change always observes that change — which is all correctness
 * needs, since `rebuildProgram` recomputes from scratch (a rebuild that runs
 * late just recomputes the newer state; one that lands out of order writes the
 * same bytes, and concurrent rebuilds serialize on the single publishedPrograms
 * row). What this buys: a per-session flag flip, a withdrawal or a decline pays
 * for its own writes only, never for an O(event) projection rebuild.
 *
 * No requireOrganizer — the actor may be a portal speaker withdrawing; the
 * caller has already authorized the underlying transition.
 */
export async function requestRebuild(
  ctx: MutationCtx,
  eventId: Id<"events">,
  publishedBy?: Id<"users">,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.publish.rebuild, {
    eventId,
    publishedBy,
  });
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
 * Inline (same transaction) variant, kept for callers whose own transaction is
 * already small and which want the rewrite visible to their own reader: the
 * portal's speaker-driven transitions go through `requestRebuild` instead, so a
 * speaker's click never pays for a full rebuild.
 */
export async function republishIfPublished(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<void> {
  await rebuildProgram(ctx, eventId);
}

export async function setFlag(
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

/** Flip one publication control and ask for the served projection to be
 * rewritten. Publication intent is independent from editorial approval: a
 * session flag may be enabled while its draft content remains held back.
 * Rewriting after every flag change keeps the served blob authoritative; an
 * unpublish is just a flag flip + rewrite (decision log #11).
 * The rewrite is SCHEDULED, not inline: this mutation is one small write, while
 * the rebuild reads the whole event graph, and a publish console flipping fifty
 * sessions must not run fifty full rebuilds inside fifty user-facing mutations.
 * The new version therefore lands a moment later — `publishState` (and the
 * console's version badge) reports it once it has. */
export async function publish(
  ctx: MutationCtx,
  caller: EventCaller,
  action: PublishAction,
): Promise<void> {
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
        throw new ConvexError({
          code: "not_found",
          message: "No such session.",
        });
      }
      await setFlag(
        ctx,
        eventId,
        "session",
        action.sessionId,
        action.published,
      );
      break;
    }
    case "agendaItem": {
      const item = await ctx.db.get("agendaItems", action.itemId);
      if (item === null || item.eventId !== eventId) {
        throw new ConvexError({ code: "not_found", message: "No such item." });
      }
      await setFlag(
        ctx,
        eventId,
        "agendaItem",
        action.itemId,
        action.published,
      );
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
  // The size guard must reach the ORGANIZER, not a scheduled job: an explicit
  // publish that would produce an unservable program is refused right here,
  // naming the largest sessions, and the flag flip rolls back with it. That is
  // worth a recompute in this transaction — publish clicks are rare, and the
  // alternative (a job throwing into the void while the console reports success)
  // would make the failure invisible. Re-read the event first: the lineup case
  // just patched it and `caller.event` is the pre-mutation snapshot.
  //
  // A SHRINKING action (unpublish/disable) always passes: refusing removal
  // because the REMAINING program is still oversized would trap the organizer
  // (codex — the M8 unpublish rule, restated for the action shape).
  const shrinking =
    ("enabled" in action && !action.enabled) ||
    ("published" in action && !action.published);
  if (!shrinking) {
    const event = (await ctx.db.get("events", eventId)) ?? caller.event;
    assertProgramFits(await computeProgram(ctx, event));
  }
  // The WRITE still happens off the hot path: one scheduled, idempotent rebuild
  // per flip, coalescing onto a single publishedPrograms row rewrite instead of
  // one rewrite (and one OCC conflict) per flip.
  await requestRebuild(ctx, eventId, caller.user._id);
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
  /**
   * The served blob no longer matches what a rebuild would produce right now.
   * Two things land here, and both mean "republish": editorial edits waiting for
   * an explicit publish (by design — decision log #12), and a SCHEDULED rebuild
   * that never landed because it threw (oversized program, an at-cap read). The
   * latter is why this exists at all: with the rewrite off the hot path, a failed
   * rebuild would otherwise leave the public program quietly behind with nobody
   * to tell. A rebuild that ran and found nothing to change leaves this FALSE —
   * "already correct" and "failed" must never look the same.
   */
  stale: boolean;
  /**
   * The projection under the CURRENT flags — the same object the `stale`
   * comparison above computed. The console renders this as its live preview,
   * so the page needs one projection for state+stale, not two.
   */
  preview: PublicProgram;
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
    // Same cap, same refusal as the projection itself: a console reporting
    // "412 accepted sessions" for an event that publishes fewer would be a lie.
    takeAll(
      ctx.db
        .query("sessions")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      SESSION_SCAN,
      "sessions",
    ),
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
  // Compared against a fresh projection rather than against timestamps: it is
  // the BYTES the public sees that matter. That same projection is what the
  // console previews, so compute it once and serve it back.
  const preview = await computeProgram(ctx, caller.event);
  const stale =
    published !== null && canonical(published.program) !== canonical(preview);
  return {
    lineupPublished: caller.event.publicPageEnabled === true,
    agendaPublished: isPublished(flags, "agenda", "event", false),
    stale,
    preview,
    version: published?.version ?? null,
    publishedAt: published?.publishedAt ?? null,
    publishedSessionIds,
    publishedAgendaItemIds,
    acceptedSessions: planned.length,
    releasedSessions: planned.filter((s) => s.releasedSlot !== undefined)
      .length,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Diff preview (W10). "What will publishing change?"
//
// HISTORY DECISION: diff-only, no schema change. `publishedPrograms` stays ONE
// row with one `version` per event, and any rebuild still rewrites both halves.
// What the publish center needed was never a per-channel version LOG — it was
// the answer to "what am I about to do", and that is derivable from the
// combined blob: `program.lineup` and `program.agenda` are already separate
// arrays, so a per-channel structural diff against the would-be projection
// costs one extra recompute and no new storage. A per-channel version history
// would need a second table, a second writer and a second thing to keep
// consistent with the served bytes — for a question nobody on the console asked.
//
// The read pattern is `publishState`'s: load the served blob, recompute fresh,
// compare. `publishState` reduces that to a boolean (`stale`); this reduces it
// to a structure. Both recompute rather than trusting timestamps, because it is
// the BYTES the public sees that matter.
// ─────────────────────────────────────────────────────────────────────────

/** Coarse buckets, one per thing an organizer would recognise on the public
 * page. Anything the projection grows later lands in `details` rather than
 * being silently dropped — a changed row must never be reported as unchanged. */
export type ProgramChangeField =
  | "title"
  | "format"
  | "track"
  | "description"
  | "speakers"
  | "slot"
  | "details";

/** Which bucket each projection field belongs to. `speakers` covers the
 * to-be-announced line because that IS the speaker line the public reads. */
const CHANGE_FIELD: Record<string, ProgramChangeField> = {
  title: "title",
  format: "format",
  trackName: "track",
  description: "description",
  speakers: "speakers",
  toBeAnnounced: "speakers",
  startsAt: "slot",
  endsAt: "slot",
  roomName: "slot",
};

const CHANGE_ORDER: ProgramChangeField[] = [
  "title",
  "format",
  "track",
  "description",
  "speakers",
  "slot",
  "details",
];

export type DiffEntry = {
  /** Session id or agenda-item id — the same opaque id the blob carries. */
  id: string;
  title: string;
  /** Populated for `changed` only, in a stable order. */
  changes: ProgramChangeField[];
};

export type ChannelDiff = {
  added: DiffEntry[];
  changed: DiffEntry[];
  removed: DiffEntry[];
  /** True when publishing this channel would change what the public SEES. */
  empty: boolean;
  /**
   * True when the publish action would have no effect whatsoever — which is
   * NOT the same as an empty diff.
   *
   * Turning on a channel that has nothing eligible yet changes no bytes and
   * still does something real: the channel is on, and the next eligible session
   * appears without a second decision. The mutation supports it, so the console
   * must not disable it. Only "already on, and nothing to serve differently"
   * is a genuine no-op.
   */
  doesNothing: boolean;
  /** How many entries this channel serves right now. */
  servedCount: number;
  /** How many it would serve after publishing. */
  wouldBeCount: number;
  /** Composed here and printed verbatim — the console re-words nothing. */
  sentence: string;
  /** The other direction, for the unpublish confirmation. */
  unpublishSentence: string;
};

export type ProgramDiff = {
  /** Nothing has ever been published: every entry is an addition. */
  neverPublished: boolean;
  lineup: ChannelDiff;
  agenda: ChannelDiff;
};

type DiffRow = { id: string; title: string; value: Record<string, unknown> };

function lineupRows(program: PublicProgram): DiffRow[] {
  return program.lineup.map((session) => ({
    id: session.sessionId,
    title: session.title,
    value: session as unknown as Record<string, unknown>,
  }));
}

function agendaRows(program: PublicProgram): DiffRow[] {
  return program.agenda.map((entry) => ({
    // Sessions and items share the agenda array; the kind keeps their ids in
    // separate namespaces so an item can never look like a changed session.
    id: entry.kind === "session" ? `session:${entry.sessionId}` : `item:${entry.itemId}`,
    title: entry.title,
    value: entry as unknown as Record<string, unknown>,
  }));
}

function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ProgramChangeField[] {
  const fields = new Set<ProgramChangeField>();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    // Ids are the join key, not a change; `kind` is part of the key too.
    if (key === "sessionId" || key === "itemId" || key === "kind") continue;
    if (canonical(before[key]) === canonical(after[key])) continue;
    fields.add(CHANGE_FIELD[key] ?? "details");
  }
  return CHANGE_ORDER.filter((field) => fields.has(field));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function diffChannel(
  channel: "lineup" | "agenda",
  served: DiffRow[],
  wouldBe: DiffRow[],
  /** Whether the channel's master switch is on right now. */
  channelPublished: boolean,
): ChannelDiff {
  const servedById = new Map(served.map((row) => [row.id, row]));
  const wouldById = new Map(wouldBe.map((row) => [row.id, row]));

  const added: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  const removed: DiffEntry[] = [];

  for (const row of wouldBe) {
    const before = servedById.get(row.id);
    if (before === undefined) {
      added.push({ id: row.id, title: row.title, changes: [] });
      continue;
    }
    const changes = changedFields(before.value, row.value);
    if (changes.length > 0) {
      changed.push({ id: row.id, title: row.title, changes });
    }
  }
  for (const row of served) {
    if (!wouldById.has(row.id)) {
      removed.push({ id: row.id, title: row.title, changes: [] });
    }
  }

  const noun = channel === "lineup" ? "session" : "entry";
  const nouns = channel === "lineup" ? "sessions" : "entries";
  const empty =
    added.length === 0 && changed.length === 0 && removed.length === 0;
  const fields = CHANGE_ORDER.filter((field) =>
    changed.some((entry) => entry.changes.includes(field)),
  );
  const label = channel === "lineup" ? "the lineup" : "the schedule";
  // An empty diff on a channel that is still OFF is not "nothing to do": the
  // action turns the channel on. Say exactly that instead of "no changes",
  // which would read as a reason not to press a button that does something.
  const enableOnly =
    channel === "lineup"
      ? "Turns the public page on. Nothing is eligible to appear yet."
      : "Publishes the schedule. Nothing is eligible to appear yet.";
  const sentence = empty
    ? channelPublished
      ? "No changes to publish."
      : enableOnly
    : `Publishing ${label} adds ${added.length} ${plural(added.length, noun, nouns)}, ` +
      `changes ${changed.length}${fields.length === 0 ? "" : ` (${fields.join(", ")})`}, ` +
      `removes ${removed.length}.`;
  const unpublishSentence =
    served.length === 0
      ? `Unpublishing ${label} removes nothing — it is not serving anything right now.`
      : `Unpublishing ${label} removes ${served.length} ${plural(served.length, noun, nouns)} from the public page.`;

  return {
    added,
    changed,
    removed,
    empty,
    doesNothing: empty && channelPublished,
    servedCount: served.length,
    wouldBeCount: wouldBe.length,
    sentence,
    unpublishSentence,
  };
}

/**
 * Per-channel structural diff between what is served and what publishing would
 * serve. Organizer-only: it reports, session by session, exactly what the
 * public program is about to gain, lose and change.
 *
 * The would-be side forces BOTH channel gates on, because the question the
 * console asks is "what would publishing this channel do", and with the gate
 * off the projection is empty by construction. It does NOT bypass the 1MiB
 * guard: no write happens here, and the guard still fires inside `publish`,
 * where the refusal can roll a flag flip back.
 */
export async function programDiff(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<ProgramDiff> {
  requireOrganizer(caller);
  const [published, flags, wouldBe] = await Promise.all([
    ctx.db
      .query("publishedPrograms")
      .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
      .unique(),
    publicationFlags(ctx, caller.event._id),
    computeProgram(ctx, caller.event, {
      lineupPublished: true,
      agendaPublished: true,
      everyEligibleEntry: true,
    }),
  ]);
  const served: PublicProgram | null =
    published === null ? null : (published.program as PublicProgram);
  const servedLineup = served === null ? [] : lineupRows(served);
  const servedAgenda = served === null ? [] : agendaRows(served);
  return {
    neverPublished: served === null,
    lineup: diffChannel(
      "lineup",
      servedLineup,
      lineupRows(wouldBe),
      caller.event.publicPageEnabled === true,
    ),
    agenda: diffChannel(
      "agenda",
      servedAgenda,
      agendaRows(wouldBe),
      isPublished(flags, "agenda", "event", false),
    ),
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
  return await servedProgramForEvent(ctx, event._id);
}

/** Same served-blob read keyed by event id (embeds resolve by id). */
export async function servedProgramForEvent(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<PublicProgram | null> {
  const event = await ctx.db.get("events", eventId);
  if (event === null || event.archivedAt !== undefined) return null;
  const published = await ctx.db
    .query("publishedPrograms")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .unique();
  if (published === null) return null;
  const program = published.program as PublicProgram;
  // Respect a later "turn the whole page off": if the organizer disabled the
  // public page after publishing, serve nothing.
  if (!program.lineupPublished && !program.agendaPublished) return null;
  return program;
}
