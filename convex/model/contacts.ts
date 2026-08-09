import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { OrgCaller } from "../lib/functions";
import { forbidden } from "../lib/functions";
import { logAudit } from "./audit";

// Org contact directory (M0): current reusable profiles. Event snapshots are
// copied from these when a contact joins an event (M2+); snapshots never
// change automatically.

export type ContactProfileInput = {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  tagline?: string;
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
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (firstName.length === 0 || firstName.length > 80) {
    throw new ConvexError({
      code: "invalid_name",
      message: "First name must be 1-80 characters.",
    });
  }
  if (lastName.length > 80) {
    throw new ConvexError({
      code: "invalid_name",
      message: "Last name must be at most 80 characters.",
    });
  }
  const email = input.email?.trim().toLowerCase();
  if (email !== undefined && email.length > 0 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ConvexError({
      code: "invalid_email",
      message: "That doesn't look like an email address.",
    });
  }
  return { ...input, firstName, lastName, email: email || undefined };
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
        [c.firstName, c.lastName, c.email ?? "", c.tagline ?? ""]
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
    throw new ConvexError({
      code: "not_found",
      message: "No such contact in this organization.",
    });
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
