import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { Resend, vOnEmailEventArgs, type EmailId } from "@convex-dev/resend";

// Convex isolate has no Node types (same pattern as auth.config.ts).
declare const process: { env: Record<string, string | undefined> };

// testMode flipped off deliberately (ARCHITECTURE.md): stagestack.dev is
// verified in Resend and the walking skeleton requires a real delivery.
export const resend: Resend = new Resend(components.resend, {
  testMode: false,
  onEmailEvent: internal.emails.handleEmailEvent,
});

// Delivery events land here via the Resend webhook. For now just log; this
// becomes the write path into the per-contact comms log in M1.
export const handleEmailEvent = internalMutation({
  args: vOnEmailEventArgs,
  returns: v.null(),
  handler: async (_ctx, args) => {
    console.log("resend event", args.id, args.event.type);
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

// Calendar invites need attachments, which the component's batch sendEmail
// doesn't support — so this goes through sendEmailManually + the raw Resend
// API. Status/webhook tracking (and later the comms log) stays identical.
export const sendIcsTest = internalAction({
  args: { to: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const start = new Date(now + 24 * 3600 * 1000);
    const end = new Date(start.getTime() + 3600 * 1000);
    const fmtUtc = (d: Date) =>
      d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = [
      "BEGIN:VCALENDAR",
      "PRODID:-//StageStack//StageStack v1//EN",
      "VERSION:2.0",
      "CALSCALE:GREGORIAN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      `UID:ics-skeleton-test-${args.to}@stagestack.dev`,
      "SEQUENCE:0",
      `DTSTAMP:${fmtUtc(new Date(now))}`,
      `DTSTART:${fmtUtc(start)}`,
      `DTEND:${fmtUtc(end)}`,
      "SUMMARY:StageStack walking skeleton: .ics test session",
      "DESCRIPTION:If this shows up as a native calendar invite\\, check #3 passes.",
      "LOCATION:Main Stage",
      "ORGANIZER;CN=StageStack:mailto:hello@stagestack.dev",
      `ATTENDEE;CN=${args.to};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${args.to}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const from = "StageStack <hello@stagestack.dev>";
    const subject = "Invitation: StageStack .ics test session";
    return await resend.sendEmailManually(
      ctx,
      { from, to: args.to, subject },
      async (emailId) => {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": emailId,
          },
          body: JSON.stringify({
            from,
            to: [args.to],
            subject,
            html: "<p>Calendar invite attached — it should render natively in Gmail.</p>",
            attachments: [
              {
                filename: "invite.ics",
                content: btoa(ics),
                content_type: "text/calendar; method=REQUEST; charset=UTF-8",
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
  },
});

export const emailStatus = internalMutation({
  args: { emailId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await resend.status(ctx, args.emailId as EmailId);
  },
});
