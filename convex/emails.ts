import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
// Cycle with model/comms is deliberate and safe: both sides bind functions
// used at call time, never at module init.
import { unsubscribeHeaders } from "./model/comms";
import type { ActionCtx } from "./_generated/server";
import { Resend, vOnEmailEventArgs, type EmailId } from "@convex-dev/resend";
import {
  base64Utf8,
  buildIcs,
  icsContentType,
  type IcsMethod,
} from "./model/ics";

// ── Mail identity & send mode (M14) ──────────────────────────────────────
//
// Both facts a self-hoster must own — WHICH domain we send from and WHETHER we
// are allowed to send to real people — come from deployment env vars, because
// the alternative (constants) means a fresh clone tries to send as
// hello@stagestack.dev, a domain it does not control, and Resend records every
// lifecycle email as failed.
//
// `MAIL_FROM` is the single source of truth for the envelope From; it must be
// an address on a domain verified in the deployment's own Resend account.
const DEFAULT_MAIL_FROM = "StageStack <hello@stagestack.dev>";

/** Envelope `From` for every StageStack email (batch sends and the raw-API
 * calendar sends alike). Read per send, so setting the env var takes effect
 * without touching code. */
export function mailFrom(): string {
  const configured = process.env.MAIL_FROM?.trim();
  return configured === undefined || configured.length === 0
    ? DEFAULT_MAIL_FROM
    : configured;
}

/** The bare address inside a `Name <addr>` mailbox — what a header that must
 * carry an address and nothing else (List-Unsubscribe) needs. */
export function mailFromAddress(): string {
  const match = /<([^>]+)>/.exec(mailFrom());
  return (match?.[1] ?? mailFrom()).trim();
}

/**
 * Whether the Resend component stays in test mode (it then REFUSES any
 * recipient outside Resend's own test addresses, throwing inside the sending
 * mutation).
 *
 * Default ON, so a clone that copies a RESEND_API_KEY in cannot email real
 * speakers from a domain it has not verified. Turning it off is deliberate and
 * explicit: set `RESEND_TEST_MODE` to `false` / `0` / `no` / `off` (any case)
 * on the deployment. Anything else — including a typo like `flase` — leaves
 * test mode ON, because the failure mode of guessing wrong here is real mail
 * to real people.
 */
const TEST_MODE_OFF = new Set(["false", "0", "no", "off"]);
export function resendTestMode(): boolean {
  const raw = process.env.RESEND_TEST_MODE?.trim().toLowerCase();
  return raw === undefined || raw.length === 0
    ? true
    : !TEST_MODE_OFF.has(raw);
}

export const resend: Resend = new Resend(components.resend, {
  testMode: resendTestMode(),
  onEmailEvent: internal.emails.handleEmailEvent,
});

