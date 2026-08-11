import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import * as Agenda from "./agenda";
import { logAudit } from "./audit";
import { sendLoggedEmail, siteUrl } from "./comms";
import { renderTemplate } from "./templates";
import { proposalAbstract, proposalLink } from "./cfp";
import { republishIfPublished } from "./publish";
import { assertEventActive } from "./reviews";
import { instantiateForSession } from "./tasks";
import { assertText, normalizeEmail } from "./validation";

// ─────────────────────────────────────────────────────────────────────────
// Decisions & sessions (M2).
//
// The pipeline is Draft → Pending → Accept/Decline Queue → Accepted/Declined
// (plus Withdrawn). Queue placement is an INTERNAL staged decision: nothing
// leaves the building until an organizer explicitly releases it, which is what
// makes wave-based acceptance possible. Releasing an acceptance materialises
// the session, snapshots each speaker into the event, and starts every
// participation at Awaiting Response.
//
// Bulk capabilities return PER-ID results rather than throwing on the first
// bad row: a 200-proposal release must not be lost because one proposal moved
// underneath the organizer's table.
//
// Every mutating capability re-checks `requireOrganizer` itself even when the
// public wrapper already did — the Import agent adapter calls these directly.
// ─────────────────────────────────────────────────────────────────────────

// Release fans out sessions, contacts, participants and emails per proposal —
// 100 per transaction stays well inside Convex limits; the UI batches larger
// selections across calls (codex review).
const MAX_BULK = 100;
const MAX_SPEAKERS_PER_PROPOSAL = 40;
const MAX_PARTICIPANTS_PER_SESSION = 100;
const SESSION_SCAN = 1000;
const PARTICIPANT_SCAN = 5000;
const CONTACT_SCAN = 2000;
const MAX_NOTE = 2000;

export type StageTarget = "pending" | "acceptQueue" | "declineQueue";
export type DecisionStatus = "accepted" | "declined";

/** Result of one id inside a bulk action. `error` is a stable code the UI can
 * map: "not_found" | "invalid_status". */
export type BulkResult = {
  proposalId: Id<"proposals">;
  ok: boolean;
  error?: string;
};

/** Statuses a staged decision may move between. Draft/withdrawn/decided
 * proposals are not stageable. */
const STAGEABLE: ReadonlySet<Doc<"proposals">["status"]> = new Set([
  "pending",
  "acceptQueue",
  "declineQueue",
]);

function assertBulkSize(ids: ReadonlyArray<unknown>): void {
  if (ids.length === 0) {
    throw new ConvexError({
      code: "empty_selection",
      message: "Select at least one proposal.",
    });
  }
  if (ids.length > MAX_BULK) {
    throw new ConvexError({
      code: "too_many",
      message: `At most ${MAX_BULK} proposals at a time.`,
    });
  }
}

/** Event-time rendering for emails. Deliberately plain: M5 owns real
 * templating and locale-aware formatting. */
function eventWhen(event: Doc<"events">): string {
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const range =
    day(event.startsAt) === day(event.endsAt)
      ? day(event.startsAt)
      : `${day(event.startsAt)} – ${day(event.endsAt)}`;
  return `${range} (${event.timezone})`;
}

function portalLink(eventSlug: string): string {
  // The M3 speaker portal route. Linking it now is intentional: invitations
  // sent in M2 must survive into M3 without a re-send.
  return `${siteUrl()}/portal/${eventSlug}`;
}

// ── Contact snapshots ────────────────────────────────────────────────────

/** The publishable profile fields copied from a speaker into the event. */
export type SpeakerProfile = {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  tagline?: string;
  jobTitle?: string;
  company?: string;
  bio?: string;
  headshotId?: Id<"_storage">;
  links?: {
    website?: string;
    twitter?: string;
    linkedin?: string;
    github?: string;
  };
};

/** "Principal Engineer, Latticework" → structured title/company. Only the
 * unambiguous two-part shape splits; anything else stays tagline-only. */
function splitTagline(
  tagline: string | undefined,
): { jobTitle?: string; company?: string } {
  if (tagline === undefined) return {};
  const parts = tagline.split(",").map((p) => p.trim());
  if (parts.length !== 2 || parts.some((p) => p === "")) return {};
  return { jobTitle: parts[0], company: parts[1] };
}

