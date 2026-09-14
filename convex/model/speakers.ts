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
import { MAX_HEADSHOT_BYTES, supportedHeadshotType } from "./headshotImages";
// Headshot upload tickets, storage accounting and cleanup moved verbatim to
// `./headshots`. The four entry points below are what the profile writes in
// this file still need; the rest of that module is re-exported at the bottom
// because `convex/headshotUploads.ts`, `model/portal.ts` and the speaker tests
// reach it through `Speakers.*`.
import {
  beginHeadshotUpload,
  discardHeadshotUpload,
  invalidHeadshot,
  requireHeadshotUpload,
} from "./headshots";
import type { HeadshotUploadScope } from "./headshots";

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
export const MAX_SPEAKER_CUSTOM_VALUES_BYTES = 32 * 1024;

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
  await ctx.scheduler.runAfter(0, internal.headshotUploads.cleanupReplacement, {
    uploadId: ownership._id,
  });
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
  intent: { contentType: string; size: number; filename?: string },
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
  const encodedBytes = new TextEncoder().encode(JSON.stringify(cleaned)).length;
  if (encodedBytes > MAX_SPEAKER_CUSTOM_VALUES_BYTES) {
    throw new ConvexError({
      code: "custom_values_too_large",
      message: `Speaker custom values must use at most ${MAX_SPEAKER_CUSTOM_VALUES_BYTES / 1024} KiB in total.`,
    });
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

export {
  beginHeadshotUpload,
  discardHeadshotUpload,
  beginHeadshotStorageAttempt,
  markHeadshotOutputStoreStarted,
  markHeadshotOutputKnownDeleted,
  claimHeadshotHttpUpload,
  recordHeadshotSource,
  headshotSourceDetails,
  cleanupHeadshotSource,
  retainIndeterminateHeadshotAttempt,
  releaseKnownCleanHeadshotAttempt,
  completeHeadshotHttpUpload,
  failHeadshotHttpUpload,
  cleanupExpiredHeadshotUploads,
  cleanupReplacedHeadshot,
  MAX_HEADSHOT_STORED_BYTES_PER_USER,
  MAX_HEADSHOT_STORED_TICKETS_PER_USER,
  MAX_HEADSHOT_STORED_BYTES_PER_USER_GLOBAL,
  MAX_HEADSHOT_STORED_TICKETS_PER_USER_GLOBAL,
  MAX_HEADSHOT_STORED_BYTES_PER_ORG,
  MAX_HEADSHOT_STORED_TICKETS_PER_ORG,
  HEADSHOT_ATTEMPT_RESERVED_BYTES,
  HEADSHOT_ATTEMPT_RESERVED_BLOBS,
} from "./headshots";
export type {
  HeadshotUploadScope,
  HeadshotUploadClaim,
  HeadshotSourceRegistration,
  HeadshotSourceDetails,
  HeadshotStorageReservation,
} from "./headshots";
