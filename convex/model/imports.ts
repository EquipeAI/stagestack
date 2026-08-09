import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { forbidden, notFound } from "../lib/functions";
import type {
  ImportPlan,
  ImportRecord,
  PlannedRecord,
  RecordResult,
} from "../shared/importPlan";
import { IMPORT_LIMITS } from "../shared/importPlan";
import { logAudit } from "./audit";
import { createContact } from "./contacts";
import { addLibraryItem, listLibrary } from "./library";
import { createManualProposal } from "./cfp";
import { importSession } from "./sessions";
import { assertEventActive } from "./reviews";

// ─────────────────────────────────────────────────────────────────────────
// The Import agent's server side (M2). The worker never carries authority:
// every worker call resolves the *initiating user* recorded on the job row
// and re-derives their role before touching any capability — the agent acts
// strictly with its initiator's permissions (MILESTONES M0 trust boundary,
// ARCHITECTURE "Worker auth").
// ─────────────────────────────────────────────────────────────────────────

/** Rebuild an EventCaller for a job's initiator. Throws if the user lost
 * access between enqueue and execution. */
export async function resolveJobCaller(
  ctx: QueryCtx,
  job: Doc<"jobs">,
  eventId: Id<"events">,
): Promise<EventCaller> {
  if (job.initiatedBy === undefined) {
    throw new ConvexError({
      code: "no_initiator",
      message: "This job has no initiating user recorded.",
    });
  }
  const user = await ctx.db.get("users", job.initiatedBy);
  if (user === null) notFound("user");
  const event = await ctx.db.get("events", eventId);
  if (event === null) notFound("event");
  const org = await ctx.db.get("organizations", event.orgId);
  if (org === null) notFound("organization");
  const membership = await ctx.db
    .query("members")
    .withIndex("by_orgId_and_userId", (q) =>
      q.eq("orgId", org._id).eq("userId", user._id),
    )
    .unique();
  if (membership !== null) {
    return { user, org, event, role: "organizer", orgRole: membership.role };
  }
  const eventMembership = await ctx.db
    .query("eventMembers")
    .withIndex("by_eventId_and_userId", (q) =>
      q.eq("eventId", event._id).eq("userId", user._id),
    )
    .unique();
  if (eventMembership === null || eventMembership.role !== "organizer") {
    forbidden("The initiating user is not an organizer of this event.");
  }
  return { user, org, event, role: "organizer", orgRole: null };
}

export function assertPlanShape(plan: unknown): asserts plan is ImportPlan {
  const p = plan as ImportPlan;
  if (
    typeof p !== "object" ||
    p === null ||
    typeof p.summary !== "string" ||
    !Array.isArray(p.records) ||
    !Array.isArray(p.skippedRows)
  ) {
    throw new ConvexError({
      code: "invalid_plan",
      message: "The planner returned an unusable plan.",
    });
  }
  if (p.records.length > IMPORT_LIMITS.maxRecords) {
    throw new ConvexError({
      code: "invalid_plan",
      message: `Plans are limited to ${IMPORT_LIMITS.maxRecords} records.`,
    });
  }
}

/** Execute one approved record with the initiator's authority. Never throws:
 * per-record failures become results the organizer can read. */
async function executeRecord(
  ctx: MutationCtx,
  caller: EventCaller,
  planned: PlannedRecord,
): Promise<RecordResult> {
  const record = planned.record as ImportRecord;
  try {
    switch (record.kind) {
      case "contact": {
        // Reuse silently when the directory already has this email — the
        // agent may only look up and reuse, never bulk-update (MILESTONES).
        if (record.email !== undefined) {
          const existing = await ctx.db
            .query("contacts")
            .withIndex("by_orgId_and_email", (q) =>
              q
                .eq("orgId", caller.org._id)
                .eq("email", record.email!.trim().toLowerCase()),
            )
            .first();
          if (existing !== null) {
            return {
              id: planned.id,
              ok: true,
              detail: `Reused existing contact ${existing.firstName} ${existing.lastName}`,
            };
          }
        }
        await createContact(
          ctx,
          {
            user: caller.user,
            org: caller.org,
            orgRole: caller.orgRole,
            organizesEvents: true,
            eventMemberships: [],
          },
          {
            firstName: record.firstName,
            lastName: record.lastName,
            email: record.email,
            tagline: record.tagline,
            bio: record.bio,
          },
        );
        return { id: planned.id, ok: true, detail: "Contact created" };
      }
      case "track":
      case "tag": {
        const table = record.kind === "track" ? "tracks" : "tags";
        const library = await listLibrary(ctx, caller.event._id);
        const existing = (table === "tracks" ? library.tracks : library.tags).find(
          (t) => t.name.toLowerCase() === record.name.trim().toLowerCase(),
        );
        if (existing !== undefined) {
          return {
            id: planned.id,
            ok: true,
            detail: `Reused existing ${record.kind} "${existing.name}"`,
          };
        }
        await addLibraryItem(ctx, caller, table, { name: record.name });
        return {
          id: planned.id,
          ok: true,
          detail: `${record.kind === "track" ? "Track" : "Tag"} created`,
        };
      }
      case "proposal": {
        await createManualProposal(ctx, caller, {
          title: record.title,
          abstract: record.abstract,
          speakers: record.speakers,
        });
        return { id: planned.id, ok: true, detail: "Proposal created" };
      }
      case "session": {
        await importSession(ctx, caller, {
          title: record.title,
          description: record.description,
          speaker: record.speaker,
        });
        return {
          id: planned.id,
          ok: true,
          detail: "Session created (no communications sent)",
        };
      }
      default:
        return { id: planned.id, ok: false, detail: "Unknown record kind" };
    }
  } catch (err) {
    const detail =
      err instanceof ConvexError
        ? String((err.data as { message?: string })?.message ?? "Rejected")
        : "Rejected by validation";
    return { id: planned.id, ok: false, detail };
  }
}

export async function executeRecords(
  ctx: MutationCtx,
  caller: EventCaller,
  records: PlannedRecord[],
): Promise<RecordResult[]> {
  assertEventActive(caller.event);
  if (records.length > IMPORT_LIMITS.executeBatch) {
    throw new ConvexError({
      code: "batch_too_large",
      message: `Execute at most ${IMPORT_LIMITS.executeBatch} records per call.`,
    });
  }
  const results: RecordResult[] = [];
  for (const planned of records) {
    results.push(await executeRecord(ctx, caller, planned));
  }
  await logAudit(ctx, {
    orgId: caller.org._id,
    eventId: caller.event._id,
    actorUserId: caller.user._id,
    viaAgent: true,
    action: "import.executeBatch",
    meta: {
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
  });
  return results;
}
