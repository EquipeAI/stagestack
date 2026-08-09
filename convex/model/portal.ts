import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import {
  emailShell,
  escapeHtml,
  notifyOrganizers,
  sendLoggedEmail,
  siteUrl,
} from "./comms";
import { renderTemplate } from "./templates";
import { publicProposalStatus } from "./cfp";
import * as Sessions from "./sessions";
import * as Tasks from "./tasks";
import { assertEventActive, assertText, normalizeEmail } from "./validation";

// ─────────────────────────────────────────────────────────────────────────
// Speaker portal (M3).
//
// Portal users are PLAIN SIGNED-IN USERS — never event members. Nothing here
// resolves a role; every capability is scoped by ownership:
//
//   * a claimed event snapshot   (eventContacts.userId === user._id)
//   * a managed participation    (sessionParticipants.managerUserId === user._id)
//   * an owned proposal          (proposals.submitterUserId === user._id)
//
// Access itself is verified-email auto-claim: `enterPortal` links the event's
// snapshots that carry the user's Clerk-verified address, and completes any
// pending manager handoff addressed to it. There is no portal password, no
// bearer link and no event-specific account (MILESTONES M3).
//
// Ownership misses throw `not_found`, never `forbidden`: ids must not be
// probeable from the open internet.
// ─────────────────────────────────────────────────────────────────────────

/** One event's participant rows fit comfortably; the organizer UI paginates
 * well before this becomes the wrong shape (see model/sessions.ts). */
const PARTICIPANT_SCAN = 5000;
const MAX_PARTICIPANTS_PER_SESSION = 100;
/** A person can hold a handful of snapshots per event at most (one per email). */
const CONTACT_SCAN = 200;
const HANDOFF_SCAN = 50;
const PROPOSAL_SCAN = 100;
const SESSION_FETCH = 200;

/** Handoff invitations expire so an abandoned one can't be claimed a year
 * later by whoever inherits the mailbox. */
const HANDOFF_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type ParticipantState = Doc<"sessionParticipants">["state"];

export function portalLink(eventSlug: string): string {
  return `${siteUrl()}/portal/${eventSlug}`;
}

/** Resolve the event a portal call names. No membership is implied — the
 * caller's reach is decided by the ownership guards below. */
export async function requireEventForPortal(
  ctx: QueryCtx,
  eventSlug: string,
): Promise<Doc<"events">> {
  const event = await ctx.db
    .query("events")
    .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
    .unique();
  if (event === null) notFound("event");
  return event;
}

const eventBySlug = requireEventForPortal;

// ── Profile shape ────────────────────────────────────────────────────────

export type PortalLinks = {
  website?: string;
  twitter?: string;
  linkedin?: string;
  github?: string;
};

export type PortalProfileInput = {
  firstName: string;
  lastName: string;
  tagline?: string;
  bio?: string;
  links?: PortalLinks;
  headshotId?: Id<"_storage">;
};

/** The publishable snapshot as the owning speaker sees it, plus a resolved
 * headshot URL so the portal can render it without a second round trip. */
export type PortalProfileView = {
  _id: Id<"eventContacts">;
  firstName: string;
  lastName: string;
  tagline?: string;
  bio?: string;
  headshotId?: Id<"_storage">;
  headshotUrl: string | null;
  links?: PortalLinks;
};

/** Trim + bound an optional field; blank collapses to absent so a cleared
 * form field removes the value rather than storing "". */