function profileOf(speaker: Doc<"proposalSpeakers">): SpeakerProfile {
  return {
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    email: speaker.email,
    phone: speaker.phone,
    tagline: speaker.tagline,
    // CFP speakers enter a freeform tagline; the roster and public widgets
    // want structured fields, so the common "Title, Company" shape carries
    // over (the speaker or organizer can refine it later).
    ...splitTagline(speaker.tagline),
    bio: speaker.bio,
    headshotId: speaker.headshotId,
    links: speaker.links,
  };
}

/**
 * Find-or-create the org directory entry behind an event snapshot. M0 frames
 * the directory as the source a snapshot is copied FROM, so a speaker who
 * arrives through the CFP gets a directory row here — otherwise the org would
 * accumulate event snapshots with nothing reusable behind them.
 */
async function upsertOrgContact(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  profile: SpeakerProfile,
): Promise<Id<"contacts">> {
  if (profile.email !== undefined) {
    // .first() rather than .unique(): a legacy duplicate must not break a
    // decision release.
    const existing = await ctx.db
      .query("contacts")
      .withIndex("by_orgId_and_email", (q) =>
        q.eq("orgId", orgId).eq("email", profile.email),
      )
      .first();
    if (existing !== null) return existing._id;
  }
  return await ctx.db.insert("contacts", { orgId, ...profile });
}

/**
 * Find-or-create the event-scoped publishable snapshot. Existing snapshots are
 * never rewritten (M0: "existing event snapshots never change automatically")
 * — only a missing directory link is backfilled.
 *
 * Identity: the source proposal speaker first (stable even when the speaker
 * has no email — a decline→accept correction must restore, never duplicate),
 * then email. Direct/imported speakers have no source row and match by email
 * alone.
 */
async function ensureEventContact(
  ctx: MutationCtx,
  event: Doc<"events">,
  profile: SpeakerProfile,
  proposalSpeakerId?: Id<"proposalSpeakers">,
): Promise<Id<"eventContacts">> {
  if (proposalSpeakerId !== undefined) {
    const bySpeaker = await ctx.db
      .query("eventContacts")
      .withIndex("by_proposalSpeakerId", (q) =>
        q.eq("proposalSpeakerId", proposalSpeakerId),
      )
      .first();
    if (bySpeaker !== null) {
      if (bySpeaker.contactId === undefined) {
        await ctx.db.patch("eventContacts", bySpeaker._id, {
          contactId: await upsertOrgContact(ctx, event.orgId, profile),
        });
      }
      return bySpeaker._id;
    }
  }
  if (profile.email !== undefined) {
    const existing = await ctx.db
      .query("eventContacts")
      .withIndex("by_eventId_and_email", (q) =>
        q.eq("eventId", event._id).eq("email", profile.email),
      )
      .first();
    if (existing !== null) {
      if (existing.contactId === undefined) {
        await ctx.db.patch("eventContacts", existing._id, {
          contactId: await upsertOrgContact(ctx, event.orgId, profile),
        });
      }
      return existing._id;
    }
  }
  const contactId = await upsertOrgContact(ctx, event.orgId, profile);
  return await ctx.db.insert("eventContacts", {
    eventId: event._id,
    orgId: event.orgId,
    contactId,
    proposalSpeakerId,
    ...profile,
  });
}

/** Idempotent participant creation: the same contact is never added to one
 * session twice (a restore must not duplicate the line-up). */
async function ensureParticipant(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    eventId: Id<"events">;
    eventContactId: Id<"eventContacts">;
    managerUserId?: Id<"users">;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("sessionParticipants")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .take(MAX_PARTICIPANTS_PER_SESSION);
  if (existing.some((p) => p.eventContactId === args.eventContactId)) return;
  await ctx.db.insert("sessionParticipants", {
    sessionId: args.sessionId,
    eventId: args.eventId,
    eventContactId: args.eventContactId,
    role: "speaker",
    // Acceptance creates the session, but "each speaker's participation
    // remains separately Awaiting Response until confirmed or declined" (M2).
    state: "awaiting",
    managerUserId: args.managerUserId,
    // Fix 2: stamp creation time so the first PARTICIPATION reminder waits a
    // full cadence after the invitation, rather than firing at the next sweep.
    lastRemindedAt: Date.now(),
  });
}

async function sessionForProposal(
  ctx: QueryCtx,
  proposalId: Id<"proposals">,
): Promise<Doc<"sessions"> | null> {
  return await ctx.db
    .query("sessions")
    .withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId))
    .first();
}

