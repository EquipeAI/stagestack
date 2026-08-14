import { ConvexError, v } from "convex/values";
import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type ApiKeyIdentity,
  type EventCaller,
  apiKeyEventCaller,
  apiKeyOrgCaller,
  apiKeyScopedEvent,
  notFound,
  resolveCallerFromApiKey,
} from "./lib/functions";
import {
  vProposalStatus,
  vParticipantState,
  vTaskStatus,
} from "./lib/validators";
import { vControlRow } from "./readiness";
import { vAnswerValue } from "./shared/formDef";
import * as ApiKeys from "./model/apiKeys";
import * as Agenda from "./model/agenda";
import * as Cfp from "./model/cfp";
import * as Events from "./model/events";
import * as Publish from "./model/publish";
import * as Readiness from "./model/readiness";
import * as Reviews from "./model/reviews";
import * as Search from "./model/search";
import * as Sessions from "./model/sessions";
import * as Tasks from "./model/tasks";

// ─────────────────────────────────────────────────────────────────────────
// The internal surface behind the hosted MCP endpoint (D2).
//
// `httpAction` has no database, so every tool body is one of these functions.
// They all take the PRESENTED KEY and re-resolve the caller themselves: the
// HTTP layer authenticates once for rate limiting, but no tool trusts that —
// authorization is re-derived per call, from the live row, exactly like the
// signed-in surface re-derives it per query.
//
// EVERY TOOL RETURNS AN EXPLICIT PROJECTION, never a document. This is an
// external surface: a raw `Doc` spread would hand an outside agent internal
// ids, storage ids and every column a future migration adds, and would keep
// doing so silently. The `returns` validator below each tool IS the contract —
// fields chosen on purpose, and a new column reaches an agent only when
// somebody writes it in here. Serialization to JSON text happens at the MCP
// boundary (convex/lib/mcpServer.ts), not in these queries.
//
// Truncation is always named. A model told "these are the sessions" acts on
// that sentence, so every list that can stop short carries `capped`.
// ─────────────────────────────────────────────────────────────────────────

// One bucket per key, alongside the worker's `workerCalls`. 300/min is far
// above an agent working an event by hand (a Claude Code turn is a handful of
// tool calls) and caps a runaway loop at 5/second. Same caveat as the worker:
// a mutation that throws refunds its spend, so this bounds accepted volume,
// not authentication guessing — key entropy does that.
const mcpLimiter = new RateLimiter(components.rateLimiter, {
  mcpCalls: { kind: "token bucket", rate: 300, period: MINUTE, capacity: 600 },
});

/** Resolve the presented key inside a read transaction. */
async function identify(
  ctx: QueryCtx,
  presentedKey: string,
  now: number,
): Promise<ApiKeyIdentity> {
  return await resolveCallerFromApiKey(ctx, presentedKey, now);
}

/** Shared argument shape: every tool call carries the credential and a clock
 * read taken in the action (queries must not read the wall clock). */
const keyArgs = { presentedKey: v.string(), now: v.number() };
const eventArgs = { ...keyArgs, eventSlug: v.string() };

// ── Projections ──────────────────────────────────────────────────────────

/** An event as an outside agent sees it: what it is and when, never its ids
 * or its storage handles. `slug` is the identifier every other tool takes. */
const vEvent = v.object({
  slug: v.string(),
  name: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  timezone: v.string(),
  type: v.optional(v.string()),
  location: v.optional(v.string()),
  website: v.optional(v.string()),
  description: v.optional(v.string()),
  cfpOpenAt: v.optional(v.number()),
  cfpCloseAt: v.optional(v.number()),
  cfpPublished: v.boolean(),
  publicPageEnabled: v.boolean(),
  archived: v.boolean(),
});

function projectEvent(event: Doc<"events">) {
  return {
    slug: event.slug,
    name: event.name,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    type: event.type,
    location: event.location,
    website: event.website,
    description: event.description,
    cfpOpenAt: event.cfpOpenAt,
    cfpCloseAt: event.cfpCloseAt,
    cfpPublished: event.cfpPublished,
    publicPageEnabled: event.publicPageEnabled ?? false,
    archived: event.archivedAt !== undefined,
  };
}

const vSpeakerName = v.object({
  name: v.string(),
  role: v.string(),
  state: vParticipantState,
});

const vConflict = v.object({
  kind: v.union(v.literal("room"), v.literal("speaker"), v.literal("track")),
  level: v.union(v.literal("blocker"), v.literal("warning")),
  withTitle: v.string(),
  message: v.string(),
});

function projectConflicts(
  conflicts: Array<{
    kind: "room" | "speaker" | "track";
    level: "blocker" | "warning";
    withTitle: string;
    message: string;
  }>,
) {
  return conflicts.map((c) => ({
    kind: c.kind,
    level: c.level,
    withTitle: c.withTitle,
    message: c.message,
  }));
}