function optionalText(
  value: string | undefined,
  label: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = assertText(value, { label, max, min: 0 });
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateProfile(input: PortalProfileInput): PortalProfileInput {
  return {
    firstName: assertText(input.firstName, { label: "First name", max: 80 }),
    // Mononyms exist; the last name is bounded but may be blank.
    lastName: assertText(input.lastName, {
      label: "Last name",
      max: 80,
      min: 0,
    }),
    tagline: optionalText(input.tagline, "Tagline", 200),
    bio: optionalText(input.bio, "Bio", 4000),
    links:
      input.links === undefined
        ? undefined
        : {
            website: optionalText(input.links.website, "Website", 300),
            twitter: optionalText(input.links.twitter, "Twitter", 300),
            linkedin: optionalText(input.links.linkedin, "LinkedIn", 300),
            github: optionalText(input.links.github, "GitHub", 300),
          },
    headshotId: input.headshotId,
  };
}

async function profileView(
  ctx: QueryCtx,
  contact: Doc<"eventContacts">,
): Promise<PortalProfileView> {
  return {
    _id: contact._id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    tagline: contact.tagline,
    bio: contact.bio,
    headshotId: contact.headshotId,
    headshotUrl:
      contact.headshotId === undefined
        ? null
        : await ctx.storage.getUrl(contact.headshotId),
    links: contact.links,
  };
}

function fullName(contact: Doc<"eventContacts">): string {
  return `${contact.firstName} ${contact.lastName}`.trim();
}

// ── Portal context ───────────────────────────────────────────────────────

export type PortalSpeakingItem = {
  participantId: Id<"sessionParticipants">;
  sessionId: Id<"sessions">;
  sessionTitle: string;
  sessionDescription?: string;
  format?: string;
  state: ParticipantState;
  eventContact: PortalProfileView;
};

/** The managed-session view deliberately exposes only a name and a state per
 * co-speaker — a manager must never learn other speakers' contact details
 * through the portal (MILESTONES M3 + the M0 privacy boundary). */
export type PortalManagedParticipant = {
  participantId: Id<"sessionParticipants">;
  firstName: string;
  lastName: string;
  state: ParticipantState;
};

export type PortalManagingItem = {
  sessionId: Id<"sessions">;
  title: string;
  description?: string;
  format?: string;
  source: Doc<"sessions">["source"];
  status: Doc<"sessions">["status"];
  viaProposalId?: Id<"proposals">;
  participants: PortalManagedParticipant[];
};

export type PortalProposalSummary = {
  proposalId: Id<"proposals">;
  title: string;
  status: Doc<"proposals">["status"];
};

export type PortalContext = {
  event: {
    name: string;
    slug: string;
    startsAt: number;
    endsAt: number;
    timezone: string;
    location?: string;
  };
  speaking: PortalSpeakingItem[];
  managing: PortalManagingItem[];
  myProposalsSummary: PortalProposalSummary[];
  /** False means "you have nothing here" — the UI shows the empty state
   * instead of a broken portal. */
  hasAccess: boolean;
};

/**
 * Build one subject's portal view of an event.
 *
 * `contacts` are the snapshots the subject owns (their speaking side);
 * `userId` is the account whose management and proposals count. Preview mode
 * passes an organizer-chosen contact and that contact's (possibly absent)
 * user id, which is why the two are separate inputs.
 */
async function buildContext(
  ctx: QueryCtx,
  event: Doc<"events">,
  subject: { contacts: Array<Doc<"eventContacts">>; userId?: Id<"users"> },
): Promise<PortalContext> {
  const speaking: PortalSpeakingItem[] = [];
  for (const contact of subject.contacts) {
    const view = await profileView(ctx, contact);
    const rows = await ctx.db
      .query("sessionParticipants")
      .withIndex("by_eventContactId", (q) => q.eq("eventContactId", contact._id))
      .take(SESSION_FETCH);
    for (const row of rows) {
      if (row.eventId !== event._id) continue;
      const session = await ctx.db.get("sessions", row.sessionId);
      if (session === null) continue;
      speaking.push({
        participantId: row._id,
        sessionId: session._id,
        sessionTitle: session.title,
        sessionDescription: session.description,
        format: session.format,
        state: row.state,
        eventContact: view,
      });
    }
  }

  const managing: PortalManagingItem[] = [];
  const myProposalsSummary: PortalProposalSummary[] = [];
  const userId = subject.userId;
  if (userId !== undefined) {
    // No by_managerUserId index in v1: one bounded event-scoped scan serves
    // both the manager lookup and the co-speaker lists below.
    const participants = await ctx.db
      .query("sessionParticipants")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .take(PARTICIPANT_SCAN);

    const managedSessionIds = new Set<Id<"sessions">>();
    // Sessions whose participants are managed by SOMEONE ELSE. A completed
    // handoff writes the new manager onto every participant row, so this is
    // what takes the accepted-proposal fallback below away from the previous
    // manager ("retain the current manager until acceptance, then revoke").
    const handedAway = new Set<Id<"sessions">>();
    for (const row of participants) {
      if (row.managerUserId === undefined) continue;
      if (row.managerUserId === userId) managedSessionIds.add(row.sessionId);
      else handedAway.add(row.sessionId);
    }

    const proposals = await ctx.db
      .query("proposals")
      .withIndex("by_submitterUserId_and_eventId", (q) =>
        q.eq("submitterUserId", userId).eq("eventId", event._id),
      )
      .take(PROPOSAL_SCAN);
    for (const proposal of proposals) {
      myProposalsSummary.push({
        proposalId: proposal._id,
        title: proposal.title,
        // Staged decisions stay invisible to the submitter (MILESTONES M2).
        status: publicProposalStatus(proposal.status),
      });
      if (proposal.status !== "accepted") continue;
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_proposalId", (q) => q.eq("proposalId", proposal._id))
        .first();
      if (session === null || handedAway.has(session._id)) continue;
      managedSessionIds.add(session._id);
    }

    const byName = new Map<Id<"eventContacts">, Doc<"eventContacts"> | null>();
    for (const sessionId of managedSessionIds) {
      const session = await ctx.db.get("sessions", sessionId);
      if (session === null || session.eventId !== event._id) continue;
      const rows: PortalManagedParticipant[] = [];
      for (const row of participants) {
        if (row.sessionId !== sessionId) continue;
        if (!byName.has(row.eventContactId)) {
          byName.set(
            row.eventContactId,
            await ctx.db.get("eventContacts", row.eventContactId),
          );
        }
        const contact = byName.get(row.eventContactId) ?? null;
        rows.push({
          participantId: row._id,
          firstName: contact?.firstName ?? "",
          lastName: contact?.lastName ?? "",
          state: row.state,
        });
      }
      managing.push({
        sessionId: session._id,
        title: session.title,
        description: session.description,
        format: session.format,
        source: session.source,
        status: session.status,
        viaProposalId: session.proposalId,
        participants: rows,
      });
    }
  }

  return {
    event: {
      name: event.name,
      slug: event.slug,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timezone: event.timezone,
      location: event.location,
    },
    speaking,
    managing,
    myProposalsSummary,
    hasAccess:
      speaking.length > 0 ||
      managing.length > 0 ||
      myProposalsSummary.length > 0,
  };
}

/** Snapshots on this event already claimed by `user`. */
async function claimedContacts(
  ctx: QueryCtx,
  user: Doc<"users">,
  event: Doc<"events">,
): Promise<Array<Doc<"eventContacts">>> {
  const mine = await ctx.db
    .query("eventContacts")
    .withIndex("by_userId", (q) => q.eq("userId", user._id))
    .take(CONTACT_SCAN);
  return mine.filter((c) => c.eventId === event._id);
}

export type SpeakingSummary = {
  eventName: string;
  eventSlug: string;
  sessionTitle: string;
  state: Doc<"sessionParticipants">["state"];
};

/** Cross-event speaking engagements for My StageStack (M3). */
export async function mySpeaking(
  ctx: QueryCtx,
  user: Doc<"users">,
): Promise<SpeakingSummary[]> {
  const contacts = await ctx.db
    .query("eventContacts")
    .withIndex("by_userId", (q) => q.eq("userId", user._id))
    .take(100);
  const out: SpeakingSummary[] = [];
  for (const contact of contacts) {
    const participations = await ctx.db
      .query("sessionParticipants")
      .withIndex("by_eventContactId", (q) =>
        q.eq("eventContactId", contact._id),
      )
      .take(50);
    for (const p of participations) {
      const [session, event] = await Promise.all([
        ctx.db.get("sessions", p.sessionId),
        ctx.db.get("events", p.eventId),
      ]);
      if (session === null || event === null) continue;
      out.push({
        eventName: event.name,
        eventSlug: event.slug,
        sessionTitle: session.title,
        state: p.state,
      });
    }
  }
  return out;
}

export async function portalContext(
  ctx: QueryCtx,
  user: Doc<"users">,
  eventSlug: string,
): Promise<PortalContext> {
  const event = await eventBySlug(ctx, eventSlug);
  return await buildContext(ctx, event, {
    contacts: await claimedContacts(ctx, user, event),
    userId: user._id,
  });
}

/**
 * Read-only "Preview speaker portal" (MILESTONES M3). Organizer-only, and
 * deliberately a separate capability: previewing must never mint the
 * organizer any of the portal's write paths, and the banner needs a name.
 */
export async function previewPortalContext(
  ctx: QueryCtx,
  caller: EventCaller,
  eventContactId: Id<"eventContacts">,
): Promise<PortalContext & { contactName: string }> {
  requireOrganizer(caller);
  const contact = await ctx.db.get("eventContacts", eventContactId);
  if (contact === null || contact.eventId !== caller.event._id) {
    notFound("speaker", "No such speaker on this event.");
  }
  const context = await buildContext(ctx, caller.event, {
    contacts: [contact],
    // An unclaimed snapshot has no account, so there is nothing they manage
    // yet — the preview shows the speaking side only.
    userId: contact.userId,
  });
  return { ...context, contactName: fullName(contact) };
}

// ── Access: verified-email auto-claim ────────────────────────────────────

/**
 * Enter the portal for an event (M3 access). Clerk has already verified the
 * address on the user row, so matching it against this event's snapshots IS
 * the authorization step — there is no separate claim token.
 *
 * Two effects, both idempotent:
 *   1. link every unclaimed snapshot on this event carrying that address;
 *   2. complete any pending manager handoff addressed to it.
 *
 * Deliberately NOT gated on `assertEventActive`: claiming access is not event
 * content work, and an archived event must stay readable to the people who
 * spoke at it. The portal's content writes are gated.
 */
export async function enterPortal(
  ctx: MutationCtx,
  user: Doc<"users">,
  eventSlug: string,
): Promise<null> {
  const event = await eventBySlug(ctx, eventSlug);
  const email = user.email?.trim().toLowerCase();
  if (email === undefined || email.length === 0) return null;

  const snapshots = await ctx.db
    .query("eventContacts")
    .withIndex("by_eventId_and_email", (q) =>
      q.eq("eventId", event._id).eq("email", email),
    )
    .take(CONTACT_SCAN);
  for (const snapshot of snapshots) {
    // Never re-point a snapshot someone else already claimed.
    if (snapshot.userId !== undefined) continue;
    await ctx.db.patch("eventContacts", snapshot._id, { userId: user._id });
    await logAudit(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      actorUserId: user._id,
      viaAgent: false,
      action: "portal.claim",
      targetType: "eventContact",
      targetId: snapshot._id,
      meta: { email },
    });
  }

  await completeHandoffs(ctx, user, event, email);
  return null;
}

