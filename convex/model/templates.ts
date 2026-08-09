import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import { emailShell, escapeHtml } from "./comms";
import { assertEventActive } from "./validation";

// ─────────────────────────────────────────────────────────────────────────
// Email templates (M5). Every lifecycle email StageStack sends renders through
// `renderTemplate`, which prefers an organizer's per-event override and falls
// back to the built-in default below. The defaults are the exact copy the M1-M4
// send sites used to hardcode; the only change is that the moving parts became
// {{variables}}.
//
// Two substitution modes, deliberately different:
//   • HTML bodies escape every substituted value, EXCEPT the handful of
//     RAW_KEYS which are pre-rendered HTML blocks built server-side (a task
//     list, a session list). A speaker called `<script>` must never execute.
//   • Subjects are a mail header, not markup: they substitute plain text (no
//     entity escaping, which would show up literally in an inbox) and strip
//     CR/LF so a value can never inject a header.
//
// Unknown variables render as the empty string — an organizer typo degrades a
// sentence, it never breaks a send.
// ─────────────────────────────────────────────────────────────────────────

export type TemplateBody = { name: string; subject: string; html: string };

/** Nested-but-shallow bag: `{{speaker.firstName}}` walks it by dotted path. */
export type TemplateVars = Record<string, unknown>;

/** Paths whose values are server-built HTML and must NOT be escaped. */
export const RAW_KEYS: ReadonlySet<string> = new Set(["tasks", "body"]);

export const MAX_SUBJECT = 300;
export const MAX_HTML = 50_000;
export const MAX_TEMPLATE_NAME = 120;

