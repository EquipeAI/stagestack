/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { durationPhrase, percentile } from "./model/analytics";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
  type TestT,
} from "./test.helpers";

// ─────────────────────────────────────────────────────────────────────────
// W4 — turnaround analytics.
//
// The rules worth breaking the build over:
//   • an OPEN interval is never a data point — it is counted separately and
//     said out loud, never averaged in as a zero or as "so far";
//   • an EMPTY population produces a sentence, never a median of nothing;
//   • every sentence states its population size, and a capped read says
//     "at least N" in the same vocabulary the control center already uses;
//   • the panel is organizer-only, like every other control-center panel.
//
// Only Date is faked (`toFake: ["Date"]`): convex-test stamps `_creationTime`
// from `Date.now()`, and these intervals ARE creation times — but faking the
// timer queue as well would strand the harness's own scheduled work. Fixtures
// are therefore seeded strictly forward in time, because convex-test keeps
// `_creationTime` monotonic and would quietly collapse a backwards clock into
// millisecond ticks.
// ─────────────────────────────────────────────────────────────────────────

const T0 = Date.parse("2026-06-01T09:00:00Z");
const DAY = 24 * 3600_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Move the clock forward, then write. Every fixture below is chronological. */
function at(offsetDays: number): void {
  vi.setSystemTime(T0 + offsetDays * DAY);
}

type Panel = {
  stats: Array<{
    id: string;
    label: string;
    count: number;
    openCount: number;
    p50: number | null;
    p90: number | null;
    capped: boolean;
    sentence: string;
  }>;
  capped: boolean;
  summary: string;
};

const statOf = (panel: Panel, id: string) => {
  const stat = panel.stats.find((s) => s.id === id);
  if (stat === undefined) throw new Error(`no stat ${id}`);
  return stat;
};