async function completeHandoffs(
  ctx: MutationCtx,
  user: Doc<"users">,
  event: Doc<"events">,
  email: string,
): Promise<void> {
  const now = Date.now();
  const handoffs = await ctx.db
    .query("managerHandoffs")
    .withIndex("by_eventId_and_email", (q) =>
      q.eq("eventId", event._id).eq("email", email),
    )
    .take(HANDOFF_SCAN);
  for (const handoff of handoffs) {
    if (handoff.status !== "pending") continue;
    // An expired invitation is inert; the organizer re-sends it.
    if (handoff.expiresAt <= now) continue;

    const participants = await ctx.db
      .query("sessionParticipants")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", handoff.sessionId))
      .take(MAX_PARTICIPANTS_PER_SESSION);
    for (const participant of participants) {
      if (participant.managerUserId === user._id) continue;
      await ctx.db.patch("sessionParticipants", participant._id, {
        managerUserId: user._id,
      });
    }
    await ctx.db.patch("managerHandoffs", handoff._id, {
      status: "completed",
      completedBy: user._id,
      completedAt: now,
    });

    const session = await ctx.db.get("sessions", handoff.sessionId);
    const title = session?.title ?? "a session";
    await logAudit(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      actorUserId: user._id,
      action: "portal.handoffCompleted",
      targetType: "session",
      targetId: handoff.sessionId,
      meta: { email, handoffId: handoff._id },
    });
    await notifyOrganizers(ctx, event, {
      kind: "portal.handoffCompleted",
      subject: `Manager handoff completed: ${title}`,
      html: emailShell(
        [
          `<p><strong>${escapeHtml(email)}</strong> accepted the primary-manager handoff for <strong>${escapeHtml(title)}</strong> at ${escapeHtml(event.name)}.</p>`,
          `<p>They now manage that session's participation and shared content. The previous manager's access to it has ended.</p>`,
        ].join("\n"),
      ),
      context: { sessionId: handoff.sessionId, handoffId: handoff._id },
    });
  }
}

