import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { resend } from "../emails";
import { logAudit } from "./audit";
import {
  MAX_AUDIENCE,
  resolveAudience,
  type AudienceKind,
  type AudienceRecipient,
} from "./audiences";
import { substituteHtml, substituteSubject } from "./templates";
import { assertEventActive } from "./validation";

// ─────────────────────────────────────────────────────────────────────────
// Comms log (M1). Every StageStack email goes out through sendLoggedEmail so
// there is exactly one write path: Resend send + a `messages` row. The Resend
// webhook (convex/emails.ts) patches deliveryStatus by resendEmailId.
// ─────────────────────────────────────────────────────────────────────────

export const MAIL_FROM = "StageStack <hello@stagestack.dev>";

export function siteUrl(): string {
  return process.env.SITE_URL ?? "https://stagestack.dev";
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape user-supplied text before interpolating it into email HTML. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Minimal branded wrapper — inline styles only (email clients drop <style>). */
export function emailShell(innerHtml: string): string {
  return [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111827;max-width:560px;margin:0 auto;padding:24px">`,
    `<div style="font-weight:700;font-size:18px;letter-spacing:-0.01em;margin-bottom:16px">StageStack</div>`,
    innerHtml,
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />`,
    `<div style="font-size:12px;color:#6b7280">Sent by StageStack.</div>`,
    `</div>`,
  ].join("\n");
}

export type LoggedEmail = {
  orgId: Id<"organizations">;
  eventId?: Id<"events">;
  contactId?: Id<"contacts">;
  toEmail: string;
  /** Stable machine key, e.g. "cfp.confirmation", "team.invite". */
  kind: string;
  subject: string;
  html: string;
  sentByUserId?: Id<"users">;
  /** Event reply-to (M5). The component's batch `sendEmail` DOES accept
   * `replyTo: string[]` (verified in @convex-dev/resend 0.2.6 client types), so
   * this needs no raw-API detour — unlike attachments. */
  replyTo?: string;
  context?: unknown;
};

/** Send through Resend and record the send in the comms log. */
export async function sendLoggedEmail(
  ctx: MutationCtx,
  args: LoggedEmail,
): Promise<Id<"messages">> {
  const replyTo = args.replyTo?.trim();
  const emailId = await resend.sendEmail(ctx, {
    from: MAIL_FROM,
    to: args.toEmail,
    subject: args.subject,
    html: args.html,
    ...(replyTo !== undefined && replyTo.length > 0
      ? { replyTo: [replyTo] }
      : {}),
  });
  return await ctx.db.insert("messages", {
    orgId: args.orgId,
    eventId: args.eventId,
    contactId: args.contactId,
    toEmail: args.toEmail,
    kind: args.kind,
    subject: args.subject,
    resendEmailId: emailId,
    deliveryStatus: "queued",
    sentByUserId: args.sentByUserId,
    context: args.context,
  });
}

// ── Organizer notification audience ──────────────────────────────────────

export type Recipient = { email: string; userId: Id<"users"> };

/** Org owners/admins + event organizers, deduped by email. */
export async function organizerRecipients(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<Recipient[]> {
  const [orgMembers, eventMembers] = await Promise.all([
    ctx.db
      .query("members")
      .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", event.orgId))
      .take(200),
    ctx.db
      .query("eventMembers")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .take(200),
  ]);
  const userIds: Array<Id<"users">> = [
    ...orgMembers.map((m) => m.userId),
    ...eventMembers.filter((m) => m.role === "organizer").map((m) => m.userId),
  ];
  const users = await Promise.all(
    userIds.map((userId) => ctx.db.get("users", userId)),
  );
  const byEmail = new Map<string, Recipient>();
  for (const [i, user] of users.entries()) {
    const email = user?.email?.trim().toLowerCase();
    if (email === undefined || email.length === 0) continue;
    if (byEmail.has(email)) continue;
    byEmail.set(email, { email, userId: userIds[i] });
  }
  return [...byEmail.values()];
}

/** Fan one logged email out to everyone who organizes `event`. */
export async function notifyOrganizers(
  ctx: MutationCtx,
  event: Doc<"events">,
  args: { kind: string; subject: string; html: string; context?: unknown },
): Promise<void> {
  for (const recipient of await organizerRecipients(ctx, event)) {
    await sendLoggedEmail(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      toEmail: recipient.email,
      kind: args.kind,
      subject: args.subject,
      html: args.html,
      replyTo: event.replyTo,
      context: args.context,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Manual one-off operational sends + the per-contact comms log (M5).
// ─────────────────────────────────────────────────────────────────────────

/** Machine kind stamped on every manual send, so the log can tell an organizer
 * broadcast apart from a lifecycle email. */
export const ONE_OFF_KIND = "manual.oneoff";

const MAX_ONEOFF_SUBJECT = 300;
const MAX_ONEOFF_HTML = 50_000;
/** Bounded scan for the "same address, no linked contact" half of the log. */
const MESSAGE_SCAN = 2000;

export type OneOffTarget =
  | { kind: "contact"; eventContactId: Id<"eventContacts"> }
  | { kind: "audience"; audience: AudienceKind };

export type OneOffResult = {
  sent: number;
  /** Speakers in the audience we had no reachable address for. */
  skipped: number;
};

async function contactRecipient(
  ctx: QueryCtx,
  event: Doc<"events">,
  eventContactId: Id<"eventContacts">,
): Promise<AudienceRecipient> {
  const contact = await ctx.db.get("eventContacts", eventContactId);
  if (contact === null || contact.eventId !== event._id) {
    notFound("contact", "No such contact on this event.");
  }
  const email = contact.email?.trim().toLowerCase();
  if (email === undefined || email.length === 0) {
    throw new ConvexError({
      code: "invalid_email",
      message: "This contact has no email address on this event.",
    });
  }
  return {
    email,
    firstName: contact.firstName,
    lastName: contact.lastName,
    eventContactId: contact._id,
    userId: contact.userId,
  };
}

/**
 * Send one organizer-authored message to a single event contact or a
 * state-derived audience. The body goes through the same {{variable}}
 * substitution as templates, per recipient — so "Hi {{speaker.firstName}}"
 * works in a broadcast — and every send lands in the comms log with its
 * sender, recipient, rendered content and delivery state (MILESTONES M5).
 */
export async function sendOneOff(
  ctx: MutationCtx,
  caller: EventCaller,
  args: {
    to: OneOffTarget;
    subject: string;
    html: string;
    now: number;
  },
): Promise<OneOffResult> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const event = caller.event;

  const subject = args.subject.trim();
  if (subject.length === 0 || subject.length > MAX_ONEOFF_SUBJECT) {
    throw new ConvexError({
      code: "invalid_subject",
      message: `Subject must be 1-${MAX_ONEOFF_SUBJECT} characters.`,
    });
  }
  const body = args.html.trim();
  if (body.length === 0 || body.length > MAX_ONEOFF_HTML) {
    throw new ConvexError({
      code: "invalid_html",
      message: `Message must be 1-${MAX_ONEOFF_HTML} characters.`,
    });
  }

  let recipients: AudienceRecipient[];
  let skipped = 0;
  if (args.to.kind === "contact") {
    recipients = [await contactRecipient(ctx, event, args.to.eventContactId)];
  } else {
    const resolved = await resolveAudience(
      ctx,
      event,
      args.to.audience,
      args.now,
    );
    // Refuse rather than silently truncate: a capped send would quietly reach
    // only MAX_AUDIENCE of a larger audience (finding #5).
    if (resolved.truncated) {
      throw new ConvexError({
        code: "audience_too_large",
        message: `This audience has ${resolved.totalKnown} reachable recipients; a single send reaches at most ${MAX_AUDIENCE}. Narrow it down.`,
      });
    }
    recipients = resolved.recipients;
    skipped = resolved.skipped;
  }
  if (recipients.length === 0) {
    throw new ConvexError({
      code: "empty_audience",
      message: "Nobody in this audience has a reachable email address.",
    });
  }

  for (const recipient of recipients) {
    const vars = {
      event: { name: event.name },
      speaker: {
        firstName: recipient.firstName,
        lastName: recipient.lastName,
        fullName: `${recipient.firstName} ${recipient.lastName}`.trim(),
        email: recipient.email,
      },
      link: `${siteUrl()}/portal/${event.slug}`,
    };
    const contactId =
      recipient.eventContactId === undefined
        ? undefined
        : ((await ctx.db.get("eventContacts", recipient.eventContactId))
            ?.contactId ?? undefined);
    await sendLoggedEmail(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      contactId,
      toEmail: recipient.email,
      kind: ONE_OFF_KIND,
      subject: substituteSubject(subject, vars),
      html: emailShell(substituteHtml(body, vars)),
      sentByUserId: caller.user._id,
      replyTo: event.replyTo,
      context:
        args.to.kind === "contact"
          ? { eventContactId: args.to.eventContactId }
          : { audience: args.to.audience },
    });
  }

  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: caller.user._id,
    action: "comms.sendOneOff",
    targetType: "event",
    targetId: event._id,
    meta: {
      target: args.to.kind === "contact" ? "contact" : args.to.audience,
      sent: recipients.length,
      skipped,
    },
  });
  return { sent: recipients.length, skipped };
}

export type ContactMessageRow = {
  messageId: Id<"messages">;
  kind: string;
  subject: string;
  toEmail: string;
  deliveryStatus: Doc<"messages">["deliveryStatus"];
  sentAt: number;
};

/**
 * "Comms log per contact (what was sent, when)" (MILESTONES M5).
 *
 * Two sources, because `messages.contactId` points at the ORG contact and is
 * only stamped when the send site knew about it: the indexed rows for the
 * linked org contact, plus an event-bounded pass matching the address itself.
 * Merged by id, newest first.
 */
export async function contactLog(
  ctx: QueryCtx,
  caller: EventCaller,
  eventContactId: Id<"eventContacts">,
): Promise<ContactMessageRow[]> {
  requireOrganizer(caller);
  const contact = await ctx.db.get("eventContacts", eventContactId);
  if (contact === null || contact.eventId !== caller.event._id) {
    notFound("contact", "No such contact on this event.");
  }
  const email = contact.email?.trim().toLowerCase();

  const byContact =
    contact.contactId === undefined
      ? []
      : await ctx.db
          .query("messages")
          .withIndex("by_contactId", (q) => q.eq("contactId", contact.contactId))
          .take(MESSAGE_SCAN);

  const byEvent =
    email === undefined
      ? []
      : (
          await ctx.db
            .query("messages")
            .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
            .take(MESSAGE_SCAN)
        ).filter((m) => m.toEmail.trim().toLowerCase() === email);

  const merged = new Map<Id<"messages">, Doc<"messages">>();
  for (const message of [...byContact, ...byEvent]) {
    // A message on another event that merely shares the org contact is not
    // this event's history.
    if (message.eventId !== caller.event._id) continue;
    merged.set(message._id, message);
  }
  return [...merged.values()]
    .sort((a, b) => b._creationTime - a._creationTime)
    .map((message) => ({
      messageId: message._id,
      kind: message.kind,
      subject: message.subject,
      toEmail: message.toEmail,
      deliveryStatus: message.deliveryStatus,
      sentAt: message._creationTime,
    }));
}
