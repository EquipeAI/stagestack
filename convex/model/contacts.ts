import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { OrgCaller } from "../lib/functions";
import { forbidden, notFound, requireOrgAdmin } from "../lib/functions";
import { logAudit } from "./audit";
import { assertText, normalizeEmail } from "./validation";
import { emailShell, escapeHtml, sendLoggedEmail } from "./comms";
import {
  OUTREACH_AUDIENCE_MESSAGE,
  OUTREACH_MAX,
  OUTREACH_MIN,
  canReceiveOutreach,
} from "../shared/bulkOutreach";

// Org contact directory (M0): current reusable profiles. Event snapshots are
// copied from these when a contact joins an event (M2+); snapshots never
// change automatically.

const DIRECTORY_SCAN = 1000;

export type ContactProfileInput = {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
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

/** Directory writes: org owner/admin or an organizer of any event in the org
 * (they need it to add speakers/contacts to their events). */
export function requireDirectoryAccess(caller: OrgCaller): void {
  if (caller.orgRole === null && !caller.organizesEvents) {
    forbidden("Only organizers can manage the contact directory.");
  }
}

function validateProfile(input: ContactProfileInput): ContactProfileInput {
  const firstName = assertText(input.firstName, {
    label: "First name",
    max: 80,
  });
  // Last name is optional on a contact — bounded, but may be blank.
  const lastName = assertText(input.lastName, {
    label: "Last name",
    max: 80,
    min: 0,
  });
  const rawEmail = input.email?.trim();
  const email =
    rawEmail !== undefined && rawEmail.length > 0
      ? normalizeEmail(rawEmail)
      : undefined;
  const optionalText = (
    value: string | undefined,
    label: string,
    max: number,
  ) => {
    const trimmed = value?.trim();
    return trimmed ? assertText(trimmed, { label, max }) : undefined;
  };
  const links = input.links
    ? {
        website: optionalText(input.links.website, "Website", 500),
        twitter: optionalText(input.links.twitter, "Twitter URL", 500),
        linkedin: optionalText(input.links.linkedin, "LinkedIn URL", 500),
        github: optionalText(input.links.github, "GitHub URL", 500),
      }
    : undefined;
  return {
    firstName,
    lastName,
    email,
    phone: optionalText(input.phone, "Phone", 80),
    tagline: optionalText(input.tagline, "Tagline", 200),
    jobTitle: optionalText(input.jobTitle, "Job title", 120),
    company: optionalText(input.company, "Company", 160),
    bio: optionalText(input.bio, "Bio", 10_000),
    headshotId: input.headshotId,
    links,
  };
}

export async function listContacts(
  ctx: QueryCtx,
  caller: OrgCaller,
  search?: string,
): Promise<Array<Doc<"contacts">>> {
  requireDirectoryAccess(caller);
  const rows = await ctx.db
    .query("contacts")
    .withIndex("by_orgId", (q) => q.eq("orgId", caller.org._id))
    .take(DIRECTORY_SCAN + 1);
  if (rows.length > DIRECTORY_SCAN) {
    throw new ConvexError({
      code: "directory_too_large",
      message:
        "This directory has more than 1,000 contacts. Narrower server-side pagination is required before it can be managed safely.",
    });
  }
  const all = rows;
  const needle = search?.trim().toLowerCase();
  const filtered = needle
    ? all.filter((c) =>
        [
          c.firstName,
          c.lastName,
          c.email ?? "",
          c.tagline ?? "",
          c.jobTitle ?? "",
          c.company ?? "",
          ...(c.tags ?? []),
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
    : all;
  return filtered.sort((a, b) =>
    `${a.firstName} ${a.lastName}`.localeCompare(
      `${b.firstName} ${b.lastName}`,
    ),
  );
}

export async function createContact(
  ctx: MutationCtx,
  caller: OrgCaller,
  input: ContactProfileInput,
): Promise<Id<"contacts">> {
  requireDirectoryAccess(caller);
  const profile = validateProfile(input);
  if (profile.email !== undefined) {
    const existing = await ctx.db
      .query("contacts")
      .withIndex("by_orgId_and_email", (q) =>
        q.eq("orgId", caller.org._id).eq("email", profile.email),
      )
      .unique();
    if (existing !== null) {
      throw new ConvexError({
        code: "duplicate_email",
        message: "A contact with this email already exists.",
      });
    }
  }
  const id = await ctx.db.insert("contacts", {
    orgId: caller.org._id,
    ...profile,
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    actorUserId: caller.user._id,
    action: "contact.create",
    targetType: "contact",
    targetId: id,
    meta: { name: `${profile.firstName} ${profile.lastName}` },
  });
  return id;
}

export async function updateContact(
  ctx: MutationCtx,
  caller: OrgCaller,
  contactId: Id<"contacts">,
  input: ContactProfileInput,
): Promise<void> {
  requireDirectoryAccess(caller);
  const contact = await ctx.db.get("contacts", contactId);
  if (contact === null || contact.orgId !== caller.org._id) {
    notFound("contact", "No such contact in this organization.");
  }
  const profile = validateProfile(input);
  if (profile.email !== undefined && profile.email !== contact.email) {
    const existing = await ctx.db
      .query("contacts")
      .withIndex("by_orgId_and_email", (q) =>
        q.eq("orgId", caller.org._id).eq("email", profile.email),
      )
      .unique();
    if (existing !== null && existing._id !== contactId) {
      throw new ConvexError({
        code: "duplicate_email",
        message: "A contact with this email already exists.",
      });
    }
  }
  await ctx.db.patch("contacts", contactId, profile);
  await logAudit(ctx, {
    orgId: caller.org._id,
    actorUserId: caller.user._id,
    action: "contact.update",
    targetType: "contact",
    targetId: contactId,
  });
}

// ── Light CRM (W8): tags, notes, history, add-to-event ───────────────────

const MAX_TAGS = 20;
const MAX_NOTE = 4000;
const NOTE_SCAN = 200;
const RELATED_MERGE_LIMIT = 200;
export const CRM_STAGES = [
  "sourced",
  "contacted",
  "shortlisted",
  "confirmed",
  "declined",
] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

export async function requireContact(
  ctx: QueryCtx,
  caller: OrgCaller,
  contactId: Id<"contacts">,
): Promise<Doc<"contacts">> {
  const contact = await ctx.db.get("contacts", contactId);
  if (contact === null || contact.orgId !== caller.org._id) {
    notFound("contact", "No such contact in this organization.");
  }
  return contact;
}

export async function setTags(
  ctx: MutationCtx,
  caller: OrgCaller,
  contactId: Id<"contacts">,
  tags: string[],
): Promise<void> {
  requireDirectoryAccess(caller);
  const contact = await requireContact(ctx, caller, contactId);
  const cleaned = [
    ...new Set(
      tags
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "")
        .map((tag) => assertText(tag, { label: "Tag", max: 60 })),
    ),
  ];
  if (cleaned.length > MAX_TAGS) {
    throw new ConvexError({
      code: "too_many_tags",
      message: `A contact can have at most ${MAX_TAGS} tags.`,
    });
  }
  await ctx.db.patch("contacts", contact._id, {
    tags: cleaned.length === 0 ? undefined : cleaned,
  });
}

export type ContactNoteRow = {
  noteId: Id<"contactNotes">;
  authorName: string | null;
  body: string;
  createdAt: number;
};

export async function addNote(
  ctx: MutationCtx,
  caller: OrgCaller,
  contactId: Id<"contacts">,
  body: string,
): Promise<void> {
  requireDirectoryAccess(caller);
  const contact = await requireContact(ctx, caller, contactId);
  await ctx.db.insert("contactNotes", {
    orgId: caller.org._id,
    contactId: contact._id,
    authorUserId: caller.user._id,
    body: assertText(body, { label: "Note", max: MAX_NOTE }),
    createdAt: Date.now(),
  });
}

export async function listNotes(
  ctx: QueryCtx,
  caller: OrgCaller,
  contactId: Id<"contacts">,
): Promise<ContactNoteRow[]> {
  requireDirectoryAccess(caller);
  await requireContact(ctx, caller, contactId);
  const rows = await ctx.db
    .query("contactNotes")
    .withIndex("by_contactId", (q) => q.eq("contactId", contactId))
    .take(NOTE_SCAN);
  const out: ContactNoteRow[] = [];
  for (const row of rows.sort((a, b) => b.createdAt - a.createdAt)) {
    const author = await ctx.db.get("users", row.authorUserId);
    out.push({
      noteId: row._id,
      authorName: author?.name ?? null,
      body: row.body,
      createdAt: row.createdAt,
    });
  }
  return out;
}

export type ContactConnection = {
  eventId: Id<"events">;
  eventName: string;
  eventSlug: string;
  startsAt: number;
  sessions: Array<{ title: string; state: string }>;
};

/** Cross-event history: every event this contact has a snapshot on, with
 * their sessions and participation states (CRM-03's history surface). */
export async function connections(
  ctx: QueryCtx,
  caller: OrgCaller,
  contactId: Id<"contacts">,
): Promise<ContactConnection[]> {
  requireDirectoryAccess(caller);
  await requireContact(ctx, caller, contactId);
  const snapshots = await ctx.db
    .query("eventContacts")
    .withIndex("by_contactId", (q) => q.eq("contactId", contactId))
    .take(100);
  const out: ContactConnection[] = [];
  for (const snapshot of snapshots) {
    const event = await ctx.db.get("events", snapshot.eventId);
    if (event === null || event.orgId !== caller.org._id) continue;
    const participants = await ctx.db
      .query("sessionParticipants")
      .withIndex("by_eventContactId", (q) =>
        q.eq("eventContactId", snapshot._id),
      )
      .take(100);
    const sessions: ContactConnection["sessions"] = [];
    for (const participant of participants) {
      const session = await ctx.db.get("sessions", participant.sessionId);
      if (session === null) continue;
      sessions.push({ title: session.title, state: participant.state });
    }
    out.push({
      eventId: event._id,
      eventName: event.name,
      eventSlug: event.slug,
      startsAt: event.startsAt,
      sessions,
    });
  }
  return out.sort((a, b) => b.startsAt - a.startsAt);
}

/** Push a directory contact into an event's roster (CRM-10): creates the
 * event snapshot with the profile carried over; dedupes on an existing
 * snapshot for the same contact or email. */
export async function addToEvent(
  ctx: MutationCtx,
  caller: OrgCaller,
  contactId: Id<"contacts">,
  eventId: Id<"events">,
): Promise<{ created: boolean }> {
  requireDirectoryAccess(caller);
  const contact = await requireContact(ctx, caller, contactId);
  const event = await ctx.db.get("events", eventId);
  if (event === null || event.orgId !== caller.org._id) {
    notFound("event", "No such event in this organization.");
  }
  // Directory access alone isn't enough to mutate an event's roster: the
  // caller must be an org owner/admin, or an organizer of THIS event —
  // organizing a sibling event doesn't reach here (codex W8 review).
  if (caller.orgRole === null) {
    const membership = await ctx.db
      .query("eventMembers")
      .withIndex("by_eventId_and_userId", (q) =>
        q.eq("eventId", event._id).eq("userId", caller.user._id),
      )
      .unique();
    if (membership === null || membership.role !== "organizer") {
      forbidden("Only this event's organizers can add contacts to it.");
    }
  }
  if (event.archivedAt !== undefined) {
    throw new ConvexError({
      code: "event_archived",
      message: "This event is archived.",
    });
  }
  const existing = await ctx.db
    .query("eventContacts")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .take(2000);
  const already = existing.some(
    (snapshot) =>
      snapshot.contactId === contact._id ||
      (contact.email !== undefined && snapshot.email === contact.email),
  );
  if (already) return { created: false };
  await ctx.db.insert("eventContacts", {
    eventId,
    orgId: caller.org._id,
    contactId: contact._id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    tagline: contact.tagline,
    jobTitle: contact.jobTitle,
    company: contact.company,
    bio: contact.bio,
    headshotId: contact.headshotId,
    links: contact.links,
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId,
    actorUserId: caller.user._id,
    action: "contacts.addToEvent",
    targetType: "contact",
    targetId: contact._id,
    meta: { eventId },
  });
  return { created: true };
}

// ── Optional speaker CRM ─────────────────────────────────────────────────

export type ImportContactRow = {
  rowNumber: number;
  firstName: string;
  lastName: string;
  email: string;
  company?: string;
  jobTitle?: string;
  bio?: string;
  tags?: string[];
};

export type ImportResult = {
  received: number;
  imported: number;
  skipped: number;
  errors: Array<{ rowNumber: number; message: string }>;
};

export async function importContacts(
  ctx: MutationCtx,
  caller: OrgCaller,
  rows: ImportContactRow[],
): Promise<ImportResult> {
  requireOrgAdmin(caller);
  if (rows.length === 0 || rows.length > 100) {
    throw new ConvexError({
      code: "invalid_batch",
      message: "Import between 1 and 100 rows at a time.",
    });
  }
  const seen = new Set<string>();
  const errors: ImportResult["errors"] = [];
  let imported = 0;
  for (const row of rows) {
    if (!Number.isInteger(row.rowNumber) || row.rowNumber < 1) {
      errors.push({ rowNumber: row.rowNumber, message: "Invalid row number." });
      continue;
    }
    let profile: ContactProfileInput;
    let tags: string[];
    try {
      profile = validateProfile({
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        company: row.company,
        jobTitle: row.jobTitle,
        bio: row.bio,
      });
      const rawTags = [
        ...new Set((row.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
      ];
      if (rawTags.length > MAX_TAGS) {
        throw new ConvexError({
          code: "too_many_tags",
          message: `A contact can have at most ${MAX_TAGS} tags.`,
        });
      }
      tags = rawTags.map((tag) => assertText(tag, { label: "Tag", max: 60 }));
    } catch {
      errors.push({
        rowNumber: row.rowNumber,
        message: "Name, email, or tags are invalid.",
      });
      continue;
    }
    if (profile.email === undefined) {
      errors.push({ rowNumber: row.rowNumber, message: "Email is required." });
      continue;
    }
    if (seen.has(profile.email)) {
      errors.push({
        rowNumber: row.rowNumber,
        message: "Duplicate email in this import batch.",
      });
      continue;
    }
    seen.add(profile.email);
    const existing = await ctx.db
      .query("contacts")
      .withIndex("by_orgId_and_email", (q) =>
        q.eq("orgId", caller.org._id).eq("email", profile.email),
      )
      .unique();
    if (existing !== null) {
      errors.push({
        rowNumber: row.rowNumber,
        message: "A contact with this email already exists.",
      });
      continue;
    }
    await ctx.db.insert("contacts", {
      orgId: caller.org._id,
      ...profile,
      tags: tags.length > 0 ? tags : undefined,
    });
    imported += 1;
  }
  await logAudit(ctx, {
    orgId: caller.org._id,
    actorUserId: caller.user._id,
    action: "contacts.csvImport",
    targetType: "contact",
    meta: { received: rows.length, imported, skipped: rows.length - imported },
  });
  return {
    received: rows.length,
    imported,
    skipped: rows.length - imported,
    errors,
  };
}

function normalizedName(
  contact: Pick<Doc<"contacts">, "firstName" | "lastName">,
): string {
  return `${contact.firstName} ${contact.lastName}`
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en");
}

export type DuplicatePair = {
  primary: Doc<"contacts">;
  secondary: Doc<"contacts">;
};

export async function nearDuplicates(
  ctx: QueryCtx,
  caller: OrgCaller,
): Promise<{ pairs: DuplicatePair[]; scanned: number; capped: boolean }> {
  requireOrgAdmin(caller);
  const rows = await ctx.db
    .query("contacts")
    .withIndex("by_orgId", (q) => q.eq("orgId", caller.org._id))
    .take(DIRECTORY_SCAN + 1);
  const scannedRows = rows.slice(0, DIRECTORY_SCAN);
  const byName = new Map<string, Array<Doc<"contacts">>>();
  for (const row of scannedRows) {
    const key = normalizedName(row);
    byName.set(key, [...(byName.get(key) ?? []), row]);
  }
  const pairs: DuplicatePair[] = [];
  for (const group of byName.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        if ((group[left].email ?? "") !== (group[right].email ?? "")) {
          pairs.push({ primary: group[left], secondary: group[right] });
          if (pairs.length > 100) break;
        }
      }
      if (pairs.length > 100) break;
    }
    if (pairs.length > 100) break;
  }
  return {
    pairs: pairs.slice(0, 100),
    scanned: scannedRows.length,
    capped: rows.length > DIRECTORY_SCAN || pairs.length > 100,
  };
}

function assertMergeBound(rows: unknown[]): void {
  if (rows.length > RELATED_MERGE_LIMIT) {
    throw new ConvexError({
      code: "merge_too_large",
      message:
        "This contact has too much related history to merge safely in one operation.",
    });
  }
}

export async function mergeContacts(
  ctx: MutationCtx,
  caller: OrgCaller,
  primaryId: Id<"contacts">,
  secondaryId: Id<"contacts">,
): Promise<{ rewired: number }> {
  requireOrgAdmin(caller);
  if (primaryId === secondaryId) {
    throw new ConvexError({
      code: "invalid_merge",
      message: "Choose two different contacts.",
    });
  }
  const primary = await requireContact(ctx, caller, primaryId);
  const secondary = await requireContact(ctx, caller, secondaryId);
  if (normalizedName(primary) !== normalizedName(secondary)) {
    throw new ConvexError({
      code: "invalid_merge",
      message: "Only contacts with the same normalized name can be merged.",
    });
  }
  const [notes, snapshots, primarySnapshots, messages, history] =
    await Promise.all([
      ctx.db
        .query("contactNotes")
        .withIndex("by_contactId", (q) => q.eq("contactId", secondaryId))
        .take(RELATED_MERGE_LIMIT + 1),
      ctx.db
        .query("eventContacts")
        .withIndex("by_contactId", (q) => q.eq("contactId", secondaryId))
        .take(RELATED_MERGE_LIMIT + 1),
      ctx.db
        .query("eventContacts")
        .withIndex("by_contactId", (q) => q.eq("contactId", primaryId))
        .take(RELATED_MERGE_LIMIT + 1),
      ctx.db
        .query("messages")
        .withIndex("by_contactId", (q) => q.eq("contactId", secondaryId))
        .take(RELATED_MERGE_LIMIT + 1),
      ctx.db
        .query("contactPipelineHistory")
        .withIndex("by_contactId", (q) => q.eq("contactId", secondaryId))
        .take(RELATED_MERGE_LIMIT + 1),
    ]);
  for (const rows of [notes, snapshots, primarySnapshots, messages, history])
    assertMergeBound(rows);
  const primaryEventIds = new Set(primarySnapshots.map((row) => row.eventId));
  if (snapshots.some((row) => primaryEventIds.has(row.eventId))) {
    throw new ConvexError({
      code: "merge_event_conflict",
      message:
        "Both contacts already have a snapshot on the same event. Resolve that event before merging.",
    });
  }
  const optionalFields = [
    "email",
    "phone",
    "tagline",
    "jobTitle",
    "company",
    "bio",
    "headshotId",
  ] as const;
  const patch: Partial<Doc<"contacts">> = {};
  for (const field of optionalFields) {
    if (primary[field] === undefined && secondary[field] !== undefined) {
      Object.assign(patch, { [field]: secondary[field] });
    }
  }
  const tags = [
    ...new Set([...(primary.tags ?? []), ...(secondary.tags ?? [])]),
  ];
  if (tags.length > MAX_TAGS) {
    throw new ConvexError({
      code: "merge_too_many_tags",
      message: `The merged contact would have more than ${MAX_TAGS} tags.`,
    });
  }
  if (tags.length > 0) patch.tags = tags;
  const links = {
    website: primary.links?.website ?? secondary.links?.website,
    twitter: primary.links?.twitter ?? secondary.links?.twitter,
    linkedin: primary.links?.linkedin ?? secondary.links?.linkedin,
    github: primary.links?.github ?? secondary.links?.github,
  };
  if (Object.values(links).some((value) => value !== undefined)) {
    patch.links = links;
  }
  if (
    primary.pipelineStage === undefined &&
    secondary.pipelineStage !== undefined
  ) {
    patch.pipelineStage = secondary.pipelineStage;
  }
  await ctx.db.patch("contacts", primaryId, patch);
  for (const row of notes)
    await ctx.db.patch("contactNotes", row._id, { contactId: primaryId });
  for (const row of snapshots)
    await ctx.db.patch("eventContacts", row._id, { contactId: primaryId });
  for (const row of messages)
    await ctx.db.patch("messages", row._id, { contactId: primaryId });
  for (const row of history)
    await ctx.db.patch("contactPipelineHistory", row._id, {
      contactId: primaryId,
    });
  await ctx.db.delete("contacts", secondaryId);
  const rewired =
    notes.length + snapshots.length + messages.length + history.length;
  await logAudit(ctx, {
    orgId: caller.org._id,
    actorUserId: caller.user._id,
    action: "contacts.merge",
    targetType: "contact",
    targetId: primaryId,
    meta: { secondaryId, rewired },
  });
  return { rewired };
}

export async function setPipelineStage(
  ctx: MutationCtx,
  caller: OrgCaller,
  contactId: Id<"contacts">,
  stage: CrmStage | null,
): Promise<void> {
  requireOrgAdmin(caller);
  const contact = await requireContact(ctx, caller, contactId);
  const previous = contact.pipelineStage;
  const next = stage ?? undefined;
  if (previous === next) return;
  await ctx.db.patch("contacts", contactId, { pipelineStage: next });
  await ctx.db.insert("contactPipelineHistory", {
    orgId: caller.org._id,
    contactId,
    fromStage: previous,
    toStage: next,
    changedByUserId: caller.user._id,
    changedAt: Date.now(),
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    actorUserId: caller.user._id,
    action:
      stage === null ? "contacts.pipelineUnenroll" : "contacts.pipelineMove",
    targetType: "contact",
    targetId: contactId,
    meta: { fromStage: previous ?? null, toStage: stage },
  });
}

export async function pipelineHistory(
  ctx: QueryCtx,
  caller: OrgCaller,
  contactId: Id<"contacts">,
) {
  requireOrgAdmin(caller);
  await requireContact(ctx, caller, contactId);
  const rows = await ctx.db
    .query("contactPipelineHistory")
    .withIndex("by_contactId", (q) => q.eq("contactId", contactId))
    .order("desc")
    .take(100);
  return await Promise.all(
    rows.map(async (row) => ({
      historyId: row._id,
      fromStage: row.fromStage ?? null,
      toStage: row.toStage ?? null,
      changedAt: row.changedAt,
      changedBy: (await ctx.db.get("users", row.changedByUserId))?.name ?? null,
    })),
  );
}

export type SegmentFilters = {
  search?: string;
  tag?: string;
  company?: string;
};

function validateSegmentFilters(filters: SegmentFilters): SegmentFilters {
  const clean = (value: string | undefined, label: string, max: number) => {
    const trimmed = value?.trim();
    return trimmed ? assertText(trimmed, { label, max }) : undefined;
  };
  return {
    search: clean(filters.search, "Search", 160),
    tag: clean(filters.tag, "Tag", 60),
    company: clean(filters.company, "Company", 160),
  };
}

export async function saveSegment(
  ctx: MutationCtx,
  caller: OrgCaller,
  name: string,
  filters: SegmentFilters,
): Promise<Id<"savedSegments">> {
  requireOrgAdmin(caller);
  const existing = await ctx.db
    .query("savedSegments")
    .withIndex("by_orgId", (q) => q.eq("orgId", caller.org._id))
    .take(101);
  if (existing.length >= 100) {
    throw new ConvexError({
      code: "segment_limit",
      message: "This organization already has 100 saved segments.",
    });
  }
  return await ctx.db.insert("savedSegments", {
    orgId: caller.org._id,
    name: assertText(name, { label: "Segment name", max: 80 }),
    filters: validateSegmentFilters(filters),
    createdByUserId: caller.user._id,
    createdAt: Date.now(),
  });
}

export async function listSegments(ctx: QueryCtx, caller: OrgCaller) {
  requireOrgAdmin(caller);
  return await ctx.db
    .query("savedSegments")
    .withIndex("by_orgId", (q) => q.eq("orgId", caller.org._id))
    .order("desc")
    .take(100);
}

export async function overview(ctx: QueryCtx, caller: OrgCaller) {
  requireOrgAdmin(caller);
  const rows = await ctx.db
    .query("contacts")
    .withIndex("by_orgId", (q) => q.eq("orgId", caller.org._id))
    .take(DIRECTORY_SCAN + 1);
  const contacts = rows.slice(0, DIRECTORY_SCAN);
  const companies = new Map<string, number>();
  for (const contact of contacts) {
    if (contact.company)
      companies.set(contact.company, (companies.get(contact.company) ?? 0) + 1);
  }
  return {
    totalContacts: contacts.length,
    withEmail: contacts.filter((contact) => contact.email !== undefined).length,
    enrolled: contacts.filter((contact) => contact.pipelineStage !== undefined)
      .length,
    capped: rows.length > DIRECTORY_SCAN,
    topCompanies: [...companies.entries()]
      .map(([company, count]) => ({ company, count }))
      .sort((a, b) => b.count - a.count || a.company.localeCompare(b.company))
      .slice(0, 5),
  };
}

function renderMergeTags(template: string, contact: Doc<"contacts">): string {
  const fullName = `${contact.firstName} ${contact.lastName}`.trim();
  return template
    .replaceAll("{{firstName}}", contact.firstName)
    .replaceAll("{{speakerName}}", fullName)
    .replaceAll("{{company}}", contact.company ?? "")
    .replaceAll("{{speaker.firstName}}", contact.firstName)
    .replaceAll("{{speaker.fullName}}", fullName)
    .replaceAll("{{speaker.company}}", contact.company ?? "");
}

export async function outreachHistory(
  ctx: QueryCtx,
  caller: OrgCaller,
  contactId: Id<"contacts">,
) {
  requireOrgAdmin(caller);
  await requireContact(ctx, caller, contactId);
  return (
    await ctx.db
      .query("messages")
      .withIndex("by_contactId_and_kind", (q) =>
        q.eq("contactId", contactId).eq("kind", "crm.bulkOutreach"),
      )
      .order("desc")
      .take(50)
  ).map((message) => ({
    messageId: message._id,
    subject: message.subject,
    toEmail: message.toEmail,
    deliveryStatus: message.deliveryStatus,
    sentAt: message._creationTime,
    ...(message.deliveryUpdatedAt === undefined
      ? {}
      : { deliveryUpdatedAt: message.deliveryUpdatedAt }),
  }));
}

export async function sendBulkOutreach(
  ctx: MutationCtx,
  caller: OrgCaller,
  contactIds: Array<Id<"contacts">>,
  subject: string,
  body: string,
) {
  requireOrgAdmin(caller);
  const uniqueIds = [...new Set(contactIds)];
  // The range and the "no address on file" rule are stated once, in
  // convex/shared/bulkOutreach.ts, so the batch bar can say what this call
  // will do before it is made and reach the same numbers (W12).
  if (uniqueIds.length < OUTREACH_MIN || uniqueIds.length > OUTREACH_MAX) {
    throw new ConvexError({
      code: "invalid_audience",
      message: OUTREACH_AUDIENCE_MESSAGE,
    });
  }
  const cleanSubject = assertText(subject, { label: "Subject", max: 200 });
  const cleanBody = assertText(body, { label: "Message", max: 10_000 });
  const results: Array<{
    contactId: Id<"contacts">;
    status: "queued" | "failed" | "skipped_no_email";
    messageId: Id<"messages"> | null;
  }> = [];
  // Validate the complete audience before crossing the external email
  // boundary. A foreign/missing id late in the selection must not leave an
  // earlier recipient with a queued but rolled-back/unlogged message.
  const contacts = await Promise.all(
    uniqueIds.map((contactId) => requireContact(ctx, caller, contactId)),
  );
  for (const contact of contacts) {
    const contactId = contact._id;
    if (!canReceiveOutreach(contact)) {
      results.push({ contactId, status: "skipped_no_email", messageId: null });
      continue;
    }
    const renderedSubject = renderMergeTags(cleanSubject, contact);
    const renderedBody = renderMergeTags(cleanBody, contact);
    const messageId = await sendLoggedEmail(ctx, {
      orgId: caller.org._id,
      contactId,
      toEmail: contact.email,
      kind: "crm.bulkOutreach",
      subject: renderedSubject,
      html: emailShell(
        `<p style="white-space:pre-wrap">${escapeHtml(renderedBody)}</p>`,
      ),
      sentByUserId: caller.user._id,
      context: {
        source: "crm",
        renderedSubject,
        renderedBody,
      },
    });
    const message = await ctx.db.get("messages", messageId);
    results.push({
      contactId,
      status: message?.deliveryStatus === "failed" ? "failed" : "queued",
      messageId,
    });
  }
  await logAudit(ctx, {
    orgId: caller.org._id,
    actorUserId: caller.user._id,
    action: "contacts.bulkOutreach",
    targetType: "contact",
    meta: {
      selected: uniqueIds.length,
      queued: results.filter((row) => row.status === "queued").length,
      failed: results.filter((row) => row.status === "failed").length,
      skipped: results.filter((row) => row.status === "skipped_no_email")
        .length,
    },
  });
  return {
    selected: uniqueIds.length,
    queued: results.filter((row) => row.status === "queued").length,
    failed: results.filter((row) => row.status === "failed").length,
    skipped: results.filter((row) => row.status === "skipped_no_email").length,
    results,
  };
}
