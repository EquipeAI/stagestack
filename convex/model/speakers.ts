import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import { assertEventActive, assertText, normalizeEmail, isEmail } from "./validation";
import { optionalHttpUrl } from "../lib/urls";
import * as Publish from "./publish";

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

export type RosterRow = {
  eventContactId: Id<"eventContacts">;
  firstName: string;
  lastName: string;
  email?: string;
  tagline?: string;
  jobTitle?: string;
  company?: string;
  bio?: string;
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
    `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`),
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
  if (patch.headshotId !== undefined) update.headshotId = patch.headshotId;
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
  await Publish.requestRebuild(ctx, caller.event._id);
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
    defs.filter((d) => d.appliesTo === "speaker").map((d) => [d._id as string, d]),
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
  const existing = await ctx.db
    .query("eventContacts")
    .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
    .take(ROSTER_SCAN);
  const byEmail = new Map(
    existing
      .filter((c) => c.email !== undefined)
      .map((c) => [c.email as string, c]),
  );

  let created = 0;
  let merged = 0;
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
        skipped.push({ row: index + 1, reason: `Invalid email "${rawEmail}".` });
        continue;
      }
      email = normalizeEmail(rawEmail);
      if (seenInFile.has(email)) {
        skipped.push({ row: index + 1, reason: `Duplicate of an earlier row (${email}).` });
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
    const match = email === undefined ? undefined : byEmail.get(email);
    if (match !== undefined) {
      // Merge: only fill what the roster doesn't already have.
      const patch: Partial<Doc<"eventContacts">> = {};
      if (match.tagline === undefined && fields.tagline !== undefined)
        patch.tagline = fields.tagline;
      if (match.jobTitle === undefined && fields.jobTitle !== undefined)
        patch.jobTitle = fields.jobTitle;
      if (match.company === undefined && fields.company !== undefined)
        patch.company = fields.company;
      if (match.bio === undefined && fields.bio !== undefined)
        patch.bio = fields.bio;
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch("eventContacts", match._id, patch);
      }
      merged += 1;
      continue;
    }
    const id = await ctx.db.insert("eventContacts", {
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
    if (email !== undefined) {
      const inserted = await ctx.db.get("eventContacts", id);
      if (inserted !== null) byEmail.set(email, inserted);
    }
    created += 1;
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
