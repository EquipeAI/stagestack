import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { resend } from "../emails";

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
  context?: unknown;
};

/** Send through Resend and record the send in the comms log. */
export async function sendLoggedEmail(
  ctx: MutationCtx,
  args: LoggedEmail,
): Promise<Id<"messages">> {
  const emailId = await resend.sendEmail(ctx, {
    from: MAIL_FROM,
    to: args.toEmail,
    subject: args.subject,
    html: args.html,
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
      context: args.context,
    });
  }
}
