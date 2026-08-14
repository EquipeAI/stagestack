import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vAnswerValue, vFormDef } from "./shared/formDef";
import { vReviewAnswers, vScorecard } from "./shared/scorecard";

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
  // Structured versions of the tagline (W6): widget cards want "Job title,
  // Company" as separate fields; tagline stays as the freeform fallback.
  jobTitle: v.optional(v.string()),
  company: v.optional(v.string()),
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

// ── The published program blob (M7) ────────────────────────────────────
// The privacy-filtered snapshot stored in `publishedPrograms.program`, and the
// only shape the public page, read API and embeds ever see. Its sole producer
// is `computeProgram` in convex/model/publish.ts, whose `PublicProgram` type is
// asserted assignable to this validator there.
//
// PERMISSIVE ON PURPOSE. This validates rows written by every past version of
// the producer, not just today's — a schema push that rejected a live row would
// take the public page down for that event. `speakerId`, `jobTitle` and
// `company` were added to the speaker shape after the first programs were
// published (commit 0c7d1d0), so they are optional here even though the current
// producer always writes `speakerId`. Nothing has ever been REMOVED from the
// shape, so no field here is dead weight.

const vPublicSpeaker = v.object({
  /** Opaque stable id (the event-contact id). Absent in pre-0c7d1d0 rows. */
  speakerId: v.optional(v.string()),
  name: v.string(),
  tagline: v.optional(v.string()),
  jobTitle: v.optional(v.string()),
  company: v.optional(v.string()),
  bio: v.optional(v.string()),
  headshotUrl: v.optional(v.string()),
  links: v.optional(
    v.object({
      website: v.optional(v.string()),
      twitter: v.optional(v.string()),
      linkedin: v.optional(v.string()),
      github: v.optional(v.string()),
    }),
  ),
});

const publicSessionFields = {
  sessionId: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
  format: v.optional(v.string()),
  trackName: v.optional(v.string()),
  /** Present only when the session's slot is released. */
  startsAt: v.optional(v.number()),
  endsAt: v.optional(v.number()),
  roomName: v.optional(v.string()),
  /** Named speakers are Confirmed only; `toBeAnnounced` covers the rest. */
  speakers: v.array(vPublicSpeaker),
  toBeAnnounced: v.boolean(),
};

const publicAgendaItemFields = {
  itemId: v.string(),
  title: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  roomName: v.optional(v.string()),
  description: v.optional(v.string()),
};