// ── Ownership guards ─────────────────────────────────────────────────────

/** A snapshot on this event that `user` has claimed. Misses are `not_found`. */
export async function requireOwnEventContact(
  ctx: QueryCtx,
  user: Doc<"users">,
  event: Doc<"events">,
  eventContactId: Id<"eventContacts">,
): Promise<Doc<"eventContacts">> {
  const contact = await ctx.db.get("eventContacts", eventContactId);
  if (
    contact === null ||
    contact.eventId !== event._id ||
    contact.userId !== user._id
  ) {
    notFound("profile", "No such speaker profile.");
  }
  return contact;
}

/** A participation `user` may act on: their own claimed one, or one they
 * manage. Either way a miss reads as `not_found`. */
async function requireOwnParticipation(
  ctx: QueryCtx,
  user: Doc<"users">,
  event: Doc<"events">,
  participantId: Id<"sessionParticipants">,
): Promise<Doc<"sessionParticipants">> {
  const participant = await ctx.db.get("sessionParticipants", participantId);
  if (participant === null || participant.eventId !== event._id) {
    notFound("participation", "No such participation.");
  }
  if (participant.managerUserId === user._id) return participant;
  const contact = await ctx.db.get(
    "eventContacts",
    participant.eventContactId,
  );
  if (contact !== null && contact.userId === user._id) return participant;
  notFound("participation", "No such participation.");
}

