import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { requireOrganizer } from "../lib/functions";
import { logAudit } from "./audit";
import {
  assertProgramFits,
  computeProgram,
  isPublished,
  publicationFlags,
  requestRebuild,
  setFlag,
} from "./publish";
import { whyNotPublic } from "./readiness";
import { assertEventActive, takeAll } from "./validation";

// ─────────────────────────────────────────────────────────────────────────
// Bulk publish (W10). "Publish everything eligible", per channel.
//
// WHY ITS OWN MODULE. The eligibility set must be the same code the mutation
// enforces — otherwise the console's arithmetic ("11 eligible, 2 excluded") and
// what actually lands drift, which is the whole class of bug this plan exists
// to remove. So `channelPlan` below is the ONE producer, called by the preview
// query and by the mutation that acts on it. It needs both `whyNotPublic`
// (model/readiness) and the flag writer (model/publish), and readiness already
// imports publish — putting it in either file would close an import cycle.
//
// ELIGIBILITY IS DERIVED, NOT RESTATED. A session is eligible for a channel
// when, ASSUMING the bulk action's own effects (the channel master switch on,
// that session's flag on), `whyNotPublic` has nothing left to say about that
// channel. Everything else is excluded, and the exclusion is reported with
// W4's own sentence — never a second wording of the same fact.
//
// The 1MiB guard is NOT duplicated or bypassed here: like `publish`, this
// recomputes once at the end and calls `assertProgramFits`, so an oversized
// result refuses with `program_too_large` and every flag flip in the batch
// rolls back with it.
// ─────────────────────────────────────────────────────────────────────────

const SESSION_SCAN = 1000;
const ITEM_SCAN = 500;

export type PublishChannel = "lineup" | "agenda";

export type BulkTarget = {
  kind: "session" | "agendaItem";
  id: string;
  title: string;
  /** Already on: publishing it again would write nothing. */
  alreadyPublished: boolean;
};

export type BulkExclusion = {
  sessionId: Id<"sessions">;
  title: string;
  /** W4's sentence, verbatim. */
  sentence: string;
};

export type BulkPlan = {
  channel: PublishChannel;
  /** True when the channel's master switch is off and this would turn it on. */
  enablesChannel: boolean;
  targets: BulkTarget[];
  eligible: number;
  /** Of the eligible, those whose flag is already on. */
  alreadyPublished: number;
  excluded: BulkExclusion[];
  /** The arithmetic, composed once and printed verbatim (W5). */
  sentence: string;
};