export const DEFAULT_TEMPLATES: Record<string, TemplateBody> = {
  // ── CFP (M1) ───────────────────────────────────────────────────────────
  "cfp.confirmation": {
    name: "CFP — submission confirmation",
    subject: "{{subjectLead}}: {{proposal.title}}",
    html: [
      `<p>{{intro}} <strong>{{event.name}}</strong>.</p>`,
      `<p><strong>{{proposal.title}}</strong></p>`,
      `<p><a href="{{link}}">View or edit your proposal</a></p>`,
    ].join("\n"),
  },
  "cfp.adminNotification": {
    name: "CFP — organizer notification",
    subject: "{{subjectLead}} for {{event.name}}: {{proposal.title}}",
    html: [
      `<p>{{intro}} for <strong>{{event.name}}</strong>.</p>`,
      `<p><strong>{{proposal.title}}</strong><br />by {{proposal.speakers}}</p>`,
      `<p><a href="{{link}}">Open the event in StageStack</a></p>`,
    ].join("\n"),
  },
  "cfp.withdrawn": {
    name: "CFP — withdrawal notice",
    subject: "Proposal withdrawn for {{event.name}}: {{proposal.title}}",
    html: [
      `<p>A proposal for <strong>{{event.name}}</strong> was withdrawn by its submitter.</p>`,
      `<p><strong>{{proposal.title}}</strong></p>`,
      `<p><a href="{{link}}">Open the event in StageStack</a></p>`,
    ].join("\n"),
  },

  // ── Decisions & invitations (M2) ───────────────────────────────────────
  "decision.accepted": {
    name: "Decision — accepted",
    subject: "Your proposal was accepted: {{proposal.title}}",
    html: [
      `<p>Congratulations — your proposal was accepted for <strong>{{event.name}}</strong>.</p>`,
      `<p><strong>{{proposal.title}}</strong></p>`,
      `<p>Each speaker's participation still awaits confirmation, so we'll be in touch shortly about confirming who is presenting.</p>`,
      `<p><a href="{{link}}">View your proposal</a></p>`,
    ].join("\n"),
  },
  "decision.declined": {
    name: "Decision — declined",
    subject: "About your proposal: {{proposal.title}}",
    html: [
      `<p>Thank you for submitting to <strong>{{event.name}}</strong>.</p>`,
      `<p><strong>{{proposal.title}}</strong></p>`,
      `<p>We received more strong proposals than we have room for, and we're not able to include this one in the programme. We genuinely appreciate the time you put into it and hope you'll submit again.</p>`,
      `<p><a href="{{link}}">View your proposal</a></p>`,
    ].join("\n"),
  },
  "decision.corrected": {
    name: "Decision — correction",
    subject: "Correction about your proposal: {{proposal.title}}",
    html: [
      `<p>We need to correct the decision we sent you about <strong>{{event.name}}</strong>, and we're sorry for the confusion.</p>`,
      `<p><strong>{{proposal.title}}</strong></p>`,
      `<p>The correct decision is: <strong>{{decision}}</strong>.</p>`,
      `<p>{{note}}</p>`,
      `<p><a href="{{link}}">View your proposal</a></p>`,
    ].join("\n"),
  },
  "invitation.direct": {
    name: "Direct speaking invitation",
    subject: "Invitation to speak at {{event.name}}",
    html: [
      `<p>Hi {{speaker.firstName}},</p>`,
      `<p>You're invited to speak at <strong>{{event.name}}</strong>.</p>`,
      `<p><strong>{{session.title}}</strong><br />{{event.whenWhere}}</p>`,
      `<p><a href="{{link}}">Confirm your participation</a></p>`,
    ].join("\n"),
  },

  // ── Team & portal access (M0/M3) ───────────────────────────────────────
  "team.invite": {
    name: "Team invitation",
    subject: "{{inviter.name}} invited you to {{scope.label}} on StageStack",
    html: [
      `<p>{{inviter.name}} invited you to join <strong>{{scope.label}}</strong> as <strong>{{role.label}}</strong> on StageStack.</p>`,
      `<p><a href="{{link}}">Accept the invitation</a> (link expires in 14 days).</p>`,
      `<p>If you weren't expecting this, you can ignore this email.</p>`,
    ].join("\n"),
  },
  "portal.invite": {
    name: "Speaker portal invitation",
    subject: "Your speaker portal for {{event.name}}",
    html: [
      `<p>Hi {{speaker.firstName}},</p>`,
      `<p>You can now manage your participation in <strong>{{event.name}}</strong> yourself — confirm or decline, keep your profile current, and see what's outstanding.</p>`,
      `<p><a href="{{link}}">Open your speaker portal</a></p>`,
      `<p>Sign in with this email address and your access appears automatically.</p>`,
    ].join("\n"),
  },
  "portal.handoffInvite": {
    name: "Primary-manager handoff invitation",
    subject: `Manage "{{session.title}}" at {{event.name}}`,
    html: [
      `<p>You've been asked to become the primary manager for <strong>{{session.title}}</strong> at <strong>{{event.name}}</strong>.</p>`,
      `<p>Sign in with this email address to take over: you'll be able to edit the session's shared content and record each speaker's participation.</p>`,
      `<p><a href="{{link}}">Accept and open the portal</a></p>`,
      `<p>The current manager keeps access until you do.</p>`,
    ].join("\n"),
  },

  // ── Speaker ops (M4) ───────────────────────────────────────────────────
  "task.changesRequested": {
    name: "Task — changes requested",
    subject: "Changes requested: {{task.title}}",
    html: [
      `<p>An organizer has asked for changes to <strong>{{task.title}}</strong> for <strong>{{event.name}}</strong>.</p>`,
      `<p>{{note}}</p>`,
      `<p><a href="{{link}}">Open your speaker portal</a></p>`,
    ].join("\n"),
  },

  // ── Schedule release (M6) ──────────────────────────────────────────────
  // These three ride WITH the .ics attachment (convex/emails.ts), so the body
  // is the human half of the same message the calendar entry arrives in.
  "schedule.released": {
    name: "Schedule — slot released",
    subject: "Your slot at {{event.name}}: {{session.title}}",
    html: [
      `<p>Hi {{speaker.firstName}},</p>`,
      `<p>Your session at <strong>{{event.name}}</strong> is scheduled.</p>`,
      `<p><strong>{{session.title}}</strong><br />{{slot.when}}<br />{{slot.room}}</p>`,
      `<p>The calendar invitation is attached. Please confirm the time works:</p>`,
      `<p><a href="{{link}}">Acknowledge your slot</a></p>`,
    ].join("\n"),
  },
  "schedule.updated": {
    name: "Schedule — slot changed",
    subject: "Schedule change at {{event.name}}: {{session.title}}",
    html: [
      `<p>Hi {{speaker.firstName}},</p>`,
      `<p>Your slot at <strong>{{event.name}}</strong> has changed.</p>`,
      `<p><strong>{{session.title}}</strong><br />{{slot.when}}<br />{{slot.room}}</p>`,
      `<p>The updated calendar invitation is attached and replaces the previous one.</p>`,
      `<p><a href="{{link}}">Review and acknowledge</a></p>`,
    ].join("\n"),
  },
  "schedule.cancelled": {
    name: "Schedule — slot cancelled",
    subject: "Cancelled at {{event.name}}: {{session.title}}",
    html: [
      `<p>Hi {{speaker.firstName}},</p>`,
      `<p>The scheduled slot for <strong>{{session.title}}</strong> at <strong>{{event.name}}</strong> has been cancelled, and the attached calendar cancellation removes it from your calendar.</p>`,
      `<p>{{slot.when}}</p>`,
      `<p><a href="{{link}}">Open your speaker portal</a></p>`,
    ].join("\n"),
  },

  // ── Scheduled reminders (M5) ───────────────────────────────────────────
  // `{{tasks}}` / `{{body}}` are pre-rendered HTML lists (RAW_KEYS): one
  // consolidated message per recipient, never one email per outstanding item.
  "reminder.tasks": {
    name: "Reminder — outstanding tasks",
    subject: "Outstanding items for {{event.name}}",
    html: [
      `<p>Hi {{speaker.firstName}},</p>`,
      `<p>These items are still outstanding for <strong>{{event.name}}</strong>:</p>`,
      `{{tasks}}`,
      `<p><a href="{{link}}">Open your speaker portal</a></p>`,
    ].join("\n"),
  },
  "reminder.participation": {
    name: "Reminder — awaiting participation",
    subject: "Please confirm your participation in {{event.name}}",
    html: [
      `<p>Hi {{speaker.firstName}},</p>`,
      `<p>We're still waiting on your answer about speaking at <strong>{{event.name}}</strong>:</p>`,
      `{{body}}`,
      `<p><a href="{{link}}">Confirm or decline in your speaker portal</a></p>`,
    ].join("\n"),
  },
};