/** A session `user` is the primary manager of (any participant row carries
 * their id). */
async function requireManagedSession(
  ctx: QueryCtx,
  user: Doc<"users">,
  event: Doc<"events">,
  sessionId: Id<"sessions">,
): Promise<Doc<"sessions">> {
  const session = await ctx.db.get("sessions", sessionId);
  if (session === null || session.eventId !== event._id) {
    notFound("session", "No such session.");
  }
  const participants = await ctx.db
    .query("sessionParticipants")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .take(MAX_PARTICIPANTS_PER_SESSION);
  if (!participants.some((p) => p.managerUserId === user._id)) {
    notFound("session", "No such session.");
  }
  return session;
}

// ── Speaker self-service ─────────────────────────────────────────────────

/**
 * A speaker edits their own active event snapshot (M3). The edit lands on the
 * snapshot AND refreshes the organization's current reusable contact profile
 * for future events; other events' snapshots stay exactly as they were
 * (MILESTONES M0/M3).
 *
 * Omitted optional fields are cleared — the portal form submits the whole
 * profile, so "absent" means "the speaker removed it".
 */
export async function updateMyProfile(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: {
    eventSlug: string;
    eventContactId: Id<"eventContacts">;
    profile: PortalProfileInput;
  },
): Promise<void> {
  const event = await eventBySlug(ctx, args.eventSlug);
  const contact = await requireOwnEventContact(
    ctx,
    user,
    event,
    args.eventContactId,
  );
  assertEventActive(event);
  const profile = validateProfile(args.profile);

  await ctx.db.patch("eventContacts", contact._id, profile);
  if (contact.contactId !== undefined) {
    await ctx.db.patch("contacts", contact.contactId, profile);
  }
  // Profile-field requirements observe the snapshot, so filling in a bio here
  // IS the submission — and clearing it takes the task back (M4).
  await Tasks.recomputeProfileEvidence(ctx, contact._id);
  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: user._id,
    action: "portal.updateProfile",
    targetType: "eventContact",
    targetId: contact._id,
    meta: { refreshedDirectory: contact.contactId !== undefined },
  });
}

/**
 * Record a participation decision from the portal: the claimed speaker
 * themself, or the primary manager on their behalf (MILESTONES M3 — "a
 * speaker's confirmation can be recorded by that speaker, the primary manager,
 * or an organizer"). The actor and timestamp are stored either way.
 */
export async function confirmParticipation(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: {
    eventSlug: string;
    participantId: Id<"sessionParticipants">;
    to: "confirmed" | "declined";
  },
): Promise<void> {
  const event = await eventBySlug(ctx, args.eventSlug);
  const participant = await requireOwnParticipation(
    ctx,
    user,
    event,
    args.participantId,
  );
  await Sessions.setParticipationState(ctx, {
    event,
    participant,
    actorUserId: user._id,
    to: args.to,
  });
}

/**
 * Withdraw a participation (M3). The session is deliberately NOT cancelled:
 * "keep the session visible with other confirmed speakers or a speaker to be
 * announced placeholder and flag it for attention rather than cancelling it
 * automatically". Organizers are alerted immediately.
 */
