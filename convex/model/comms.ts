import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
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
