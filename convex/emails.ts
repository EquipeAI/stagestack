import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { Resend, vOnEmailEventArgs, type EmailId } from "@convex-dev/resend";

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

export const emailStatus = internalMutation({
  args: { emailId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await resend.status(ctx, args.emailId as EmailId);
  },
});