const LABEL: Record<PublishChannel, string> = {
  lineup: "the lineup",
  agenda: "the schedule",
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * What "publish everything eligible" would do to one channel, right now.
 *
 * Pure over reads and free of side effects, so the preview and the mutation
 * cannot disagree: the mutation calls this and then acts on exactly the
 * `targets` it returned.
 */
export async function channelPlan(
  ctx: QueryCtx,
  caller: EventCaller,
  channel: PublishChannel,
): Promise<BulkPlan> {
  requireOrganizer(caller);
  const eventId = caller.event._id;
  const [sessions, agendaItems, flags] = await Promise.all([
    takeAll(
      ctx.db
        .query("sessions")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
      SESSION_SCAN,
      "sessions",
    ),
    channel === "agenda"
      ? takeAll(
          ctx.db
            .query("agendaItems")
            .withIndex("by_eventId", (q) => q.eq("eventId", eventId)),
          ITEM_SCAN,
          "agenda items",
        )
      : Promise.resolve([] as Array<Doc<"agendaItems">>),
    publicationFlags(ctx, eventId),
  ]);

  const lineupPublished = caller.event.publicPageEnabled === true;
  const agendaPublished = isPublished(flags, "agenda", "event", false);
  const enablesChannel =
    channel === "lineup" ? !lineupPublished : !agendaPublished;

  const targets: BulkTarget[] = [];
  const excluded: BulkExclusion[] = [];
  let alreadyPublished = 0;

  for (const session of sessions) {
    // Ask W4 the question in the world this action creates: the channel's
    // master switch on, this session's own flag on. Whatever still blocks the
    // channel after that is a blocker bulk publishing genuinely cannot clear.
    const remaining = whyNotPublic(session, {
      lineupPublished: channel === "lineup" ? true : lineupPublished,
      agendaPublished: channel === "agenda" ? true : agendaPublished,
      sessionPublished: true,
      // Participations feed the to-be-announced line, never a blocker: a
      // session with nobody confirmed publishes as "speaker to be announced"
      // (model/publish.ts), so an empty list cannot make this stricter.
      participants: [],
    }).filter((reason) => reason.blocks === "both" || reason.blocks === channel);

    if (remaining.length > 0) {
      // A cancelled session is not "excluded work", it is off the board — the
      // sessions list already says so and repeating it here is noise.
      if (session.status === "planned") {
        excluded.push({
          sessionId: session._id,
          title: session.title,
          sentence: remaining[0].sentence,
        });
      }
      continue;
    }
    const on = isPublished(flags, "session", session._id, false);
    if (on) alreadyPublished += 1;
    targets.push({
      kind: "session",
      id: session._id,
      title: session.title,
      alreadyPublished: on,
    });
  }

  for (const item of agendaItems) {
    // Agenda items carry no readiness of their own — a break is publishable the
    // moment the schedule is.
    const on = isPublished(flags, "agendaItem", item._id, false);
    if (on) alreadyPublished += 1;
    targets.push({
      kind: "agendaItem",
      id: item._id,
      title: item.title,
      alreadyPublished: on,
    });
  }

  const eligible = targets.length;
  const willChange = targets.filter((t) => !t.alreadyPublished).length;
  const label = LABEL[channel];
  const parts: string[] = [
    `${eligible} ${plural(eligible, "entry is", "entries are")} eligible for ${label}` +
      (willChange === eligible
        ? "."
        : ` — ${alreadyPublished} already published, ${willChange} would change.`),
  ];
  if (excluded.length > 0) {
    parts.push(
      `${excluded.length} ${plural(excluded.length, "session is", "sessions are")} excluded: ` +
        `${excludedSummary(excluded)}.`,
    );
  }
  if (enablesChannel) {
    parts.push(
      channel === "lineup"
        ? "The public page is off, so this turns it on too."
        : "The schedule is not published, so this publishes it too.",
    );
  }

  return {
    channel,
    enablesChannel,
    targets,
    eligible,
    alreadyPublished,
    excluded,
    sentence: parts.join(" "),
  };
}

/** "2 because content is Draft, 1 because the slot has not been released" —
 * grouped by W4's sentence so the reason is never re-worded. */
function excludedSummary(excluded: BulkExclusion[]): string {
  const counts = new Map<string, number>();
  for (const row of excluded) {
    counts.set(row.sentence, (counts.get(row.sentence) ?? 0) + 1);
  }
  return [...counts]
    .map(([sentence, count]) => {
      // "Content is Draft." → "2 because content is Draft"
      const clause = sentence.replace(/\.$/, "");
      return `${count} because ${clause.charAt(0).toLowerCase()}${clause.slice(1)}`;
    })
    .join(", ");
}

export type BulkResult = {
  channel: PublishChannel;
  status: "success" | "noop";
  title: string;
  /** Composed here; the console prints them into an ActionResult verbatim. */
  lines: string[];
  published: number;
  alreadyPublished: number;
  excluded: number;
};

/**
 * Publish every eligible entry on one channel, plus the channel's own master
 * switch. One mutation, one audit row, one scheduled rebuild — not N publish
 * calls, each of which would recompute the whole projection to check the size
 * guard.
 */
export async function bulkPublishChannel(
  ctx: MutationCtx,
  caller: EventCaller,
  channel: PublishChannel,
): Promise<BulkResult> {
  requireOrganizer(caller);
  assertEventActive(caller.event);
  const eventId = caller.event._id;
  const plan = await channelPlan(ctx, caller, channel);

  if (channel === "lineup") {
    if (plan.enablesChannel) {
      await ctx.db.patch("events", eventId, { publicPageEnabled: true });
    }
  } else if (plan.enablesChannel) {
    await setFlag(ctx, eventId, "agenda", "event", true);
  }

  let published = 0;
  for (const target of plan.targets) {
    if (target.alreadyPublished) continue;
    await setFlag(
      ctx,
      eventId,
      target.kind === "session" ? "session" : "agendaItem",
      target.id,
      true,
    );
    published += 1;
  }

  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId,
    actorUserId: caller.user._id,
    action: channel === "lineup" ? "publish.bulkLineup" : "publish.bulkAgenda",
    meta: {
      channel,
      published,
      alreadyPublished: plan.alreadyPublished,
      excluded: plan.excluded.length,
    },
  });

  // Same guard, same refusal, same transaction as a single publish: this is a
  // GROWING action, so an unservable result must reach the organizer and take
  // every flag flip above it back down with it.
  const event = (await ctx.db.get("events", eventId)) ?? caller.event;
  assertProgramFits(await computeProgram(ctx, event));
  await requestRebuild(ctx, eventId, caller.user._id);

  const label = LABEL[channel];
  const lines: string[] = [];
  if (published > 0) {
    lines.push(
      `${published} ${plural(published, "entry", "entries")} newly published to ${label}.`,
    );
  }
  if (plan.alreadyPublished > 0) {
    lines.push(
      `${plan.alreadyPublished} ${plural(plan.alreadyPublished, "was", "were")} already published and left alone.`,
    );
  }
  if (plan.excluded.length > 0) {
    lines.push(
      `${plan.excluded.length} ${plural(plan.excluded.length, "session was", "sessions were")} not attempted: ${excludedSummary(plan.excluded)}.`,
    );
  }
  lines.push(
    "The public page, the read API and every embed serve the same projection; it lands a moment after the rebuild.",
  );

  return {
    channel,
    status: published === 0 && !plan.enablesChannel ? "noop" : "success",
    title:
      published === 0 && !plan.enablesChannel
        ? `Nothing to publish to ${label}`
        : `Published ${published} to ${label}`,
    lines,
    published,
    alreadyPublished: plan.alreadyPublished,
    excluded: plan.excluded.length,
  };
}