// The constructor snapshots `testMode` into `resend.config`, which the client
// then re-reads on EVERY send (`configToRuntimeConfig(this.config)`), so a
// getter makes the flag late-bound instead of module-load-bound. Two things
// depend on that: flipping `RESEND_TEST_MODE` on a deployment takes effect on
// the next send rather than the next isolate, and the test harness can pin the
// mode (convex/test.helpers.ts) without having to win an import race against
// whichever module pulls in convex/emails.ts first.
Object.defineProperty(resend.config, "testMode", {
  get: resendTestMode,
  enumerable: true,
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
      from: mailFrom(),
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

/** Raw Resend send with one .ics attachment. Returns the component's emailId.
 * `onEmailId` runs BEFORE the network call, so a caller can persist the id
 * first — the delivery webhook may otherwise race the send's bookkeeping. */
async function sendWithIcs(
  ctx: ActionCtx,
  args: {
    to: string;
    subject: string;
    html: string;
    ics: string;
    method: IcsMethod;
    replyTo?: string;
    onEmailId?: (emailId: string) => Promise<void>;
  },
): Promise<string> {
  return await resend.sendEmailManually(
    ctx,
    {
      from: mailFrom(),
      to: args.to,
      subject: args.subject,
      ...(args.replyTo === undefined ? {} : { replyTo: [args.replyTo] }),
    },
    async (emailId) => {
      await args.onEmailId?.(emailId);
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": emailId,
        },
        body: JSON.stringify({
          from: mailFrom(),
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

/** The comms-log half of a calendar send — actions have no ctx.db. Inserted
 * BEFORE the network call (M8): a send that dies mid-flight still leaves a
 * row to patch `failed`, instead of vanishing without a trace. */
export const recordCalendarMessage = internalMutation({
  args: {
    orgId: v.id("organizations"),
    eventId: v.optional(v.id("events")),
    contactId: v.optional(v.id("contacts")),
    toEmail: v.string(),
    kind: v.string(),
    subject: v.string(),
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
      deliveryStatus: "queued",
      context: args.context,
    });
  },
});

/** Progress/outcome patches for the row `recordCalendarMessage` opened.
 * `resendEmailId` lands before the network call so the delivery webhook's
 * by_resendEmailId lookup can never miss the row; "sent" only upgrades a row
 * still `queued` (a fast webhook may already have written `delivered`);
 * "failed" records the error in `context.sendError` for the re-release path. */
export const patchCalendarMessage = internalMutation({
  args: {
    messageId: v.id("messages"),
    resendEmailId: v.optional(v.string()),
    outcome: v.optional(v.union(v.literal("sent"), v.literal("failed"))),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get("messages", args.messageId);
    if (message === null) return null;
    if (args.resendEmailId !== undefined) {
      await ctx.db.patch("messages", args.messageId, {
        resendEmailId: args.resendEmailId,
      });
    }
    if (args.outcome === "failed") {
      const context =
        typeof message.context === "object" && message.context !== null
          ? message.context
          : {};
      await ctx.db.patch("messages", args.messageId, {
        deliveryStatus: "failed",
        context: { ...context, sendError: args.error ?? "send failed" },
      });
    } else if (args.outcome === "sent" && message.deliveryStatus === "queued") {
      await ctx.db.patch("messages", args.messageId, {
        deliveryStatus: "sent",
      });
    }
    return null;
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
    // Comms-log row FIRST (M8): the send must never be untraceable. The id is
    // attached before the network call, the outcome patched after.
    const messageId = await ctx.runMutation(
      internal.emails.recordCalendarMessage,
      {
        orgId: args.orgId,
        eventId: args.eventId,
        contactId: args.contactId,
        toEmail: args.toEmail,
        kind: args.kind,
        subject: args.subject,
        context: args.context,
      },
    );
    try {
      const resendEmailId = await sendWithIcs(ctx, {
        to: args.toEmail,
        subject: args.subject,
        html: args.html,
        ics,
        method: args.ics.method,
        replyTo: args.replyTo,
        onEmailId: async (emailId) => {
          await ctx.runMutation(internal.emails.patchCalendarMessage, {
            messageId,
            resendEmailId: emailId,
          });
        },
      });
      await ctx.runMutation(internal.emails.patchCalendarMessage, {
        messageId,
        outcome: "sent",
      });
      return resendEmailId;
    } catch (error) {
      // Record, then rethrow: the action still fails loudly, but the comms
      // log shows WHAT failed so the invite can be re-released.
      await ctx.runMutation(internal.emails.patchCalendarMessage, {
        messageId,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
      organizerEmail: mailFromAddress(),
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

/**
 * The actual Resend send, isolated in its own SUBTRANSACTION so a component
 * refusal (test mode + real address, bad key) rolls back nothing but itself.
 * Called only by model/comms.sendLoggedEmail, which records the outcome —
 * "queued" with the returned id, or "failed" when this throws.
 */
export const trySend = internalMutation({
  args: {
    toEmail: v.string(),
    kind: v.string(),
    subject: v.string(),
    html: v.string(),
    replyTo: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    return await resend.sendEmail(ctx, {
      from: mailFrom(),
      to: args.toEmail,
      subject: args.subject,
      html: args.html,
      ...(args.replyTo !== undefined && args.replyTo.length > 0
        ? { replyTo: [args.replyTo] }
        : {}),
      // Bulk/nudge mail only, derived from `kind` (M15).
      ...unsubscribeHeaders(args.kind, args.replyTo),
    });
  },
});
