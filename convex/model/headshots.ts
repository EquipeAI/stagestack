import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { notFound } from "../lib/functions";
import {
  HEADSHOT_FAILURE_MESSAGES,
  MAX_HEADSHOT_BYTES,
  MAX_HEADSHOT_SOURCE_BYTES,
  supportedHeadshotType,
} from "./headshotImages";
import type { HeadshotFailureCode } from "./headshotImages";

// ─────────────────────────────────────────────────────────────────────────
// Headshot uploads: tickets, storage accounting, and cleanup — moved verbatim
// out of `model/speakers.ts`, whose roster header still describes the speaker
// surfaces these tickets feed. The organizer- and portal-side entry points
// that attach a finished headshot to a speaker profile stayed there, because
// they are profile writes; everything about owning, reserving, claiming and
// reclaiming the blob itself lives here.
// ─────────────────────────────────────────────────────────────────────────

/** One named failure, as a result rather than a throw: these boundaries report
 * refusals to the HTTP action, which re-raises them by CODE. The sentence is
 * looked up so no copy of it lives here. */
function headshotFailureResult(code: HeadshotFailureCode): {
  code: HeadshotFailureCode;
  message: string;
} {
  return { code, message: HEADSHOT_FAILURE_MESSAGES[code] };
}

const HEADSHOT_UPLOAD_TTL_MS = 60 * 60 * 1000;
const HEADSHOT_UPLOAD_LEASE_MS = 15 * 60 * 1000;
const HEADSHOT_REFERENCE_SCAN = 1000;
const HEADSHOT_CLEANUP_RETRY_MS = 24 * 60 * 60 * 1000;
const MAX_HEADSHOT_FILENAME = 300;
export const MAX_HEADSHOT_STORED_BYTES_PER_USER = 50 * 1024 * 1024;
export const MAX_HEADSHOT_STORED_TICKETS_PER_USER = 50;
export const MAX_HEADSHOT_STORED_BYTES_PER_USER_GLOBAL = 50 * 1024 * 1024;
export const MAX_HEADSHOT_STORED_TICKETS_PER_USER_GLOBAL = 50;
export const MAX_HEADSHOT_STORED_BYTES_PER_ORG = 500 * 1024 * 1024;
export const MAX_HEADSHOT_STORED_TICKETS_PER_ORG = 500;
export const HEADSHOT_ATTEMPT_RESERVED_BYTES =
  MAX_HEADSHOT_SOURCE_BYTES + MAX_HEADSHOT_BYTES;
export const HEADSHOT_ATTEMPT_RESERVED_BLOBS = 2;

export function invalidHeadshot(message: string): never {
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
  code?: HeadshotFailureCode;
  message?: string;
};

export type HeadshotSourceDetails = {
  processable: boolean;
  code?: HeadshotFailureCode;
  message?: string;
  contentType?: string;
  size?: number;
};

function cleanHeadshotFilename(
  filename: string | undefined,
): string | undefined {
  if (filename === undefined) return undefined;
  const cleaned = filename.normalize("NFKC").trim();
  if (
    cleaned.length === 0 ||
    cleaned.length > MAX_HEADSHOT_FILENAME ||
    cleaned === "." ||
    cleaned === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(cleaned)
  ) {
    invalidHeadshot("The photo filename must be a safe basename.");
  }
  return cleaned;
}

function cleanHeadshotIntent(
  contentType: string,
  size: number,
  filename?: string,
) {
  const normalizedType = supportedHeadshotType(contentType);
  if (normalizedType === null)
    invalidHeadshot("Choose a JPEG, PNG, or WebP image for the headshot.");
  if (!Number.isSafeInteger(size) || size <= 0) {
    invalidHeadshot("The selected image is empty or has an invalid size.");
  }
  if (size > MAX_HEADSHOT_SOURCE_BYTES) {
    invalidHeadshot("Source headshots must be 4 MB or smaller.");
  }
  return {
    contentType: normalizedType,
    size,
    filename: cleanHeadshotFilename(filename),
  };
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

export async function requireHeadshotUpload(
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
  "unreferenced" | "referenced" | "retryableAmbiguous" | "ambiguous";

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
  const currentBlobCount =
    upload.reservedBlobCount ?? (currentBytes > 0 ? 1 : 0);
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
  code?: HeadshotFailureCode;
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
    return { reserved: false, ...headshotFailureResult("lease_expired") };
  }
  if (upload.storageAttemptStartedAt !== undefined) {
    return upload.quotaState === "conservative" &&
      upload.reservedBytes === HEADSHOT_ATTEMPT_RESERVED_BYTES &&
      upload.reservedBlobCount === HEADSHOT_ATTEMPT_RESERVED_BLOBS
      ? { reserved: true }
      : {
          reserved: false,
          ...headshotFailureResult("storage_attempt_in_progress"),
        };
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
      ...headshotFailureResult("storage_quota_reached"),
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
  "deleted" | "referenced" | "retryableAmbiguous" | "ambiguous" | "unowned";

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
  intent: { contentType: string; size: number; filename?: string },
): Promise<{ uploadId: Id<"headshotUploads"> }> {
  const cleaned = cleanHeadshotIntent(
    intent.contentType,
    intent.size,
    intent.filename,
  );
  const now = Date.now();
  const uploadId = await ctx.db.insert("headshotUploads", {
    orgId: scope.orgId,
    eventId: scope.eventId,
    eventContactId: scope.eventContactId,
    uploadedByUserId: scope.actorUserId,
    purpose: "speakerHeadshot",
    expectedContentType: cleaned.contentType,
    expectedSize: cleaned.size,
    originalFilename: cleaned.filename,
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
    return { recorded: false, ...headshotFailureResult("lease_expired") };
  }
  if (upload.sourceStorageId !== undefined) {
    return upload.sourceStorageId === sourceStorageId
      ? {
          recorded: upload.sourceDeletedAt === undefined,
          ...(upload.sourceDeletedAt === undefined
            ? {}
            : headshotFailureResult("source_already_deleted")),
        }
      : {
          recorded: false,
          ...headshotFailureResult("source_already_recorded"),
        };
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
    return { recorded: false, ...headshotFailureResult("lease_expired") };
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
    return { processable: false, ...headshotFailureResult("lease_expired") };
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
  if (upload === null || upload.sourceStorageId !== sourceStorageId) {
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
