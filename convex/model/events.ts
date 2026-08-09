import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller, OrgCaller } from "../lib/functions";
import { requireOrgAdmin } from "../lib/functions";
import { assertValidSlug, uniqueSlug } from "./slugs";
import { logAudit } from "./audit";

const IANA_ZONE = /^[A-Za-z_]+\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)?$|^UTC$/;

export type CreateEventArgs = {
  name: string;
  startsAt: number;
  endsAt: number;
  timezone: string;
};

/**
 * Fast event creation (MILESTONES M0): name, start/end, timezone only.
 * Generates a unique editable slug; exposes nothing publicly. The starter CFP
 * form is generated when the CFP model lands (M1) — recorded in PLAN.md.
 */
export async function createEvent(
  ctx: MutationCtx,
  caller: OrgCaller,
  args: CreateEventArgs,
): Promise<Doc<"events">> {
  requireOrgAdmin(caller);
  const name = args.name.trim();
  if (name.length === 0 || name.length > 120) {
    throw new ConvexError({
      code: "invalid_name",
      message: "Event name must be 1-120 characters.",
    });
  }
  if (!IANA_ZONE.test(args.timezone)) {
    throw new ConvexError({
      code: "invalid_timezone",
      message: "Timezone must be an IANA zone like America/Los_Angeles.",
    });
  }
  if (args.endsAt < args.startsAt) {
    throw new ConvexError({
      code: "invalid_dates",
      message: "Event end must not be before its start.",
    });
  }
  const slug = await uniqueSlug(ctx, "events", name);
  const eventId = await ctx.db.insert("events", {
    orgId: caller.org._id,
    name,
    slug,
    startsAt: args.startsAt,
    endsAt: args.endsAt,
    timezone: args.timezone,
    cfpPublished: false,
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId,
    actorUserId: caller.user._id,
    action: "event.create",
    targetType: "event",
    targetId: eventId,
  });
  const event = await ctx.db.get("events", eventId);
  if (event === null) throw new Error("unreachable: event just inserted");
  return event;
}

export type EventSettingsPatch = {
  name?: string;
  slug?: string;
  startsAt?: number;
  endsAt?: number;
  timezone?: string;
  type?: string | null;
  location?: string | null;
  website?: string | null;
  description?: string | null;
  logoId?: Id<"_storage"> | null;
  bannerId?: Id<"_storage"> | null;
  cfpOpenAt?: number | null;
  cfpCloseAt?: number | null;
  cfpPublished?: boolean;
};

/** Post-create Event Settings (M0). Null clears an optional field. */
export async function updateEventSettings(
  ctx: MutationCtx,
  caller: EventCaller,
  patch: EventSettingsPatch,
): Promise<void> {
  const { event } = caller;
  const update: Record<string, unknown> = {};

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length === 0 || name.length > 120) {
      throw new ConvexError({
        code: "invalid_name",
        message: "Event name must be 1-120 characters.",
      });
    }
    update.name = name;
  }
  if (patch.slug !== undefined && patch.slug !== event.slug) {
    assertValidSlug(patch.slug);
    const clash = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", patch.slug!))
      .unique();
    if (clash !== null) {
      throw new ConvexError({
        code: "slug_taken",
        message: "That slug is already in use.",
      });
    }
    update.slug = patch.slug;
  }
  if (patch.timezone !== undefined) {
    if (!IANA_ZONE.test(patch.timezone)) {
      throw new ConvexError({
        code: "invalid_timezone",
        message: "Timezone must be an IANA zone like America/Los_Angeles.",
      });
    }
    update.timezone = patch.timezone;
  }
  const startsAt = patch.startsAt ?? event.startsAt;
  const endsAt = patch.endsAt ?? event.endsAt;
  if (endsAt < startsAt) {
    throw new ConvexError({
      code: "invalid_dates",
      message: "Event end must not be before its start.",
    });
  }
  if (patch.startsAt !== undefined) update.startsAt = patch.startsAt;
  if (patch.endsAt !== undefined) update.endsAt = patch.endsAt;

  // Optional/clearable fields: null in the patch clears (stores undefined).
  for (const key of [
    "type",
    "location",
    "website",
    "description",
    "logoId",
    "bannerId",
    "cfpOpenAt",
    "cfpCloseAt",
  ] as const) {
    if (patch[key] !== undefined) {
      update[key] = patch[key] === null ? undefined : patch[key];
    }
  }
  if (patch.cfpPublished !== undefined) update.cfpPublished = patch.cfpPublished;

  await ctx.db.patch("events", event._id, update);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: event._id,
    actorUserId: caller.user._id,
    action: "event.updateSettings",
    targetType: "event",
    targetId: event._id,
    meta: { fields: Object.keys(update) },
  });
}

/** Archive is the only overall lifecycle action (M0): stops automations,
 * removes from active work, deletes nothing. */
export async function setArchived(
  ctx: MutationCtx,
  caller: EventCaller,
  archived: boolean,
): Promise<void> {
  await ctx.db.patch("events", caller.event._id, {
    archivedAt: archived ? Date.now() : undefined,
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: archived ? "event.archive" : "event.unarchive",
    targetType: "event",
    targetId: caller.event._id,
  });
}
