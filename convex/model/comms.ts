import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { mailFromAddress } from "../emails";
import { internal } from "../_generated/api";
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

/** The form an address takes in the comms log: trimmed + lowercased, so the
 * (eventId, toEmail) index is a case-insensitive lookup without a second
 * column. Deliberately NOT validated — the log records what we tried to send
 * to, even if it was junk. */
export function normalizeLogAddress(email: string): string {
  return email.trim().toLowerCase();
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

/**
 * Send through Resend and record the send in the comms log.
 *
 * The send runs in a SUBTRANSACTION (`ctx.runMutation` from a mutation): a
 * component refusal — Resend test mode with a real address, a bad key —
 * rolls back only the send's own writes, never the CALLER's. Three eval
 * findings were exactly this bug class (submit/invite/release unwound by an
 * email failure); now the business write always commits and the refused send
 * is a visible `failed` row in the comms log instead of a lost mutation.
 */
export async function sendLoggedEmail(
  ctx: MutationCtx,
  args: LoggedEmail,
): Promise<Id<"messages">> {
  const replyTo = args.replyTo?.trim();
  let emailId: string | undefined;
  try {
    emailId = await ctx.runMutation(internal.emails.trySend, {
      // Sent to the address as the caller gave it: only the LOG is normalized.
      toEmail: args.toEmail,
      kind: args.kind,
      subject: args.subject,
      html: args.html,
      replyTo,
    });
  } catch {
    emailId = undefined;
  }
  return await ctx.db.insert("messages", {
    orgId: args.orgId,
    eventId: args.eventId,
    contactId: args.contactId,
    // Normalized so `by_eventId_and_toEmail` can answer the per-contact log
    // with an indexed equality (M4). Every caller already passes cleanEmail()/
    // normalizeEmail() output; doing it here too makes that a guarantee of the
    // write path instead of a convention six call sites have to remember.
    toEmail: normalizeLogAddress(args.toEmail),
    kind: args.kind,
    subject: args.subject,
    resendEmailId: emailId,
    deliveryStatus: emailId === undefined ? "failed" : "queued",
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

// ── Bulk-mail opt-out (M15) ──────────────────────────────────────────────
//
// Two kinds of mail leave StageStack. Transactional lifecycle mail (an
// invitation, a decision, a calendar update) is a one-to-one consequence of
// something the recipient or their organizer did, and an opt-out header on it
// would offer to break a flow the recipient still needs. Bulk/nudge mail — an
// organizer broadcast to a whole audience, and the recurring reminder digests —
// is mail a recipient can legitimately want to stop, and the one Gmail/Yahoo
// bulk-sender rules (2024) penalise when `List-Unsubscribe` is missing.
//
// Only the second group gets the header, keyed off the machine `kind` so the
// classification lives in one place instead of at every send site.
const BULK_KIND_PREFIXES = ["reminder."];

/** Is this `kind` bulk/nudge mail (broadcasts + reminder digests) rather than
 * transactional lifecycle mail? */
export function isBulkKind(kind: string): boolean {
  return (
    kind === ONE_OFF_KIND ||
    kind === "crm.bulkOutreach" ||
    BULK_KIND_PREFIXES.some((prefix) => kind.startsWith(prefix))
  );
}

/**
 * `List-Unsubscribe` for bulk kinds, empty for everything else.
 *
 * DELIBERATELY `mailto:`, not RFC 8058 one-click. One-click needs an
 * unauthenticated HTTP endpoint plus a signed per-recipient token, and — the
 * part that matters — a suppression row the send path checks, or the endpoint
 * accepts requests and silently ignores them. A `mailto:` aimed at a mailbox a
 * human already reads (the event's reply-to, else the deployment's own
 * MAIL_FROM) is honest today: the request reaches the person who can honour it,
 * which is exactly what replying to the email does. `List-Unsubscribe-Post` is
 * omitted on purpose — it promises a one-click HTTPS POST target, so sending it
 * alongside a mailto: would advertise a capability that does not exist.
 *
 * docs/ARCHITECTURE.md ("Bulk mail & unsubscribe") records what the automated
 * per-event opt-out needs: a suppression table plus a check in `sendLoggedEmail`.
 */
export function unsubscribeHeaders(
  kind: string,
  replyTo: string | undefined,
): { headers?: Array<{ name: string; value: string }> } {
  if (!isBulkKind(kind)) return {};
  const target =
    replyTo !== undefined && replyTo.length > 0 ? replyTo : mailFromAddress();
  return {
    headers: [
      {
        name: "List-Unsubscribe",
        value: `<mailto:${target}?subject=Unsubscribe>`,
      },
    ],
  };
}

const MAX_ONEOFF_SUBJECT = 300;
const MAX_ONEOFF_HTML = 50_000;
/** Newest-first rows read per source in the per-contact log. Both sources are
 * indexed (M4), so this is a display bound, not a scan bound. */
const MESSAGE_SCAN = 2000;

export type OneOffTarget =
  | { kind: "contact"; eventContactId: Id<"eventContacts"> }
  | { kind: "contacts"; eventContactIds: Array<Id<"eventContacts">> }
  | { kind: "audience"; audience: AudienceKind };

export type OneOffResult = {
  /** Messages the provider accepted for delivery. */
  sent: number;
  /** Messages the provider refused before they left StageStack. */
  failed: number;
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
  } else if (args.to.kind === "contacts") {
    const uniqueIds = [...new Set(args.to.eventContactIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > MAX_AUDIENCE) {
      throw new ConvexError({
        code: "invalid_audience",
        message: `Choose between 1 and ${MAX_AUDIENCE} speakers.`,
      });
    }
    recipients = [];
    for (const eventContactId of uniqueIds) {
      const contact = await ctx.db.get("eventContacts", eventContactId);
      if (contact === null || contact.eventId !== event._id) {
        notFound("contact", "No such contact on this event.");
      }
      const email = contact.email?.trim().toLowerCase();
      if (email === undefined || email.length === 0) {
        skipped += 1;
        continue;
      }
      recipients.push({
        email,
        firstName: contact.firstName,
        lastName: contact.lastName,
        eventContactId: contact._id,
        userId: contact.userId,
      });
    }
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
  if (recipients.length === 0 && args.to.kind !== "contacts") {
    throw new ConvexError({
      code: "empty_audience",
      message: "Nobody in this audience has a reachable email address.",
    });
  }

  // A selected set can contain two event snapshots for the same real inbox.
  // IDs are deduped above to protect the read, but delivery is deduped by the
  // normalized address so that person still receives exactly one message.
  const recipientsByEmail = new Map<string, AudienceRecipient>();
  for (const recipient of recipients) {
    const email = normalizeLogAddress(recipient.email);
    if (recipientsByEmail.has(email)) continue;
    recipientsByEmail.set(email, { ...recipient, email });
  }
  recipients = [...recipientsByEmail.values()];

  let sent = 0;
  let failed = 0;
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
    const renderedSubject = substituteSubject(subject, vars);
    const renderedBody = emailShell(substituteHtml(body, vars));
    const messageId = await sendLoggedEmail(ctx, {
      orgId: event.orgId,
      eventId: event._id,
      contactId,
      toEmail: recipient.email,
      kind: ONE_OFF_KIND,
      subject: renderedSubject,
      html: renderedBody,
      sentByUserId: caller.user._id,
      replyTo: event.replyTo,
      context:
        args.to.kind === "audience"
          ? { audience: args.to.audience, renderedSubject, renderedBody }
          : {
              eventContactId: recipient.eventContactId,
              renderedSubject,
              renderedBody,
            },
    });
    const logged = await ctx.db.get("messages", messageId);
    if (logged?.deliveryStatus === "failed") failed += 1;
    else sent += 1;
  }

  await logAudit(ctx, {
    orgId: event.orgId,
    eventId: event._id,
    actorUserId: caller.user._id,
    action: "comms.sendOneOff",
    targetType: "event",
    targetId: event._id,
    meta: {
      target:
        args.to.kind === "audience"
          ? args.to.audience
          : args.to.kind === "contact"
            ? "contact"
            : "selectedContacts",
      sent,
      failed,
      skipped,
    },
  });
  return { sent, failed, skipped };
}

// ── Delivery health (CFP-08) ─────────────────────────────────────────────
//
// `sendLoggedEmail` deliberately commits the caller's write even when the mail
// service refuses the send — the refusal becomes a `failed` messages row. That
// keeps mutations honest, but it also means a misconfigured deployment (no
// Resend key, test mode with real recipients) fails EVERY send silently from
// the organizer's point of view. This summary makes that state loud: the comms
// page shows a banner whenever recent sends are failing.

/** Newest rows examined for the health summary. A display bound like
 * MESSAGE_SCAN, not a time window: "N of the last M sends failed" is the
 * honest phrasing for what one indexed newest-first read can know. */
const HEALTH_SCAN = 100;

export type DeliveryHealth = {
  /** Rows examined, newest first, so the UI can say "of the last N". */
  scanned: number;
  /** Sends the mail service refused — the email never left StageStack.
   * Distinct from bounced/complained, which left and were rejected later. */
  failed: number;
  /** When the most recent refusal happened; null when none in the window. */
  lastFailedAt: number | null;
};

/** Recent-send failure summary for the organizer-facing mail-health banner. */
export async function deliveryHealth(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<DeliveryHealth> {
  requireOrganizer(caller);
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
    .order("desc")
    .take(HEALTH_SCAN);
  const failed = recent.filter((m) => m.deliveryStatus === "failed");
  return {
    scanned: recent.length,
    failed: failed.length,
    lastFailedAt: failed.length === 0 ? null : failed[0]._creationTime,
  };
}

export type ContactMessageRow = {
  messageId: Id<"messages">;
  kind: string;
  subject: string;
  toEmail: string;
  deliveryStatus: Doc<"messages">["deliveryStatus"];
  sentAt: number;
  /** The provider's own timestamp for the last delivery event, when one has
   * arrived. Absent means no provider event has moved this row. */
  deliveryUpdatedAt?: number;
};

/**
 * "Comms log per contact (what was sent, when)" (MILESTONES M5).
 *
 * Two sources, because `messages.contactId` points at the ORG contact and is
 * only stamped when the send site knew about it: the indexed rows for the
 * linked org contact, plus the rows addressed to this snapshot's email.
 * Merged by id, newest first.
 *
 * The address half is an INDEXED equality on (eventId, toEmail) — M4. It used
 * to take the OLDEST 2000 messages on the whole event and `.filter()` them in
 * memory, so on a busy event the panel cost a 2000-row scan AND missed every
 * recent message. Both reads are now newest-first and touch only this
 * contact's rows.
 *
 * Truncation at MESSAGE_SCAN is deliberately a plain bound here, not an
 * `event_too_large` refusal: this is a listing, the rows are newest-first, so
 * a contact with more than MESSAGE_SCAN messages sees the most recent ones —
 * dropping the oldest tail is what a log view means by a limit, and no
 * decision is derived from completeness.
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
  const rawEmail = contact.email?.trim();
  const email =
    rawEmail === undefined || rawEmail.length === 0
      ? undefined
      : normalizeLogAddress(rawEmail);

  const byContact =
    contact.contactId === undefined
      ? []
      : await ctx.db
          .query("messages")
          .withIndex("by_contactId", (q) =>
            q.eq("contactId", contact.contactId),
          )
          .order("desc")
          .take(MESSAGE_SCAN);

  // Addresses are stored normalized (sendLoggedEmail), so one equality covers
  // every casing we write. The as-typed variant is read too, and only when it
  // differs: rows written before normalization was enforced could carry the
  // address exactly as an organizer typed it, and this keeps them visible
  // without a migration.
  const addressQueries =
    email === undefined
      ? []
      : [
          email,
          ...(rawEmail !== undefined && rawEmail !== email ? [rawEmail] : []),
        ].map((address) =>
          ctx.db
            .query("messages")
            .withIndex("by_eventId_and_toEmail", (q) =>
              q.eq("eventId", caller.event._id).eq("toEmail", address),
            )
            .order("desc")
            .take(MESSAGE_SCAN),
        );
  const byEvent = (await Promise.all(addressQueries)).flat();

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
      ...(message.deliveryUpdatedAt === undefined
        ? {}
        : { deliveryUpdatedAt: message.deliveryUpdatedAt }),
    }));
}
