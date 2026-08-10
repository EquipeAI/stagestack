import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { OrgCaller } from "../lib/functions";
import { forbidden, notFound } from "../lib/functions";
import { logAudit } from "./audit";
import { assertText, normalizeEmail } from "./validation";

// Org contact directory (M0): current reusable profiles. Event snapshots are
// copied from these when a contact joins an event (M2+); snapshots never
// change automatically.

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
  return { ...input, firstName, lastName, email };
}

export async function listContacts(
  ctx: QueryCtx,
  caller: OrgCaller,
  search?: string,
): Promise<Array<Doc<"contacts">>> {
  requireDirectoryAccess(caller);
  const all = await ctx.db
    .query("contacts")
    .withIndex("by_orgId", (q) => q.eq("orgId", caller.org._id))
    .take(1000);
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
    `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
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
    ...new Set(tags.map((t) => t.trim()).filter((t) => t !== "")),
  ].slice(0, MAX_TAGS);
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