export async function withdrawParticipation(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: { eventSlug: string; participantId: Id<"sessionParticipants"> },
): Promise<void> {
  const event = await eventBySlug(ctx, args.eventSlug);
  const participant = await requireOwnParticipation(
    ctx,
    user,
    event,
    args.participantId,
  );
  assertEventActive(event);
  // Idempotent: a double-submit must not alert the organizers twice.
  if (participant.state === "withdrawn") return;

  const now = Date.now();
  await ctx.db.patch("sessionParticipants", participant._id, {
    state: "withdrawn",
    stateSetBy: user._id,
    stateSetAt: now,
  });

  const session = await ctx.db.get("sessions", participant.sessionId);
  const contact = await ctx.db.get(
    "eventContacts",
    participant.eventContactId,
  );
  const speakerName = contact === null ? "A speaker" : fullName(contact);
  const title = session?.title ?? "a session";

  await notifyOrganizers(ctx, event, {
    kind: "portal.withdrawal",
    subject: `Withdrawal: ${speakerName} — ${title}`,
    html: emailShell(
      [
        `<p><strong>${escapeHtml(speakerName)}</strong> has withdrawn from <strong>${escapeHtml(title)}</strong> at ${escapeHtml(event.name)}.</p>`,
        `<p>The session is still planned and is now flagged for attention: their name and profile are suppressed from public output, and only their own participation is affected.</p>`,
        `<p><a href="${portalLink(event.slug)}">Open the event</a></p>`,
      ].join("\n"),
    ),
    context: { participantId: participant._id, sessionId: participant.sessionId },
  });

  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: user._id,
    action: "portal.withdraw",
    targetType: "sessionParticipant",
    targetId: participant._id,
    meta: { from: participant.state, sessionId: participant.sessionId },
  });
}

/**
 * The primary manager edits shared session content (M3).
 *
 * PUBLICATION BOUNDARY: nothing is public until M7, so these edits apply
 * directly. Once M7 introduces the published snapshot, this is the seam where
 * an edit becomes a PENDING public update instead — "the last published
 * version remains live until explicitly republished" (MILESTONES M3).
 */
export async function updateSessionContent(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: {
    eventSlug: string;
    sessionId: Id<"sessions">;
    patch: { title?: string; description?: string; format?: string };
  },
): Promise<void> {
  const event = await eventBySlug(ctx, args.eventSlug);
  const session = await requireManagedSession(ctx, user, event, args.sessionId);
  assertEventActive(event);

  const patch: {
    title?: string;
    description?: string;
    format?: string;
  } = {};
  if (args.patch.title !== undefined) {
    patch.title = assertText(args.patch.title, {
      label: "Session title",
      max: 200,
    });
  }
  if (args.patch.description !== undefined) {
    patch.description = optionalText(
      args.patch.description,
      "Session description",
      10000,
    );
  }
  if (args.patch.format !== undefined) {
    patch.format = optionalText(args.patch.format, "Session format", 80);
  }
  await ctx.db.patch("sessions", session._id, patch);

  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: user._id,
    action: "portal.updateSession",
    targetType: "session",
    targetId: session._id,
    meta: { fields: Object.keys(patch) },
  });
}

// ── Speaker ops: my tasks (M4) ───────────────────────────────────────────

/** Instances reachable from one contact or one session. An event's task list
 * is bounded by requirements × participants; the portal shows one person's
 * slice of it. */
const TASK_SCAN = 500;

export type PortalTaskUpload = {
  filename: string;
  version: number;
  url: string | null;
};

export type PortalTask = {
  instanceId: Id<"taskInstances">;
  requirementTitle: string;
  description?: string;
  evidence: Doc<"requirements">["evidence"];
  scope: Doc<"requirements">["scope"];
  status: Doc<"taskInstances">["status"];
  dueAt: number;
  sessionTitle: string;
  /** Set when this task is owed BY someone else that the caller manages —
   * the portal says "Carol's headshot", not just "headshot". */
  forSpeaker: { firstName: string; lastName: string } | null;
  /** The organizer's explanatory note when changes were requested (M4). */
  reviewNote?: string;
  uploads: PortalTaskUpload[];
};

/**
 * Everything the caller can act on for this event: tasks owed by the speaker
 * profiles they have claimed, plus every task on the sessions they primary-
 * manage. A manager sees their speakers' work because M4 lets them submit on
 * that speaker's behalf — the task still belongs to the speaker.
 */