async function seed() {
  const t = setupTest();
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
  const eventId = await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
      .unique();
    if (event === null) throw new Error("no event");
    return event._id;
  });
  const orgId = await t.run(async (ctx) => {
    const event = await ctx.db.get("events", eventId);
    if (event === null) throw new Error("no event");
    return event.orgId;
  });
  const actorUserId = await t.run(async (ctx) => {
    const user = await ctx.db.query("users").first();
    if (user === null) throw new Error("no user");
    return user._id;
  });
  return { t, alice, orgSlug, eventSlug, eventId, orgId, actorUserId };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function audit(
  s: Seeded,
  action: string,
  entry: {
    targetType?: string;
    targetId?: string;
    meta?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await s.t.run(async (ctx) => {
    await ctx.db.insert("auditLog", {
      orgId: s.orgId,
      eventId: s.eventId,
      actorUserId: s.actorUserId,
      action,
      ...entry,
    });
  });
}

async function addProposal(s: Seeded, title: string): Promise<Id<"proposals">> {
  return await s.t.run(async (ctx) => {
    return await ctx.db.insert("proposals", {
      eventId: s.eventId,
      submitterUserId: s.actorUserId,
      status: "pending",
      title,
      answers: {},
      formVersion: 1,
      updatedAt: Date.now(),
    });
  });
}

async function addSession(
  s: Seeded,
  title: string,
  fields: {
    proposalId?: Id<"proposals">;
    contentStatus?: "draft" | "approved";
    contentStatusSetAt?: number;
  } = {},
): Promise<Id<"sessions">> {
  return await s.t.run(async (ctx) => {
    return await ctx.db.insert("sessions", {
      eventId: s.eventId,
      title,
      format: "Talk",
      source: fields.proposalId === undefined ? "direct" : "cfp",
      status: "planned",
      ...fields,
    });
  });
}

async function addParticipant(
  s: Seeded,
  sessionId: Id<"sessions">,
  name: string,
  state: "awaiting" | "confirmed" | "declined" | "withdrawn",
): Promise<Id<"sessionParticipants">> {
  return await s.t.run(async (ctx) => {
    const eventContactId = await ctx.db.insert("eventContacts", {
      eventId: s.eventId,
      orgId: s.orgId,
      firstName: name,
      lastName: "Speaker",
      email: `${name.toLowerCase()}@example.com`,
    });
    return await ctx.db.insert("sessionParticipants", {
      sessionId,
      eventId: s.eventId,
      eventContactId,
      role: "speaker",
      state,
    });
  });
}

async function addTask(
  s: Seeded,
  fields: {
    status:
      | "pending"
      | "provided"
      | "changesRequested"
      | "approved"
      | "complete"
      | "notApplicable";
    completedAt?: number;
  },
): Promise<Id<"taskInstances">> {
  return await s.t.run(async (ctx) => {
    const requirementId = await ctx.db.insert("requirements", {
      eventId: s.eventId,
      title: "Send us your slides",
      scope: "session",
      evidence: "manual",
      reviewRequired: false,
      dueAt: T0 + 30 * DAY,
      active: true,
    });
    const sessionId = await ctx.db.insert("sessions", {
      eventId: s.eventId,
      title: "Task carrier",
      format: "Talk",
      source: "direct",
      status: "planned",
    });
    return await ctx.db.insert("taskInstances", {
      requirementId,
      eventId: s.eventId,
      sessionId,
      status: fields.status,
      dueAt: T0 + 30 * DAY,
      completedAt: fields.completedAt,
      updatedAt: Date.now(),
    });
  });
}

// ── The intervals ────────────────────────────────────────────────────────

describe("turnaround — each interval, computed from the rows already written", () => {
  test("decisions are timed from submission to release, and the undecided are counted, not averaged", async () => {
    const s = await seed();
    const fast = await addProposal(s, "Fast");
    const mid = await addProposal(s, "Mid");
    const slow = await addProposal(s, "Slow");
    const never = await addProposal(s, "Never");
    for (const id of [fast, mid, slow, never]) {
      await audit(s, "cfp.submit", { targetType: "proposal", targetId: id });
    }

    at(2);
    await audit(s, "decision.release", {
      targetType: "proposal",
      targetId: fast,
    });
    at(4);
    await audit(s, "decision.release", {
      targetType: "proposal",
      targetId: mid,
    });
    at(9);
    await audit(s, "decision.release", {
      targetType: "proposal",
      targetId: slow,
    });

    const panel = (await s.alice.query(api.analytics.turnaround, {
      eventSlug: s.eventSlug,
    })) as Panel;
    const stat = statOf(panel, "decision");

    expect(stat.count).toBe(3);
    expect(stat.openCount).toBe(1);
    expect(stat.sentence).toBe(
      "Decisions released in a median of 4 days after the proposal arrived, across 3 proposals; the slowest tenth took 9 days; 1 proposal is still undecided.",
    );
    expect(panel.capped).toBe(false);
  });

  test("a withdrawn proposal is neither timed nor chased", async () => {
    const s = await seed();
    const gone = await addProposal(s, "Withdrawn");
    await audit(s, "cfp.submit", { targetType: "proposal", targetId: gone });
    at(1);
    await audit(s, "cfp.withdraw", { targetType: "proposal", targetId: gone });

    const panel = (await s.alice.query(api.analytics.turnaround, {
      eventSlug: s.eventSlug,
    })) as Panel;
    const stat = statOf(panel, "decision");

    expect(stat.count).toBe(0);
    expect(stat.openCount).toBe(0);
    expect(stat.sentence).toBe(
      "No proposal has been submitted yet, so there is no decision turnaround to report.",
    );
  });

  test("confirmations are timed from the release that reached the speaker", async () => {
    const s = await seed();
    const proposalId = await addProposal(s, "Accepted talk");
    const sessionId = await addSession(s, "Accepted talk", { proposalId });
    const quick = await addParticipant(s, sessionId, "Quick", "confirmed");
    const slow = await addParticipant(s, sessionId, "Slow", "confirmed");
    await addParticipant(s, sessionId, "Silent", "awaiting");
    // A declined speaker ANSWERED: not a confirmation time, not an open one.
    await addParticipant(s, sessionId, "Declined", "declined");

    await audit(s, "decision.release", {
      targetType: "proposal",
      targetId: proposalId,
    });
    at(1);
    await audit(s, "participation.setState", {
      targetType: "sessionParticipant",
      targetId: quick,
      meta: { to: "confirmed" },
    });
    at(5);
    await audit(s, "participation.setState", {
      targetType: "sessionParticipant",
      targetId: slow,
      meta: { to: "confirmed" },
    });

    const panel = (await s.alice.query(api.analytics.turnaround, {
      eventSlug: s.eventSlug,
    })) as Panel;
    const stat = statOf(panel, "confirmation");

    expect(stat.count).toBe(2);
    expect(stat.openCount).toBe(1);
    expect(stat.sentence).toBe(
      "Speakers confirmed in a median of 1 day after the decision was released, across 2 speakers; the slowest tenth took 5 days; 1 speaker is still to answer.",
    );
  });

  test("tasks are timed from the moment the instance existed, and Not Applicable is not a completion", async () => {
    const s = await seed();
    const done = await addTask(s, { status: "complete" });
    await addTask(s, { status: "pending" });
    await addTask(s, { status: "notApplicable" });
    at(3);
    await audit(s, "task.markProvided", {
      targetType: "taskInstance",
      targetId: done,
    });

    const panel = (await s.alice.query(api.analytics.turnaround, {
      eventSlug: s.eventSlug,
    })) as Panel;
    const stat = statOf(panel, "task");

    expect(stat.count).toBe(1);
    expect(stat.openCount).toBe(1);
    expect(stat.sentence).toBe(
      "Tasks completed in a median of 3 days after they were assigned, across 1 task; the slowest tenth took 3 days; 1 task is still open.",
    );
  });

  test("a task settled without an audit row falls back to its own completedAt", async () => {
    const s = await seed();
    await addTask(s, { status: "approved", completedAt: T0 + 6 * DAY });

    const panel = (await s.alice.query(api.analytics.turnaround, {
      eventSlug: s.eventSlug,
    })) as Panel;
    const stat = statOf(panel, "task");

    expect(stat.count).toBe(1);
    expect(stat.p50).toBeGreaterThan(5.9 * DAY);
    expect(stat.sentence).toBe(
      "Tasks completed in a median of 6 days after they were assigned, across 1 task; the slowest tenth took 6 days; none are still open.",
    );
  });

  test("publish latency is timed from content approval, including a bulk publish that left no per-session row", async () => {
    const s = await seed();
    const solo = await addSession(s, "Individually published", {
      contentStatus: "approved",
    });
    const bulk = await addSession(s, "Bulk published", {
      contentStatus: "approved",
    });
    const waiting = await addSession(s, "Approved, never published", {
      contentStatus: "approved",
    });
    for (const id of [solo, bulk, waiting]) {
      await audit(s, "sessions.setContentStatus", {
        targetType: "session",
        targetId: id,
        meta: { to: "approved" },
      });
    }

    at(2);
    await audit(s, "publish.session", {
      meta: { kind: "session", sessionId: solo, published: true },
    });
    at(4);
    // The bulk path writes one event-wide row and flips flags: the flag is the
    // only per-session record of when this one went public.
    await s.t.run(async (ctx) => {
      await ctx.db.insert("publicationFlags", {
        eventId: s.eventId,
        targetType: "session",
        targetId: bulk,
        published: true,
        updatedAt: Date.now(),
      });
    });

    const panel = (await s.alice.query(api.analytics.turnaround, {
      eventSlug: s.eventSlug,
    })) as Panel;
    const stat = statOf(panel, "publish");

    expect(stat.count).toBe(2);
    expect(stat.openCount).toBe(1);
    expect(stat.sentence).toBe(
      // Nearest-rank: p50 of two observations is the lower one, and both
      // figures are intervals that actually happened.
      "Sessions published in a median of 2 days after their content was approved, across 2 sessions; the slowest tenth took 4 days; 1 session is approved but not published.",
    );
  });
});

// ── Honest emptiness, and honest floors ──────────────────────────────────

describe("turnaround — the empty event and the capped read", () => {
  test("an event with no history gets four sentences and not one zero", async () => {
    const s = await seed();
    const panel = (await s.alice.query(api.analytics.turnaround, {
      eventSlug: s.eventSlug,
    })) as Panel;

    expect(panel.capped).toBe(false);
    expect(panel.stats.map((stat) => stat.sentence)).toEqual([
      "No proposal has been submitted yet, so there is no decision turnaround to report.",
      "No decision has reached a speaker yet, so there is no confirmation turnaround to report.",
      "No task has been assigned yet, so there is no completion turnaround to report.",
      "No session content has been approved yet, so there is no publish latency to report.",
    ]);
    for (const stat of panel.stats) {
      expect(stat.count).toBe(0);
      expect(stat.openCount).toBe(0);
      // A median of nothing is null, never zero: zero is a lie with a number.
      expect(stat.p50).toBeNull();
      expect(stat.p90).toBeNull();
      expect(stat.sentence).not.toMatch(/\b0\b/);
    }
  });

  test("a capped read reports floors, and says so", async () => {
    const s = await seed();
    const first = await addProposal(s, "First");
    await audit(s, "cfp.submit", {
      targetType: "proposal",
      targetId: first,
    });
    at(3);
    await audit(s, "decision.release", {
      targetType: "proposal",
      targetId: first,
    });
    // 501 sessions is one past the session ceiling this panel reads.
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 501; i += 1) {
        await ctx.db.insert("sessions", {
          eventId: s.eventId,
          title: `Session ${i}`,
          format: "Talk",
          source: "direct",
          status: "planned",
        });
      }
    });

    const panel = (await s.alice.query(api.analytics.turnaround, {
      eventSlug: s.eventSlug,
    })) as Panel;

    expect(panel.capped).toBe(true);
    expect(panel.summary).toContain("floors from a sample");
    const stat = statOf(panel, "decision");
    expect(stat.capped).toBe(true);
    expect(stat.sentence).toBe(
      "Decisions released in a median of 3 days after the proposal arrived, across at least 1 proposal; the slowest tenth took 3 days; none are still undecided.",
    );
  });
});

