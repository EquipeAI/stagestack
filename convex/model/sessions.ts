import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import { escapeHtml, emailShell, sendLoggedEmail, siteUrl } from "./comms";
import { proposalAbstract, proposalLink } from "./cfp";
import { assertEventActive } from "./reviews";
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
  bio?: string;
  headshotId?: Id<"_storage">;
  links?: {
    website?: string;
    twitter?: string;
    linkedin?: string;
    github?: string;
  };
};

function profileOf(speaker: Doc<"proposalSpeakers">): SpeakerProfile {
  return {
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    email: speaker.email,
    phone: speaker.phone,
    tagline: speaker.tagline,
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
 */
async function ensureEventContact(
  ctx: MutationCtx,
  event: Doc<"events">,
  profile: SpeakerProfile,
): Promise<Id<"eventContacts">> {
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
async function materializeSession(
  ctx: MutationCtx,
  event: Doc<"events">,
  proposal: Doc<"proposals">,
): Promise<Id<"sessions">> {
  const existing = await sessionForProposal(ctx, proposal._id);
  const sessionId =
    existing?._id ??
    (await ctx.db.insert("sessions", {
      eventId: event._id,
      title: proposal.title,
      description: await proposalAbstract(ctx, proposal),
      proposalId: proposal._id,
      source: "cfp",
      status: "planned",
    }));
  const speakers = await ctx.db
    .query("proposalSpeakers")
    .withIndex("by_proposalId", (q) => q.eq("proposalId", proposal._id))
    .take(MAX_SPEAKERS_PER_PROPOSAL);
  for (const speaker of speakers.sort((a, b) => a.order - b.order)) {
    const eventContactId = await ensureEventContact(
      ctx,
      event,
      profileOf(speaker),
    );
    await ensureParticipant(ctx, {
      sessionId,
      eventId: event._id,
      eventContactId,
      managerUserId: proposal.submitterUserId,
    });
  }
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

function acceptedEmail(
  event: Doc<"events">,
  proposal: Doc<"proposals">,
): { subject: string; html: string } {
  return {
    subject: `Your proposal was accepted: ${proposal.title}`,
    html: emailShell(
      [
        `<p>Congratulations — your proposal was accepted for <strong>${escapeHtml(event.name)}</strong>.</p>`,
        `<p><strong>${escapeHtml(proposal.title)}</strong></p>`,
        `<p>Each speaker's participation still awaits confirmation, so we'll be in touch shortly about confirming who is presenting.</p>`,
        `<p><a href="${proposalLink(event.slug, proposal._id)}">View your proposal</a></p>`,
      ].join("\n"),
    ),
  };
}

function declinedEmail(
  event: Doc<"events">,
  proposal: Doc<"proposals">,
): { subject: string; html: string } {
  return {
    subject: `About your proposal: ${proposal.title}`,
    html: emailShell(
      [
        `<p>Thank you for submitting to <strong>${escapeHtml(event.name)}</strong>.</p>`,
        `<p><strong>${escapeHtml(proposal.title)}</strong></p>`,
        `<p>We received more strong proposals than we have room for, and we're not able to include this one in the programme. We genuinely appreciate the time you put into it and hope you'll submit again.</p>`,
        `<p><a href="${proposalLink(event.slug, proposal._id)}">View your proposal</a></p>`,
      ].join("\n"),
    ),
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

    if (to === "accepted") {
      await materializeSession(ctx, event, proposal);
      const { subject, html } = acceptedEmail(event, proposal);
      await mailSubmitter(ctx, event, proposal, {
        kind: "decision.accepted",
        subject,
        html,
      });
    } else {
      const { subject, html } = declinedEmail(event, proposal);
      await mailSubmitter(ctx, event, proposal, {
        kind: "decision.declined",
        subject,
        html,
      });
    }

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

  if (to === "declined") {
    // Cancel, never delete: "retain it as restorable history, remove it from
    // active scheduling and public views". Calendar cancellations are N/A
    // until M5 distributes invitations.
    const session = await sessionForProposal(ctx, proposalId);
    if (session !== null && session.status !== "cancelled") {
      await ctx.db.patch("sessions", session._id, {
        status: "cancelled",
        cancelledAt: now,
      });
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

  await mailSubmitter(ctx, event, proposal, {
    kind: "decision.corrected",
    subject: `Correction about your proposal: ${proposal.title}`,
    html: emailShell(
      [
        `<p>We need to correct the decision we sent you about <strong>${escapeHtml(event.name)}</strong>, and we're sorry for the confusion.</p>`,
        `<p><strong>${escapeHtml(proposal.title)}</strong></p>`,
        `<p>The correct decision is: <strong>${to === "accepted" ? "accepted" : "not accepted"}</strong>.</p>`,
        `<p>${escapeHtml(reason)}</p>`,
        `<p><a href="${proposalLink(event.slug, proposalId)}">View your proposal</a></p>`,
      ].join("\n"),
    ),
    context: { proposalId, from, to },
  });

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: event._id,
    actorUserId: caller.user._id,
    action: "decision.correct",
    targetType: "proposal",
    targetId: proposalId,
    meta: { from, to, note: reason },
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

  await sendLoggedEmail(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    toEmail: speakerEmail,
    kind: "invitation.direct",
    subject: `Invitation to speak at ${event.name}`,
    html: emailShell(
      [
        `<p>Hi ${escapeHtml(profile.firstName)},</p>`,
        `<p>You're invited to speak at <strong>${escapeHtml(event.name)}</strong>.</p>`,
        `<p><strong>${escapeHtml(title)}</strong><br />${escapeHtml(eventWhen(event))}${
          event.location === undefined
            ? ""
            : `<br />${escapeHtml(event.location)}`
        }</p>`,
        `<p><a href="${portalLink(event.slug)}">Confirm your participation</a></p>`,
      ].join("\n"),
    ),
    sentByUserId: caller.user._id,
    context: { sessionId, eventContactId },
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
  });
  const eventContactId = await ensureEventContact(ctx, caller.event, profile);
  await ensureParticipant(ctx, {
    sessionId,
    eventId: caller.event._id,
    eventContactId,
    managerUserId: undefined,
  });
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