export const TEMPLATE_KEYS: ReadonlyArray<string> = Object.keys(
  DEFAULT_TEMPLATES,
);

const CUSTOM_KEY_RE = /^custom:[a-z0-9][a-z0-9-]{0,39}$/;

/** A key is usable if it is one of ours or a validated `custom:<slug>`. */
export function isKnownKey(key: string): boolean {
  return key in DEFAULT_TEMPLATES || CUSTOM_KEY_RE.test(key);
}

export function assertTemplateKey(key: string): string {
  if (!isKnownKey(key)) {
    throw new ConvexError({
      code: "invalid_template_key",
      message:
        "Unknown template. Use a built-in key or custom:<slug> (lowercase letters, digits and dashes).",
    });
  }
  return key;
}

// ── Substitution ─────────────────────────────────────────────────────────

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;

function lookup(vars: TemplateVars, path: string): unknown {
  let current: unknown = vars;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolved(vars: TemplateVars, path: string): string | null {
  const value = lookup(vars, path);
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return null;
  return String(value);
}

/** Body substitution: everything is escaped unless it is a RAW_KEYS block. */
export function substituteHtml(template: string, vars: TemplateVars): string {
  return template.replace(VAR_RE, (_match, path: string) => {
    const text = resolved(vars, path);
    if (text === null) return "";
    return RAW_KEYS.has(path) ? text : escapeHtml(text);
  });
}

/** Subject substitution: plain text, CR/LF stripped (header-injection safe). */
export function substituteSubject(
  template: string,
  vars: TemplateVars,
): string {
  return template
    .replace(VAR_RE, (_match, path: string) => resolved(vars, path) ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

// ── Rendering ────────────────────────────────────────────────────────────

/** The organizer's override for `key`, or null. `event` is null for org-wide
 * sends (the team invite that isn't scoped to an event). */
export async function findOverride(
  ctx: QueryCtx,
  event: Doc<"events"> | null,
  key: string,
): Promise<Doc<"emailTemplates"> | null> {
  if (event === null) return null;
  return await ctx.db
    .query("emailTemplates")
    .withIndex("by_eventId_and_key", (q) =>
      q.eq("eventId", event._id).eq("key", key),
    )
    .first();
}

/**
 * Render one email. Organizer override wins; otherwise the built-in default.
 * The returned html is already wrapped in the branded shell, so call sites hand
 * it straight to `sendLoggedEmail`.
 */
export async function renderTemplate(
  ctx: QueryCtx,
  event: Doc<"events"> | null,
  key: string,
  vars: TemplateVars,
): Promise<{ subject: string; html: string }> {
  const override = await findOverride(ctx, event, key);
  const source = override ?? DEFAULT_TEMPLATES[key];
  if (source === undefined) {
    notFound("template", `No email template for "${key}".`);
  }
  return {
    subject: substituteSubject(source.subject, vars),
    html: emailShell(substituteHtml(source.html, vars)),
  };
}

// ── Sample data for the live preview ─────────────────────────────────────

/** Every variable any built-in template can reference, with believable values
 * so the organizer's preview looks like a real message. */
export function sampleVars(event: Doc<"events"> | null): TemplateVars {
  const eventName = event?.name ?? "Acme Summit";
  return {
    event: {
      name: eventName,
      when: "2026-09-01 – 2026-09-03 (America/Los_Angeles)",
      location: "Moscone West",
      whenWhere: "2026-09-01 – 2026-09-03 (America/Los_Angeles) — Moscone West",
    },
    speaker: {
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
      email: "ada@example.com",
    },
    session: { title: "Analytical engines in production" },
    slot: {
      when: "Tue, Sep 1, 2:00 PM – Tue, Sep 1, 2:45 PM (America/Los_Angeles)",
      room: "Main Stage",
    },
    proposal: {
      title: "Analytical engines in production",
      speakers: "Ada Lovelace",
    },
    task: { title: "Speaker headshot" },
    inviter: { name: "Grace Hopper" },
    scope: { label: eventName },
    role: { label: "organizer" },
    decision: "accepted",
    note: "Sample note from the organizer.",
    intro: "Thanks for submitting to",
    subjectLead: "We received your proposal",
    link: "https://stagestack.dev/portal/sample-event",
    tasks: [
      `<ul>`,
      `<li><strong>Speaker headshot</strong> — Analytical engines in production (due 2026-08-20)</li>`,
      `<li><strong>Final slides</strong> — Analytical engines in production (due 2026-08-25)</li>`,
      `</ul>`,
    ].join("\n"),
    body: [
      `<ul>`,
      `<li><strong>Analytical engines in production</strong></li>`,
      `</ul>`,
    ].join("\n"),
  };
}

// ── Organizer capabilities ───────────────────────────────────────────────

export type TemplateRow = {
  key: string;
  name: string;
  subject: string;
  html: string;
  customized: boolean;
  updatedAt?: number;
  updatedBy?: Id<"users">;
};

/** Every built-in key plus any custom ones the organizer added, defaults
 * merged with overrides so the UI has one list to render. */
export async function listTemplates(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<TemplateRow[]> {
  requireOrganizer(caller);
  const overrides = await ctx.db
    .query("emailTemplates")
    .withIndex("by_eventId_and_key", (q) => q.eq("eventId", caller.event._id))
    .take(200);
  const byKey = new Map(overrides.map((row) => [row.key, row]));

  const keys = [
    ...TEMPLATE_KEYS,
    ...overrides.map((o) => o.key).filter((k) => !(k in DEFAULT_TEMPLATES)),
  ];
  return keys.map((key) => {
    const override = byKey.get(key);
    const fallback = DEFAULT_TEMPLATES[key];
    if (override !== undefined) {
      return {
        key,
        name: override.name,
        subject: override.subject,
        html: override.html,
        customized: true,
        updatedAt: override.updatedAt,
        updatedBy: override.updatedBy,
      };
    }
    return {
      key,
      name: fallback.name,
      subject: fallback.subject,
      html: fallback.html,
      customized: false,
    };
  });
}

export async function upsertTemplate(
  ctx: MutationCtx,
  caller: EventCaller,
  args: { key: string; name?: string; subject: string; html: string },
): Promise<Id<"emailTemplates">> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const key = assertTemplateKey(args.key);

  const subject = args.subject.trim();
  if (subject.length === 0 || subject.length > MAX_SUBJECT) {
    throw new ConvexError({
      code: "invalid_subject",
      message: `Subject must be 1-${MAX_SUBJECT} characters.`,
    });
  }
  const html = args.html.trim();
  if (html.length === 0 || html.length > MAX_HTML) {
    throw new ConvexError({
      code: "invalid_html",
      message: `Template body must be 1-${MAX_HTML} characters.`,
    });
  }
  const fallbackName = DEFAULT_TEMPLATES[key]?.name ?? key;
  const rawName = (args.name ?? fallbackName).trim();
  const name =
    rawName.length === 0 || rawName.length > MAX_TEMPLATE_NAME
      ? fallbackName
      : rawName;

  const existing = await findOverride(ctx, caller.event, key);
  const now = Date.now();
  let templateId: Id<"emailTemplates">;
  if (existing === null) {
    templateId = await ctx.db.insert("emailTemplates", {
      eventId: caller.event._id,
      key,
      name,
      subject,
      html,
      updatedAt: now,
      updatedBy: caller.user._id,
    });
  } else {
    templateId = existing._id;
    await ctx.db.patch("emailTemplates", templateId, {
      name,
      subject,
      html,
      updatedAt: now,
      updatedBy: caller.user._id,
    });
  }

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "template.upsert",
    targetType: "emailTemplate",
    targetId: templateId,
    meta: { key },
  });
  return templateId;
}

/** Drop the override; the built-in default takes over again. */
export async function resetTemplate(
  ctx: MutationCtx,
  caller: EventCaller,
  key: string,
): Promise<boolean> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const existing = await findOverride(ctx, caller.event, key);
  if (existing === null) return false;
  await ctx.db.delete("emailTemplates", existing._id);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "template.reset",
    targetType: "emailTemplate",
    targetId: existing._id,
    meta: { key },
  });
  return true;
}

/** What the organizer's editor shows: the current template rendered against
 * sample data, through the same substitution the real send uses. */
export async function previewTemplate(
  ctx: QueryCtx,
  caller: EventCaller,
  key: string,
): Promise<{ subject: string; html: string }> {
  requireOrganizer(caller);
  return await renderTemplate(
    ctx,
    caller.event,
    key,
    sampleVars(caller.event),
  );
}