export const vPublicProgram = v.object({
  event: v.object({
    name: v.string(),
    slug: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    timezone: v.string(),
    location: v.optional(v.string()),
    description: v.optional(v.string()),
    website: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
  }),
  lineupPublished: v.boolean(),
  agendaPublished: v.boolean(),
  /** Accepted sessions + confirmed speakers. */
  lineup: v.array(v.object(publicSessionFields)),
  /** Released+slotted sessions and agenda items, time-ordered. */
  agenda: v.array(
    v.union(
      v.object({ kind: v.literal("session"), ...publicSessionFields }),
      v.object({ kind: v.literal("item"), ...publicAgendaItemFields }),
    ),
  ),
});

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
    // Org-scoped membership resolution without scanning all of a user's
    // memberships (a >200-membership user must never be falsely denied).
    .index("by_userId_and_orgId", ["userId", "orgId"])
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
    // Event-wide default cadence for task reminders, in days (M5). Absent →
    // reminders off by default.
    reminderCadenceDays: v.optional(v.number()),
    // Reply-to address for outgoing event email (M5); inherits nothing yet.
    replyTo: v.optional(v.string()),
    // Public event page toggle (M7). Lineup and agenda publish independently
    // of each other and of speaker release (decision log #13; M6 rule).
    publicPageEnabled: v.optional(v.boolean()),
    archivedAt: v.optional(v.number()),
  })
    .index("by_orgId", ["orgId"])
    .index("by_slug", ["slug"])
    .index("by_logoId", ["logoId"])
    .index("by_bannerId", ["bannerId"])
    // The hourly reminder sweep (convex/reminders.ts) dispatches only events
    // that opted into reminders. Indexing the cadence lets it SELECT those
    // rows instead of scanning the head of the table and silently missing
    // every event past the scan bound (H5). Only `undefined` means "off", so
    // the sweep's range is `gte(reminderCadenceDays, 0)` — a present number.
    // Trade-off taken deliberately: long-finished events with a cadence stay
    // in the range (one row read each, then filtered by the grace window),
    // whereas indexing `endsAt` instead would read every upcoming event
    // including the majority that have reminders switched off.
    .index("by_reminderCadenceDays", ["reminderCadenceDays"]),

  // ── Org contact directory (current profiles) ─────────────────────────
  // Portal claims live on eventContacts.userId; the directory row itself
  // carries no user link.
  contacts: defineTable({
    orgId: v.id("organizations"),
    ...contactProfileFields,
    // Light CRM (W8): freeform labels, filterable in the directory. A future
    // pipeline/segments build layers on these rather than replacing them.
    tags: v.optional(v.array(v.string())),
    // Optional CRM enrollment. Absent means the contact is not on the board.
    pipelineStage: v.optional(
      v.union(
        v.literal("sourced"),
        v.literal("contacted"),
        v.literal("shortlisted"),
        v.literal("confirmed"),
        v.literal("declined"),
      ),
    ),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_and_email", ["orgId", "email"])
    // Replacement cleanup only deletes a securely-owned headshot after an
    // exact reference lookup proves no reusable directory profile still uses
    // it. Legacy/shared blobs are retained when ownership is ambiguous.
    .index("by_headshotId", ["headshotId"]),

  // Internal notes on a directory contact (W8) — organizer-only, never
  // published anywhere. Kept as its own table so activity kinds (stage
  // moves, outreach) can join it later without a schema rewrite.
  contactNotes: defineTable({
    orgId: v.id("organizations"),
    contactId: v.id("contacts"),
    authorUserId: v.id("users"),
    body: v.string(),
    createdAt: v.number(),
  }).index("by_contactId", ["contactId"]),

  contactPipelineHistory: defineTable({
    orgId: v.id("organizations"),
    contactId: v.id("contacts"),
    fromStage: v.optional(
      v.union(
        v.literal("sourced"),
        v.literal("contacted"),
        v.literal("shortlisted"),
        v.literal("confirmed"),
        v.literal("declined"),
      ),
    ),
    toStage: v.optional(
      v.union(
        v.literal("sourced"),
        v.literal("contacted"),
        v.literal("shortlisted"),
        v.literal("confirmed"),
        v.literal("declined"),
      ),
    ),
    changedByUserId: v.id("users"),
    changedAt: v.number(),
  }).index("by_contactId", ["contactId"]),

  savedSegments: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    filters: v.object({
      search: v.optional(v.string()),
      tag: v.optional(v.string()),
      company: v.optional(v.string()),
    }),
    createdByUserId: v.id("users"),
    createdAt: v.number(),
  }).index("by_orgId", ["orgId"]),

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

  // Session formats (W2). The NAME is the verbatim organizer-facing label —
  // "Workshop (120 min)" keeps its parenthetical, because the CFP form's
  // conditional logic matches option strings exactly and the eval asserts
  // those labels verbatim. `defaultDurationMinutes` is the parsed number, kept
  // as a separate field precisely so nothing has to re-parse the label.
  formats: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    defaultDurationMinutes: v.optional(v.number()),
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

  // ── Content history & file comments (W5) ─────────────────────────────
  // One row per content edit of a session (organizer or portal), storing the
  // values BEFORE the edit so any revision can be restored. CNT-11.
  sessionRevisions: defineTable({
    eventId: v.id("events"),
    sessionId: v.id("sessions"),
    editedBy: v.id("users"),
    editedAt: v.number(),
    /** The fields as they were before this edit (only content fields). */
    before: v.object({
      title: v.string(),
      description: v.optional(v.string()),
      format: v.optional(v.string()),
    }),
    /** What the edit changed them to (for display; restore uses `before`). */
    after: v.object({
      title: v.string(),
      description: v.optional(v.string()),
      format: v.optional(v.string()),
    }),
    /**
     * Present only when this revision was written BY a restore (W3), so the
     * history can render it as one event — "Restored the snapshot from …" —
     * instead of as another anonymous edit. Optional, so every row written
     * before W3 stays valid and no migration is needed; absence means
     * "an ordinary edit".
     *
     * `restoredSnapshotAt` is denormalized on purpose: the grouping sentence
     * must not need a second read per row, and it must survive even if the
     * referenced revision ever becomes unreachable.
     */
    origin: v.optional(
      v.object({
        kind: v.literal("restore"),
        restoredRevisionId: v.id("sessionRevisions"),
        restoredSnapshotAt: v.number(),
      }),
    ),
  }).index("by_sessionId", ["sessionId"]),

  // Comment thread on a task instance's uploaded file(s) — speaker and
  // organizer both read and write (CNT-05).
  uploadComments: defineTable({
    eventId: v.id("events"),
    instanceId: v.id("taskInstances"),
    authorUserId: v.id("users"),
    body: v.string(),
    createdAt: v.number(),
  })
    .index("by_instanceId", ["instanceId"])
    .index("by_eventId", ["eventId"]),

  // ── Embeds (W3) ──────────────────────────────────────────────────────
  // Named, enable/disable-able widget embeds an organizer generates from the
  // publish console. The embed id is the public key: /embed/w/<id> renders
  // the widget, /api/embeds/<id>(.ics) serves the feed — all reading the same
  // published-program blob with this row's filters applied.
  embeds: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    widget: v.union(
      v.literal("sessions"),
      v.literal("speakers"),
      v.literal("agenda"),
      v.literal("itinerary"),
      v.literal("gallery"),
    ),
    enabled: v.boolean(),
    config: v.object({
      /** Restrict to one track (by published track name). */
      trackName: v.optional(v.string()),
      /** Accent color for the styled widget (hex). */
      brandColor: v.optional(v.string()),
      /** Card fields to hide (e.g. "description", "speakers", "room"). */
      hiddenFields: v.optional(v.array(v.string())),
    }),
    createdBy: v.id("users"),
    updatedAt: v.number(),
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
      v.literal("done"),
      v.literal("failed"),
    ),
    // Who asked for this work; the worker executes with this user's authority.
    initiatedBy: v.optional(v.id("users")),
    // Denormalized from event-scoped payloads at enqueue time so the UI can
    // list an event's jobs without scanning the queue (payload is v.any(),
    // which can't be indexed).
    eventId: v.optional(v.id("events")),
    // Times the lease sweep found this job's claim expired. At
    // WORKER_MAX_ATTEMPTS (convex/worker.ts) the sweep fails the job instead
    // of requeueing it.
    attempts: v.optional(v.number()),
    // Fencing token minted on each claim (worker.claim). finish/touch/
    // importExecuteBatch require it, so a worker whose lease was swept and
    // re-claimed by someone else can no longer mutate the row or execute
    // batches against it — status alone can't tell the two claims apart.
    // Optional: rows claimed before this field existed simply have no token
    // and are refused (their lease expires and the sweep requeues them).
    claimToken: v.optional(v.string()),
    // Last lease renewal from the claiming worker (worker.touch). The sweep
    // measures the lease from this when present, so a legitimately long job
    // (an import plan is ~10 sequential LLM exchanges) is not requeued
    // underneath the worker that is still working on it.
    heartbeatAt: v.optional(v.number()),
    // Committed import-execute batches with their recorded results: replaying
    // a batch whose response was lost returns the record instead of writing
    // duplicates (worker.ts importExecuteBatch).
    completedBatches: v.optional(
      v.array(v.object({ batchIndex: v.number(), results: v.any() })),
    ),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_eventId", ["eventId"]),

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
    /** Monotonic proposal-content revision. Optional for pre-fence rows, which
     * read as version 0 until their first content-changing resubmit. */
    contentVersion: v.optional(v.number()),
    submittedAt: v.optional(v.number()),
    updatedAt: v.number(),
    withdrawnAt: v.optional(v.number()),
    // Organizer-granted edit window past cfpCloseAt (audited reopen, M1).
    reopenedUntil: v.optional(v.number()),
  })
    .index("by_eventId_and_status", ["eventId", "status"])
    // Unfiltered organizer lists: creation-ordered so the take() cap keeps
    // the newest rows rather than a status-skewed slice.
    .index("by_eventId", ["eventId"])
    .index("by_submitterUserId", ["submitterUserId"])
    // Scopes the per-user submission-limit count to one event.
    .index("by_submitterUserId_and_eventId", ["submitterUserId", "eventId"]),

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
    /** Role label on this proposal: Speaker, Co-speaker, Co-author, Panelist…
     * Free text so imports can carry whatever the source used. */
    role: v.optional(v.string()),
  })
    .index("by_proposalId", ["proposalId"])
    // One-query speaker counts for the organizer's proposal list.
    .index("by_eventId", ["eventId"])
    .index("by_headshotId", ["headshotId"]),

  // ── Review & sessions (M2, rebuilt W2) ───────────────────────────────
  // An evaluation plan is one or more rounds per event, each with its own
  // dates, anonymization flag, reviewer pool and scorecard.
  reviewRounds: defineTable({
    eventId: v.id("events"),
    name: v.string(),
    /** Display + default-round order (0 = first). */
    order: v.number(),
    opensAt: v.optional(v.number()),
    closesAt: v.optional(v.number()),
    /** Blind review: reviewers in this round see no author identity. */
    anonymized: v.boolean(),
    /** Per-reviewer assignment ceiling for auto-distribute; no cap when unset. */
    reviewerCap: v.optional(v.number()),
    scorecard: vScorecard,
    /**
     * Set while the launch flow is still building the round (W11).
     *
     * Polarity is deliberate: ABSENCE means launched, so every row written
     * before this field existed keeps exactly today's behavior with no
     * migration. A draft round is visible only on the organizer's plan list
     * (as a draft) — it assigns nothing, reaches no reviewer, and counts
     * toward no readiness number until `launchRound` clears the marker.
     */
    draft: v.optional(v.boolean()),
    updatedAt: v.number(),
  }).index("by_eventId", ["eventId"]),

  // Round membership: who reviews in a given round. Kept separate from
  // eventMembers so round 2 can have a different pool than round 1.
  roundReviewers: defineTable({
    eventId: v.id("events"),
    roundId: v.id("reviewRounds"),
    userId: v.id("users"),
  })
    .index("by_roundId_and_userId", ["roundId", "userId"])
    .index("by_eventId_and_userId", ["eventId", "userId"]),

  // Assignment + evaluation in one row: created when a reviewer is assigned.
  reviews: defineTable({
    eventId: v.id("events"),
    proposalId: v.id("proposals"),
    reviewerUserId: v.id("users"),
    /** Absent only on rows that predate rounds; read through the event's
     * default round (see model/reviews.ts `roundFor`). */
    roundId: v.optional(v.id("reviewRounds")),
    status: v.union(
      v.literal("assigned"),
      v.literal("draft"),
      v.literal("submitted"),
      v.literal("locked"),
      // Reviewer declared a conflict of interest; out of their queue,
      // surfaced to organizers for reassignment.
      v.literal("conflict"),
    ),
    /** Scorecard answers keyed by criterion id (W2). */
    answers: v.optional(vReviewAnswers),
    /** Proposal content revision these answers evaluate. Optional legacy rows
     * are version 0; writes must fence against both this and the proposal. */
    contentVersion: v.optional(v.number()),
    /** Weighted mean of this review's numeric criteria, precomputed on
     * submit so list views never re-derive it. */
    weightedScore: v.optional(v.number()),
    conflictNote: v.optional(v.string()),
    // Pre-W2 columns; still written for the default round so the decision
    // pipeline's recommendation counts keep working.
    score: v.optional(v.number()), // 1-5
    recommendation: v.optional(
      v.union(v.literal("accept"), v.literal("decline"), v.literal("neutral")),
    ),
    comments: v.optional(v.string()),
    submittedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_eventId_and_reviewerUserId", ["eventId", "reviewerUserId"])
    .index("by_proposalId", ["proposalId"])
    .index("by_reviewerUserId", ["reviewerUserId"]),

  // Event-scoped publishable contact snapshot, copied from the org directory
  // (or created fresh) when someone becomes a speaker/participant. Snapshots
  // never change automatically (M0 rule).
  eventContacts: defineTable({
    eventId: v.id("events"),
    orgId: v.id("organizations"),
    contactId: v.optional(v.id("contacts")),
    // The proposal speaker this snapshot was materialised from (set on insert
    // only): the stable identity a decline→accept correction matches on, so
    // an email-less speaker is never snapshotted twice.
    proposalSpeakerId: v.optional(v.id("proposalSpeakers")),
    ...contactProfileFields,
    // Set when a portal user claims this snapshot (M3).
    userId: v.optional(v.id("users")),
    // Values for the event's speaker-scoped custom fields (W6: logistics
    // like travel preferences), keyed by customFields id. Wired through
    // speakers.setCustomValues; select/multiselect store option strings.
    customValues: v.optional(
      v.record(v.string(), v.union(v.string(), v.array(v.string()))),
    ),
  })
    .index("by_eventId", ["eventId"])
    .index("by_contactId", ["contactId"])
    .index("by_proposalSpeakerId", ["proposalSpeakerId"])
    .index("by_userId", ["userId"])
    .index("by_eventId_and_userId", ["eventId", "userId"])
    .index("by_eventId_and_email", ["eventId", "email"])
    .index("by_eventId_and_headshotId", ["eventId", "headshotId"])
    .index("by_headshotId", ["headshotId"]),

  // One-time, actor-bound headshot upload tickets. Only the authenticated HTTP
  // upload action receives bytes and calls storage.store; the client never sees
  // the resulting storage id. Attach consumes the ready ticket rather than a
  // bearer-like raw id.
  headshotUploads: defineTable({
    orgId: v.id("organizations"),
    eventId: v.id("events"),
    eventContactId: v.id("eventContacts"),
    uploadedByUserId: v.id("users"),
    purpose: v.literal("speakerHeadshot"),
    expectedContentType: v.string(),
    expectedSize: v.number(),
    // Browser-provided basename, validated at authenticated ticket minting.
    // Optional for tickets created before provenance was retained.
    originalFilename: v.optional(v.string()),
    // Raw source bytes live only long enough for the private Node action to
    // decode and normalize them. The HTTP action records the fresh storage id
    // immediately so the sweeper can recover a crashed/lost-response action.
    sourceStorageId: v.optional(v.id("_storage")),
    sourceStoredAt: v.optional(v.number()),
    sourceContentType: v.optional(v.string()),
    sourceSize: v.optional(v.number()),
    sourceCleanupPending: v.optional(v.boolean()),
    sourceDeletedAt: v.optional(v.number()),
    storageId: v.optional(v.id("_storage")),
    status: v.union(
      v.literal("pending"),
      v.literal("uploading"),
      v.literal("ready"),
      v.literal("attached"),
      v.literal("rejected"),
      v.literal("discarded"),
      v.literal("replaced"),
      v.literal("deleted"),
      v.literal("retained"),
      v.literal("cleanupPending"),
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
    claimedAt: v.optional(v.number()),
    uploadLeaseExpiresAt: v.optional(v.number()),
    reservedBytes: v.optional(v.number()),
    reservedBlobCount: v.optional(v.number()),
    storageAttemptStartedAt: v.optional(v.number()),
    outputStoreStartedAt: v.optional(v.number()),
    outputKnownDeletedAt: v.optional(v.number()),
    quotaState: v.optional(
      v.union(
        v.literal("conservative"),
        v.literal("reconciled"),
        v.literal("indeterminate"),
      ),
    ),
    // Present only when the dedicated HTTP action itself stored the bytes.
    // Cleanup never deletes a legacy/client-uploaded id without this proof.
    serverStoredAt: v.optional(v.number()),
    registeredAt: v.optional(v.number()),
    sanitizedContentType: v.optional(v.string()),
    sanitizedSize: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    attachedAt: v.optional(v.number()),
    replacedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    cleanupAfter: v.optional(v.number()),
  })
    .index("by_storageId", ["storageId"])
    .index("by_sourceStorageId", ["sourceStorageId"])
    .index("by_eventId_and_attachedAt", ["eventId", "attachedAt"])
    .index("by_sourceCleanupPending_and_sourceStoredAt", [
      "sourceCleanupPending",
      "sourceStoredAt",
    ])
    .index("by_eventContactId", ["eventContactId"])
    .index("by_status_and_expiresAt", ["status", "expiresAt"])
    .index("by_status_and_cleanupAfter", ["status", "cleanupAfter"]),

  // Durable quota accounting includes active and retained server-owned
  // headshots. `ticketCount` counts reserved physical blob slots (two during
  // an indeterminate store attempt, one after success reconciliation).
  // A blob releases its reservation only after safe deletion.
  headshotUploadUsage: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    storedBytes: v.number(),
    ticketCount: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId_and_userId", ["orgId", "userId"]),

  // Cross-org and org-total ledgers close quota bypasses through disposable
  // organizations while preserving the stricter per-org/user allowance.
  headshotUploadUserUsage: defineTable({
    userId: v.id("users"),
    storedBytes: v.number(),
    ticketCount: v.number(),
    updatedAt: v.number(),
  }).index("by_userId", ["userId"]),

  headshotUploadOrgUsage: defineTable({
    orgId: v.id("organizations"),
    storedBytes: v.number(),
    ticketCount: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // A planned talk: created by accepting a proposal or by direct invitation.
  sessions: defineTable({
    eventId: v.id("events"),
    title: v.string(),
    description: v.optional(v.string()),
    // Free-text format label. Kept as the DISPLAY FALLBACK forever: sessions
    // that predate the formats library (or whose label never matched a row)
    // still show what the organizer typed. When `formatId` is set this string
    // is the library row's name, denormalized so revisions stay readable.
    format: v.optional(v.string()),
    /** Link to the formats library — what carries the default duration. */
    formatId: v.optional(v.id("formats")),
    /** Per-session override of the format's default block length. */
    durationMinutes: v.optional(v.number()),
    trackId: v.optional(v.id("tracks")),
    tagIds: v.optional(v.array(v.id("tags"))),
    proposalId: v.optional(v.id("proposals")),
    source: v.union(v.literal("cfp"), v.literal("direct")),
    status: v.union(v.literal("planned"), v.literal("cancelled")),
    cancelledAt: v.optional(v.number()),
    // Content approval (W5): draft content never reaches public output.
    // Absent on legacy rows = approved (they were already being served).
    // Approval and the publish console's per-session listing flag are
    // independent: an enabled draft remains held back until approved.
    contentStatus: v.optional(
      v.union(v.literal("draft"), v.literal("approved")),
    ),
    contentStatusSetBy: v.optional(v.id("users")),
    contentStatusSetAt: v.optional(v.number()),
    // ── Scheduling (M6). Draft placement is internal; releasedSlot is what
    // speakers were told (its sequence records the release that carried it).
    roomId: v.optional(v.id("rooms")),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    releasedSlot: v.optional(
      v.object({
        startsAt: v.number(),
        endsAt: v.number(),
        roomId: v.optional(v.id("rooms")),
        releasedAt: v.number(),
        sequence: v.number(),
      }),
    ),
    // Last .ics SEQUENCE sent for this session's invite UIDs. Monotonic — it
    // only ever increments and survives cancelRelease clearing releasedSlot,
    // because Outlook/Exchange tombstone a cancelled UID and silently drop a
    // later REQUEST whose SEQUENCE isn't higher than the CANCEL's (RFC 5546;
    // gaps are fine, going backwards is not). Absent on rows that predate the
    // field → readers fall back to releasedSlot.sequence.
    icsSequence: v.optional(v.number()),
    // Manually entered virtual/hybrid links with explicit audiences (M6).
    virtualLinks: v.optional(
      v.object({
        attendee: v.optional(v.string()),
        backstage: v.optional(v.string()),
        host: v.optional(v.string()),
      }),
    ),
  })
    .index("by_eventId", ["eventId"])
    .index("by_proposalId", ["proposalId"]),

  sessionParticipants: defineTable({
    sessionId: v.id("sessions"),
    eventId: v.id("events"),
    eventContactId: v.id("eventContacts"),
    role: v.string(), // "speaker" in v1
    state: v.union(
      v.literal("awaiting"),
      v.literal("confirmed"),
      v.literal("declined"),
      v.literal("withdrawn"),
    ),
    // Who recorded the state change (speaker/manager/organizer) and when.
    stateSetBy: v.optional(v.id("users")),
    stateSetAt: v.optional(v.number()),
    // The proposal's primary manager, when this came via CFP.
    managerUserId: v.optional(v.id("users")),
    // Participation-reminder bookkeeping (M5; unconfirmed speakers get
    // participation reminders, never task chasing).
    lastRemindedAt: v.optional(v.number()),
    // Schedule acknowledgement (M6), tracked separately from participation.
    // Set to awaitingAck when a slot is first released or its date/start
    // changes; room/track/wording changes don't reset it.
    ack: v.optional(
      v.union(
        v.literal("awaitingAck"),
        v.literal("acknowledged"),
        v.literal("conflict"),
      ),
    ),
    ackSetBy: v.optional(v.id("users")),
    ackSetAt: v.optional(v.number()),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_eventId", ["eventId"])
    .index("by_eventContactId", ["eventContactId"]),

  // ── Portal (M3) ──────────────────────────────────────────────────────
  // Organizer-controlled primary-manager handoff: invited by email, completed
  // when a signed-in user with that (Clerk-verified) email enters the portal.
  // The current manager keeps access until completion (MILESTONES M3).
  managerHandoffs: defineTable({
    eventId: v.id("events"),
    sessionId: v.id("sessions"),
    email: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("revoked"),
    ),
    invitedBy: v.id("users"),
    completedBy: v.optional(v.id("users")),
    completedAt: v.optional(v.number()),
    expiresAt: v.number(),
  })
    .index("by_eventId_and_email", ["eventId", "email"])
    .index("by_sessionId", ["sessionId"]),

  // ── Speaker ops: tasks & readiness (M4) ──────────────────────────────
  // Requirement definitions are event-scoped snapshots (M4: independent of
  // any future org template library).
  requirements: defineTable({
    eventId: v.id("events"),
    title: v.string(),
    description: v.optional(v.string()),
    // participant → one obligation per applicable speaker; session → one
    // shared obligation with one accountable assignee.
    scope: v.union(v.literal("participant"), v.literal("session")),
    // What "Provided" observes. `manual` = organizer/speaker ticks it.
    evidence: v.union(
      v.literal("file"),
      v.literal("profileField"), // e.g. bio/headshot present on the snapshot
      v.literal("manual"),
    ),
    // For profileField evidence: which snapshot field ("bio" | "headshot" | "tagline").
    fieldKey: v.optional(v.string()),
    // Optional organizer review gate (off by default in v1).
    reviewRequired: v.boolean(),
    dueAt: v.number(),
    active: v.boolean(),
    // M5 reminder overrides: cadence in days, or disabled outright.
    reminderCadenceDays: v.optional(v.number()),
    remindersDisabled: v.optional(v.boolean()),
  })
    .index("by_eventId", ["eventId"])
    // The reminder dispatcher must discover requirement-level cadence even
    // when the parent event has no default and the task is not due soon.
    .index("by_reminderCadenceDays", ["reminderCadenceDays"]),

  taskInstances: defineTable({
    requirementId: v.id("requirements"),
    eventId: v.id("events"),
    sessionId: v.id("sessions"),
    // Set for participant-scope tasks; session tasks have one accountable
    // assignee (defaults to the primary manager) identified by participantId
    // too when the manager is a participant, else undefined.
    participantId: v.optional(v.id("sessionParticipants")),
    eventContactId: v.optional(v.id("eventContacts")),
    status: v.union(
      v.literal("pending"),
      v.literal("provided"),
      v.literal("changesRequested"),
      v.literal("approved"),
      v.literal("complete"),
      v.literal("notApplicable"),
    ),
    dueAt: v.number(),
    naReason: v.optional(v.string()),
    reviewNote: v.optional(v.string()),
    completedBy: v.optional(v.id("users")),
    completedAt: v.optional(v.number()),
    lastRemindedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_status_and_dueAt", ["status", "dueAt"])
    .index("by_requirementId", ["requirementId"])
    .index("by_sessionId", ["sessionId"])
    .index("by_eventContactId", ["eventContactId"]),

  // One compact operational row per event. All paginated reminder discovery
  // sources converge here before scheduling a per-event sweep, so one logical
  // hourly run cannot enqueue the same expensive event sweep repeatedly.
  reminderDispatchStates: defineTable({
    eventId: v.id("events"),
    lastRunAt: v.number(),
    dispatchCount: v.number(),
  }).index("by_eventId", ["eventId"]),

  // Versioned uploads as task evidence. Resubmission adds a version; prior
  // files, feedback, actors and timestamps are never erased (M4).
  uploads: defineTable({
    eventId: v.id("events"),
    taskInstanceId: v.id("taskInstances"),
    storageId: v.id("_storage"),
    filename: v.string(),
    version: v.number(),
    uploadedBy: v.id("users"),
    // Version-specific approval (M4): replacing an approved file returns the
    // task to provided/awaiting review.
    approvedAt: v.optional(v.number()),
    approvedBy: v.optional(v.id("users")),
  })
    .index("by_taskInstanceId", ["taskInstanceId"])
    // The files library (W5) reads all of an event's uploads in one scan.
    .index("by_eventId", ["eventId"])
    .index("by_storageId", ["storageId"]),

  // ── Agenda items (M6): non-session blocks (breaks, registration, meals).
  // They share drafting/overlap checks/publication but bypass CFP, review,
  // speakers, tasks and calendar invitations (decision log #7).
  agendaItems: defineTable({
    eventId: v.id("events"),
    title: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    roomId: v.optional(v.id("rooms")),
    description: v.optional(v.string()),
  }).index("by_eventId", ["eventId"]),

  // ── Email templates (M5) ─────────────────────────────────────────────
  // Organizer-editable templates for lifecycle sends + custom one-offs.
  // Variables use {{var}} syntax; renderers fall back to built-in defaults
  // when no row exists for a key.
  emailTemplates: defineTable({
    eventId: v.id("events"),
    // "cfp.confirmation" | "decision.accepted" | "decision.declined" |
    // "invitation.direct" | "task.assigned" | "reminder.tasks" |
    // "reminder.participation" | "custom:<slug>"
    key: v.string(),
    name: v.string(),
    subject: v.string(),
    html: v.string(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }).index("by_eventId_and_key", ["eventId", "key"]),

  // ── Public program (M7) ──────────────────────────────────────────────
  // One row per event holding the LAST EXPLICITLY PUBLISHED projection —
  // the single shared program consumed by the public page, read API and
  // embeds. Never the organizer's working state. Per-item unpublish rewrites
  // this projection (decision log #12).
  publishedPrograms: defineTable({
    eventId: v.id("events"),
    version: v.number(),
    publishedAt: v.number(),
    publishedBy: v.id("users"),
    // Denormalized, already-privacy-filtered snapshot (only Confirmed
    // participants' event-profile fields; no backstage/host links).
    program: vPublicProgram,
  }).index("by_eventId", ["eventId"]),

  // Per-item publication flags — which sessions/speakers/agenda items the
  // organizer has chosen to expose. Publishing the program reads these.
  publicationFlags: defineTable({
    eventId: v.id("events"),
    // "session" | "agendaItem" | "speaker" (eventContact) | "lineup" | "agenda"
    targetType: v.string(),
    targetId: v.string(),
    published: v.boolean(),
    updatedAt: v.number(),
  }).index("by_eventId_and_target", ["eventId", "targetType", "targetId"]),

  // ── Saved views (W2) ─────────────────────────────────────────────────
  // A named set of URL search params for one module table, owned by one user
  // on one event. Private by construction: there is no share model and no
  // permission field, because a shared view is just its URL — which carries
  // the params and never this row's id.
  //
  // `params` is validated against the destination module's own parser
  // (convex/shared/viewParams.ts) on every write AND re-validated on read, so
  // a row cannot outlive the vocabulary it was written against.
  savedViews: defineTable({
    eventId: v.id("events"),
    userId: v.id("users"),
    // A ViewModule (convex/shared/viewParams.ts). Stored as a string so an
    // unknown value is a refused read rather than a schema error on a table
    // full of preferences.
    module: v.string(),
    name: v.string(),
    params: v.record(v.string(), v.string()),
    // Absent means "not my default". At most one per (event, user, module).
    isDefault: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_eventId_and_userId_and_module", ["eventId", "userId", "module"]),

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
    // Why a `failed` row failed, composed at the moment of refusal — the only
    // time the cause (test mode, bad key) is knowable. Absent on rows that
    // left the building and on failures recorded before this field existed.
    failureReason: v.optional(v.string()),
    deliveryStatus: v.union(
      v.literal("queued"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("delivery_delayed"),
      v.literal("bounced"),
      v.literal("complained"),
      v.literal("failed"),
    ),
    // The PROVIDER's own timestamp for the delivery event that last moved
    // `deliveryStatus`, so the log can say when something was delivered rather
    // than only when StageStack handed it over. Optional: rows written before
    // this field existed (and rows still sitting at `queued`, which no provider
    // event has touched) simply do not carry one — no backfill needed.
    deliveryUpdatedAt: v.optional(v.number()),
    sentByUserId: v.optional(v.id("users")),
    context: v.optional(v.any()),
  })
    .index("by_eventId", ["eventId"])
    .index("by_contactId", ["contactId"])
    .index("by_contactId_and_kind", ["contactId", "kind"])
    .index("by_resendEmailId", ["resendEmailId"])
    // Per-contact comms log (M4): `toEmail` is stored NORMALIZED (trimmed +
    // lowercased) by every write path, so an indexed equality on the address
    // replaces the event-wide scan + unindexed `.filter()` this used to need.
    // Storing the normalization rather than adding a second `toEmailLower`
    // column means existing rows keep working: they were already written from
    // cleanEmail()/normalizeEmail() output, so they are already lowercase —
    // no field is `undefined` on old docs and no migration is required for
    // correctness (model/comms.ts also reads the as-typed variant for any
    // stray mixed-case legacy row).
    .index("by_eventId_and_toEmail", ["eventId", "toEmail"])
    // Calendar trail lookups (M5): releasing slots must find each
    // participant's most recent schedule.* message. Indexing (eventId, kind)
    // lets one read per kind cover the whole release wave, instead of
    // re-scanning every message on the event once per session.
    .index("by_eventId_and_kind", ["eventId", "kind"]),
});