export async function myTasks(
  ctx: QueryCtx,
  user: Doc<"users">,
  eventSlug: string,
): Promise<PortalTask[]> {
  const event = await eventBySlug(ctx, eventSlug);
  const byId = new Map<Id<"taskInstances">, Doc<"taskInstances">>();

  for (const contact of await claimedContacts(ctx, user, event)) {
    const rows = await ctx.db
      .query("taskInstances")
      .withIndex("by_eventContactId", (q) =>
        q.eq("eventContactId", contact._id),
      )
      .take(TASK_SCAN);
    for (const row of rows) {
      if (row.eventId === event._id) byId.set(row._id, row);
    }
  }

  const participants = await ctx.db
    .query("sessionParticipants")
    .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
    .take(PARTICIPANT_SCAN);
  const managed = new Set(
    participants
      .filter((p) => p.managerUserId === user._id)
      .map((p) => p.sessionId),
  );
  for (const sessionId of managed) {
    const rows = await ctx.db
      .query("taskInstances")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .take(TASK_SCAN);
    for (const row of rows) byId.set(row._id, row);
  }

  const out: PortalTask[] = [];
  const requirements = new Map<
    Id<"requirements">,
    Doc<"requirements"> | null
  >();
  const sessions = new Map<Id<"sessions">, Doc<"sessions"> | null>();
  const contacts = new Map<Id<"eventContacts">, Doc<"eventContacts"> | null>();
  for (const instance of byId.values()) {
    if (!requirements.has(instance.requirementId)) {
      requirements.set(
        instance.requirementId,
        await ctx.db.get("requirements", instance.requirementId),
      );
    }
    const requirement = requirements.get(instance.requirementId) ?? null;
    if (requirement === null) continue;
    if (!sessions.has(instance.sessionId)) {
      sessions.set(
        instance.sessionId,
        await ctx.db.get("sessions", instance.sessionId),
      );
    }
    const session = sessions.get(instance.sessionId) ?? null;

    let forSpeaker: { firstName: string; lastName: string } | null = null;
    if (instance.eventContactId !== undefined) {
      if (!contacts.has(instance.eventContactId)) {
        contacts.set(
          instance.eventContactId,
          await ctx.db.get("eventContacts", instance.eventContactId),
        );
      }
      const contact = contacts.get(instance.eventContactId) ?? null;
      // Null means "this is your own task"; a name means you're acting for
      // someone else.
      if (contact !== null && contact.userId !== user._id) {
        forSpeaker = {
          firstName: contact.firstName,
          lastName: contact.lastName,
        };
      }
    }

    const uploads: PortalTaskUpload[] = [];
    if (requirement.evidence === "file") {
      const rows = await ctx.db
        .query("uploads")
        .withIndex("by_taskInstanceId", (q) =>
          q.eq("taskInstanceId", instance._id),
        )
        .take(TASK_SCAN);
      for (const row of rows.sort((a, b) => b.version - a.version)) {
        uploads.push({
          filename: row.filename,
          version: row.version,
          url: await ctx.storage.getUrl(row.storageId),
        });
      }
    }

    out.push({
      instanceId: instance._id,
      requirementTitle: requirement.title,
      description: requirement.description,
      evidence: requirement.evidence,
      scope: requirement.scope,
      status: instance.status,
      dueAt: instance.dueAt,
      sessionTitle: session?.title ?? "",
      forSpeaker,
      reviewNote: instance.reviewNote,
      uploads,
    });
  }
  out.sort((a, b) => a.dueAt - b.dueAt);
  return out;
}

/** Tick a manual task from the portal. `markProvided` re-checks the speaker/
 * manager/organizer trio itself. */
export async function completeTask(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: { eventSlug: string; instanceId: Id<"taskInstances"> },
): Promise<void> {
  const event = await eventBySlug(ctx, args.eventSlug);
  await Tasks.markProvided(ctx, user, event, args.instanceId);
}

/** Attach a new version of a requested file from the portal. */
export async function uploadForTask(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: {
    eventSlug: string;
    instanceId: Id<"taskInstances">;
    storageId: Id<"_storage">;
    filename: string;
  },
): Promise<{ uploadId: Id<"uploads">; version: number }> {
  const event = await eventBySlug(ctx, args.eventSlug);
  return await Tasks.attachUpload(ctx, user, event, {
    instanceId: args.instanceId,
    storageId: args.storageId,
    filename: args.filename,
  });
}

/** Authorization half of `portal.generateTaskUploadUrl` — the wrapper adds the
 * rate limit, exactly like the headshot upload URL. */
export async function requireTaskUploadAccess(
  ctx: QueryCtx,
  user: Doc<"users">,
  args: { eventSlug: string; instanceId: Id<"taskInstances"> },
): Promise<void> {
  const event = await eventBySlug(ctx, args.eventSlug);
  await Tasks.requireTaskAccess(ctx, user, event, args.instanceId);
}

// ── Organizer side ───────────────────────────────────────────────────────

/**
 * Invite a speaker to claim their portal access (M3: "after acceptance,
 * speakers can be invited to claim their own access, but an account is not
 * required merely to be listed as a speaker"). The link deep-links to the
 * event portal; Clerk verification plus `enterPortal` does the rest.
 */