// ── Authentication + budget (once per HTTP request) ──────────────────────

/**
 * Verify the presented key, spend one token from its bucket, and touch
 * `lastUsedAt`. A mutation because both of those are writes — `check()` only
 * observes (the C2 lesson), so the budget is spent here or not at all.
 */
export const authenticate = internalMutation({
  args: keyArgs,
  returns: v.object({
    orgSlug: v.string(),
    orgName: v.string(),
    keyName: v.string(),
    ceiling: v.union(v.literal("read"), v.literal("organizer")),
    eventSlug: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    if (
      !(await mcpLimiter.limit(ctx, "mcpCalls", { key: identity.key._id })).ok
    ) {
      throw new ConvexError({
        code: "rate_limited",
        message: ApiKeys.MCP_REFUSAL_MESSAGES.rate_limited,
      });
    }
    await ApiKeys.touchLastUsed(ctx, identity.key, args.now);
    const scoped = await apiKeyScopedEvent(ctx, identity);
    return {
      orgSlug: identity.orgCaller.org.slug,
      orgName: identity.orgCaller.org.name,
      keyName: identity.key.name,
      ceiling: identity.key.ceiling,
      eventSlug: scoped?.slug ?? null,
    };
  },
});

// ── Curated read tools ───────────────────────────────────────────────────

/**
 * Search, bounded by the KEY's scope rather than the minter's whole account.
 *
 * The scope goes into the candidate reads (`Search.search`'s `scope`), not
 * into a filter over the results: a minter who also belongs to a second
 * organization must never see it through this key, and post-filtering would
 * leave the group sentences and the summary counting rows the caller was not
 * allowed to see.
 */
export const search = internalQuery({
  args: { ...keyArgs, term: v.string(), eventSlug: v.optional(v.string()) },
  returns: v.object({
    summary: v.string(),
    capped: v.boolean(),
    groups: v.array(
      v.object({
        kind: v.union(
          v.literal("event"),
          v.literal("session"),
          v.literal("speaker"),
          v.literal("proposal"),
          v.literal("review"),
        ),
        label: v.string(),
        capped: v.boolean(),
        sentence: v.string(),
        hits: v.array(
          v.object({
            kind: v.string(),
            id: v.string(),
            eventSlug: v.string(),
            title: v.string(),
            subtitle: v.optional(v.string()),
          }),
        ),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    const scoped = await apiKeyScopedEvent(ctx, identity);
    // An event-scoped key searches its own event; an org key searches the one
    // it was pointed at, if any. Either way the event caller is resolved
    // through the key, so the scope check happens before a record is read.
    const inEventSlug = scoped?.slug ?? args.eventSlug;
    const caller =
      inEventSlug === undefined
        ? null
        : await apiKeyEventCaller(ctx, identity, inEventSlug, "read");
    const results = await Search.search(ctx, identity.user, caller, args.term, {
      orgId: identity.key.orgId,
      eventId: identity.key.eventId,
    });
    return {
      summary: results.summary,
      capped: results.groups.some((group) => group.capped),
      groups: results.groups.map((group) => ({
        kind: group.kind,
        label: group.label,
        capped: group.capped,
        sentence: group.sentence,
        hits: group.hits.map((hit) => ({
          kind: hit.kind,
          id: hit.id,
          eventSlug: hit.eventSlug,
          title: hit.title,
          subtitle: hit.subtitle,
        })),
      })),
    };
  },
});

/** Events the key can reach. An event-scoped key returns exactly one. */
export const listEvents = internalQuery({
  args: keyArgs,
  returns: v.object({
    scope: v.union(v.literal("organization"), v.literal("event")),
    org: v.union(v.string(), v.null()),
    capped: v.boolean(),
    events: v.array(vEvent),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    const scoped = await apiKeyScopedEvent(ctx, identity);
    if (scoped !== null) {
      // Resolve through the event caller so a minter who lost their
      // membership on this event gets a refusal, not a row.
      const caller = await apiKeyEventCaller(ctx, identity, scoped.slug, "read");
      return {
        scope: "event" as const,
        org: caller.org.slug,
        capped: false,
        events: [projectEvent(caller.event)],
      };
    }
    const caller = apiKeyOrgCaller(identity, "read");
    const visible = await Events.listVisibleCapped(ctx, caller);
    return {
      scope: "organization" as const,
      org: caller.org.slug,
      capped: visible.capped,
      events: visible.events.map(projectEvent),
    };
  },
});

export const getEvent = internalQuery({
  args: eventArgs,
  returns: v.object({
    event: vEvent,
    organization: v.object({ slug: v.string(), name: v.string() }),
    yourRole: v.union(v.literal("organizer"), v.literal("reviewer")),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    const caller = await apiKeyEventCaller(
      ctx,
      identity,
      args.eventSlug,
      "read",
    );
    return {
      event: projectEvent(caller.event),
      organization: { slug: caller.org.slug, name: caller.org.name },
      yourRole: caller.role,
    };
  },
});

export const listProposals = internalQuery({
  args: { ...eventArgs, status: v.optional(vProposalStatus) },
  returns: v.object({
    eventSlug: v.string(),
    capped: v.boolean(),
    note: v.optional(v.string()),
    proposals: v.array(
      v.object({
        proposalId: v.string(),
        title: v.string(),
        status: vProposalStatus,
        speakerCount: v.number(),
        submittedAt: v.optional(v.number()),
        updatedAt: v.number(),
        withdrawnAt: v.optional(v.number()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    const caller = await apiKeyEventCaller(
      ctx,
      identity,
      args.eventSlug,
      "read",
    );
    const list = await Cfp.listProposals(ctx, caller, { status: args.status });
    return {
      eventSlug: caller.event.slug,
      capped: list.capped,
      // A truncated list read as a complete one is a wrong answer, not a
      // shorter one — say so in the payload the model actually reads.
      note: list.capped
        ? "This event has more proposals than one read returns; this list is incomplete."
        : undefined,
      proposals: list.rows.map((row) => ({
        proposalId: row.proposal._id as string,
        title: row.proposal.title,
        status: row.proposal.status,
        speakerCount: row.speakerCount,
        submittedAt: row.proposal.submittedAt,
        updatedAt: row.proposal.updatedAt,
        withdrawnAt: row.proposal.withdrawnAt,
      })),
    };
  },
});

export const getProposal = internalQuery({
  args: { ...eventArgs, proposalId: v.string() },
  returns: v.object({
    eventSlug: v.string(),
    proposalId: v.string(),
    title: v.string(),
    status: vProposalStatus,
    submittedAt: v.optional(v.number()),
    updatedAt: v.number(),
    answers: v.record(v.string(), vAnswerValue),
    speakers: v.array(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        email: v.optional(v.string()),
        tagline: v.optional(v.string()),
        bio: v.optional(v.string()),
      }),
    ),
    submitter: v.object({
      name: v.union(v.string(), v.null()),
      email: v.union(v.string(), v.null()),
    }),
    fileUrls: v.record(v.string(), v.union(v.string(), v.null())),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    const caller = await apiKeyEventCaller(
      ctx,
      identity,
      args.eventSlug,
      "read",
    );
    // The id arrives as agent-authored text; normalize it rather than casting,
    // so a malformed string is a refusal instead of a runtime surprise.
    const proposalId = ctx.db.normalizeId("proposals", args.proposalId);
    if (proposalId === null) {
      notFound("proposal", "No such proposal on this event.");
    }
    const detail = await Cfp.getProposalDetail(ctx, caller, proposalId);
    return {
      eventSlug: caller.event.slug,
      proposalId: detail.proposal._id as string,
      title: detail.proposal.title,
      status: detail.proposal.status,
      submittedAt: detail.proposal.submittedAt,
      updatedAt: detail.proposal.updatedAt,
      answers: detail.proposal.answers,
      speakers: detail.speakers.map((speaker) => ({
        firstName: speaker.firstName,
        lastName: speaker.lastName,
        email: speaker.email,
        tagline: speaker.tagline,
        bio: speaker.bio,
      })),
      submitter: detail.submitter,
      fileUrls: detail.fileUrls,
    };
  },
});

/**
 * Review completion. Organizers get the whole board; a reviewer-scoped key
 * gets its own assignments — the same split the UI makes, so a reviewer key
 * is useful without ever seeing another reviewer's scores.
 */
export const reviewProgress = internalQuery({
  args: eventArgs,
  returns: v.object({
    eventSlug: v.string(),
    scope: v.union(
      v.literal("whole event"),
      v.literal("your assignments only"),
    ),
    byProposal: v.optional(
      v.array(
        v.object({
          proposalId: v.string(),
          assigned: v.number(),
          submitted: v.number(),
          conflicts: v.number(),
          avgScore: v.union(v.number(), v.null()),
        }),
      ),
    ),
    byReviewer: v.optional(
      v.array(
        v.object({
          name: v.union(v.string(), v.null()),
          email: v.union(v.string(), v.null()),
          roundName: v.string(),
          assigned: v.number(),
          submitted: v.number(),
          conflicts: v.number(),
        }),
      ),
    ),
    assignments: v.optional(
      v.array(
        v.object({
          proposalId: v.string(),
          title: v.string(),
          status: v.string(),
          roundName: v.string(),
        }),
      ),
    ),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    const caller = await apiKeyEventCaller(
      ctx,
      identity,
      args.eventSlug,
      "read",
    );
    if (caller.role !== "organizer") {
      const mine = await Reviews.myAssignments(ctx, caller);
      return {
        eventSlug: caller.event.slug,
        scope: "your assignments only" as const,
        assignments: mine.map((row) => ({
          proposalId: row.proposal._id as string,
          title: row.proposal.title,
          status: row.status,
          roundName: row.round.name,
        })),
      };
    }
    const [byProposal, byReviewer] = await Promise.all([
      Reviews.reviewProgress(ctx, caller),
      Reviews.reviewerProgress(ctx, caller),
    ]);
    return {
      eventSlug: caller.event.slug,
      scope: "whole event" as const,
      byProposal: Object.entries(byProposal).map(([proposalId, entry]) => ({
        proposalId,
        assigned: entry.assigned,
        submitted: entry.submitted,
        conflicts: entry.conflicts,
        avgScore: entry.avgScore,
      })),
      byReviewer: byReviewer.map((row) => ({
        name: row.name,
        email: row.email,
        roundName: row.roundName,
        assigned: row.assigned,
        submitted: row.submitted,
        conflicts: row.conflicts,
      })),
    };
  },
});

export const listSessions = internalQuery({
  args: eventArgs,
  returns: v.object({
    eventSlug: v.string(),
    capped: v.boolean(),
    note: v.optional(v.string()),
    sessions: v.array(
      v.object({
        sessionId: v.string(),
        title: v.string(),
        description: v.optional(v.string()),
        format: v.optional(v.string()),
        status: v.union(v.literal("planned"), v.literal("cancelled")),
        contentStatus: v.union(v.literal("draft"), v.literal("approved")),
        source: v.union(v.literal("cfp"), v.literal("direct")),
        startsAt: v.optional(v.number()),
        endsAt: v.optional(v.number()),
        scheduled: v.boolean(),
        speakers: v.array(vSpeakerName),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    const caller = await apiKeyEventCaller(
      ctx,
      identity,
      args.eventSlug,
      "read",
    );
    const list = await Sessions.listSessionsCapped(ctx, caller);
    return {
      eventSlug: caller.event.slug,
      capped: list.capped,
      // Say what is actually uncertain. Three different reads feed this flag
      // (sessions, participants, speaker identities), so naming only the
      // first would be a specific claim the flag does not support.
      note: list.capped
        ? "This read hit a size ceiling: some sessions and/or their speakers may be missing from this answer. Treat it as a sample, not the whole programme."
        : undefined,
      sessions: list.rows.map((row) => ({
        sessionId: row.session._id as string,
        title: row.session.title,
        description: row.session.description,
        format: row.session.format,
        status: row.session.status,
        // Absent means approved: legacy rows were already being served.
        contentStatus: row.session.contentStatus ?? ("approved" as const),
        source: row.session.source,
        startsAt: row.session.startsAt,
        endsAt: row.session.endsAt,
        scheduled: row.session.startsAt !== undefined,
        speakers: row.participants.map((p) => ({
          name: `${p.firstName} ${p.lastName}`.trim(),
          role: p.role,
          state: p.state,
        })),
      })),
    };
  },
});

export const taskDashboard = internalQuery({
  args: eventArgs,
  returns: v.object({
    eventSlug: v.string(),
    asOf: v.number(),
    speakers: v.array(
      v.object({
        name: v.string(),
        state: vParticipantState,
        claimed: v.boolean(),
        missingBio: v.boolean(),
        missingHeadshot: v.boolean(),
        outstandingTasks: v.number(),
        overdueTasks: v.number(),
      }),
    ),
    sessions: v.array(
      v.object({
        sessionId: v.string(),
        title: v.string(),
        readiness: v.object({
          status: v.union(
            v.literal("ready"),
            v.literal("needsAttention"),
            v.literal("blocked"),
          ),
          reasons: v.array(v.string()),
        }),
      }),
    ),
    totals: v.object({
      confirmed: v.number(),
      awaiting: v.number(),
      declined: v.number(),
      withdrawn: v.number(),
      acceptedSpeakers: v.number(),
      missingProfile: v.number(),
      overdue: v.number(),
    }),
    blockers: v.object({
      contentDrafts: v.number(),
      unscheduled: v.number(),
      scheduleConflicts: v.number(),
      blockedSessions: v.number(),
      rows: v.array(vControlRow),
    }),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    const caller = await apiKeyEventCaller(
      ctx,
      identity,
      args.eventSlug,
      "read",
    );
    // Overdue state depends on "now", which a query must be told rather than
    // read — the action supplies it with every call.
    const dashboard = await Readiness.dashboard(ctx, caller, args.now);
    return {
      eventSlug: caller.event.slug,
      asOf: args.now,
      speakers: dashboard.speakers.map((speaker) => ({
        name: speaker.name,
        state: speaker.state,
        claimed: speaker.claimed,
        missingBio: speaker.missingBio,
        missingHeadshot: speaker.missingHeadshot,
        outstandingTasks: speaker.outstandingTasks,
        overdueTasks: speaker.overdueTasks,
      })),
      sessions: dashboard.sessions.map((session) => ({
        sessionId: session.sessionId as string,
        title: session.title,
        readiness: {
          status: session.readiness.status,
          reasons: session.readiness.reasons,
        },
      })),
      totals: dashboard.totals,
      blockers: {
        contentDrafts: dashboard.blockers.contentDrafts,
        unscheduled: dashboard.blockers.unscheduled,
        scheduleConflicts: dashboard.blockers.scheduleConflicts,
        blockedSessions: dashboard.blockers.blockedSessions,
        rows: dashboard.blockers.rows,
      },
    };
  },
});

export const agendaBoard = internalQuery({
  args: eventArgs,
  returns: v.object({
    eventSlug: v.string(),
    timezone: v.string(),
    rooms: v.array(v.object({ name: v.string(), capacity: v.optional(v.number()) })),
    tracks: v.array(v.object({ name: v.string() })),
    scheduled: v.array(
      v.object({
        sessionId: v.string(),
        title: v.string(),
        format: v.optional(v.string()),
        durationMinutes: v.number(),
        startsAt: v.number(),
        endsAt: v.number(),
        room: v.union(v.string(), v.null()),
        track: v.union(v.string(), v.null()),
        pendingRelease: v.boolean(),
        speakers: v.array(v.string()),
        conflicts: v.array(vConflict),
      }),
    ),
    unscheduled: v.array(
      v.object({
        sessionId: v.string(),
        title: v.string(),
        format: v.optional(v.string()),
        durationMinutes: v.number(),
        speakers: v.array(v.string()),
      }),
    ),
    agendaItems: v.array(
      v.object({
        title: v.string(),
        startsAt: v.number(),
        endsAt: v.number(),
        room: v.union(v.string(), v.null()),
        description: v.optional(v.string()),
        conflicts: v.array(vConflict),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    const caller = await apiKeyEventCaller(
      ctx,
      identity,
      args.eventSlug,
      "read",
    );
    const board = await Agenda.boardData(ctx, caller);
    // Room and track ids mean nothing outside StageStack; a name is what an
    // agent can put in a sentence, so the board is resolved to names here.
    const roomName = new Map(board.rooms.map((r) => [r.roomId as string, r.name]));
    const trackName = new Map(
      board.tracks.map((t) => [t.trackId as string, t.name]),
    );
    const speakerNames = (
      participants: Array<{ firstName: string; lastName: string }>,
    ) => participants.map((p) => `${p.firstName} ${p.lastName}`.trim());

    const placed = board.sessions.filter(
      (session) => session.startsAt !== undefined && session.endsAt !== undefined,
    );
    return {
      eventSlug: caller.event.slug,
      timezone: board.event.timezone,
      rooms: board.rooms.map((room) => ({
        name: room.name,
        capacity: room.capacity,
      })),
      tracks: board.tracks.map((track) => ({ name: track.name })),
      scheduled: placed.map((session) => ({
        sessionId: session.sessionId as string,
        title: session.title,
        format: session.format,
        durationMinutes: session.durationMinutes,
        startsAt: session.startsAt as number,
        endsAt: session.endsAt as number,
        room:
          session.roomId === undefined
            ? null
            : (roomName.get(session.roomId as string) ?? null),
        track:
          session.trackId === undefined
            ? null
            : (trackName.get(session.trackId as string) ?? null),
        pendingRelease: session.pendingRelease,
        speakers: speakerNames(session.participants),
        conflicts: projectConflicts(session.conflicts),
      })),
      unscheduled: board.sessions
        .filter((session) => session.startsAt === undefined)
        .map((session) => ({
          sessionId: session.sessionId as string,
          title: session.title,
          format: session.format,
          durationMinutes: session.durationMinutes,
          speakers: speakerNames(session.participants),
        })),
      agendaItems: board.agendaItems.map((item) => ({
        title: item.title,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        room:
          item.roomId === undefined
            ? null
            : (roomName.get(item.roomId as string) ?? null),
        description: item.description,
        conflicts: projectConflicts(item.conflicts),
      })),
    };
  },
});

const vDiffEntry = v.object({
  title: v.string(),
  changes: v.array(v.string()),
});

const vChannelDiff = v.object({
  sentence: v.string(),
  empty: v.boolean(),
  doesNothing: v.boolean(),
  servedCount: v.number(),
  wouldBeCount: v.number(),
  added: v.array(vDiffEntry),
  changed: v.array(vDiffEntry),
  removed: v.array(vDiffEntry),
});

export const publishState = internalQuery({
  args: eventArgs,
  returns: v.object({
    eventSlug: v.string(),
    state: v.object({
      lineupPublished: v.boolean(),
      agendaPublished: v.boolean(),
      stale: v.boolean(),
      version: v.union(v.number(), v.null()),
      publishedAt: v.union(v.number(), v.null()),
      acceptedSessions: v.number(),
      releasedSessions: v.number(),
      publishedSessionCount: v.number(),
      publishedAgendaItemCount: v.number(),
    }),
    diff: v.object({
      neverPublished: v.boolean(),
      lineup: vChannelDiff,
      agenda: vChannelDiff,
    }),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    const caller = await apiKeyEventCaller(
      ctx,
      identity,
      args.eventSlug,
      "read",
    );
    const [state, diff] = await Promise.all([
      Publish.publishState(ctx, caller),
      Publish.programDiff(ctx, caller),
    ]);
    // `state.preview` — the whole published program blob — is deliberately NOT
    // here: an agent asking "is the public page current" wants the answer, not
    // a second copy of the program it can already read from the public API.
    const channel = (from: typeof diff.lineup) => ({
      sentence: from.sentence,
      empty: from.empty,
      doesNothing: from.doesNothing,
      servedCount: from.servedCount,
      wouldBeCount: from.wouldBeCount,
      added: from.added.map((e) => ({ title: e.title, changes: e.changes })),
      changed: from.changed.map((e) => ({ title: e.title, changes: e.changes })),
      removed: from.removed.map((e) => ({ title: e.title, changes: e.changes })),
    });
    return {
      eventSlug: caller.event.slug,
      state: {
        lineupPublished: state.lineupPublished,
        agendaPublished: state.agendaPublished,
        stale: state.stale,
        version: state.version,
        publishedAt: state.publishedAt,
        acceptedSessions: state.acceptedSessions,
        releasedSessions: state.releasedSessions,
        publishedSessionCount: state.publishedSessionIds.length,
        publishedAgendaItemCount: state.publishedAgendaItemIds.length,
      },
      diff: {
        neverPublished: diff.neverPublished,
        lineup: channel(diff.lineup),
        agenda: channel(diff.agenda),
      },
    };
  },
});

/**
 * The review queue: speaker work that is sitting in front of an organizer.
 *
 * This exists because D3's two review tools need an id, and no other read tool
 * emits one — `task_dashboard` counts obligations, it does not name them. A
 * write tool an agent cannot address is not a thinner surface, it is a broken
 * one, so the discovery half ships with the acting half.
 *
 * TRUNCATES rather than refuses: an event's whole task table can be thousands
 * of rows, and a review queue is a worklist, not a fact about the event. The
 * cap is named in the payload, as everywhere else here.
 */
export const TASK_REVIEW_CAP = 200;

export const listTaskReviews = internalQuery({
  args: { ...eventArgs, status: v.optional(vTaskStatus) },
  returns: v.object({
    eventSlug: v.string(),
    status: vTaskStatus,
    capped: v.boolean(),
    note: v.optional(v.string()),
    tasks: v.array(
      v.object({
        taskId: v.string(),
        requirementTitle: v.string(),
        sessionTitle: v.string(),
        speakerName: v.optional(v.string()),
        status: vTaskStatus,
        evidence: v.union(
          v.literal("file"),
          v.literal("profileField"),
          v.literal("manual"),
        ),
        reviewRequired: v.boolean(),
        dueAt: v.number(),
        uploadCount: v.number(),
        reviewNote: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const identity = await identify(ctx, args.presentedKey, args.now);
    const caller = await apiKeyEventCaller(
      ctx,
      identity,
      args.eventSlug,
      "read",
    );
    // Default to the queue the tool exists for: work submitted and awaiting a
    // decision. Any other status is asked for explicitly.
    const status = args.status ?? "provided";
    const { rows, capped } = await Tasks.reviewQueue(
      ctx,
      caller,
      status,
      TASK_REVIEW_CAP,
    );
    return {
      eventSlug: caller.event.slug,
      status,
      capped,
      note: capped
        ? `More than ${TASK_REVIEW_CAP} tasks are in this state; this is the first ${TASK_REVIEW_CAP}, not the whole queue.`
        : undefined,
      tasks: rows.map((row) => ({
        taskId: row.instanceId as string,
        requirementTitle: row.requirementTitle,
        sessionTitle: row.sessionTitle,
        speakerName: row.speakerName,
        status: row.status,
        evidence: row.evidence,
        reviewRequired: row.reviewRequired,
        dueAt: row.dueAt,
        uploadCount: row.uploadCount,
        reviewNote: row.reviewNote,
      })),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Write tools (D3). Reversible, non-outbound-by-design writes only. What is
// deliberately NOT here — outbound campaigns (`comms.sendBulkOutreach` /
// `sendOneOff`), publishing (`publish.bulkPublish` / `setLineup`), contact
// `merge`, and anything minting invitations or touching membership — is listed
// in PLAN.md D3 so that nobody adds it by reflex. There is no toggle: the
// absence of a tool is the mechanism.
//
// Four properties every one of these has, and none may quietly lose:
//
//  1. `intent: "write"`, so `assertCeilingAllows` refuses a read-ceiling key
//     BEFORE a record is read. The ceiling is the whole point of the key.
//  2. The capability in `convex/model/*` is called unchanged, so it re-checks
//     `requireOrganizer` and `assertEventActive` against the minter's LIVE
//     role. An organizer-ceiling key minted by someone since demoted to
//     reviewer is refused by the model layer, not by anything here.
//  3. The capability call is wrapped in `withAgentAudit`, which marks the
//     audit rows the capability ACTUALLY WROTE with `viaAgent: true` and the
//     key's prefix, in the same transaction. No tool writes an audit row of
//     its own: one act stays one row, a call that changed nothing records
//     nothing, and the flagged row carries the capability's normalized values
//     rather than the tool's copy of its arguments. (See model/apiKeys.ts for
//     the design and the first, wrong version of it.)
//  4. `Date.now()` is read HERE, server-side. The read tools are told `now` by
//     the action because a query must not read the clock; a mutation may, and
//     a WRITE must never let the caller choose the instant its credential's
//     expiry is measured against.
//
// Rate limiting needs nothing new and deliberately gets nothing new: the
// per-key bucket is spent by `authenticate` in `convex/http.ts`, once per HTTP
// REQUEST, before the SDK is handed the body — so a `tools/call` naming a write
// tool has already paid exactly as a read would. Spending again in here would
// charge one agent action twice and make the published "300 calls a minute"
// mean two different things depending on which tool you picked.
// ─────────────────────────────────────────────────────────────────────────

const writeArgs = { presentedKey: v.string(), eventSlug: v.string() };

/** Resolve the key for a write on one event. Refuses a read-ceiling key, a key
 * scoped to another event, and a key whose minter's membership is gone. */
async function writeCaller(
  ctx: MutationCtx,
  args: { presentedKey: string; eventSlug: string },
): Promise<{ identity: ApiKeyIdentity; caller: EventCaller }> {
  const identity = await resolveCallerFromApiKey(
    ctx,
    args.presentedKey,
    Date.now(),
  );
  const caller = await apiKeyEventCaller(
    ctx,
    identity,
    args.eventSlug,
    "write",
  );
  return { identity, caller };
}

/** Agent-authored ids are text. Normalize rather than cast, so a malformed one
 * is a registered refusal instead of a runtime surprise. */
function requireId<T extends "sessions" | "taskInstances">(
  ctx: MutationCtx,
  table: T,
  raw: string,
  what: string,
): Id<T> {
  const id = ctx.db.normalizeId(table, raw);
  if (id === null) notFound(what, `No such ${what} on this event.`);
  return id;
}

/**
 * Edit a session's content — the same capability the organizer's session
 * editor calls, including its revision history, so an agent's edit is
 * inspectable and restorable exactly like a human one.
 */
export const updateSessionContent = internalMutation({
  args: {
    ...writeArgs,
    sessionId: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    format: v.optional(v.string()),
    durationMinutes: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.object({
    eventSlug: v.string(),
    sessionId: v.string(),
    revisionRecorded: v.boolean(),
    title: v.string(),
    description: v.optional(v.string()),
    format: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
    contentStatus: v.union(v.literal("draft"), v.literal("approved")),
  }),
  handler: async (ctx, args) => {
    const { identity, caller } = await writeCaller(ctx, args);
    const sessionId = requireId(ctx, "sessions", args.sessionId, "session");
    const { result } = await ApiKeys.withAgentAudit(
      ctx,
      identity,
      caller.event._id,
      () =>
        Sessions.updateContent(ctx, caller, sessionId, {
          title: args.title,
          description: args.description,
          format: args.format,
          durationMinutes: args.durationMinutes,
        }),
    );
    const revisionId = result.revisionId;
    // Read back rather than echo the request: what the agent is told is what
    // the capability actually stored, after its own trimming and clamping.
    const session = await ctx.db.get("sessions", sessionId);
    if (session === null) notFound("session", "No such session on this event.");
    return {
      eventSlug: caller.event.slug,
      sessionId: sessionId as string,
      revisionRecorded: revisionId !== null,
      title: session.title,
      description: session.description,
      format: session.format,
      durationMinutes: session.durationMinutes,
      contentStatus: session.contentStatus ?? ("approved" as const),
    };
  },
});

/** Shared projection for both review decisions: the task as it now stands. */
const vTaskOutcome = v.object({
  eventSlug: v.string(),
  taskId: v.string(),
  requirementTitle: v.string(),
  sessionTitle: v.string(),
  status: vTaskStatus,
  reviewNote: v.optional(v.string()),
});

async function projectTask(
  ctx: MutationCtx,
  caller: EventCaller,
  instanceId: Id<"taskInstances">,
): Promise<{
  eventSlug: string;
  taskId: string;
  requirementTitle: string;
  sessionTitle: string;
  status: Doc<"taskInstances">["status"];
  reviewNote: string | undefined;
}> {
  const instance = await ctx.db.get("taskInstances", instanceId);
  if (instance === null) notFound("task", "No such task on this event.");
  const requirement = await ctx.db.get("requirements", instance.requirementId);
  const session = await ctx.db.get("sessions", instance.sessionId);
  return {
    eventSlug: caller.event.slug,
    taskId: instanceId as string,
    requirementTitle: requirement?.title ?? "",
    sessionTitle: session?.title ?? "",
    status: instance.status,
    reviewNote: instance.reviewNote,
  };
}

/** Accept submitted speaker work. Sends nothing. */
export const approveTask = internalMutation({
  args: { ...writeArgs, taskId: v.string() },
  returns: vTaskOutcome,
  handler: async (ctx, args) => {
    const { identity, caller } = await writeCaller(ctx, args);
    const instanceId = requireId(ctx, "taskInstances", args.taskId, "task");
    await ApiKeys.withAgentAudit(ctx, identity, caller.event._id, () =>
      Tasks.approveInstance(ctx, caller, instanceId),
    );
    return await projectTask(ctx, caller, instanceId);
  },
});

/**
 * Send submitted speaker work back with a note.
 *
 * This one DOES notify: `Tasks.requestChanges` mails whoever owes the work
 * (falling back to the session's manager, then the organizers), because a
 * change request nobody is told about is not a change request. That is the
 * capability's own rule, not something added for agents — and it is why the
 * tool description says so in the first sentence rather than in a footnote.
 */
export const requestTaskChanges = internalMutation({
  args: { ...writeArgs, taskId: v.string(), note: v.string() },
  returns: vTaskOutcome,
  handler: async (ctx, args) => {
    const { identity, caller } = await writeCaller(ctx, args);
    const instanceId = requireId(ctx, "taskInstances", args.taskId, "task");
    // The note travels no further than the capability: it is what trims it,
    // caps it, stores it and mails it, and its own audit row is what records
    // the value it actually used.
    await ApiKeys.withAgentAudit(ctx, identity, caller.event._id, () =>
      Tasks.requestChanges(ctx, caller, instanceId, args.note),
    );
    return await projectTask(ctx, caller, instanceId);
  },
});

/**
 * Place a session on the board, or send it back to the unscheduled tray.
 *
 * Rooms are addressed BY NAME: a room id means nothing outside StageStack, and
 * `agenda_board` — the read an agent uses to plan a move — only ever emits
 * names. An unknown or ambiguous name is a refusal, never a silent placement
 * in no room at all.
 */
export const scheduleSession = internalMutation({
  args: {
    ...writeArgs,
    sessionId: v.string(),
    slot: v.union(
      v.object({
        startsAt: v.number(),
        endsAt: v.number(),
        room: v.optional(v.string()),
      }),
      v.null(),
    ),
  },
  returns: v.object({
    eventSlug: v.string(),
    sessionId: v.string(),
    title: v.string(),
    scheduled: v.boolean(),
    startsAt: v.union(v.number(), v.null()),
    endsAt: v.union(v.number(), v.null()),
    room: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const { identity, caller } = await writeCaller(ctx, args);
    const sessionId = requireId(ctx, "sessions", args.sessionId, "session");
    const slot = args.slot;
    const roomId =
      slot === null || slot.room === undefined
        ? undefined
        : await Agenda.resolveRoomByName(ctx, caller.event, slot.room);
    await ApiKeys.withAgentAudit(ctx, identity, caller.event._id, () =>
      Agenda.scheduleSession(
        ctx,
        caller,
        sessionId,
        slot === null
          ? null
          : { startsAt: slot.startsAt, endsAt: slot.endsAt, roomId },
      ),
    );
    const session = await ctx.db.get("sessions", sessionId);
    if (session === null) notFound("session", "No such session on this event.");
    const room =
      session.roomId === undefined
        ? null
        : ((await ctx.db.get("rooms", session.roomId))?.name ?? null);
    return {
      eventSlug: caller.event.slug,
      sessionId: sessionId as string,
      title: session.title,
      scheduled: session.startsAt !== undefined,
      startsAt: session.startsAt ?? null,
      endsAt: session.endsAt ?? null,
      room,
    };
  },
});
