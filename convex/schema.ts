import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vAnswerValue, vFormDef } from "./shared/formDef";

// Org-level roles: owner manages ownership + billing-ish concerns, admin has
// org-wide admin powers. Event-scoped access lives in eventMembers.
export const vOrgRole = v.union(v.literal("owner"), v.literal("admin"));
export const vEventRole = v.union(
  v.literal("organizer"),
  v.literal("reviewer"),
);

// Contact/profile fields shared by the org directory (current profile) and,
// later, event-specific publishable snapshots.
export const contactProfileFields = {
  firstName: v.string(),
  lastName: v.string(),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  // Short role line, e.g. "CTO, Acme" — shown on public speaker cards.
  tagline: v.optional(v.string()),
  bio: v.optional(v.string()),
  headshotId: v.optional(v.id("_storage")),
  links: v.optional(
    v.object({
      website: v.optional(v.string()),
      twitter: v.optional(v.string()),
      linkedin: v.optional(v.string()),
      github: v.optional(v.string()),
    }),
  ),
};

export default defineSchema({
  // ── Identity & tenancy ────────────────────────────────────────────────
  users: defineTable({
    // Canonical auth link (guidelines: prefer tokenIdentifier over subject).
    tokenIdentifier: v.string(),
    clerkSubject: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"])
    .index("by_email", ["email"]),

  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    createdBy: v.id("users"),
  }).index("by_slug", ["slug"]),

  members: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    role: vOrgRole,
  })
    .index("by_orgId_and_userId", ["orgId", "userId"])
    .index("by_userId", ["userId"]),

  eventMembers: defineTable({
    eventId: v.id("events"),
    orgId: v.id("organizations"),
    userId: v.id("users"),
    role: vEventRole,
  })
    .index("by_eventId_and_userId", ["eventId", "userId"])
    .index("by_userId", ["userId"])
    .index("by_eventId", ["eventId"]),

  invitations: defineTable({
    orgId: v.id("organizations"),
    // Absent → org-wide admin invite; present → event-scoped invite.
    eventId: v.optional(v.id("events")),
    email: v.string(),
    role: v.union(vOrgRole, vEventRole),
    // Unguessable bearer token embedded in the invite link.
    token: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
    ),
    invitedBy: v.id("users"),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_orgId", ["orgId"])
    .index("by_eventId", ["eventId"])
    .index("by_email", ["email"]),

  // ── Events ────────────────────────────────────────────────────────────
  events: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    // Globally unique: public URLs are stagestack.dev/e/<slug>.
    slug: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    // IANA zone, e.g. "America/Los_Angeles" — the authoritative event time.
    timezone: v.string(),
    type: v.optional(v.string()),
    location: v.optional(v.string()),
    website: v.optional(v.string()),
    description: v.optional(v.string()),
    logoId: v.optional(v.id("_storage")),
    bannerId: v.optional(v.id("_storage")),
    // CFP window + publication are independent of event dates and of the
    // public agenda (MILESTONES M0: independent controls).
    cfpOpenAt: v.optional(v.number()),
    cfpCloseAt: v.optional(v.number()),
    cfpPublished: v.boolean(),
    archivedAt: v.optional(v.number()),
  })
    .index("by_orgId", ["orgId"])
    .index("by_slug", ["slug"]),

  // ── Org contact directory (current profiles) ─────────────────────────
  contacts: defineTable({
    orgId: v.id("organizations"),
    ...contactProfileFields,
    // Set when a StageStack user claims/links this contact (M3 portal).
    userId: v.optional(v.id("users")),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_and_email", ["orgId", "email"])
    .index("by_userId", ["userId"]),

  // ── Event library (event-scoped vocabulary) ──────────────────────────
  tracks: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    description: v.optional(v.string()),
    color: v.optional(v.string()),
    order: v.number(),
  }).index("by_eventId", ["eventId"]),

  tags: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    color: v.optional(v.string()),
    order: v.number(),
  }).index("by_eventId", ["eventId"]),

  rooms: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    capacity: v.optional(v.number()),
    order: v.number(),
  }).index("by_eventId", ["eventId"]),

  customFields: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    kind: v.union(
      v.literal("text"),
      v.literal("number"),
      v.literal("select"),
      v.literal("multiselect"),
      v.literal("url"),
    ),
    options: v.optional(v.array(v.string())),
    appliesTo: v.union(v.literal("session"), v.literal("speaker")),
    order: v.number(),
  }).index("by_eventId", ["eventId"]),

  // ── Audit trail ──────────────────────────────────────────────────────
  auditLog: defineTable({
    orgId: v.id("organizations"),
    eventId: v.optional(v.id("events")),
    actorUserId: v.id("users"),
    // True when an agent performed this on the actor's behalf.
    viaAgent: v.optional(v.boolean()),
    action: v.string(),
    targetType: v.optional(v.string()),
    targetId: v.optional(v.string()),
    meta: v.optional(v.any()),
  })
    .index("by_orgId", ["orgId"])
    .index("by_eventId", ["eventId"]),

  // ── Worker queue ─────────────────────────────────────────────────────
  // Types/payloads are validated at the enqueue site against
  // convex/shared/jobTypes.ts; the table stays permissive so old rows never
  // block a schema push.
  jobs: defineTable({
    type: v.string(),
    payload: v.any(),
    status: v.union(
      v.literal("queued"),
      v.literal("claimed"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
    ),
    // Who asked for this work; the worker executes with this user's authority.
    initiatedBy: v.optional(v.string()),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  }).index("by_status", ["status"]),

  // CFP wizard drafts, created unauthenticated (public path, rate-limited).
  // anonKey is the client-generated session key; the draft is linked to a
  // real account at the wizard's account step (M1).
  cfpDrafts: defineTable({
    talkTitle: v.string(),
    anonKey: v.string(),
    status: v.literal("draft"),
  }).index("by_anonKey", ["anonKey"]),

  // ── CFP (M1) ─────────────────────────────────────────────────────────
  // One form per event. `working` is the organizer's private draft;
  // `published` is what the public wizard renders (absent until first
  // publish). Publishing copies working → published and bumps version.
  cfpForms: defineTable({
    eventId: v.id("events"),
    working: vFormDef,
    published: v.optional(vFormDef),
    version: v.number(),
    publishedAt: v.optional(v.number()),
    maxSubmissionsPerUser: v.optional(v.number()),
    successMessage: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_eventId", ["eventId"]),

  proposals: defineTable({
    eventId: v.id("events"),
    // The proposal's primary manager (may or may not be a speaker).
    submitterUserId: v.id("users"),
    status: v.union(
      v.literal("draft"),
      v.literal("pending"),
      v.literal("acceptQueue"),
      v.literal("declineQueue"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("withdrawn"),
    ),
    // Denormalized from the talkTitle answer for lists/tables.
    title: v.string(),
    answers: v.record(v.string(), vAnswerValue),
    // Form version the answers were last validated against (stamped on
    // submit/resubmit).
    formVersion: v.number(),
    submittedAt: v.optional(v.number()),
    updatedAt: v.number(),
    withdrawnAt: v.optional(v.number()),
    // Organizer-granted edit window past cfpCloseAt (audited reopen, M1).
    reopenedUntil: v.optional(v.number()),
  })
    .index("by_eventId_and_status", ["eventId", "status"])
    .index("by_submitterUserId", ["submitterUserId"]),

  // Speakers entered in the wizard — no accounts required pre-acceptance.
  proposalSpeakers: defineTable({
    proposalId: v.id("proposals"),
    eventId: v.id("events"),
    order: v.number(),
    firstName: v.string(),
    lastName: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    tagline: v.optional(v.string()),
    bio: v.optional(v.string()),
    headshotId: v.optional(v.id("_storage")),
    links: v.optional(
      v.object({
        website: v.optional(v.string()),
        twitter: v.optional(v.string()),
        linkedin: v.optional(v.string()),
        github: v.optional(v.string()),
      }),
    ),
    // True when this row mirrors the submitter themself.
    isPrimary: v.boolean(),
  }).index("by_proposalId", ["proposalId"]),

  // ── Comms log (starts M1; grows in M5) ───────────────────────────────
  // Every email StageStack sends is recorded here; the Resend webhook
  // updates deliveryStatus by resendEmailId.
  messages: defineTable({
    orgId: v.id("organizations"),
    eventId: v.optional(v.id("events")),
    contactId: v.optional(v.id("contacts")),
    toEmail: v.string(),
    // e.g. "cfp.confirmation", "cfp.adminNotification", "team.invite"
    kind: v.string(),
    subject: v.string(),
    resendEmailId: v.optional(v.string()),
    deliveryStatus: v.union(
      v.literal("queued"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("delivery_delayed"),
      v.literal("bounced"),
      v.literal("complained"),
      v.literal("failed"),
    ),
    sentByUserId: v.optional(v.id("users")),
    context: v.optional(v.any()),
  })
    .index("by_eventId", ["eventId"])
    .index("by_contactId", ["contactId"])
    .index("by_resendEmailId", ["resendEmailId"]),
});
