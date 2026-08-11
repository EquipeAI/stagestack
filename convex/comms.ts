import { v } from "convex/values";
import { eventMutation, eventQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Audiences from "./model/audiences";
import * as Comms from "./model/comms";

// ─────────────────────────────────────────────────────────────────────────
// The organizer's communications surface (M5): who can I reach, send them one
// message, and what has this contact already been sent.
// ─────────────────────────────────────────────────────────────────────────

// Mirrors AUDIENCE_KINDS in convex/model/audiences.ts; the model's
// `resolveAudience` switch is exhaustive, so adding a kind there without adding
// it here is a type error at the call site.
const vAudience = v.union(
  v.literal("allSpeakers"),
  v.literal("confirmedSpeakers"),
  v.literal("unconfirmedSpeakers"),
  v.literal("overdueTasks"),
  v.literal("assignedReviewers"),
);

const vDeliveryStatus = v.union(
  v.literal("queued"),
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("delivery_delayed"),
  v.literal("bounced"),
  v.literal("complained"),
  v.literal("failed"),
);

/**
 * Reachable-recipient counts per audience. `now` is an argument rather than a
 * clock read because Convex does not re-run a query just because time passed —
 * "overdue" has to come from the client's ticking value to stay honest.
 */
export const listAudiences = eventQuery({
  args: { now: v.number() },
  returns: v.array(
    v.object({
      kind: vAudience,
      /** Recipients this send would reach, capped at MAX_AUDIENCE. */
      count: v.number(),
      /** People in this audience with no reachable address at all. */
      skipped: v.number(),
      /** True total before the cap, so a truncated audience is visible. */
      totalKnown: v.number(),
      truncated: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    return await Audiences.audienceCounts(ctx, ctx.caller, args.now);
  },
});

/** Manual operational send to one contact or one state-derived audience. */
export const sendOneOff = eventMutation({
  args: {
    to: v.union(
      v.object({
        kind: v.literal("contact"),
        eventContactId: v.id("eventContacts"),
      }),
      v.object({
        kind: v.literal("contacts"),
        eventContactIds: v.array(v.id("eventContacts")),
      }),
      v.object({ kind: v.literal("audience"), audience: vAudience }),
    ),
    subject: v.string(),
    /** Supports the same {{variables}} as templates, per recipient. */
    html: v.string(),
    now: v.number(),
  },
  returns: v.object({
    sent: v.number(),
    failed: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    return await Comms.sendOneOff(ctx, ctx.caller, {
      to: args.to,
      subject: args.subject,
      html: args.html,
      now: args.now,
    });
  },
});

/**
 * Recent-send failure summary (CFP-08). A refused send commits the caller's
 * write and lands as a `failed` messages row, so repeated failures — almost
 * always a misconfigured mail deployment — need an organizer-visible signal.
 */
export const deliveryHealth = eventQuery({
  args: {},
  returns: v.object({
    scanned: v.number(),
    failed: v.number(),
    lastFailedAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    return await Comms.deliveryHealth(ctx, ctx.caller);
  },
});

/** Everything StageStack has sent this event contact, newest first. */
export const contactLog = eventQuery({
  args: { eventContactId: v.id("eventContacts") },
  returns: v.array(
    v.object({
      messageId: vv.id("messages"),
      kind: v.string(),
      subject: v.string(),
      toEmail: v.string(),
      deliveryStatus: vDeliveryStatus,
      sentAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    return await Comms.contactLog(ctx, ctx.caller, args.eventContactId);
  },
});
