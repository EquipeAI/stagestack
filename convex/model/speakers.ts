import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import {
  assertEventActive,
  assertText,
  normalizeEmail,
  isEmail,
} from "./validation";
import { optionalHttpUrl } from "../lib/urls";
import * as Publish from "./publish";
import * as Tasks from "./tasks";
import {
  MAX_HEADSHOT_BYTES,
  MAX_HEADSHOT_SOURCE_BYTES,
  supportedHeadshotType,
} from "./headshotImages";

// ─────────────────────────────────────────────────────────────────────────
// Organizer speaker roster (W6). The roster is the event's eventContacts —
// the publishable snapshots — joined with participation state. It adds three
// capabilities the eval called out as missing:
//   * a dedicated searchable roster (SPK-01),
//   * organizer-side profile editing incl. custom/logistics values (SPK-15,
//     CNT-10),
//   * a deterministic CSV import path (SPK-03) that dedupes by email.
// ─────────────────────────────────────────────────────────────────────────

const ROSTER_SCAN = 2000;
const MAX_IMPORT_ROWS = 300;
const HEADSHOT_UPLOAD_TTL_MS = 60 * 60 * 1000;
const HEADSHOT_UPLOAD_LEASE_MS = 15 * 60 * 1000;
const HEADSHOT_REFERENCE_SCAN = 1000;
const HEADSHOT_CLEANUP_RETRY_MS = 24 * 60 * 60 * 1000;
export const MAX_HEADSHOT_STORED_BYTES_PER_USER = 50 * 1024 * 1024;
export const MAX_HEADSHOT_STORED_TICKETS_PER_USER = 50;
export const MAX_HEADSHOT_STORED_BYTES_PER_USER_GLOBAL = 50 * 1024 * 1024;
export const MAX_HEADSHOT_STORED_TICKETS_PER_USER_GLOBAL = 50;
export const MAX_HEADSHOT_STORED_BYTES_PER_ORG = 500 * 1024 * 1024;
export const MAX_HEADSHOT_STORED_TICKETS_PER_ORG = 500;
export const HEADSHOT_ATTEMPT_RESERVED_BYTES =
  MAX_HEADSHOT_SOURCE_BYTES + MAX_HEADSHOT_BYTES;
export const HEADSHOT_ATTEMPT_RESERVED_BLOBS = 2;

function invalidHeadshot(message: string): never {
  throw new ConvexError({ code: "invalid_headshot", message });
}

export type HeadshotUploadScope = {
  orgId: Id<"organizations">;
  eventId: Id<"events">;
  eventContactId: Id<"eventContacts">;
  actorUserId: Id<"users">;
};

export type HeadshotUploadClaim = {
  claimed: boolean;
  message?: string;
  expectedContentType?: string;
  expectedSize?: number;
};

export type HeadshotSourceRegistration = {
  recorded: boolean;
  message?: string;
};

export type HeadshotSourceDetails = {
  processable: boolean;
  message?: string;
  contentType?: string;
  size?: number;
};

function cleanHeadshotIntent(contentType: string, size: number) {
  const normalizedType = supportedHeadshotType(contentType);
  if (normalizedType === null)
    invalidHeadshot("Choose a JPEG, PNG, or WebP image for the headshot.");
  if (!Number.isSafeInteger(size) || size <= 0) {
    invalidHeadshot("The selected image is empty or has an invalid size.");
  }
  if (size > MAX_HEADSHOT_SOURCE_BYTES) {
    invalidHeadshot("Source headshots must be 4 MB or smaller.");
  }
  return { contentType: normalizedType, size };
}

function uploadMatchesScope(
  upload: Doc<"headshotUploads">,
  scope: HeadshotUploadScope,
): boolean {
  return (
    upload.orgId === scope.orgId &&
    upload.eventId === scope.eventId &&
    upload.eventContactId === scope.eventContactId &&
    upload.uploadedByUserId === scope.actorUserId &&
    upload.purpose === "speakerHeadshot"
  );
}

async function requireHeadshotUpload(
  ctx: QueryCtx,
  scope: HeadshotUploadScope,
  uploadId: Id<"headshotUploads">,
): Promise<Doc<"headshotUploads">> {
  const upload = await ctx.db.get("headshotUploads", uploadId);
  if (upload === null || !uploadMatchesScope(upload, scope)) {
    // Upload tickets are scoped capabilities. A mismatch is deliberately
    // indistinguishable from a nonexistent ticket.
    notFound("headshot upload", "No such headshot upload.");
  }
  return upload;
}

async function requireActorHeadshotUpload(
  ctx: QueryCtx,
  actorUserId: Id<"users">,
  uploadId: Id<"headshotUploads">,
): Promise<Doc<"headshotUploads">> {
  const upload = await ctx.db.get("headshotUploads", uploadId);
  if (
    upload === null ||
    upload.uploadedByUserId !== actorUserId ||
    upload.purpose !== "speakerHeadshot"
  ) {
    notFound("headshot upload", "No such headshot upload.");
  }
  return upload;
}

type FlexibleReferenceMatch = "clear" | "referenced" | "ambiguous";

function flexibleReferenceMatch(
  value: unknown,
  storageId: Id<"_storage">,
  depth = 0,
): FlexibleReferenceMatch {
  if (value === storageId) return "referenced";
  if (value === null || typeof value !== "object") return "clear";
  // Convex values are acyclic JSON, but unusually deep flexible payloads are
  // still ambiguous ownership. Retain rather than assuming they are safe.
  if (depth >= 8) return "ambiguous";
  const values = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  let match: FlexibleReferenceMatch = "clear";
  for (const item of values) {
    const child = flexibleReferenceMatch(item, storageId, depth + 1);
    if (child === "referenced") return child;
    if (child === "ambiguous") match = child;
  }
  return match;
}

type FlexibleHeadshotReferences = {
  proposals: Array<Doc<"proposals">>;
  jobs: Array<Doc<"jobs">>;
  incomplete: boolean;
};

async function loadFlexibleHeadshotReferences(
  ctx: QueryCtx,
): Promise<FlexibleHeadshotReferences> {
  const [proposals, jobs] = await Promise.all([
    ctx.db.query("proposals").take(HEADSHOT_REFERENCE_SCAN + 1),
    ctx.db.query("jobs").take(HEADSHOT_REFERENCE_SCAN + 1),
  ]);
  return {
    proposals,
    jobs,
    incomplete:
      proposals.length > HEADSHOT_REFERENCE_SCAN ||
      jobs.length > HEADSHOT_REFERENCE_SCAN,
  };
}

type HeadshotReferenceState =
  | "unreferenced"
  | "referenced"
  | "retryableAmbiguous"
  | "ambiguous";

async function headshotReferenceState(
  ctx: QueryCtx,
  storageId: Id<"_storage">,
  ignoredUploadId: Id<"headshotUploads">,
  flexible?: FlexibleHeadshotReferences,
): Promise<HeadshotReferenceState> {
  const [
    directory,
    snapshot,
    proposalSpeaker,
    taskUpload,
    eventLogo,
    eventBanner,
    uploadTickets,
  ] = await Promise.all([
    ctx.db
      .query("contacts")
      .withIndex("by_headshotId", (q) => q.eq("headshotId", storageId))
      .first(),
    ctx.db
      .query("eventContacts")
      .withIndex("by_headshotId", (q) => q.eq("headshotId", storageId))
      .first(),
    ctx.db
      .query("proposalSpeakers")
      .withIndex("by_headshotId", (q) => q.eq("headshotId", storageId))
      .first(),
    ctx.db
      .query("uploads")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .first(),
    ctx.db
      .query("events")
      .withIndex("by_logoId", (q) => q.eq("logoId", storageId))
      .first(),
    ctx.db
      .query("events")
      .withIndex("by_bannerId", (q) => q.eq("bannerId", storageId))
      .first(),
    ctx.db
      .query("headshotUploads")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .take(2),
  ]);
  if (
    directory !== null ||
    snapshot !== null ||
    proposalSpeaker !== null ||
    taskUpload !== null ||
    eventLogo !== null ||
    eventBanner !== null ||
    uploadTickets.some((upload) => upload._id !== ignoredUploadId)
  ) {
    return "referenced";
  }

  // Proposal answers and worker payloads are intentionally flexible JSON and
  // cannot be indexed by storage id. Cleanup scans a bounded slice and fails
  // closed if the slice is incomplete; uncertain ownership means retention.
  const references = flexible ?? (await loadFlexibleHeadshotReferences(ctx));
  if (references.incomplete) return "retryableAmbiguous";
  let state: HeadshotReferenceState = "unreferenced";
  for (const proposal of references.proposals) {
    const match = flexibleReferenceMatch(proposal.answers, storageId);
    if (match === "referenced") return match;
    if (match === "ambiguous") state = match;
  }
  for (const job of references.jobs) {
    for (const value of [job.payload, job.result]) {
      const match = flexibleReferenceMatch(value, storageId);
      if (match === "referenced") return match;
      if (match === "ambiguous") state = match;
    }
  }
  return state;
}