/**
 * Turn an accepted proposal into a planned session with its speaker snapshots
 * and Awaiting-Response participations. Reuses an existing session for the
 * proposal so a decline→accept correction restores rather than duplicates.
 */
/**
 * The CFP form's track question is an ordinary dropdown answer, not a typed
 * column — carry it over by matching any answer string against the event's
 * track names (case-insensitive). Ambiguity (two answers naming two
 * different tracks) resolves to nothing rather than guessing.
 */
async function trackFromAnswers(
  ctx: QueryCtx,
  event: Doc<"events">,
  proposal: Doc<"proposals">,
): Promise<Id<"tracks"> | undefined> {
  const tracks = await ctx.db
    .query("tracks")
    .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
    .take(200);
  if (tracks.length === 0) return undefined;
  const byName = new Map(
    tracks.map((t) => [t.name.trim().toLowerCase(), t._id]),
  );
  const hits = new Set<Id<"tracks">>();
  for (const value of Object.values(proposal.answers)) {
    if (typeof value !== "string") continue;
    const match = byName.get(value.trim().toLowerCase());
    if (match !== undefined) hits.add(match);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

async function materializeSession(
  ctx: MutationCtx,
  event: Doc<"events">,
  proposal: Doc<"proposals">,
): Promise<Id<"sessions">> {
  const existing = await sessionForProposal(ctx, proposal._id);
  const trackId =
    existing?.trackId ?? (await trackFromAnswers(ctx, event, proposal));
  const sessionId =
    existing?._id ??
    (await ctx.db.insert("sessions", {
      eventId: event._id,
      title: proposal.title,
      description: await proposalAbstract(ctx, proposal),
      proposalId: proposal._id,
      source: "cfp",
      status: "planned",
      contentStatus: "draft",
      trackId,
    }));
  // A correction that restores an existing track-less session still gets the
  // carry-over (the eval saw "No track" on a converted session).
  if (existing !== null && existing.trackId === undefined && trackId !== undefined) {
    await ctx.db.patch("sessions", existing._id, { trackId });
  }
  const speakers = await ctx.db
    .query("proposalSpeakers")
    .withIndex("by_proposalId", (q) => q.eq("proposalId", proposal._id))
    .take(MAX_SPEAKERS_PER_PROPOSAL);
  for (const speaker of speakers.sort((a, b) => a.order - b.order)) {
    const eventContactId = await ensureEventContact(
      ctx,
      event,
      profileOf(speaker),
      speaker._id,
    );
    await ensureParticipant(ctx, {
      sessionId,
      eventId: event._id,
      eventContactId,
      managerUserId: proposal.submitterUserId,
    });
  }
  // "Create and assign applicable requirements when an acceptance ... is
  // formally released" (M4). Idempotent per (requirement, participant), so a
  // decline→accept correction or a later co-speaker adds only what's missing.
  await instantiateForSession(ctx, event, sessionId);
  return sessionId;
}

// ── Staging ──────────────────────────────────────────────────────────────

/**
 * Move proposals into (or back out of) a decision queue. Nothing is sent and
 * nothing is revealed: the submitter keeps seeing "pending" (see
 * `publicProposalStatus` in model/cfp.ts).
 */
export async function setProposalStatus(
  ctx: MutationCtx,
  caller: EventCaller,
  proposalIds: Array<Id<"proposals">>,
  to: StageTarget,
): Promise<BulkResult[]> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  assertBulkSize(proposalIds);

  const results: BulkResult[] = [];
  for (const proposalId of proposalIds) {
    const proposal = await ctx.db.get("proposals", proposalId);
    if (proposal === null || proposal.eventId !== caller.event._id) {
      results.push({ proposalId, ok: false, error: "not_found" });
      continue;
    }
    if (!STAGEABLE.has(proposal.status)) {
      results.push({ proposalId, ok: false, error: "invalid_status" });
      continue;
    }
    if (proposal.status !== to) {
      await ctx.db.patch("proposals", proposalId, {
        status: to,
        updatedAt: Date.now(),
      });
      await logAudit(ctx, {
        orgId: caller.org._id,
        eventId: caller.event._id,
        actorUserId: caller.user._id,
        action: "decision.stage",
        targetType: "proposal",
        targetId: proposalId,
        meta: { from: proposal.status, to },
      });
    }
    results.push({ proposalId, ok: true });
  }
  return results;
}

// ── Release ──────────────────────────────────────────────────────────────

/** The variables every decision template can reference. */
function decisionVars(
  event: Doc<"events">,
  proposal: Doc<"proposals">,
): Record<string, unknown> {
  return {
    event: { name: event.name },
    proposal: { title: proposal.title },
    link: proposalLink(event.slug, proposal._id),
  };
}

/** Email the proposal's primary manager, when we have an address for them. */
async function mailSubmitter(
  ctx: MutationCtx,
  event: Doc<"events">,
  proposal: Doc<"proposals">,
  args: { kind: string; subject: string; html: string; context?: unknown },
): Promise<void> {
  const submitter = await ctx.db.get("users", proposal.submitterUserId);
  const email = submitter?.email?.trim();
  if (email === undefined || email.length === 0) return;
  await sendLoggedEmail(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    toEmail: email,
    kind: args.kind,
    subject: args.subject,
    html: args.html,
    replyTo: event.replyTo,
    context: args.context ?? { proposalId: proposal._id },
  });
}

