import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { notFound, requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import { assertEventActive, assertText } from "./validation";
import type { PublicProgram, PublicSession } from "./publish";
import { servedProgramForEvent } from "./publish";
import { ICS_PRODID, escapeIcsText, foldIcsLine, formatIcsUtc } from "./ics";

// ─────────────────────────────────────────────────────────────────────────
// Embeds (W3, EMB-15): organizer-generated widget instances. Each row names
// a widget type + filters; the public read path resolves the row (enabled
// only), loads the served program blob, and applies the filters — so an
// embed can never disagree with the public page (EMB-16).
// ─────────────────────────────────────────────────────────────────────────

const MAX_EMBEDS = 50;

export type EmbedWidget = Doc<"embeds">["widget"];
export type EmbedConfig = Doc<"embeds">["config"];

export const WIDGETS: ReadonlyArray<EmbedWidget> = [
  "sessions",
  "speakers",
  "agenda",
  "itinerary",
  "gallery",
];

function assertConfig(config: EmbedConfig): EmbedConfig {
  const out: EmbedConfig = {};
  if (config.trackName !== undefined && config.trackName.trim() !== "") {
    out.trackName = assertText(config.trackName, {
      label: "Track filter",
      max: 120,
    });
  }
  if (config.brandColor !== undefined && config.brandColor.trim() !== "") {
    const color = config.brandColor.trim();
    if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) {
      throw new ConvexError({
        code: "invalid_config",
        message: "The brand color must be a hex value like #7c5cff.",
      });
    }
    out.brandColor = color;
  }
  if (config.hiddenFields !== undefined && config.hiddenFields.length > 0) {
    out.hiddenFields = config.hiddenFields
      .map((f) => f.trim())
      .filter((f) => f !== "")
      .slice(0, 20);
  }
  return out;
}

export async function listEmbeds(
  ctx: QueryCtx,
  caller: EventCaller,
): Promise<Array<Doc<"embeds">>> {
  requireOrganizer(caller);
  return await ctx.db
    .query("embeds")
    .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
    .take(MAX_EMBEDS);
}

export async function createEmbed(
  ctx: MutationCtx,
  caller: EventCaller,
  input: { name: string; widget: EmbedWidget; config: EmbedConfig },
): Promise<Id<"embeds">> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const existing = await ctx.db
    .query("embeds")
    .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
    .take(MAX_EMBEDS);
  if (existing.length >= MAX_EMBEDS) {
    throw new ConvexError({
      code: "too_many",
      message: `At most ${MAX_EMBEDS} embeds per event.`,
    });
  }
  const id = await ctx.db.insert("embeds", {
    eventId: caller.event._id,
    name: assertText(input.name, { label: "Embed name", max: 120 }),
    widget: input.widget,
    enabled: true,
    config: assertConfig(input.config),
    createdBy: caller.user._id,
    updatedAt: Date.now(),
  });
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "embeds.create",
    targetType: "embed",
    targetId: id,
    meta: { widget: input.widget, name: input.name },
  });
  return id;
}

async function requireEmbed(
  ctx: QueryCtx,
  caller: EventCaller,
  embedId: Id<"embeds">,
): Promise<Doc<"embeds">> {
  const embed = await ctx.db.get("embeds", embedId);
  if (embed === null || embed.eventId !== caller.event._id) {
    notFound("embed", "No such embed on this event.");
  }
  return embed;
}

export async function updateEmbed(
  ctx: MutationCtx,
  caller: EventCaller,
  embedId: Id<"embeds">,
  patch: { name?: string; enabled?: boolean; config?: EmbedConfig },
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  await requireEmbed(ctx, caller, embedId);
  const update: Partial<Doc<"embeds">> = { updatedAt: Date.now() };
  if (patch.name !== undefined) {
    update.name = assertText(patch.name, { label: "Embed name", max: 120 });
  }
  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  if (patch.config !== undefined) update.config = assertConfig(patch.config);
  await ctx.db.patch("embeds", embedId, update);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "embeds.update",
    targetType: "embed",
    targetId: embedId,
    meta: { fields: Object.keys(patch) },
  });
}