async function usageFor(
  ctx: QueryCtx,
  upload: Doc<"headshotUploads">,
): Promise<Doc<"headshotUploadUsage"> | null> {
  return await ctx.db
    .query("headshotUploadUsage")
    .withIndex("by_orgId_and_userId", (q) =>
      q.eq("orgId", upload.orgId).eq("userId", upload.uploadedByUserId),
    )
    .unique();
}

async function globalUserUsageFor(
  ctx: QueryCtx,
  upload: Doc<"headshotUploads">,
): Promise<Doc<"headshotUploadUserUsage"> | null> {
  return await ctx.db
    .query("headshotUploadUserUsage")
    .withIndex("by_userId", (q) => q.eq("userId", upload.uploadedByUserId))
    .unique();
}

async function orgUsageFor(
  ctx: QueryCtx,
  upload: Doc<"headshotUploads">,
): Promise<Doc<"headshotUploadOrgUsage"> | null> {
  return await ctx.db
    .query("headshotUploadOrgUsage")
    .withIndex("by_orgId", (q) => q.eq("orgId", upload.orgId))
    .unique();
}

async function releaseHeadshotReservation(
  ctx: MutationCtx,
  upload: Doc<"headshotUploads">,
): Promise<void> {
  if (upload.reservedBytes === undefined) return;
  await reconcileHeadshotReservation(ctx, upload, 0, 0, undefined);
}

async function reconcileHeadshotReservation(
  ctx: MutationCtx,
  upload: Doc<"headshotUploads">,
  nextBytes: number,
  nextBlobCount: number,
  quotaState: Doc<"headshotUploads">["quotaState"],
): Promise<void> {
  const currentBytes = upload.reservedBytes ?? 0;
  const currentBlobCount = upload.reservedBlobCount ??
    (currentBytes > 0 ? 1 : 0);
  if (currentBytes === nextBytes && currentBlobCount === nextBlobCount) {
    await ctx.db.patch("headshotUploads", upload._id, { quotaState });
    return;
  }
  const [usage, globalUsage, orgUsage] = await Promise.all([
    usageFor(ctx, upload),
    globalUserUsageFor(ctx, upload),
    orgUsageFor(ctx, upload),
  ]);
  if (usage === null || globalUsage === null || orgUsage === null) {
    throw new Error("Headshot quota ledger is inconsistent.");
  }
  const byteDelta = nextBytes - currentBytes;
  const blobDelta = nextBlobCount - currentBlobCount;
  const nextLedgerValues = (storedBytes: number, ticketCount: number) => {
    const updatedBytes = storedBytes + byteDelta;
    const updatedCount = ticketCount + blobDelta;
    if (updatedBytes < 0 || updatedCount < 0) {
      throw new Error("Headshot quota ledger is inconsistent.");
    }
    return {
      storedBytes: updatedBytes,
      ticketCount: updatedCount,
      updatedAt: Date.now(),
    };
  };
  await ctx.db.patch(
    "headshotUploadUsage",
    usage._id,
    nextLedgerValues(usage.storedBytes, usage.ticketCount),
  );
  await ctx.db.patch(
    "headshotUploadUserUsage",
    globalUsage._id,
    nextLedgerValues(globalUsage.storedBytes, globalUsage.ticketCount),
  );
  await ctx.db.patch(
    "headshotUploadOrgUsage",
    orgUsage._id,
    nextLedgerValues(orgUsage.storedBytes, orgUsage.ticketCount),
  );
  await ctx.db.patch("headshotUploads", upload._id, {
    reservedBytes: nextBytes === 0 ? undefined : nextBytes,
    reservedBlobCount: nextBlobCount === 0 ? undefined : nextBlobCount,
    quotaState,
  });
}

async function markHeadshotAttemptIndeterminate(
  ctx: MutationCtx,
  upload: Doc<"headshotUploads">,
): Promise<void> {
  if (upload.storageAttemptStartedAt === undefined) return;
  await ctx.db.patch("headshotUploads", upload._id, {
    status: "retained",
    quotaState: "indeterminate",
    cleanupAfter: undefined,
  });
}

export type HeadshotStorageReservation = {
  reserved: boolean;
  message?: string;
};

/** Charge the worst-case two-blob footprint before the first storage call.
 * A crash in either store→record gap therefore leaves a durable bounded
 * reservation even though the physical orphan's id is unknowable. */