// ── The pure helpers ─────────────────────────────────────────────────────

describe("the arithmetic, said in whole units", () => {
  test("percentile is nearest-rank, so every figure is an interval that happened", () => {
    const sorted = [1, 2, 3, 4, 10];
    expect(percentile(sorted, 0.5)).toBe(3);
    expect(percentile(sorted, 0.9)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.9)).toBe(7);
  });

  test("durations round to whole days, hours or minutes", () => {
    expect(durationPhrase(3 * DAY)).toBe("3 days");
    expect(durationPhrase(DAY)).toBe("1 day");
    expect(durationPhrase(5 * 3600_000)).toBe("5 hours");
    expect(durationPhrase(90_000)).toBe("2 minutes");
    expect(durationPhrase(0)).toBe("1 minute");
    // The unit follows the rounded value: never "24 hours", never "60 minutes".
    expect(durationPhrase(DAY - 1)).toBe("1 day");
    expect(durationPhrase(3599_000)).toBe("1 hour");
  });
});

// ── Authorization ────────────────────────────────────────────────────────

describe("turnaround — who may read it", () => {
  test("NEGATIVE: a reviewer is refused", async () => {
    const s = await seed();
    const rita = await signIn(s.t, "rita");
    await grantEventRole(s.t, s.eventSlug, "rita", "reviewer");
    await expectRejectedWith(
      rita.query(api.analytics.turnaround, { eventSlug: s.eventSlug }),
      "forbidden",
    );
  });

  test("NEGATIVE: an organizer of another organization is refused", async () => {
    const s = await seed();
    const bob = await signIn(s.t, "bob");
    await createOrg(bob, "Rival Events");
    await expectRejectedWith(
      bob.query(api.analytics.turnaround, { eventSlug: s.eventSlug }),
      "forbidden",
    );
  });

  test("NEGATIVE: signed out is refused", async () => {
    const s = await seed();
    await expectRejectedWith(
      s.t.query(api.analytics.turnaround, { eventSlug: s.eventSlug }),
      "not_authenticated",
    );
  });
});