/**
 * The explicit release step (M2). Queued decisions become Accepted/Declined,
 * the submitter is told, and acceptances materialise their session. Proposals
 * that are not queued come back as per-id errors so the rest of the wave still
 * goes out.
 */
export async function releaseDecisions(
  ctx: MutationCtx,
  caller: EventCaller,
  proposalIds: Array<Id<"proposals">>,
): Promise<BulkResult[]> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  assertBulkSize(proposalIds);
  const event = caller.event;

  const results: BulkResult[] = [];
  for (const proposalId of proposalIds) {
    const proposal = await ctx.db.get("proposals", proposalId);
    if (proposal === null || proposal.eventId !== event._id) {
      results.push({ proposalId, ok: false, error: "not_found" });
      continue;
    }
    if (
      proposal.status !== "acceptQueue" &&
      proposal.status !== "declineQueue"
    ) {
      results.push({ proposalId, ok: false, error: "invalid_status" });
      continue;
    }
    const to: DecisionStatus =
      proposal.status === "acceptQueue" ? "accepted" : "declined";
    // The proposals table has no lastDecisionAt column; `updatedAt` plus the
    // audit row below is the decision's authoritative timestamp.
    await ctx.db.patch("proposals", proposalId, {
      status: to,
      updatedAt: Date.now(),
    });

    const kind = to === "accepted" ? "decision.accepted" : "decision.declined";
    if (to === "accepted") await materializeSession(ctx, event, proposal);
    const { subject, html } = await renderTemplate(
      ctx,
      event,
      kind,
      decisionVars(event, proposal),
    );
    await mailSubmitter(ctx, event, proposal, { kind, subject, html });

    await logAudit(ctx, {
      orgId: caller.org._id,
      eventId: event._id,
      actorUserId: caller.user._id,
      action: "decision.release",
      targetType: "proposal",
      targetId: proposalId,
      meta: { from: proposal.status, to },
    });
    results.push({ proposalId, ok: true });
  }
  return results;
}

// ── Correction ───────────────────────────────────────────────────────────

/**
 * The only way to reverse a released decision (M2). Both decisions survive in
 * the audit trail, the correction is clearly identified to the submitter, and
 * an accepted→declined correction cancels the session as restorable history
 * instead of deleting it.
 */
