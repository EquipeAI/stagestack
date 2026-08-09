import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { Resend, vOnEmailEventArgs, type EmailId } from "@convex-dev/resend";
import {
  base64Utf8,
  buildIcs,
  icsContentType,
  type IcsMethod,
} from "./model/ics";

// testMode flipped off deliberately (ARCHITECTURE.md): stagestack.dev is
// verified in Resend and the walking skeleton requires a real delivery.
export const resend: Resend = new Resend(components.resend, {
  testMode: false,
  onEmailEvent: internal.emails.handleEmailEvent,
});

// Resend event type → the comms log's deliveryStatus. Engagement events
// ("email.opened"/"email.clicked") say nothing about delivery, so they leave
// the stored status alone.
const DELIVERY_STATUS_BY_EVENT: Record<
  string,
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "bounced"
  | "complained"
  | "failed"
  | undefined
> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
};

// Delivery events land here via the Resend webhook and update the comms log
// row that model/comms.ts wrote when the email was queued (M1).
export const handleEmailEvent = internalMutation({
  args: vOnEmailEventArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    console.log("resend event", args.id, args.event.type);
    const status = DELIVERY_STATUS_BY_EVENT[args.event.type];
    if (status === undefined) return null;
    const message = await ctx.db
      .query("messages")
      .withIndex("by_resendEmailId", (q) => q.eq("resendEmailId", args.id))
      .first();
    if (message === null) return null;
    await ctx.db.patch("messages", message._id, { deliveryStatus: status });
    return null;
  },
});

export const sendTestEmail = internalMutation({
  args: { to: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const emailId = await resend.sendEmail(ctx, {
      from: "StageStack <hello@stagestack.dev>",
      to: args.to,
      subject: "StageStack walking skeleton: real-mode send",
      html: "<p>Hello from the StageStack Convex + Resend pipeline. If you can read this, real-mode email works.</p>",
    });
    return emailId;
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Calendar sends (M5 machinery, M6 caller).
//
// Attachments are the one thing the component's batch `sendEmail` cannot do
// (verified in the walking skeleton), so calendar mail goes through
// `sendEmailManually` + the raw Resend API with `Idempotency-Key: <emailId>`.
// Status/webhook tracking is unchanged, and the comms-log write path stays
// identical — an action can't touch ctx.db, so it hands the row to
// `recordCalendarMessage` right after the send.
// ─────────────────────────────────────────────────────────────────────────

const MAIL_FROM = "StageStack <hello@stagestack.dev>";

/** Raw Resend send with one .ics attachment. Returns the component's emailId. */
async function sendWithIcs(
  ctx: ActionCtx,
  args: {
    to: string;
    subject: string;
    html: string;
    ics: string;
    method: IcsMethod;
    replyTo?: string;
  },
): Promise<string> {
  return await resend.sendEmailManually(
    ctx,
    {
      from: MAIL_FROM,
      to: args.to,
      subject: args.subject,
      ...(args.replyTo === undefined ? {} : { replyTo: [args.replyTo] }),
    },
    async (emailId) => {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": emailId,
        },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: [args.to],
          subject: args.subject,
          html: args.html,
          ...(args.replyTo === undefined ? {} : { reply_to: [args.replyTo] }),
          attachments: [
            {
              filename: "invite.ics",
              content: base64Utf8(args.ics),
              content_type: icsContentType(args.method),
            },
          ],
        }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error(`Resend API ${res.status}: ${JSON.stringify(data)}`);
      }
      return (data as { id: string }).id;
    },
  );
}

/** The comms-log half of a calendar send — actions have no ctx.db. */
export const recordCalendarMessage = internalMutation({
  args: {
    orgId: v.id("organizations"),
    eventId: v.optional(v.id("events")),
    contactId: v.optional(v.id("contacts")),
    toEmail: v.string(),
    kind: v.string(),
    subject: v.string(),
    resendEmailId: v.string(),
    context: v.optional(v.any()),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      orgId: args.orgId,
      eventId: args.eventId,
      contactId: args.contactId,
      toEmail: args.toEmail,
      kind: args.kind,
      subject: args.subject,
      resendEmailId: args.resendEmailId,
      deliveryStatus: "queued",
      context: args.context,
    });
  },
});

const vIcs = v.object({
  method: v.union(v.literal("REQUEST"), v.literal("CANCEL")),
  uid: v.string(),
  sequence: v.number(),
  startMs: v.number(),
  endMs: v.number(),
  summary: v.string(),
  description: v.optional(v.string()),
  location: v.optional(v.string()),
  url: v.optional(v.string()),
  organizerName: v.string(),
  organizerEmail: v.string(),
  attendeeName: v.string(),
  attendeeEmail: v.string(),
});

/**
 * Send one calendar invitation/update/cancellation and log it.
 *
 * Callers schedule this from a mutation:
 *   ctx.scheduler.runAfter(0, internal.emails.sendCalendarInvite, args)
 * so the mutation stays transactional and the network call happens after it
 * commits.
 */
export const sendCalendarInvite = internalAction({
  args: {
    orgId: v.id("organizations"),
    eventId: v.optional(v.id("events")),
    contactId: v.optional(v.id("contacts")),
    toEmail: v.string(),
    subject: v.string(),
    html: v.string(),
    ics: vIcs,
    /** e.g. "calendar.invite" | "calendar.update" | "calendar.cancel". */
    kind: v.string(),
    replyTo: v.optional(v.string()),
    context: v.optional(v.any()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const ics = buildIcs(args.ics);
    const resendEmailId = await sendWithIcs(ctx, {
      to: args.toEmail,
      subject: args.subject,
      html: args.html,
      ics,
      method: args.ics.method,
      replyTo: args.replyTo,
    });
    await ctx.runMutation(internal.emails.recordCalendarMessage, {
      orgId: args.orgId,
      eventId: args.eventId,
      contactId: args.contactId,
      toEmail: args.toEmail,
      kind: args.kind,
      subject: args.subject,
      resendEmailId,
      context: args.context,
    });
    return resendEmailId;
  },
});

/** Walking-skeleton probe (checklist #3), now on the shared .ics builder. */
export const sendIcsTest = internalAction({
  args: { to: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const start = now + 24 * 3600 * 1000;
    const ics = buildIcs({
      method: "REQUEST",
      uid: `ics-skeleton-test-${args.to}@stagestack.dev`,
      sequence: 0,
      startMs: start,
      endMs: start + 3600 * 1000,
      stampMs: now,
      summary: "StageStack walking skeleton: .ics test session",
      description:
        "If this shows up as a native calendar invite, check #3 passes.",
      location: "Main Stage",
      organizerName: "StageStack",
      organizerEmail: "hello@stagestack.dev",
      attendeeName: args.to,
      attendeeEmail: args.to,
    });
    return await sendWithIcs(ctx, {
      to: args.to,
      subject: "Invitation: StageStack .ics test session",
      html: "<p>Calendar invite attached — it should render natively in Gmail.</p>",
      ics,
      method: "REQUEST",
    });
  },
});

export const emailStatus = internalMutation({
  args: { emailId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await resend.status(ctx, args.emailId as EmailId);
  },
});
