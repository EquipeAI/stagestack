import type { UserIdentity } from "convex/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

function cleanIdentityText(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/\s+/g, " ");
  return cleaned === "" ||
    cleaned === undefined ||
    cleaned.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(cleaned)
    ? undefined
    : cleaned;
}

function cleanPersonName(
  value: string | undefined,
  email: string | undefined,
): string | undefined {
  const cleaned = cleanIdentityText(value);
  if (cleaned === undefined) return undefined;
  const normalizedEmail = cleanIdentityText(email)?.toLowerCase();
  if (
    cleaned.toLowerCase() === normalizedEmail ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)
  ) {
    return undefined;
  }
  return cleaned;
}

/** Validate a display-only name chosen by the authenticated account owner.
 * The caller still owns no identity authority beyond their stable users row:
 * this value is presentation metadata and must never authorize access. */
export function requirePersonDisplayName(
  value: string,
  email: string | undefined,
): string {
  const cleaned = cleanPersonName(value, email);
  if (cleaned === undefined) {
    throw new ConvexError({
      code: "invalid_display_name",
      message:
        "Enter a name up to 200 characters. Email addresses cannot be used as a display name.",
    });
  }
  return cleaned;
}

/**
 * The canonical display name persisted by `users.ensure`.
 *
 * Clerk/OIDC tokens do not always expose `name`, but may expose the standard
 * given/family or nickname claims. Email is delivery data only: candidates
 * equal to (or shaped like) an email are never persisted as a person name.
 */
export function canonicalIdentityName(
  identity: Pick<
    UserIdentity,
    "givenName" | "familyName" | "name" | "nickname" | "email"
  >,
  clientDisplayName?: string,
): string | undefined {
  const fullName = [identity.givenName, identity.familyName]
    .map((part) => cleanPersonName(part, identity.email))
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return (
    (fullName === "" ? undefined : fullName) ??
    cleanPersonName(identity.name, identity.email) ??
    cleanPersonName(identity.nickname, identity.email) ??
    cleanPersonName(clientDisplayName, identity.email)
  );
}

/** A stored `name` equal to the delivery email is legacy fallback data, not a
 * person name. Return null so callers can resolve a better event-scoped name
 * or safely show the separate email field. */
export function storedPersonName(user: Doc<"users"> | null): string | null {
  const name = cleanPersonName(user?.name, user?.email);
  if (name === undefined) return null;
  return name;
}

/**
 * Resolve the best human name known for an event actor. An exact resource's
 * claimed speaker snapshot wins, then the canonical auth profile, then a
 * single nonconflicting event-scoped snapshot fills the legacy-name gap.
 */
export async function eventUserDisplayName(
  ctx: QueryCtx,
  eventId: Id<"events">,
  user: Doc<"users"> | null,
  exactEventContactId?: Id<"eventContacts">,
): Promise<string | null> {
  if (user === null) return null;
  if (exactEventContactId !== undefined) {
    const exact = await ctx.db.get("eventContacts", exactEventContactId);
    if (
      exact !== null &&
      exact.eventId === eventId &&
      exact.userId === user._id
    ) {
      const exactName = `${exact.firstName} ${exact.lastName}`
        .trim()
        .replace(/\s+/g, " ");
      if (exactName !== "") return exactName;
    }
  }
  const profileName = storedPersonName(user);
  if (profileName !== null) return profileName;

  // Without an exact resource relationship, use an event snapshot only when
  // every bounded match agrees. Never choose an arbitrary contact or cross an
  // event boundary just to manufacture a name.
  const contacts = await ctx.db
    .query("eventContacts")
    .withIndex("by_eventId_and_userId", (q) =>
      q.eq("eventId", eventId).eq("userId", user._id),
    )
    .take(51);
  if (contacts.length > 50) return null;
  const names = new Set(
    contacts
      .map((contact) =>
        `${contact.firstName} ${contact.lastName}`.trim().replace(/\s+/g, " "),
      )
      .filter((name) => name !== ""),
  );
  return names.size === 1 ? ([...names][0] ?? null) : null;
}