export async function correctDecision(
  ctx: MutationCtx,
  caller: EventCaller,
  proposalId: Id<"proposals">,
  to: DecisionStatus,
  note: string,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const reason = assertText(note, {
    label: "Correction note",
    max: MAX_NOTE,
    code: "invalid_note",
  });
  const event = caller.event;
  const proposal = await ctx.db.get("proposals", proposalId);
  if (proposal === null || proposal.eventId !== event._id) {
    notFound("proposal", "No such proposal on this event.");
  }
  const from = proposal.status;
  if (from !== "accepted" && from !== "declined") {
    throw new ConvexError({
      code: "invalid_status",
      message: "Only a released decision can be corrected.",
    });
  }
  if (from === to) {
    throw new ConvexError({
      code: "invalid_status",
      message: `This proposal is already ${to}.`,
    });
  }

  const now = Date.now();
  await ctx.db.patch("proposals", proposalId, { status: to, updatedAt: now });

  let withdrawnKept = 0;
  if (to === "declined") {
    // Cancel, never delete: "retain it as restorable history, remove it from
    // active scheduling and public views ... and send calendar cancellations if
    // invitations were already distributed" (M2).
    const session = await sessionForProposal(ctx, proposalId);
    if (session !== null && session.status !== "cancelled") {
      await ctx.db.patch("sessions", session._id, {
        status: "cancelled",
        cancelledAt: now,
      });
      if (session.releasedSlot !== undefined) {
        await Agenda.cancelReleasedSlot(ctx, {
          event,
          session,
          actorUserId: caller.user._id,
          reason: "sessionCancelled",
        });
      }
      // A published program must not keep serving the cancelled session:
      // rewrite the served blob now if one exists (model/publish.ts).
      await republishIfPublished(ctx, event._id);
    }
    // Participants are intentionally left in place so a later correction back
    // to accepted restores the line-up.
  } else {
    // "restore that session without duplication — or create it if none
    // existed — preserve prior work, and reset every participant to Awaiting
    // Response for fresh confirmation."
    const session = await sessionForProposal(ctx, proposalId);
    if (session !== null) {
      await ctx.db.patch("sessions", session._id, {
        status: "planned",
        cancelledAt: undefined,
      });
      const participants = await ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
        .take(MAX_PARTICIPANTS_PER_SESSION);
      for (const participant of participants) {
        // Withdrawn is terminal everywhere (setParticipationState); a restore
        // must not quietly resurrect someone who pulled out.
        if (participant.state === "withdrawn") {
          withdrawnKept += 1;
          continue;
        }
        await ctx.db.patch("sessionParticipants", participant._id, {
          state: "awaiting",
          stateSetBy: caller.user._id,
          stateSetAt: now,
        });
      }
    }
    // Reuses the restored session; only genuinely missing speakers are added.
    await materializeSession(ctx, event, proposal);
  }

  const correction = await renderTemplate(ctx, event, "decision.corrected", {
    ...decisionVars(event, proposal),
    decision: to === "accepted" ? "accepted" : "not accepted",
    note: reason,
  });
  await mailSubmitter(ctx, event, proposal, {
    kind: "decision.corrected",
    subject: correction.subject,
    html: correction.html,
    context: { proposalId, from, to },
  });

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: event._id,
    actorUserId: caller.user._id,
    action: "decision.correct",
    targetType: "proposal",
    targetId: proposalId,
    meta: {
      from,
      to,
      note: reason,
      // Visible in the trail when a restore left withdrawn speakers out.
      ...(withdrawnKept > 0 ? { withdrawnExcluded: withdrawnKept } : {}),
    },
  });
}

// ── Direct invitation ────────────────────────────────────────────────────

export type DirectSessionArgs = {
  title: string;
  description?: string;
  format?: string;
  trackId?: Id<"tracks">;
  speaker: {
    firstName: string;
    lastName: string;
    /** Required: a direct invitation exists to be sent. */
    email: string;
    phone?: string;
    tagline?: string;
    bio?: string;
  };
};

/**
 * An organizer creates a private planned session and invites a speaker,
 * bypassing CFP and review (M2). The participation starts at Awaiting Response
 * exactly like an accepted CFP speaker's does.
 */
export async function createDirectSession(
  ctx: MutationCtx,
  caller: EventCaller,
  args: DirectSessionArgs,
): Promise<{ sessionId: Id<"sessions">; eventContactId: Id<"eventContacts"> }> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const event = caller.event;

  const title = assertText(args.title, { label: "Session title", max: 200 });
  // A direct invitation exists to be sent, so the address is non-optional here
  // even though the snapshot type allows contacts without one.
  const speakerEmail = normalizeEmail(args.speaker.email);
  const profile: SpeakerProfile = {
    firstName: assertText(args.speaker.firstName, {
      label: "Speaker first name",
      max: 80,
    }),
    lastName: assertText(args.speaker.lastName, {
      label: "Speaker last name",
      max: 80,
    }),
    email: speakerEmail,
    phone: args.speaker.phone,
    tagline: args.speaker.tagline,
    ...splitTagline(args.speaker.tagline),
    bio: args.speaker.bio,
  };
  if (args.trackId !== undefined) {
    const track = await ctx.db.get("tracks", args.trackId);
    if (track === null || track.eventId !== event._id) {
      notFound("track", "No such track on this event.");
    }
  }

  const sessionId = await ctx.db.insert("sessions", {
    eventId: event._id,
    title,
    description: args.description,
    format: args.format,
    trackId: args.trackId,
    source: "direct",
    status: "planned",
    contentStatus: "draft",
  });
  const eventContactId = await ensureEventContact(ctx, event, profile);
  await ensureParticipant(ctx, {
    sessionId,
    eventId: event._id,
    eventContactId,
    // No CFP submitter: the speaker manages their own participation until an
    // organizer says otherwise (M3 handles manager handoff).
    managerUserId: undefined,
  });
  // A direct invitation is a formal release too (M4).
  await instantiateForSession(ctx, event, sessionId);

  // The invitation goes out AFTER this transaction commits: an email failure
  // must never unwind the session/contact/participant writes (same rule as
  // cfp.submitProposal — the eval's finding #4 class of bug).
  await ctx.scheduler.runAfter(0, internal.sessions.sendDirectInvitation, {
    sessionId,
    eventContactId,
    sentByUserId: caller.user._id,
  });

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: event._id,
    actorUserId: caller.user._id,
    action: "session.directInvite",
    targetType: "session",
    targetId: sessionId,
    meta: { title, toEmail: profile.email },
  });
  return { sessionId, eventContactId };
}