export async function invitePortal(
  ctx: MutationCtx,
  caller: EventCaller,
  eventContactId: Id<"eventContacts">,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const event = caller.event;
  const contact = await ctx.db.get("eventContacts", eventContactId);
  if (contact === null || contact.eventId !== event._id) {
    notFound("speaker", "No such speaker on this event.");
  }
  const raw = contact.email?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new ConvexError({
      code: "invalid_email",
      message: "This speaker has no email address on this event.",
    });
  }
  const toEmail = normalizeEmail(raw);

  const rendered = await renderTemplate(ctx, event, "portal.invite", {
    event: { name: event.name },
    speaker: { firstName: contact.firstName, lastName: contact.lastName },
    link: portalLink(event.slug),
  });
  await sendLoggedEmail(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    contactId: contact.contactId,
    toEmail,
    kind: "portal.invite",
    subject: rendered.subject,
    html: rendered.html,
    sentByUserId: caller.user._id,
    replyTo: event.replyTo,
    context: { eventContactId },
  });

  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: caller.user._id,
    action: "portal.invite",
    targetType: "eventContact",
    targetId: eventContactId,
    meta: { toEmail },
  });
}

/**
 * Start an organizer-controlled primary-manager handoff (M3). The CURRENT
 * manager keeps access until the invitee actually enters the portal — this
 * only records the intent and sends the invitation.
 */
export async function startManagerHandoff(
  ctx: MutationCtx,
  caller: EventCaller,
  args: { sessionId: Id<"sessions">; email: string },
): Promise<Id<"managerHandoffs">> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const event = caller.event;
  const session = await ctx.db.get("sessions", args.sessionId);
  if (session === null || session.eventId !== event._id) {
    notFound("session", "No such session on this event.");
  }
  const email = normalizeEmail(args.email);

  // At most one live invitation per session, so a re-send can't leave two
  // addresses able to take over.
  const existing = await ctx.db
    .query("managerHandoffs")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
    .take(HANDOFF_SCAN);
  for (const handoff of existing) {
    if (handoff.status !== "pending") continue;
    await ctx.db.patch("managerHandoffs", handoff._id, { status: "revoked" });
  }

  const handoffId = await ctx.db.insert("managerHandoffs", {
    eventId: event._id,
    sessionId: session._id,
    email,
    status: "pending",
    invitedBy: caller.user._id,
    expiresAt: Date.now() + HANDOFF_TTL_MS,
  });

  const rendered = await renderTemplate(ctx, event, "portal.handoffInvite", {
    event: { name: event.name },
    session: { title: session.title },
    link: portalLink(event.slug),
  });
  await sendLoggedEmail(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    toEmail: email,
    kind: "portal.handoffInvite",
    subject: rendered.subject,
    html: rendered.html,
    sentByUserId: caller.user._id,
    replyTo: event.replyTo,
    context: { sessionId: session._id, handoffId },
  });

  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: caller.user._id,
    action: "portal.handoffStarted",
    targetType: "session",
    targetId: session._id,
    meta: { email, handoffId },
  });
  return handoffId;
}

export async function revokeHandoff(
  ctx: MutationCtx,
  caller: EventCaller,
  handoffId: Id<"managerHandoffs">,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const handoff = await ctx.db.get("managerHandoffs", handoffId);
  if (handoff === null || handoff.eventId !== caller.event._id) {
    notFound("handoff", "No such handoff on this event.");
  }
  if (handoff.status !== "pending") {
    throw new ConvexError({
      code: "invalid_status",
      message: "Only a pending handoff can be revoked.",
    });
  }
  await ctx.db.patch("managerHandoffs", handoffId, { status: "revoked" });
  await logAudit(ctx, {
    orgId: caller.event.orgId,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "portal.handoffRevoked",
    targetType: "session",
    targetId: handoff.sessionId,
    meta: { email: handoff.email, handoffId },
  });
}

/**
 * Organizer-side participation control (M3: "organizers can edit all speaker
 * and session information"). Same model function as the portal, so the actor
 * and timestamp are recorded identically — organizers may additionally reset
 * a decision back to Awaiting Response.
 */
export async function organizerSetParticipationState(
  ctx: MutationCtx,
  caller: EventCaller,
  participantId: Id<"sessionParticipants">,
  to: "awaiting" | "confirmed" | "declined",
): Promise<void> {
  requireOrganizer(caller);
  const participant = await ctx.db.get("sessionParticipants", participantId);
  if (participant === null || participant.eventId !== caller.event._id) {
    notFound("participation", "No such participation on this event.");
  }
  await Sessions.setParticipationState(ctx, {
    event: caller.event,
    participant,
    actorUserId: caller.user._id,
    to,
  });
}
