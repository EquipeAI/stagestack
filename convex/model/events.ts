import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller, OrgCaller } from "../lib/functions";
import { requireOrgAdmin } from "../lib/functions";
import { assertSlugFree, assertValidSlug, uniqueSlug } from "./slugs";
import { logAudit } from "./audit";
import { ensureForm } from "./cfpForms";
import { republishIfPublished } from "./publish";
import { assertText, normalizeEmail } from "./validation";
import { optionalHttpUrl } from "../lib/urls";

const IANA_ZONE = /^[A-Za-z_]+\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)?$|^UTC$/;

const EVENT_NAME = { label: "Event name", max: 120 } as const;

function assertTimezone(timezone: string): void {
  if (!IANA_ZONE.test(timezone)) {
    throw new ConvexError({
      code: "invalid_timezone",
      message: "Timezone must be an IANA zone like America/Los_Angeles.",
    });
  }
}

function assertDateOrder(startsAt: number, endsAt: number): void {
  if (endsAt < startsAt) {
    throw new ConvexError({
      code: "invalid_dates",
      message: "Event end must not be before its start.",
    });
  }
}

/** Events in one org the caller may see: org owner/admins see them all;
 * event-scoped members see only the events they belong to. */
export async function listVisible(
  ctx: QueryCtx,
  caller: OrgCaller,
): Promise<Array<Doc<"events">>> {
  if (caller.orgRole !== null) {
    return await ctx.db
      .query("events")
      .withIndex("by_orgId", (q) => q.eq("orgId", caller.org._id))
      .take(200);
  }
  // resolveOrgCaller already scoped eventMemberships to this org.
  const events = await Promise.all(
    caller.eventMemberships.map((m) => ctx.db.get("events", m.eventId)),
  );
  return events.filter((e): e is Doc<"events"> => e !== null);
}

export type CreateEventArgs = {
  name: string;
  startsAt: number;
  endsAt: number;
  timezone: string;
};

/**
 * Fast event creation (MILESTONES M0): name, start/end, timezone only.
 * Generates a unique editable slug; exposes nothing publicly. Also seeds the
 * event's starter CFP form (M1) so the form builder is never empty.
 */
export async function createEvent(
  ctx: MutationCtx,
  caller: OrgCaller,
  args: CreateEventArgs,
): Promise<Doc<"events">> {
  requireOrgAdmin(caller);
  const name = assertText(args.name, EVENT_NAME);
  assertTimezone(args.timezone);
  assertDateOrder(args.startsAt, args.endsAt);
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
  // Every event ships with the starter CFP form (M1). Not audited: it is part
  // of creating the event, not a separate organizer action.
  await ensureForm(ctx, eventId);
  // Every event starts with one discoverable place for speaker logistics.
  // Organizers can rename/delete it through the existing custom-fields UI.
  await ctx.db.insert("customFields", {
    eventId,
    name: "Travel preferences",
    kind: "text",
    appliesTo: "speaker",
    order: 0,
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
  /** M5 comms settings. Null clears (reminders off / no reply-to). */
  reminderCadenceDays?: number | null;
  replyTo?: string | null;
};

/** Reminder cadence is whole days, 1-90. Absent/null means "no reminders". */
function assertCadence(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new ConvexError({
      code: "invalid_cadence",
      message:
        "Reminder cadence must be a whole number of days between 1 and 90.",
    });
  }
  return days;
}

/** Post-create Event Settings (M0). Null clears an optional field. */
export async function updateEventSettings(
  ctx: MutationCtx,
  caller: EventCaller,
  patch: EventSettingsPatch,
): Promise<void> {
  const { event } = caller;
  const update: Record<string, unknown> = {};

  if (patch.name !== undefined) {
    update.name = assertText(patch.name, EVENT_NAME);
  }
  if (patch.slug !== undefined && patch.slug !== event.slug) {
    assertValidSlug(patch.slug);
    await assertSlugFree(ctx, "events", patch.slug);
    update.slug = patch.slug;
  }
  if (patch.timezone !== undefined) {
    assertTimezone(patch.timezone);
    update.timezone = patch.timezone;
  }
  assertDateOrder(
    patch.startsAt ?? event.startsAt,
    patch.endsAt ?? event.endsAt,
  );
  if (patch.startsAt !== undefined) update.startsAt = patch.startsAt;
  if (patch.endsAt !== undefined) update.endsAt = patch.endsAt;

  // Optional/clearable fields: null in the patch clears (stores undefined).
  for (const key of [
    "type",
    "location",
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
  // The website renders as an href on the public event page, so it goes
  // through the shared http(s)-only gate (lib/urls.ts). Null or blank clears.
  if (patch.website !== undefined) {
    update.website =
      patch.website === null
        ? undefined
        : optionalHttpUrl(patch.website, "Website");
  }
  if (patch.cfpPublished !== undefined)
    update.cfpPublished = patch.cfpPublished;

  // M5: the event-wide reminder default and the reply-to address Cloudflare
  // routes to the team's inbox.
  if (patch.reminderCadenceDays !== undefined) {
    update.reminderCadenceDays =
      patch.reminderCadenceDays === null
        ? undefined
        : assertCadence(patch.reminderCadenceDays);
  }
  if (patch.replyTo !== undefined) {
    update.replyTo =
      patch.replyTo === null ? undefined : normalizeEmail(patch.replyTo);
  }

  await ctx.db.patch("events", event._id, update);
  // A slug/name rename changes the event's public identity, which the served
  // blob embeds — stale identity there is the privacy-style exception that
  // rewrites immediately (model/publish.ts). Other fields (description,
  // website, ...) stay editorial and wait for an explicit republish.
  if (update.slug !== undefined || update.name !== undefined) {
    await republishIfPublished(ctx, event._id);
  }
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