/**
 * Import-agent session creation (M2): same session/contact/participant shape
 * as a direct invitation, but imported records never send communications
 * (MILESTONES M2), so no email is required and none is sent.
 */
export async function importSession(
  ctx: MutationCtx,
  caller: EventCaller,
  args: {
    title: string;
    description?: string;
    speaker: { firstName: string; lastName: string; email?: string };
  },
): Promise<Id<"sessions">> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const title = assertText(args.title, { label: "Session title", max: 200 });
  const profile: SpeakerProfile = {
    firstName: assertText(args.speaker.firstName, {
      label: "Speaker first name",
      max: 80,
    }),
    lastName: assertText(args.speaker.lastName, {
      label: "Speaker last name",
      max: 80,
    }),
    email:
      args.speaker.email === undefined
        ? undefined
        : normalizeEmail(args.speaker.email),
  };
  const sessionId = await ctx.db.insert("sessions", {
    eventId: caller.event._id,
    title,
    description: args.description,
    source: "direct",
    status: "planned",
    contentStatus: "draft",
  });
  const eventContactId = await ensureEventContact(ctx, caller.event, profile);
  await ensureParticipant(ctx, {
    sessionId,
    eventId: caller.event._id,
    eventContactId,
    managerUserId: undefined,
  });
  await instantiateForSession(ctx, caller.event, sessionId);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    viaAgent: true,
    action: "session.import",
    targetType: "session",
    targetId: sessionId,
    meta: { title },
  });
  return sessionId;
}

// ── Participation state (M3) ─────────────────────────────────────────────

/**
 * Record a participation decision. The single write path for Awaiting
 * Response → Confirmed/Declined, shared by the speaker, their primary manager
 * and organizers (MILESTONES M3), so the actor and timestamp are always
 * captured the same way.
 *
 * Authorization happens in the CALLER (portal ownership check, or
 * `requireOrganizer`): this function only knows the transition rules.
 *
 * Withdrawn is terminal here — it is reached only through the portal's
 * withdrawal capability, which also alerts organizers. Re-setting the current
 * state is a no-op rather than an error so a double-click is harmless.
 */
export async function setParticipationState(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    participant: Doc<"sessionParticipants">;
    actorUserId: Id<"users">;
    to: "awaiting" | "confirmed" | "declined";
  },
): Promise<void> {
  assertEventActive(args.event);
  const from = args.participant.state;
  if (from === "withdrawn") {
    throw new ConvexError({
      code: "invalid_state",
      message: "This speaker withdrew; their participation can't be changed.",
    });
  }
  if (from === args.to) return;

  const contact = await ctx.db.get(
    "eventContacts",
    args.participant.eventContactId,
  );
  await ctx.db.patch("sessionParticipants", args.participant._id, {
    state: args.to,
    stateSetBy: args.actorUserId,
    stateSetAt: Date.now(),
  });
  if (args.to === "declined") {
    // A speaker who drops out must not keep a calendar entry for a slot they
    // are no longer speaking in — only THEIR invitation is cancelled (M3/M6).
    await Agenda.cancelParticipantSlot(ctx, {
      event: args.event,
      participant: args.participant,
      actorUserId: args.actorUserId,
      reason: "declined",
    });
  }
  await logAudit(ctx, {
    orgId: args.event.orgId,
    eventId: args.event._id,
    actorUserId: args.actorUserId,
    action: "participation.setState",
    targetType: "sessionParticipant",
    targetId: args.participant._id,
    meta: {
      from,
      to: args.to,
      // True when a manager or organizer answered for the speaker — M3 wants
      // that visible, not hidden behind an anonymous state change.
      onBehalf: contact?.userId !== args.actorUserId,
    },
  });
}