export async function beginHeadshotStorageAttempt(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  uploadId: Id<"headshotUploads">,
): Promise<HeadshotStorageReservation> {
  const upload = await requireActorHeadshotUpload(ctx, actorUserId, uploadId);
  if (
    upload.status !== "uploading" ||
    upload.uploadLeaseExpiresAt === undefined ||
    upload.uploadLeaseExpiresAt <= Date.now()
  ) {
    return { reserved: false, message: "That upload lease expired." };
  }
  if (upload.storageAttemptStartedAt !== undefined) {
    return upload.quotaState === "conservative" &&
      upload.reservedBytes === HEADSHOT_ATTEMPT_RESERVED_BYTES &&
      upload.reservedBlobCount === HEADSHOT_ATTEMPT_RESERVED_BLOBS
      ? { reserved: true }
      : { reserved: false, message: "That storage attempt already started." };
  }
  const [usage, globalUsage, orgUsage] = await Promise.all([
    usageFor(ctx, upload),
    globalUserUsageFor(ctx, upload),
    orgUsageFor(ctx, upload),
  ]);
  const storedBytes = usage?.storedBytes ?? 0;
  const ticketCount = usage?.ticketCount ?? 0;
  const globalStoredBytes = globalUsage?.storedBytes ?? 0;
  const globalTicketCount = globalUsage?.ticketCount ?? 0;
  const orgStoredBytes = orgUsage?.storedBytes ?? 0;
  const orgTicketCount = orgUsage?.ticketCount ?? 0;
  if (
    storedBytes + HEADSHOT_ATTEMPT_RESERVED_BYTES >
      MAX_HEADSHOT_STORED_BYTES_PER_USER ||
    ticketCount + HEADSHOT_ATTEMPT_RESERVED_BLOBS >
      MAX_HEADSHOT_STORED_TICKETS_PER_USER ||
    globalStoredBytes + HEADSHOT_ATTEMPT_RESERVED_BYTES >
      MAX_HEADSHOT_STORED_BYTES_PER_USER_GLOBAL ||
    globalTicketCount + HEADSHOT_ATTEMPT_RESERVED_BLOBS >
      MAX_HEADSHOT_STORED_TICKETS_PER_USER_GLOBAL ||
    orgStoredBytes + HEADSHOT_ATTEMPT_RESERVED_BYTES >
      MAX_HEADSHOT_STORED_BYTES_PER_ORG ||
    orgTicketCount + HEADSHOT_ATTEMPT_RESERVED_BLOBS >
      MAX_HEADSHOT_STORED_TICKETS_PER_ORG
  ) {
    await ctx.db.patch("headshotUploads", upload._id, {
      status: "rejected",
      expiresAt: Date.now(),
    });
    return {
      reserved: false,
      message:
        "Headshot storage quota reached. Remove unused photos or ask an administrator for help.",
    };
  }
  const now = Date.now();
  if (usage === null) {
    await ctx.db.insert("headshotUploadUsage", {
      orgId: upload.orgId,
      userId: upload.uploadedByUserId,
      storedBytes: HEADSHOT_ATTEMPT_RESERVED_BYTES,
      ticketCount: HEADSHOT_ATTEMPT_RESERVED_BLOBS,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch("headshotUploadUsage", usage._id, {
      storedBytes: storedBytes + HEADSHOT_ATTEMPT_RESERVED_BYTES,
      ticketCount: ticketCount + HEADSHOT_ATTEMPT_RESERVED_BLOBS,
      updatedAt: now,
    });
  }
  if (globalUsage === null) {
    await ctx.db.insert("headshotUploadUserUsage", {
      userId: upload.uploadedByUserId,
      storedBytes: HEADSHOT_ATTEMPT_RESERVED_BYTES,
      ticketCount: HEADSHOT_ATTEMPT_RESERVED_BLOBS,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch("headshotUploadUserUsage", globalUsage._id, {
      storedBytes: globalStoredBytes + HEADSHOT_ATTEMPT_RESERVED_BYTES,
      ticketCount: globalTicketCount + HEADSHOT_ATTEMPT_RESERVED_BLOBS,
      updatedAt: now,
    });
  }
  if (orgUsage === null) {
    await ctx.db.insert("headshotUploadOrgUsage", {
      orgId: upload.orgId,
      storedBytes: HEADSHOT_ATTEMPT_RESERVED_BYTES,
      ticketCount: HEADSHOT_ATTEMPT_RESERVED_BLOBS,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch("headshotUploadOrgUsage", orgUsage._id, {
      storedBytes: orgStoredBytes + HEADSHOT_ATTEMPT_RESERVED_BYTES,
      ticketCount: orgTicketCount + HEADSHOT_ATTEMPT_RESERVED_BLOBS,
      updatedAt: now,
    });
  }
  await ctx.db.patch("headshotUploads", upload._id, {
    reservedBytes: HEADSHOT_ATTEMPT_RESERVED_BYTES,
    reservedBlobCount: HEADSHOT_ATTEMPT_RESERVED_BLOBS,
    storageAttemptStartedAt: now,
    quotaState: "conservative",
  });
  return { reserved: true };
}

export async function markHeadshotOutputStoreStarted(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  uploadId: Id<"headshotUploads">,
): Promise<boolean> {
  const upload = await requireActorHeadshotUpload(ctx, actorUserId, uploadId);
  if (
    upload.status !== "uploading" ||
    upload.uploadLeaseExpiresAt === undefined ||
    upload.uploadLeaseExpiresAt <= Date.now() ||
    upload.sourceStorageId === undefined ||
    upload.sourceDeletedAt !== undefined ||
    upload.quotaState !== "conservative" ||
    upload.reservedBytes !== HEADSHOT_ATTEMPT_RESERVED_BYTES ||
    upload.reservedBlobCount !== HEADSHOT_ATTEMPT_RESERVED_BLOBS
  ) {
    return false;
  }
  if (upload.outputStoreStartedAt !== undefined) return true;
  await ctx.db.patch("headshotUploads", upload._id, {
    outputStoreStartedAt: Date.now(),
  });
  return true;
}

export async function markHeadshotOutputKnownDeleted(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  uploadId: Id<"headshotUploads">,
): Promise<boolean> {
  const upload = await requireActorHeadshotUpload(ctx, actorUserId, uploadId);
  if (
    upload.outputStoreStartedAt === undefined ||
    upload.storageId !== undefined
  ) {
    return false;
  }
  await ctx.db.patch("headshotUploads", upload._id, {
    outputKnownDeletedAt: Date.now(),
  });
  return true;
}

type HeadshotDeletionResult =
  | "deleted"
  | "referenced"
  | "retryableAmbiguous"
  | "ambiguous"
  | "unowned";

/** Delete only a blob that is both owned by this exact ticket and no longer
 * referenced by any directory/snapshot/other ticket. Bounded-scan ambiguity
 * and exact shared refs stay retryable; legacy and irreducibly ambiguous
 * storage is retained. */
async function deleteOwnedHeadshotIfUnreferenced(
  ctx: MutationCtx,
  upload: Doc<"headshotUploads">,
  flexible?: FlexibleHeadshotReferences,
): Promise<HeadshotDeletionResult> {
  if (upload.storageId === undefined || upload.serverStoredAt === undefined) {
    return "unowned";
  }
  if (upload.quotaState === "indeterminate") return "ambiguous";
  if (
    upload.storageAttemptStartedAt !== undefined &&
    upload.sourceStorageId === undefined
  ) {
    return "ambiguous";
  }
  if (
    upload.sourceStorageId !== undefined &&
    upload.sourceDeletedAt === undefined
  ) {
    return "retryableAmbiguous";
  }
  const references = await headshotReferenceState(
    ctx,
    upload.storageId,
    upload._id,
    flexible,
  );
  if (references !== "unreferenced") return references;
  await ctx.storage.delete(upload.storageId);
  await releaseHeadshotReservation(ctx, upload);
  return "deleted";
}

/** Mint a one-time ticket bound to one actor, event, snapshot, purpose, MIME
 * type and byte size. Only the dedicated authenticated HTTP action may turn
 * it into storage; no generic upload URL or storage id reaches the browser. */
export async function beginHeadshotUpload(
  ctx: MutationCtx,
  scope: HeadshotUploadScope,
  intent: { contentType: string; size: number },
): Promise<{ uploadId: Id<"headshotUploads"> }> {
  const cleaned = cleanHeadshotIntent(intent.contentType, intent.size);
  const now = Date.now();
  const uploadId = await ctx.db.insert("headshotUploads", {
    orgId: scope.orgId,
    eventId: scope.eventId,
    eventContactId: scope.eventContactId,
    uploadedByUserId: scope.actorUserId,
    purpose: "speakerHeadshot",
    expectedContentType: cleaned.contentType,
    expectedSize: cleaned.size,
    status: "pending",
    createdAt: now,
    expiresAt: now + HEADSHOT_UPLOAD_TTL_MS,
  });
  return { uploadId };
}

/** Atomically claim a ticket for the authenticated HTTP request. The contact
 * and event bindings are rechecked so a stale or cross-actor ticket cannot be
 * promoted to an upload capability. */
export async function claimHeadshotHttpUpload(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  uploadId: Id<"headshotUploads">,
  contentType: string,
): Promise<HeadshotUploadClaim> {
  const upload = await requireActorHeadshotUpload(ctx, actorUserId, uploadId);
  if (upload.status !== "pending") {
    return { claimed: false, message: "That upload ticket was already used." };
  }
  const now = Date.now();
  if (upload.expiresAt <= now) {
    await ctx.db.patch("headshotUploads", upload._id, {
      status: "rejected",
    });
    return {
      claimed: false,
      message: "That upload expired. Choose the photo again.",
    };
  }
  if (supportedHeadshotType(contentType) !== upload.expectedContentType) {
    await ctx.db.patch("headshotUploads", upload._id, { status: "rejected" });
    return {
      claimed: false,
      message: "The upload content type did not match the selected image.",
    };
  }
  const [event, contact] = await Promise.all([
    ctx.db.get("events", upload.eventId),
    ctx.db.get("eventContacts", upload.eventContactId),
  ]);
  if (
    event === null ||
    contact === null ||
    event.orgId !== upload.orgId ||
    contact.eventId !== upload.eventId ||
    contact.orgId !== upload.orgId
  ) {
    notFound("headshot upload", "No such headshot upload.");
  }

  const uploadLeaseExpiresAt = now + HEADSHOT_UPLOAD_LEASE_MS;
  await ctx.db.patch("headshotUploads", upload._id, {
    status: "uploading",
    claimedAt: now,
    uploadLeaseExpiresAt,
    // Once claimed, the bounded in-flight lease replaces the longer pending
    // ticket window. The expiry index can therefore sweep a crashed request as
    // soon as its lease ends instead of retaining its reservation for an hour.
    expiresAt: uploadLeaseExpiresAt,
  });
  return {
    claimed: true,
    expectedContentType: upload.expectedContentType,
    expectedSize: upload.expectedSize,
  };
}

/** Bind the fresh temporary source blob created by the authenticated HTTP
 * action to its already-claimed ticket. Raw bytes never cross a Convex value
 * boundary; this durable id lets the Node action read storage directly and
 * lets cron delete the source if either runtime crashes. */
export async function recordHeadshotSource(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  uploadId: Id<"headshotUploads">,
  sourceStorageId: Id<"_storage">,
  contentType: string,
  size: number,
): Promise<HeadshotSourceRegistration> {
  const upload = await requireActorHeadshotUpload(ctx, actorUserId, uploadId);
  if (upload.status !== "uploading" || upload.claimedAt === undefined) {
    return { recorded: false, message: "That upload lease expired." };
  }
  if (upload.sourceStorageId !== undefined) {
    return upload.sourceStorageId === sourceStorageId
      ? {
          recorded: upload.sourceDeletedAt === undefined,
          ...(upload.sourceDeletedAt === undefined
            ? {}
            : { message: "That upload source was already deleted." }),
        }
      : { recorded: false, message: "That upload already has source bytes." };
  }
  const [metadata, existing] = await Promise.all([
    ctx.db.system.get(sourceStorageId),
    ctx.db
      .query("headshotUploads")
      .withIndex("by_sourceStorageId", (q) =>
        q.eq("sourceStorageId", sourceStorageId),
      )
      .first(),
  ]);
  const normalizedContentType = supportedHeadshotType(contentType);
  if (
    metadata === null ||
    existing !== null ||
    upload.storageAttemptStartedAt === undefined ||
    upload.quotaState !== "conservative" ||
    upload.reservedBytes !== HEADSHOT_ATTEMPT_RESERVED_BYTES ||
    upload.reservedBlobCount !== HEADSHOT_ATTEMPT_RESERVED_BLOBS ||
    normalizedContentType === null ||
    normalizedContentType !== upload.expectedContentType ||
    metadata.contentType?.trim().toLowerCase() !== normalizedContentType ||
    metadata.size !== size ||
    size !== upload.expectedSize ||
    size > MAX_HEADSHOT_SOURCE_BYTES ||
    metadata._creationTime < upload.claimedAt
  ) {
    invalidHeadshot("The temporary image did not match its upload ticket.");
  }
  const now = Date.now();
  await ctx.db.patch("headshotUploads", upload._id, {
    sourceStorageId,
    sourceStoredAt: now,
    sourceContentType: normalizedContentType,
    sourceSize: size,
    sourceCleanupPending: true,
  });
  if (
    upload.uploadLeaseExpiresAt === undefined ||
    upload.uploadLeaseExpiresAt <= now
  ) {
    await ctx.db.patch("headshotUploads", upload._id, {
      status: "rejected",
      expiresAt: now,
    });
    return { recorded: false, message: "That upload lease expired." };
  }
  return { recorded: true };
}

/** Small-value handoff used by the Node action before it reads the raw source
 * directly from storage. */
export async function headshotSourceDetails(
  ctx: QueryCtx,
  actorUserId: Id<"users">,
  uploadId: Id<"headshotUploads">,
  sourceStorageId: Id<"_storage">,
): Promise<HeadshotSourceDetails> {
  const upload = await requireActorHeadshotUpload(ctx, actorUserId, uploadId);
  const now = Date.now();
  if (
    upload.status !== "uploading" ||
    upload.uploadLeaseExpiresAt === undefined ||
    upload.uploadLeaseExpiresAt <= now ||
    upload.sourceStorageId !== sourceStorageId ||
    upload.sourceDeletedAt !== undefined ||
    upload.sourceCleanupPending !== true ||
    upload.sourceContentType === undefined ||
    upload.sourceSize === undefined ||
    upload.storageAttemptStartedAt === undefined ||
    upload.quotaState !== "conservative"
  ) {
    return { processable: false, message: "That upload lease expired." };
  }
  return {
    processable: true,
    contentType: upload.sourceContentType,
    size: upload.sourceSize,
  };
}

/** The source id is server-minted, ticket-bound, unique, and never exposed.
 * That proof makes exact deletion safe without a global reference scan. */
export async function cleanupHeadshotSource(
  ctx: MutationCtx,
  uploadId: Id<"headshotUploads">,
  sourceStorageId: Id<"_storage">,
): Promise<boolean> {
  const upload = await ctx.db.get("headshotUploads", uploadId);
  if (
    upload === null ||
    upload.sourceStorageId !== sourceStorageId
  ) {
    return false;
  }
  if (
    upload.status === "uploading" &&
    upload.uploadLeaseExpiresAt !== undefined &&
    upload.uploadLeaseExpiresAt > Date.now()
  ) {
    return true;
  }
  if (upload.sourceDeletedAt === undefined) {
    await ctx.storage.delete(sourceStorageId);
    await ctx.db.patch("headshotUploads", upload._id, {
      sourceCleanupPending: false,
      sourceDeletedAt: Date.now(),
    });
  }
  const current = await ctx.db.get("headshotUploads", upload._id);
  if (current === null || current.quotaState === "indeterminate") return true;

  if (
    (current.status === "ready" ||
      current.status === "attached" ||
      current.status === "replaced" ||
      current.status === "cleanupPending") &&
    current.storageId !== undefined &&
    current.sanitizedSize !== undefined
  ) {
    await reconcileHeadshotReservation(
      ctx,
      current,
      current.sanitizedSize,
      1,
      "reconciled",
    );
    return true;
  }

  if (
    current.outputStoreStartedAt !== undefined &&
    current.storageId === undefined &&
    current.outputKnownDeletedAt === undefined
  ) {
    await markHeadshotAttemptIndeterminate(ctx, current);
    return true;
  }

  if (current.storageId !== undefined) {
    // A rejected output was never exposed or attached. Its exact server-owned
    // id is safe to delete without the shared-reference scan.
    if (current.serverStoredAt === undefined) {
      await markHeadshotAttemptIndeterminate(ctx, current);
      return true;
    }
    await ctx.storage.delete(current.storageId);
    await releaseHeadshotReservation(ctx, current);
    await ctx.db.patch("headshotUploads", current._id, {
      status: "deleted",
      deletedAt: Date.now(),
    });
    return true;
  }

  // No output store was attempted, and the one recorded raw source is now
  // proven deleted. This is an ordinary failure, so release the full charge.
  await releaseHeadshotReservation(ctx, current);
  return true;
}

export async function retainIndeterminateHeadshotAttempt(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  uploadId: Id<"headshotUploads">,
): Promise<void> {
  const upload = await requireActorHeadshotUpload(ctx, actorUserId, uploadId);
  await markHeadshotAttemptIndeterminate(ctx, upload);
}

export async function releaseKnownCleanHeadshotAttempt(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  uploadId: Id<"headshotUploads">,
): Promise<boolean> {
  const upload = await requireActorHeadshotUpload(ctx, actorUserId, uploadId);
  if (
    upload.storageAttemptStartedAt === undefined ||
    upload.sourceStorageId !== undefined ||
    upload.outputStoreStartedAt !== undefined ||
    upload.storageId !== undefined
  ) {
    return false;
  }
  await releaseHeadshotReservation(ctx, upload);
  await ctx.db.patch("headshotUploads", upload._id, { status: "rejected" });
  return true;
}

/** Persist the result of storage.store on the private ticket. This mutation
 * accepts a storage id only from the internal HTTP action and re-validates the
 * system metadata before exposing the ticket to attach. */
export async function completeHeadshotHttpUpload(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  uploadId: Id<"headshotUploads">,
  storageId: Id<"_storage">,
  contentType: string,
  size: number,
  width: number,
  height: number,
): Promise<boolean> {
  const upload = await requireActorHeadshotUpload(ctx, actorUserId, uploadId);
  const wasLeaseCleaned =
    upload.status === "discarded" &&
    upload.claimedAt !== undefined &&
    upload.uploadLeaseExpiresAt !== undefined;
  if (upload.status !== "uploading" && !wasLeaseCleaned) {
    invalidHeadshot("That upload ticket is not awaiting bytes.");
  }
  if (
    upload.quotaState !== "conservative" ||
    upload.reservedBytes !== HEADSHOT_ATTEMPT_RESERVED_BYTES ||
    upload.reservedBlobCount !== HEADSHOT_ATTEMPT_RESERVED_BLOBS ||
    upload.outputStoreStartedAt === undefined
  ) {
    invalidHeadshot("That upload did not reserve its storage attempt.");
  }
  const metadata = await ctx.db.system.get(storageId);
  if (
    metadata === null ||
    metadata.contentType?.trim().toLowerCase() !== contentType ||
    metadata.size !== size ||
    metadata.size > MAX_HEADSHOT_BYTES ||
    contentType !== "image/webp" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    invalidHeadshot("The stored image did not match its upload ticket.");
  }
  const existing = await ctx.db
    .query("headshotUploads")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .first();
  if (existing !== null) {
    invalidHeadshot("That uploaded photo was already claimed.");
  }
  const now = Date.now();
  const ready =
    upload.status === "uploading" &&
    upload.uploadLeaseExpiresAt !== undefined &&
    upload.uploadLeaseExpiresAt > now;
  await ctx.db.patch("headshotUploads", upload._id, {
    storageId,
    status: ready ? "ready" : "rejected",
    serverStoredAt: now,
    registeredAt: now,
    sanitizedContentType: contentType,
    sanitizedSize: size,
    width,
    height,
  });
  return ready;
}

export async function failHeadshotHttpUpload(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  uploadId: Id<"headshotUploads">,
  stored?: {
    storageId: Id<"_storage">;
    contentType: string;
    size: number;
    width: number;
    height: number;
  },
): Promise<void> {
  const upload = await requireActorHeadshotUpload(ctx, actorUserId, uploadId);
  const wasLeaseCleaned =
    upload.status === "discarded" &&
    upload.claimedAt !== undefined &&
    upload.uploadLeaseExpiresAt !== undefined;
  if (upload.status !== "uploading" && !wasLeaseCleaned) return;
  if (stored === undefined) {
    await ctx.db.patch("headshotUploads", upload._id, { status: "rejected" });
    return;
  }
  const metadata = await ctx.db.system.get(stored.storageId);
  const existing = await ctx.db
    .query("headshotUploads")
    .withIndex("by_storageId", (q) => q.eq("storageId", stored.storageId))
    .first();
  if (
    metadata === null ||
    metadata.contentType?.trim().toLowerCase() !== stored.contentType ||
    metadata.size !== stored.size ||
    stored.contentType !== "image/webp" ||
    upload.quotaState !== "conservative" ||
    upload.reservedBytes !== HEADSHOT_ATTEMPT_RESERVED_BYTES ||
    upload.reservedBlobCount !== HEADSHOT_ATTEMPT_RESERVED_BLOBS ||
    upload.outputStoreStartedAt === undefined ||
    existing !== null
  ) {
    invalidHeadshot("The failed upload could not be recorded safely.");
  }
  const now = Date.now();
  await ctx.db.patch("headshotUploads", upload._id, {
    storageId: stored.storageId,
    status: "rejected",
    serverStoredAt: now,
    registeredAt: now,
    sanitizedContentType: stored.contentType,
    sanitizedSize: stored.size,
    width: stored.width,
    height: stored.height,
  });
}

/** Release an unconsumed ticket. Attached tickets are intentionally a no-op:
 * a lost network response must never let the browser delete a photo that did
 * in fact become public profile data. */
export async function discardHeadshotUpload(
  ctx: MutationCtx,
  scope: HeadshotUploadScope,
  uploadId: Id<"headshotUploads">,
): Promise<void> {
  const upload = await requireHeadshotUpload(ctx, scope, uploadId);
  // A browser can time out and call discard while the HTTP action is between
  // claim, sanitize, store, and completion. The bounded lease owns that state;
  // discard must not invalidate the action's ability to record/delete a blob.
  if (upload.status === "uploading") return;
  if (
    upload.status === "attached" ||
    upload.status === "replaced" ||
    upload.status === "deleted" ||
    upload.status === "retained" ||
    upload.status === "cleanupPending"
  ) {
    return;
  }
  const now = Date.now();
  if (upload.storageId === undefined) {
    await ctx.db.patch("headshotUploads", upload._id, { status: "discarded" });
    return;
  }
  const result = await deleteOwnedHeadshotIfUnreferenced(ctx, upload);
  await recordHeadshotCleanupResult(ctx, upload, result, now);
}

async function recordHeadshotCleanupResult(
  ctx: MutationCtx,
  upload: Doc<"headshotUploads">,
  result: HeadshotDeletionResult,
  now: number,
): Promise<void> {
  if (result === "deleted") {
    await ctx.db.patch("headshotUploads", upload._id, {
      status: "deleted",
      deletedAt: now,
      cleanupAfter: undefined,
    });
  } else if (result === "retryableAmbiguous" || result === "referenced") {
    // Exact shared refs can disappear later (for example when the other event
    // replaces its copied snapshot). Keep every server-owned blob retryable;
    // the durable quota bounds both shared and ambiguous retention.
    await ctx.db.patch("headshotUploads", upload._id, {
      status: "cleanupPending",
      cleanupAfter: now + HEADSHOT_CLEANUP_RETRY_MS,
    });
  } else {
    // Legacy/unowned storage and irreducibly deep flexible data are terminal
    // fail-closed; the quota still bounds retained growth.
    await ctx.db.patch("headshotUploads", upload._id, {
      status: "retained",
      cleanupAfter: undefined,
    });
  }
}

/** Sweep abandoned tickets in small indexed batches. Ready server-owned blobs
 * are deleted only after exhaustive indexed checks plus conservative bounded
 * JSON scans. Incomplete scans and exact shared refs stay retryable; legacy or
 * irreducibly ambiguous ownership is retained rather than risking data. */
export async function cleanupExpiredHeadshotUploads(
  ctx: MutationCtx,
): Promise<number> {
  const now = Date.now();
  const rawSources = await ctx.db
    .query("headshotUploads")
    .withIndex("by_sourceCleanupPending_and_sourceStoredAt", (q) =>
      q.eq("sourceCleanupPending", true).lte("sourceStoredAt", now),
    )
    .take(25);
  let cleaned = 0;
  for (const upload of rawSources) {
    if (
      upload.status === "uploading" &&
      upload.uploadLeaseExpiresAt !== undefined &&
      upload.uploadLeaseExpiresAt > now
    ) {
      continue;
    }
    if (upload.sourceStorageId !== undefined) {
      await cleanupHeadshotSource(ctx, upload._id, upload.sourceStorageId);
      cleaned += 1;
    }
  }
  const statuses: Array<Doc<"headshotUploads">["status"]> = [
    "pending",
    "uploading",
    "ready",
    "rejected",
  ];
  const expiredUploads: Array<Doc<"headshotUploads">> = [];
  for (const status of statuses) {
    expiredUploads.push(
      ...(await ctx.db
        .query("headshotUploads")
        .withIndex("by_status_and_expiresAt", (q) =>
          q.eq("status", status).lte("expiresAt", now),
        )
        .take(25)),
    );
  }
  expiredUploads.push(
    ...(await ctx.db
      .query("headshotUploads")
      .withIndex("by_status_and_cleanupAfter", (q) =>
        q.eq("status", "cleanupPending").lte("cleanupAfter", now),
      )
      .take(25)),
  );
  const uniqueExpired = Array.from(
    new Map(expiredUploads.map((upload) => [upload._id, upload])).values(),
  );
  const needsReferenceCheck = uniqueExpired.some(
    (upload) =>
      upload.storageId !== undefined && upload.serverStoredAt !== undefined,
  );
  const flexible = needsReferenceCheck
    ? await loadFlexibleHeadshotReferences(ctx)
    : undefined;
  for (const expiredUpload of uniqueExpired) {
    let upload =
      (await ctx.db.get("headshotUploads", expiredUpload._id)) ?? expiredUpload;
    if (
      upload.status === "uploading" &&
      upload.uploadLeaseExpiresAt !== undefined &&
      upload.uploadLeaseExpiresAt > now
    ) {
      continue;
    }
    if (
      upload.sourceStorageId !== undefined &&
      upload.sourceDeletedAt === undefined
    ) {
      await cleanupHeadshotSource(ctx, upload._id, upload.sourceStorageId);
      upload = (await ctx.db.get("headshotUploads", upload._id)) ?? upload;
    }
    if (upload.status === "deleted" || upload.status === "retained") continue;
    if (upload.quotaState === "indeterminate") continue;
    if (
      upload.storageAttemptStartedAt !== undefined &&
      (upload.sourceStorageId === undefined ||
        (upload.outputStoreStartedAt !== undefined &&
          upload.storageId === undefined &&
          upload.outputKnownDeletedAt === undefined))
    ) {
      await markHeadshotAttemptIndeterminate(ctx, upload);
      cleaned += 1;
      continue;
    }
    if (upload.storageId === undefined) {
      await releaseHeadshotReservation(ctx, upload);
      await ctx.db.patch("headshotUploads", upload._id, {
        status: "discarded",
      });
    } else {
      const result = await deleteOwnedHeadshotIfUnreferenced(
        ctx,
        upload,
        flexible,
      );
      await recordHeadshotCleanupResult(ctx, upload, result, now);
    }
    cleaned += 1;
  }
  return cleaned;
}

export async function cleanupReplacedHeadshot(
  ctx: MutationCtx,
  uploadId: Id<"headshotUploads">,
): Promise<void> {
  const upload = await ctx.db.get("headshotUploads", uploadId);
  if (upload === null || upload.status !== "replaced") return;
  const result = await deleteOwnedHeadshotIfUnreferenced(ctx, upload);
  await recordHeadshotCleanupResult(ctx, upload, result, Date.now());
}

export type RosterRow = {
  eventContactId: Id<"eventContacts">;
  firstName: string;
  lastName: string;
  email?: string;
  tagline?: string;
  jobTitle?: string;
  company?: string;
  bio?: string;
  links?: {
    website?: string;
    twitter?: string;
    linkedin?: string;
    github?: string;
  };
  headshotUrl: string | null;
  claimed: boolean;
  customValues: Record<string, string | string[]>;
  sessions: Array<{
    sessionId: Id<"sessions">;
    title: string;
    state: Doc<"sessionParticipants">["state"];
  }>;
};

/** Every speaker snapshot on the event with their session links. */
export async function roster(
  ctx: QueryCtx,
  caller: EventCaller,
  search?: string,
): Promise<RosterRow[]> {
  requireOrganizer(caller);
  const contacts = await ctx.db
    .query("eventContacts")
    .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
    .take(ROSTER_SCAN);
  const participants = await ctx.db
    .query("sessionParticipants")
    .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
    .take(ROSTER_SCAN);
  const sessionTitles = new Map<Id<"sessions">, string>();
  const byContact = new Map<Id<"eventContacts">, RosterRow["sessions"]>();
  for (const participant of participants) {
    let title = sessionTitles.get(participant.sessionId);
    if (title === undefined) {
      const session = await ctx.db.get("sessions", participant.sessionId);
      title = session?.title ?? "(deleted session)";
      sessionTitles.set(participant.sessionId, title);
    }
    const list = byContact.get(participant.eventContactId) ?? [];
    list.push({
      sessionId: participant.sessionId,
      title,
      state: participant.state,
    });
    byContact.set(participant.eventContactId, list);
  }

  const needle = search?.trim().toLowerCase() ?? "";
  const rows: RosterRow[] = [];
  for (const contact of contacts) {
    if (needle !== "") {
      const haystack = [
        contact.firstName,
        contact.lastName,
        contact.email ?? "",
        contact.tagline ?? "",
        contact.jobTitle ?? "",
        contact.company ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    rows.push({
      eventContactId: contact._id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      tagline: contact.tagline,
      jobTitle: contact.jobTitle,
      company: contact.company,
      bio: contact.bio,
      links: contact.links,
      headshotUrl:
        contact.headshotId === undefined
          ? null
          : await ctx.storage.getUrl(contact.headshotId),
      claimed: contact.userId !== undefined,
      customValues: contact.customValues ?? {},
      sessions: byContact.get(contact._id) ?? [],
    });
  }
  return rows.sort((a, b) =>
    `${a.lastName} ${a.firstName}`.localeCompare(
      `${b.lastName} ${b.firstName}`,
    ),
  );
}

function optionalTrimmed(
  value: string | undefined,
  label: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = assertText(value, { label, max, min: 0 });
  return trimmed.length > 0 ? trimmed : undefined;
}

function blankProfileText(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

export type SpeakerProfilePatch = {
  firstName?: string;
  lastName?: string;
  email?: string;
  tagline?: string;
  jobTitle?: string;
  company?: string;
  bio?: string;
  headshotId?: Id<"_storage">;
  links?: {
    website?: string;
    twitter?: string;
    linkedin?: string;
    github?: string;
  };
};

async function requireEventContact(
  ctx: QueryCtx,
  caller: EventCaller,
  eventContactId: Id<"eventContacts">,
): Promise<Doc<"eventContacts">> {
  const contact = await ctx.db.get("eventContacts", eventContactId);
  if (contact === null || contact.eventId !== caller.event._id) {
    notFound("speaker", "No such speaker on this event.");
  }
  return contact;
}

function uploadScopeFor(
  caller: EventCaller,
  eventContactId: Id<"eventContacts">,
): HeadshotUploadScope {
  return {
    orgId: caller.org._id,
    eventId: caller.event._id,
    eventContactId,
    actorUserId: caller.user._id,
  };
}

/** Mark a previous securely-uploaded photo as replaced, then clean it in an
 * isolated mutation after every profile reference has moved. The cleanup uses
 * exact lookups plus the conservative flexible-reference scan. */
export async function retireReplacedHeadshot(
  ctx: MutationCtx,
  eventContactId: Id<"eventContacts">,
  previousId: Id<"_storage"> | undefined,
  replacementId: Id<"_storage"> | undefined,
): Promise<void> {
  if (previousId === undefined || previousId === replacementId) return;
  const ownership = await ctx.db
    .query("headshotUploads")
    .withIndex("by_storageId", (q) => q.eq("storageId", previousId))
    .unique();
  if (
    ownership === null ||
    ownership.eventContactId !== eventContactId ||
    ownership.status !== "attached"
  ) {
    return;
  }
  const now = Date.now();
  await ctx.db.patch("headshotUploads", ownership._id, {
    status: "replaced",
    replacedAt: now,
  });
  await ctx.scheduler.runAfter(
    0,
    internal.headshotUploads.cleanupReplacement,
    { uploadId: ownership._id },
  );
}

/** Organizer edit of a speaker's event snapshot (CNT-10). Also refreshes the
 * org directory profile when the snapshot is linked, mirroring the portal's
 * own edit semantics — and the published program follows (W4). */
export async function updateSpeakerProfile(
  ctx: MutationCtx,
  caller: EventCaller,
  eventContactId: Id<"eventContacts">,
  patch: SpeakerProfilePatch,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const contact = await requireEventContact(ctx, caller, eventContactId);

  const update: Partial<Doc<"eventContacts">> = {};
  if (patch.firstName !== undefined) {
    update.firstName = assertText(patch.firstName, {
      label: "First name",
      max: 80,
    });
  }
  if (patch.lastName !== undefined) {
    update.lastName = assertText(patch.lastName, {
      label: "Last name",
      max: 80,
      min: 0,
    });
  }
  if (patch.email !== undefined) {
    const trimmed = patch.email.trim();
    if (trimmed === "") {
      update.email = undefined;
    } else {
      if (!isEmail(trimmed)) {
        throw new ConvexError({
          code: "invalid_email",
          message: "That doesn't look like an email address.",
        });
      }
      update.email = normalizeEmail(trimmed);
    }
  }
  if (patch.tagline !== undefined)
    update.tagline = optionalTrimmed(patch.tagline, "Tagline", 200);
  if (patch.jobTitle !== undefined)
    update.jobTitle = optionalTrimmed(patch.jobTitle, "Job title", 120);
  if (patch.company !== undefined)
    update.company = optionalTrimmed(patch.company, "Company", 120);
  if (patch.bio !== undefined)
    update.bio = optionalTrimmed(patch.bio, "Bio", 4000);
  if (patch.headshotId !== undefined) {
    // A new raw storage id must never enter through the general profile API.
    // Upload + registration + attach is the only transition; resubmitting the
    // already-attached id from an open form remains idempotent.
    if (patch.headshotId !== contact.headshotId) {
      invalidHeadshot("Upload that photo before saving the speaker profile.");
    }
    update.headshotId = patch.headshotId;
  }
  if (patch.links !== undefined) {
    update.links = {
      website: optionalHttpUrl(patch.links.website, "Website"),
      twitter: optionalHttpUrl(patch.links.twitter, "Twitter"),
      linkedin: optionalHttpUrl(patch.links.linkedin, "LinkedIn"),
      github: optionalHttpUrl(patch.links.github, "GitHub"),
    };
  }

  await ctx.db.patch("eventContacts", contact._id, update);
  if (contact.contactId !== undefined) {
    // Only the shared profile fields cross into the org directory row.
    const {
      firstName,
      lastName,
      email,
      tagline,
      jobTitle,
      company,
      bio,
      headshotId,
      links,
    } = update;
    await ctx.db.patch("contacts", contact.contactId, {
      ...(firstName !== undefined ? { firstName } : {}),
      ...(lastName !== undefined ? { lastName } : {}),
      ...("email" in patch ? { email } : {}),
      ...("tagline" in patch ? { tagline } : {}),
      ...("jobTitle" in patch ? { jobTitle } : {}),
      ...("company" in patch ? { company } : {}),
      ...("bio" in patch ? { bio } : {}),
      ...(headshotId !== undefined ? { headshotId } : {}),
      ...(links !== undefined ? { links } : {}),
    });
  }
  await Tasks.recomputeProfileEvidence(ctx, contact._id);
  // Profile data can grow the one-document public projection. Rebuild inline
  // so an oversize profile edit is refused atomically instead of committing a
  // private/public divergence and failing later in a scheduled job.
  await Publish.republishIfPublished(ctx, caller.event._id);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "speakers.updateProfile",
    targetType: "eventContact",
    targetId: contact._id,
    meta: { fields: Object.keys(update) },
  });
}

/** Apply a ready, bound upload to an already-authorized event snapshot. Both
 * the organizer and portal entry points delegate here after proving their own
 * access, so storage validation and replacement cleanup cannot drift. */
export async function attachRegisteredHeadshot(
  ctx: MutationCtx,
  scope: HeadshotUploadScope,
  event: Doc<"events">,
  contact: Doc<"eventContacts">,
  uploadId: Id<"headshotUploads">,
  auditAction: "speakers.attachHeadshot" | "portal.attachHeadshot",
): Promise<void> {
  if (
    event._id !== scope.eventId ||
    event.orgId !== scope.orgId ||
    contact._id !== scope.eventContactId ||
    contact.eventId !== event._id
  ) {
    notFound("headshot upload", "No such headshot upload.");
  }
  assertEventActive(event);
  const upload = await requireHeadshotUpload(ctx, scope, uploadId);
  if (
    upload.status === "attached" &&
    upload.storageId !== undefined &&
    contact.headshotId === upload.storageId
  ) {
    return;
  }
  if (upload.status !== "ready" || upload.storageId === undefined) {
    invalidHeadshot("That headshot upload is not ready to attach.");
  }
  if (upload.serverStoredAt === undefined) {
    invalidHeadshot("That photo did not come through the secure upload path.");
  }
  if (upload.expiresAt <= Date.now()) {
    invalidHeadshot("That headshot upload expired. Choose the photo again.");
  }
  const metadata = await ctx.db.system.get(upload.storageId);
  if (
    metadata === null ||
    upload.sanitizedContentType === undefined ||
    upload.sanitizedContentType !== "image/webp" ||
    upload.sanitizedSize === undefined ||
    upload.width === undefined ||
    upload.height === undefined ||
    supportedHeadshotType(metadata.contentType) !==
      upload.sanitizedContentType ||
    metadata.contentType?.trim().toLowerCase() !==
      upload.sanitizedContentType ||
    metadata.size !== upload.sanitizedSize ||
    metadata.size > MAX_HEADSHOT_BYTES ||
    upload.reservedBytes !== upload.sanitizedSize ||
    upload.reservedBlobCount !== 1 ||
    upload.quotaState !== "reconciled"
  ) {
    invalidHeadshot("The uploaded photo changed before it could be attached.");
  }

  const previousId = contact.headshotId;
  await ctx.db.patch("eventContacts", contact._id, {
    headshotId: upload.storageId,
  });
  if (contact.contactId !== undefined) {
    await ctx.db.patch("contacts", contact.contactId, {
      headshotId: upload.storageId,
    });
  }
  await Tasks.recomputeProfileEvidence(ctx, contact._id);
  await Publish.republishIfPublished(ctx, event._id);
  await ctx.db.patch("headshotUploads", upload._id, {
    status: "attached",
    attachedAt: Date.now(),
  });
  await retireReplacedHeadshot(ctx, contact._id, previousId, upload.storageId);
  await logAudit(ctx, {
    orgId: scope.orgId,
    eventId: event._id,
    actorUserId: scope.actorUserId,
    action: auditAction,
    targetType: "eventContact",
    targetId: contact._id,
    meta: { refreshedDirectory: contact.contactId !== undefined },
  });
}

/** Persist a just-uploaded organizer headshot immediately. This deliberately
 * does not submit the rest of the open form, so unsaved text stays untouched. */
export async function attachHeadshot(
  ctx: MutationCtx,
  caller: EventCaller,
  eventContactId: Id<"eventContacts">,
  uploadId: Id<"headshotUploads">,
): Promise<void> {
  requireOrganizer(caller);
  const contact = await requireEventContact(ctx, caller, eventContactId);
  await attachRegisteredHeadshot(
    ctx,
    uploadScopeFor(caller, eventContactId),
    caller.event,
    contact,
    uploadId,
    "speakers.attachHeadshot",
  );
}

export async function beginOrganizerHeadshotUpload(
  ctx: MutationCtx,
  caller: EventCaller,
  eventContactId: Id<"eventContacts">,
  intent: { contentType: string; size: number },
): Promise<{ uploadId: Id<"headshotUploads"> }> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  await requireEventContact(ctx, caller, eventContactId);
  return await beginHeadshotUpload(
    ctx,
    uploadScopeFor(caller, eventContactId),
    intent,
  );
}

export async function discardOrganizerHeadshotUpload(
  ctx: MutationCtx,
  caller: EventCaller,
  eventContactId: Id<"eventContacts">,
  uploadId: Id<"headshotUploads">,
): Promise<void> {
  requireOrganizer(caller);
  await discardHeadshotUpload(
    ctx,
    uploadScopeFor(caller, eventContactId),
    uploadId,
  );
}

/** Speaker-scoped custom-field values (SPK-15): validated against the
 * event's customFields definitions (appliesTo "speaker"). */
export async function setCustomValues(
  ctx: MutationCtx,
  caller: EventCaller,
  eventContactId: Id<"eventContacts">,
  values: Record<string, string | string[]>,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const contact = await requireEventContact(ctx, caller, eventContactId);
  const defs = await ctx.db
    .query("customFields")
    .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
    .take(200);
  const speakerFields = new Map(
    defs
      .filter((d) => d.appliesTo === "speaker")
      .map((d) => [d._id as string, d]),
  );
  const cleaned: Record<string, string | string[]> = {};
  for (const [key, raw] of Object.entries(values)) {
    const def = speakerFields.get(key);
    if (def === undefined) {
      throw new ConvexError({
        code: "invalid_field",
        message: "A value targets a field that isn't a speaker field here.",
      });
    }
    if (def.kind === "multiselect") {
      if (!Array.isArray(raw)) {
        throw new ConvexError({
          code: "invalid_value",
          message: `"${def.name}" takes a list of options.`,
        });
      }
      const bad = raw.find((o) => !(def.options ?? []).includes(o));
      if (bad !== undefined) {
        throw new ConvexError({
          code: "invalid_value",
          message: `"${bad}" isn't an option of "${def.name}".`,
        });
      }
      if (raw.length > 0) cleaned[key] = raw;
      continue;
    }
    if (Array.isArray(raw)) {
      throw new ConvexError({
        code: "invalid_value",
        message: `"${def.name}" takes a single value.`,
      });
    }
    const text = raw.trim();
    if (text === "") continue; // cleared
    if (def.kind === "select" && !(def.options ?? []).includes(text)) {
      throw new ConvexError({
        code: "invalid_value",
        message: `"${text}" isn't an option of "${def.name}".`,
      });
    }
    if (def.kind === "number" && Number.isNaN(Number(text))) {
      throw new ConvexError({
        code: "invalid_value",
        message: `"${def.name}" takes a number.`,
      });
    }
    if (def.kind === "url") {
      const url = optionalHttpUrl(text, def.name);
      if (url !== undefined) cleaned[key] = url;
      continue;
    }
    cleaned[key] = text.slice(0, 2000);
  }
  await ctx.db.patch("eventContacts", contact._id, { customValues: cleaned });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "speakers.setCustomValues",
    targetType: "eventContact",
    targetId: contact._id,
    meta: { fields: Object.keys(cleaned) },
  });
}

export type ImportRow = {
  firstName: string;
  lastName: string;
  email?: string;
  tagline?: string;
  jobTitle?: string;
  company?: string;
  bio?: string;
};

export type ImportResult = {
  created: number;
  merged: number;
  skipped: Array<{ row: number; reason: string }>;
};

/**
 * Deterministic CSV import (SPK-03): the web client parses + column-maps the
 * file and sends clean rows; this dedupes by email against the event roster
 * (merge = fill blank fields only, never overwrite) and creates snapshots
 * for the rest. The AI import agent remains the richer path; this one is the
 * predictable one.
 */
export async function importRows(
  ctx: MutationCtx,
  caller: EventCaller,
  rows: ImportRow[],
): Promise<ImportResult> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  if (rows.length === 0 || rows.length > MAX_IMPORT_ROWS) {
    throw new ConvexError({
      code: "invalid_import",
      message: `Import between 1 and ${MAX_IMPORT_ROWS} rows at a time.`,
    });
  }
  let created = 0;
  let merged = 0;
  let changedProfile = false;
  const skipped: ImportResult["skipped"] = [];
  const seenInFile = new Set<string>();
  for (const [index, raw] of rows.entries()) {
    const firstName = raw.firstName.trim();
    const lastName = raw.lastName.trim();
    if (firstName === "" && lastName === "") {
      skipped.push({ row: index + 1, reason: "No name." });
      continue;
    }
    let email: string | undefined;
    const rawEmail = raw.email?.trim();
    if (rawEmail !== undefined && rawEmail !== "") {
      if (!isEmail(rawEmail)) {
        skipped.push({
          row: index + 1,
          reason: `Invalid email "${rawEmail}".`,
        });
        continue;
      }
      email = normalizeEmail(rawEmail);
      if (seenInFile.has(email)) {
        skipped.push({
          row: index + 1,
          reason: `Duplicate of an earlier row (${email}).`,
        });
        continue;
      }
      seenInFile.add(email);
    }
    const fields = {
      tagline: optionalTrimmed(raw.tagline, "Tagline", 200),
      jobTitle: optionalTrimmed(raw.jobTitle, "Job title", 120),
      company: optionalTrimmed(raw.company, "Company", 120),
      bio: optionalTrimmed(raw.bio, "Bio", 4000),
    };
    const matches =
      email === undefined
        ? []
        : await ctx.db
            .query("eventContacts")
            .withIndex("by_eventId_and_email", (q) =>
              q.eq("eventId", caller.event._id).eq("email", email),
            )
            .take(2);
    if (matches.length > 1) {
      skipped.push({
        row: index + 1,
        reason: `More than one existing speaker uses ${email}; merge them manually first.`,
      });
      continue;
    }
    const match = matches[0];
    if (match !== undefined) {
      // The event snapshot is historical event data: CSV only fills blanks.
      // The linked org directory may have been edited more recently, so it is
      // refreshed only where it is itself blank.
      const patch: {
        tagline?: string;
        jobTitle?: string;
        company?: string;
        bio?: string;
      } = {};
      if (blankProfileText(match.tagline) && fields.tagline !== undefined)
        patch.tagline = fields.tagline;
      if (blankProfileText(match.jobTitle) && fields.jobTitle !== undefined)
        patch.jobTitle = fields.jobTitle;
      if (blankProfileText(match.company) && fields.company !== undefined)
        patch.company = fields.company;
      if (blankProfileText(match.bio) && fields.bio !== undefined)
        patch.bio = fields.bio;
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch("eventContacts", match._id, patch);
      }
      if (match.contactId !== undefined) {
        const directory = await ctx.db.get("contacts", match.contactId);
        if (directory !== null) {
          const effective = {
            tagline: patch.tagline ?? match.tagline,
            jobTitle: patch.jobTitle ?? match.jobTitle,
            company: patch.company ?? match.company,
            bio: patch.bio ?? match.bio,
          };
          const directoryPatch: typeof patch = {};
          if (
            blankProfileText(directory.tagline) &&
            !blankProfileText(effective.tagline)
          ) {
            directoryPatch.tagline = effective.tagline;
          }
          if (
            blankProfileText(directory.jobTitle) &&
            !blankProfileText(effective.jobTitle)
          ) {
            directoryPatch.jobTitle = effective.jobTitle;
          }
          if (
            blankProfileText(directory.company) &&
            !blankProfileText(effective.company)
          ) {
            directoryPatch.company = effective.company;
          }
          if (
            blankProfileText(directory.bio) &&
            !blankProfileText(effective.bio)
          ) {
            directoryPatch.bio = effective.bio;
          }
          if (Object.keys(directoryPatch).length > 0) {
            await ctx.db.patch("contacts", directory._id, directoryPatch);
          }
        }
      }
      await Tasks.recomputeProfileEvidence(ctx, match._id);
      changedProfile = true;
      merged += 1;
      continue;
    }
    await ctx.db.insert("eventContacts", {
      eventId: caller.event._id,
      orgId: caller.org._id,
      firstName: assertText(firstName === "" ? lastName : firstName, {
        label: "First name",
        max: 80,
      }),
      lastName: firstName === "" ? "" : lastName.slice(0, 80),
      email,
      ...fields,
    });
    created += 1;
  }
  if (changedProfile) {
    // Existing roster rows may already be published. Keep their directory,
    // readiness evidence and public projection in the same transaction as the
    // deterministic merge so CSV import cannot report success over stale data.
    await Publish.republishIfPublished(ctx, caller.event._id);
  }
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "speakers.import",
    targetType: "event",
    targetId: caller.event._id,
    meta: { created, merged, skipped: skipped.length, rows: rows.length },
  });
  return { created, merged, skipped };
}