export async function deleteEmbed(
  ctx: MutationCtx,
  caller: EventCaller,
  embedId: Id<"embeds">,
): Promise<void> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  await requireEmbed(ctx, caller, embedId);
  await ctx.db.delete("embeds", embedId);
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    action: "embeds.delete",
    targetType: "embed",
    targetId: embedId,
    meta: {},
  });
}

// ── Public read ──────────────────────────────────────────────────────────

function filterSession(
  session: PublicSession,
  config: EmbedConfig,
): PublicSession | null {
  if (
    config.trackName !== undefined &&
    session.trackName !== config.trackName
  ) {
    return null;
  }
  const hidden = new Set(config.hiddenFields ?? []);
  if (hidden.size === 0) return session;
  return {
    ...session,
    description: hidden.has("description") ? undefined : session.description,
    roomName: hidden.has("room") ? undefined : session.roomName,
    speakers: hidden.has("speakers") ? [] : session.speakers,
  };
}

export type PublicEmbed = {
  embedId: string;
  widget: EmbedWidget;
  name: string;
  config: EmbedConfig;
  program: PublicProgram;
};

/** The anonymous read behind /embed/w/<id> and /api/embeds/<id>: the served
 * blob with this embed's filters applied. Null when the embed is disabled,
 * unknown, or the program isn't published. */
export async function resolveEmbed(
  ctx: QueryCtx,
  embedId: string,
): Promise<PublicEmbed | null> {
  const id = ctx.db.normalizeId("embeds", embedId);
  if (id === null) return null;
  const embed = await ctx.db.get("embeds", id);
  if (embed === null || !embed.enabled) return null;
  const program = await servedProgramForEvent(ctx, embed.eventId);
  if (program === null) return null;
  const lineup = program.lineup
    .map((s) => filterSession(s, embed.config))
    .filter((s): s is PublicSession => s !== null);
  const agenda = program.agenda
    .map((entry) => {
      if (entry.kind === "item") return entry;
      const filtered = filterSession(entry, embed.config);
      return filtered === null ? null : { kind: "session" as const, ...filtered };
    })
    .filter((e): e is PublicProgram["agenda"][number] => e !== null);
  return {
    embedId: embed._id,
    widget: embed.widget,
    name: embed.name,
    config: embed.config,
    program: { ...program, lineup, agenda },
  };
}

// ── iCal feed (W3: EMB-15 formats) ───────────────────────────────────────

/** A subscribable VCALENDAR of the program's agenda (sessions + items).
 * No METHOD — this is a feed, not an invitation. */
export function programIcs(program: PublicProgram, key: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    `PRODID:${ICS_PRODID}`,
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcsText(program.event.name)}`,
  ];
  const now = formatIcsUtc(Date.now());
  for (const entry of program.agenda) {
    const startsAt = entry.startsAt;
    const endsAt = entry.endsAt;
    if (startsAt === undefined || endsAt === undefined) continue;
    const uid =
      entry.kind === "session"
        ? `feed-${entry.sessionId}@stagestack`
        : `feed-${entry.itemId}@stagestack`;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}-${key}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${formatIcsUtc(startsAt)}`);
    lines.push(`DTEND:${formatIcsUtc(endsAt)}`);
    lines.push(`SUMMARY:${escapeIcsText(entry.title)}`);
    if (entry.roomName !== undefined) {
      lines.push(`LOCATION:${escapeIcsText(entry.roomName)}`);
    }
    if (entry.description !== undefined && entry.description !== "") {
      lines.push(`DESCRIPTION:${escapeIcsText(entry.description)}`);
    }
    if (entry.kind === "session" && entry.speakers.length > 0) {
      lines.push(
        `X-STAGESTACK-SPEAKERS:${escapeIcsText(entry.speakers.map((s) => s.name).join(", "))}`,
      );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