// ── Organizer session list ───────────────────────────────────────────────

export type SessionParticipantRow = {
  participantId: Id<"sessionParticipants">;
  eventContactId: Id<"eventContacts">;
  firstName: string;
  lastName: string;
  role: string;
  state: Doc<"sessionParticipants">["state"];
};

export type SessionRow = {
  session: Doc<"sessions">;
  participants: SessionParticipantRow[];
};

/** The M2 sessions list. Organizer-only: sessions carry post-acceptance
 * operational data, which reviewers must not see. */
export async function listSessions(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<SessionRow[]> {
  requireOrganizer(caller);
  const eventId = caller.event._id;
  const [sessions, participants, contacts] = await Promise.all([
    ctx.db
      .query("sessions")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(SESSION_SCAN),
    ctx.db
      .query("sessionParticipants")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(PARTICIPANT_SCAN),
    ctx.db
      .query("eventContacts")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(CONTACT_SCAN),
  ]);
  const contactById = new Map(contacts.map((c) => [c._id, c]));
  const bySession = new Map<Id<"sessions">, SessionParticipantRow[]>();
  for (const participant of participants) {
    const contact = contactById.get(participant.eventContactId);
    const rows = bySession.get(participant.sessionId) ?? [];
    rows.push({
      participantId: participant._id,
      eventContactId: participant.eventContactId,
      firstName: contact?.firstName ?? "",
      lastName: contact?.lastName ?? "",
      role: participant.role,
      state: participant.state,
    });
    bySession.set(participant.sessionId, rows);
  }
  return sessions.map((session) => ({
    session,
    participants: bySession.get(session._id) ?? [],
  }));
}

/** Content approval (W5, CNT-12): the editorial gate on public output.
 * Distinct from the publish flag — approving doesn't list a session, but
 * setting draft pulls it from every public surface immediately. */
export async function setContentStatus(
  ctx: MutationCtx,
  caller: EventCaller,
  sessionId: Id<"sessions">,
  to: "draft" | "approved",
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const session = await ctx.db.get("sessions", sessionId);
  if (session === null || session.eventId !== caller.event._id) {
    notFound("session", "No such session on this event.");
  }
  if ((session.contentStatus ?? "approved") === to) return;
  await ctx.db.patch("sessions", sessionId, {
    contentStatus: to,
    contentStatusSetBy: caller.user._id,
    contentStatusSetAt: Date.now(),
  });
  await republishIfPublished(ctx, caller.event._id);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "sessions.setContentStatus",
    targetType: "session",
    targetId: sessionId,
    meta: { to },
  });
}

// ── Content editing & revision history (W5: CNT-09/CNT-11) ───────────────

type SessionContentFields = {
  title: string;
  description?: string;
  format?: string;
};

function contentFields(session: Doc<"sessions">): SessionContentFields {
  return {
    title: session.title,
    description: session.description,
    format: session.format,
  };
}

/** Record one edit in the session's history. Exported so the portal's
 * manager-side edit records through the same trail. */
export async function recordRevision(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    session: Doc<"sessions">;
    after: SessionContentFields;
    editedBy: Id<"users">;
  },
): Promise<void> {
  await ctx.db.insert("sessionRevisions", {
    eventId: args.event._id,
    sessionId: args.session._id,
    editedBy: args.editedBy,
    editedAt: Date.now(),
    before: contentFields(args.session),
    after: args.after,
  });
}

/** Organizer content edit from the central admin view (CNT-09): patches the
 * content fields, records the revision, keeps public output current. */
export async function updateContent(
  ctx: MutationCtx,
  caller: EventCaller,
  sessionId: Id<"sessions">,
  patch: { title?: string; description?: string; format?: string },
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const session = await ctx.db.get("sessions", sessionId);
  if (session === null || session.eventId !== caller.event._id) {
    notFound("session", "No such session on this event.");
  }
  const next: SessionContentFields = {
    title:
      patch.title === undefined
        ? session.title
        : assertText(patch.title, { label: "Session title", max: 200 }),
    description:
      patch.description === undefined
        ? session.description
        : patch.description.trim() === ""
          ? undefined
          : patch.description.slice(0, 10000),
    format:
      patch.format === undefined
        ? session.format
        : patch.format.trim() === ""
          ? undefined
          : patch.format.slice(0, 80),
  };
  const unchanged =
    next.title === session.title &&
    next.description === session.description &&
    next.format === session.format;
  if (unchanged) return;
  await recordRevision(ctx, {
    event: caller.event,
    session,
    after: next,
    editedBy: caller.user._id,
  });
  await ctx.db.patch("sessions", sessionId, next);
  await republishIfPublished(ctx, caller.event._id);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "sessions.updateContent",
    targetType: "session",
    targetId: sessionId,
    meta: { fields: Object.keys(patch) },
  });
}

export type RevisionRow = {
  revisionId: Id<"sessionRevisions">;
  editedAt: number;
  editorName: string | null;
  editorEmail: string | null;
  before: SessionContentFields;
  after: SessionContentFields;
};

export async function listRevisions(
  ctx: QueryCtx,
  caller: EventCaller,
  sessionId: Id<"sessions">,
): Promise<RevisionRow[]> {
  requireOrganizer(caller);
  const session = await ctx.db.get("sessions", sessionId);
  if (session === null || session.eventId !== caller.event._id) {
    notFound("session", "No such session on this event.");
  }
  // Newest 200 — descending BEFORE the take, or a long history would keep
  // the oldest rows and drop the recent ones (codex).
  const rows = await ctx.db
    .query("sessionRevisions")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .take(200);
  const out: RevisionRow[] = [];
  for (const row of rows) {
    const editor = await ctx.db.get("users", row.editedBy);
    out.push({
      revisionId: row._id,
      editedAt: row.editedAt,
      editorName: editor?.name ?? null,
      editorEmail: editor?.email ?? null,
      before: row.before,
      after: row.after,
    });
  }
  // Newest first — the history panel reads downward into the past.
  return out.sort((a, b) => b.editedAt - a.editedAt);
}

/** Restore the content as it was BEFORE the given revision (CNT-11). The
 * restore itself is recorded as a new revision, so nothing is ever lost. */
export async function restoreRevision(
  ctx: MutationCtx,
  caller: EventCaller,
  revisionId: Id<"sessionRevisions">,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const revision = await ctx.db.get("sessionRevisions", revisionId);
  if (revision === null || revision.eventId !== caller.event._id) {
    notFound("revision", "No such revision on this event.");
  }
  // Absent fields restore as CLEARED, not as kept-current — "" is
  // updateContent's explicit clear.
  await updateContent(ctx, caller, revision.sessionId, {
    title: revision.before.title,
    description: revision.before.description ?? "",
    format: revision.before.format ?? "",
  });
}

/** Post-commit half of `createDirectSession`: render + send the invitation
 * in its own transaction so a delivery failure can't unwind the invite. */
export async function sendDirectInvitation(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    eventContactId: Id<"eventContacts">;
    sentByUserId: Id<"users">;
  },
): Promise<void> {
  const session = await ctx.db.get("sessions", args.sessionId);
  if (session === null || session.status !== "planned") return;
  const event = await ctx.db.get("events", session.eventId);
  if (event === null) return;
  const contact = await ctx.db.get("eventContacts", args.eventContactId);
  const toEmail = contact?.email?.trim();
  if (contact === null || toEmail === undefined || toEmail.length === 0) return;
  // A decline/withdrawal (or a removed participant) that lands between the
  // invite committing and this job running wins: no invitation goes out for
  // a participation that no longer stands.
  const participant = await ctx.db
    .query("sessionParticipants")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
    .take(MAX_PARTICIPANTS_PER_SESSION)
    .then((rows) => rows.find((p) => p.eventContactId === contact._id));
  if (
    participant === undefined ||
    participant.state === "declined" ||
    participant.state === "withdrawn"
  ) {
    return;
  }

  const when = eventWhen(event);
  const invitation = await renderTemplate(ctx, event, "invitation.direct", {
    event: {
      name: event.name,
      when,
      location: event.location ?? "",
      // One escaped line so the default template needs no conditional markup;
      // organizers editing the template still have {{event.when}} and
      // {{event.location}} separately.
      whenWhere:
        event.location === undefined ? when : `${when} — ${event.location}`,
    },
    speaker: { firstName: contact.firstName, lastName: contact.lastName },
    session: { title: session.title },
    link: portalLink(event.slug),
  });
  await sendLoggedEmail(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    toEmail,
    kind: "invitation.direct",
    subject: invitation.subject,
    html: invitation.html,
    sentByUserId: args.sentByUserId,
    replyTo: event.replyTo,
    context: { sessionId: session._id, eventContactId: contact._id },
  });
}
