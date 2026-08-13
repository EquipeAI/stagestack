/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  changeSentence,
  genericClause,
  relativeTime,
} from "./model/controlCenter";
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
// W8 — the event control center.
//
// The rules worth breaking the build over:
//   • each panel is its OWN query with its OWN read policy, and the panel that
//     truncates never refuses (one over-ceiling table must cost one panel, not
//     the screen);
//   • the decisions count has ONE producer, so the nav badge and the panel row
//     cannot disagree;
//   • every sentence is composed in the model — including the honest generic
//     one for an action code this build has never seen, which must not crash;
//   • "first event" is measurable, and any one piece of history flips it;
//   • every panel is organizer-only.
// ─────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-12T12:00:00Z");
const DAY = 24 * 3600_000;

async function seed(t: TestT) {
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
  return { alice, orgSlug, eventSlug, eventId };
}

async function addProposal(
  t: TestT,
  eventId: Id<"events">,
  status:
    | "draft"
    | "pending"
    | "acceptQueue"
    | "declineQueue"
    | "accepted"
    | "declined"
    | "withdrawn",
  title = "A talk",
) {
  return await t.run(async (ctx) => {
    const user = await ctx.db.query("users").first();
    if (user === null) throw new Error("no user");
    return await ctx.db.insert("proposals", {
      eventId,
      submitterUserId: user._id,
      status,
      title,
      answers: {},
      formVersion: 1,
      updatedAt: NOW,
    });
  });
}

const rowOf = (
  panel: { rows: Array<{ id: string }> },
  id: string,
) => {
  const row = panel.rows.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row as {
    id: string;
    label: string;
    count: number;
    capped: boolean;
    sentence: string;
    tone: string;
    link: { tab: string; search?: Record<string, string> };
  };
};

// ── The attention panel ──────────────────────────────────────────────────

describe("attentionPanel — the rows the review specified", () => {
  test("the CFP row counts submissions and says when the CFP closes", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("events", eventId, {
        cfpPublished: true,
        cfpOpenAt: NOW - DAY,
        cfpCloseAt: NOW + 6 * DAY,
      });
    });
    await addProposal(t, eventId, "pending");
    await addProposal(t, eventId, "pending", "Another talk");

    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    const cfp = rowOf(panel, "cfp");
    expect(cfp.count).toBe(2);
    expect(cfp.sentence).toBe(
      "The call for speakers closes in 6 days; 2 submissions are waiting for a decision.",
    );
    // The count's destination is the already-filtered inbox, not the CFP
    // builder — a deep link that does not pre-filter is a link to a page.
    expect(cfp.link).toEqual({
      tab: "proposals",
      search: { status: "pending" },
    });
  });

  test("a closed CFP says so in the past tense", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("events", eventId, {
        cfpPublished: true,
        cfpOpenAt: NOW - 10 * DAY,
        cfpCloseAt: NOW - 2 * DAY,
      });
    });

    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    expect(rowOf(panel, "cfp").sentence).toBe(
      "The call for speakers closed 2 days ago; 0 submissions are waiting for a decision.",
    );
  });

  test("staged decisions are counted and deep-link to both queues", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await addProposal(t, eventId, "acceptQueue");
    await addProposal(t, eventId, "acceptQueue", "Second");
    await addProposal(t, eventId, "declineQueue", "Third");
    // Released decisions are NOT staged: they have already been told.
    await addProposal(t, eventId, "accepted", "Fourth");

    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    const decisions = rowOf(panel, "decisions");
    expect(decisions.count).toBe(3);
    expect(decisions.sentence).toBe(
      "3 staged decisions have not been released, so nobody has been told yet.",
    );
    expect(decisions.link).toEqual({
      tab: "proposals",
      search: { status: "acceptQueue,declineQueue" },
    });
  });

  test("the nav badge and the panel row share one producer", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await addProposal(t, eventId, "acceptQueue");
    await addProposal(t, eventId, "declineQueue", "Second");

    const [panel, attention] = await Promise.all([
      alice.query(api.readiness.attentionPanel, { eventSlug, now: NOW }),
      alice.query(api.readiness.attention, { eventSlug }),
    ]);
    expect(attention.counts.decisions).toBe(2);
    expect(attention.counts.decisions).toBe(rowOf(panel, "decisions").count);
  });

  test("reviews name the reviewers who are past their round's close date", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    const proposalId = await addProposal(t, eventId, "pending");
    await t.run(async (ctx) => {
      const user = await ctx.db.query("users").first();
      if (user === null) throw new Error("no user");
      const roundId = await ctx.db.insert("reviewRounds", {
        eventId,
        name: "Round 1",
        order: 0,
        closesAt: NOW - DAY,
        anonymized: false,
        scorecard: [],
        updatedAt: NOW,
      });
      await ctx.db.insert("reviews", {
        eventId,
        proposalId,
        reviewerUserId: user._id,
        roundId,
        status: "assigned",
        updatedAt: NOW,
      });
    });

    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    const reviews = rowOf(panel, "reviews");
    expect(reviews.count).toBe(1);
    expect(reviews.sentence).toBe(
      "1 assigned review has not been submitted, and 1 reviewer is past their round's closing date.",
    );
    expect(reviews.tone).toBe("blocked");
    expect(reviews.link).toEqual({ tab: "reviews", search: { tab: "progress" } });
  });

  test("no round deadline means nobody is called overdue", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    const proposalId = await addProposal(t, eventId, "pending");
    await t.run(async (ctx) => {
      const user = await ctx.db.query("users").first();
      if (user === null) throw new Error("no user");
      await ctx.db.insert("reviews", {
        eventId,
        proposalId,
        reviewerUserId: user._id,
        status: "assigned",
        updatedAt: NOW,
      });
    });

    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    expect(rowOf(panel, "reviews").sentence).toBe(
      "1 assigned review has not been submitted.",
    );
    expect(rowOf(panel, "reviews").tone).toBe("attention");
  });

  test("a capped reviews read never claims every review is submitted", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      const user = await ctx.db.query("users").first();
      if (user === null) throw new Error("no user");
      // 2001 rows: one past PANEL_REVIEW_SCAN, so the read is capped. Every row
      // is submitted — the filter empties the set, which is exactly the case
      // that must not print "every assigned review has been submitted".
      for (let i = 0; i < 2001; i += 1) {
        const proposalId = await ctx.db.insert("proposals", {
          eventId,
          title: `Submitted ${i}`,
          status: "pending",
          submitterUserId: user._id,
          answers: {},
          formVersion: 1,
          updatedAt: NOW,
        });
        await ctx.db.insert("reviews", {
          eventId,
          proposalId,
          reviewerUserId: user._id,
          status: "submitted",
          updatedAt: NOW,
        });
      }
    });

    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    const reviews = rowOf(panel, "reviews");
    expect(reviews.count).toBe(0);
    expect(reviews.capped).toBe(true);
    expect(reviews.sentence).toBe(
      "No outstanding review among the first 2000 read — larger events may have more.",
    );
    expect(reviews.tone).toBe("neutral");
  });

  test("a capped speakers read never claims every speaker answered", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      const event = await ctx.db.get("events", eventId);
      if (event === null) throw new Error("no event");
      const sessionId = await ctx.db.insert("sessions", {
        eventId,
        title: "Many speakers",
        source: "direct",
        status: "planned",
      });
      // 1001 confirmed participations: one past PANEL_PARTICIPANT_SCAN.
      for (let i = 0; i < 1001; i += 1) {
        const contactId = await ctx.db.insert("eventContacts", {
          eventId,
          orgId: event.orgId,
          firstName: `Speaker`,
          lastName: `${i}`,
        });
        await ctx.db.insert("sessionParticipants", {
          sessionId,
          eventId,
          eventContactId: contactId,
          role: "speaker",
          state: "confirmed",
        });
      }
    });

    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    const speakers = rowOf(panel, "speakers");
    expect(speakers.count).toBe(0);
    expect(speakers.capped).toBe(true);
    expect(speakers.sentence).toBe(
      "Every invited speaker among the first 1000 participations read has answered — larger events may have more.",
    );
    expect(speakers.tone).toBe("neutral");
  });

  test("an uncapped true-zero read keeps the confident sentence", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seed(t);

    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    const reviews = rowOf(panel, "reviews");
    expect(reviews.count).toBe(0);
    expect(reviews.capped).toBe(false);
    expect(reviews.sentence).toBe("Every assigned review has been submitted.");
    expect(reviews.tone).toBe("success");
    const speakers = rowOf(panel, "speakers");
    expect(speakers.sentence).toBe("Every invited speaker has answered.");
    const tasks = rowOf(panel, "tasks");
    expect(tasks.sentence).toBe("No speaker owes you anything right now.");
  });

  test("speakers and tasks are counted with their own deep links", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      const event = await ctx.db.get("events", eventId);
      if (event === null) throw new Error("no event");
      const sessionId = await ctx.db.insert("sessions", {
        eventId,
        title: "Agents in Production",
        source: "direct",
        status: "planned",
      });
      const contactId = await ctx.db.insert("eventContacts", {
        eventId,
        orgId: event.orgId,
        firstName: "Grace",
        lastName: "Hopper",
      });
      await ctx.db.insert("sessionParticipants", {
        sessionId,
        eventId,
        eventContactId: contactId,
        role: "speaker",
        state: "awaiting",
      });
    });

    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    const speakers = rowOf(panel, "speakers");
    expect(speakers.count).toBe(1);
    expect(speakers.sentence).toBe(
      "1 speaker has not answered their invitation.",
    );
    expect(speakers.link).toEqual({
      tab: "speakers",
      search: { state: "awaiting" },
    });
    // The count is every OPEN task, so the link carries the filter that shows
    // every open task — not `pending`, which would show a shorter list than
    // the number the organizer clicked.
    expect(rowOf(panel, "tasks").link).toEqual({
      tab: "tasks",
      search: { tab: "instances", status: "outstanding" },
    });
  });

  test("the tasks count spans every OPEN status, matching what its link shows", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      const requirementId = await ctx.db.insert("requirements", {
        eventId,
        title: "Slides",
        scope: "participant",
        evidence: "file",
        dueAt: NOW + DAY,
        reviewRequired: true,
        active: true,
      });
      const sessionId = await ctx.db.insert("sessions", {
        eventId,
        title: "Keynote",
        source: "direct",
        status: "planned",
      });
      // One per status: three are still owed, three are settled.
      for (const status of [
        "pending",
        "provided",
        "changesRequested",
        "approved",
        "complete",
        "notApplicable",
      ] as const) {
        await ctx.db.insert("taskInstances", {
          requirementId,
          eventId,
          sessionId,
          status,
          dueAt: NOW + DAY,
          updatedAt: NOW,
        });
      }
    });

    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    const tasks = rowOf(panel, "tasks");
    // Not 1 (pending only) — Awaiting Review and Changes Requested are still
    // work somebody owes, and the destination filter is the same predicate.
    expect(tasks.count).toBe(3);
    expect(tasks.sentence).toBe("3 tasks are outstanding.");
    expect(tasks.link.search).toEqual({
      tab: "instances",
      status: "outstanding",
    });
  });

  test("a capped read renders its overdue suffix as a floor, not a total", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    // One past the panel's 2000-row task ceiling, every one of them overdue.
    await t.run(async (ctx) => {
      const requirementId = await ctx.db.insert("requirements", {
        eventId,
        title: "Slides",
        scope: "participant",
        evidence: "file",
        dueAt: NOW - DAY,
        reviewRequired: false,
        active: true,
      });
      const sessionId = await ctx.db.insert("sessions", {
        eventId,
        title: "Keynote",
        source: "direct",
        status: "planned",
      });
      for (let i = 0; i < 2001; i += 1) {
        await ctx.db.insert("taskInstances", {
          requirementId,
          eventId,
          sessionId,
          status: "pending",
          dueAt: NOW - DAY,
          updatedAt: NOW,
        });
      }
    });

    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    const tasks = rowOf(panel, "tasks");
    expect(tasks.capped).toBe(true);
    // BOTH numbers are floors. Printing the overdue tail as an exact count
    // while the head says "at least" is under-reporting dressed as certainty.
    expect(tasks.sentence).toBe(
      "at least 2000 tasks are outstanding, at least 2000 of them overdue.",
    );
  });

  test("it TRUNCATES rather than refusing, and says the count is a floor", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    // One past the panel's 500-row proposal ceiling.
    await t.run(async (ctx) => {
      const user = await ctx.db.query("users").first();
      if (user === null) throw new Error("no user");
      for (let i = 0; i < 501; i += 1) {
        await ctx.db.insert("proposals", {
          eventId,
          submitterUserId: user._id,
          status: "pending",
          title: `Talk ${i}`,
          answers: {},
          formVersion: 1,
          updatedAt: NOW,
        });
      }
    });

    // The whole point: this must ANSWER, not throw event_too_large.
    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    expect(panel.capped).toBe(true);
    const cfp = rowOf(panel, "cfp");
    expect(cfp.count).toBe(500);
    expect(cfp.capped).toBe(true);
    // A floor never prints as an exact total.
    expect(cfp.sentence).toContain("at least 500 submissions");
  });
});

// ── First event vs returning event ───────────────────────────────────────

describe("first event vs returning event", () => {
  test("a brand new event is a first event, with the lifecycle checklist", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seed(t);
    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    expect(panel.firstEvent).toBe(true);
    expect(panel.checklist.map((s) => s.id)).toEqual([
      "setup",
      "cfp",
      "collect",
      "select",
      "schedule",
      "publish",
    ]);
    // The smallest useful set of statuses, each with one next action.
    expect(panel.checklist[0].state).toBe("todo");
    expect(panel.checklist[0].action).toEqual({
      label: "Open settings",
      link: { tab: "settings" },
    });
  });

  test("ANY proposal — even a withdrawn one — is history", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await addProposal(t, eventId, "withdrawn");
    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    expect(panel.firstEvent).toBe(false);
  });

  test("a session makes it a returning event", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        eventId,
        title: "Keynote",
        source: "direct",
        status: "planned",
      });
    });
    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    expect(panel.firstEvent).toBe(false);
  });

  test("opening the CFP makes it a returning event even with nothing in it", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("events", eventId, { cfpPublished: true });
    });
    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    expect(panel.firstEvent).toBe(false);
    expect(panel.checklist[1].state).toBe("done");
  });
});

// ── Recent changes ───────────────────────────────────────────────────────

describe("recentChanges — the audit rows, rendered", () => {
  test("it reads the rows capabilities already write, newest first", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { location: "Lisbon" },
    });

    const changes = await alice.query(api.readiness.recentChanges, {
      eventSlug,
    });
    expect(changes.rows.length).toBeGreaterThan(0);
    const latest = changes.rows[0];
    expect(latest.action).toBe("event.updateSettings");
    expect(latest.sentence).toBe("alice changed the event settings.");
    expect(latest.link).toEqual({ tab: "details" });
    expect(changes.capped).toBe(false);
    // Nothing was written by this panel — it only reads.
    expect(eventId).toBeDefined();
  });

  test("an unknown action code renders honestly generic instead of crashing", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      const event = await ctx.db.get("events", eventId);
      const user = await ctx.db.query("users").first();
      if (event === null || user === null) throw new Error("no seed");
      await ctx.db.insert("auditLog", {
        orgId: event.orgId,
        eventId,
        actorUserId: user._id,
        action: "quantum.entangleSchedule",
        targetType: "wormhole",
      });
    });

    const changes = await alice.query(api.readiness.recentChanges, {
      eventSlug,
    });
    const row = changes.rows[0];
    expect(row.action).toBe("quantum.entangleSchedule");
    expect(row.sentence).toBe(
      "alice performed a recorded action: quantum entangle schedule.",
    );
    // An unrecognised target type gets no link rather than a wrong one.
    expect(row.link).toBeNull();
  });

  test("the sentence mapping is pure and total", () => {
    expect(changeSentence("Jordan", "decision.release")).toBe(
      "Jordan released a decision.",
    );
    // No actor resolved is stated, not faked.
    expect(changeSentence(null, "decision.release")).toBe(
      "Someone released a decision.",
    );
    expect(genericClause("library.tracks.add")).toBe(
      "performed a recorded action: library tracks add",
    );
    expect(genericClause("")).toBe("performed a recorded action");
  });
});

// ── What happens next ────────────────────────────────────────────────────

describe("upNext — milestones and channels", () => {
  test("milestones are chronological and carry the right tense", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("events", eventId, {
        cfpOpenAt: NOW - 3 * DAY,
        cfpCloseAt: NOW + 4 * DAY,
      });
    });

    const next = await alice.query(api.readiness.upNext, {
      eventSlug,
      now: NOW,
    });
    expect(next.milestones.map((m) => m.id)).toEqual([
      "cfpOpens",
      "cfpCloses",
      "eventStarts",
      "eventEnds",
    ]);
    expect(next.milestones[0].past).toBe(true);
    expect(next.milestones[0].sentence).toBe(
      "The call for speakers opened 3 days ago.",
    );
    expect(next.milestones[1].sentence).toBe(
      "The call for speakers closes in 4 days.",
    );
  });

  test("an unpublished event says so, with no attribution to invent", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seed(t);
    const next = await alice.query(api.readiness.upNext, {
      eventSlug,
      now: NOW,
    });
    expect(next.version).toBeNull();
    expect(next.channels.map((c) => c.id)).toEqual(["lineup", "agenda"]);
    expect(next.channels[0].published).toBe(false);
    expect(next.channels[0].sentence).toBe(
      "The public page is off, so no lineup is being served.",
    );
    expect(next.channels[0].link).toEqual({ tab: "publish" });
  });

  test("a published channel names who published it and when", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seed(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await t.finishInProgressScheduledFunctions();
    }

    const published = await t.run(async (ctx) => {
      return await ctx.db.query("publishedPrograms").first();
    });
    if (published === null) throw new Error("nothing published");
    const next = await alice.query(api.readiness.upNext, {
      eventSlug,
      now: published.publishedAt + 2 * 3600_000,
    });
    expect(next.channels[0].published).toBe(true);
    expect(next.channels[0].sentence).toBe(
      "The public page is on, so the lineup is being served. Last published by alice 2 hours ago.",
    );
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────

describe("relativeTime", () => {
  test("says whole units, in both directions", () => {
    expect(relativeTime(NOW + 6 * DAY, NOW)).toBe("in 6 days");
    expect(relativeTime(NOW + DAY, NOW)).toBe("in 1 day");
    expect(relativeTime(NOW + 3 * 3600_000, NOW)).toBe("in 3 hours");
    expect(relativeTime(NOW - 90_000, NOW)).toBe("1 minute ago");
    // Sub-minute never reads as "0 minutes ago" — it rounds up to one.
    expect(relativeTime(NOW - 500, NOW)).toBe("1 minute ago");
  });
});

// ── Negative authz ───────────────────────────────────────────────────────

describe("every control-center panel is organizer-only", () => {
  test("a reviewer on the event is refused by all three new queries", async () => {
    const t = setupTest();
    const { eventSlug } = await seed(t);
    await signIn(t, "bob");
    await grantEventRole(t, eventSlug, "bob", "reviewer");
    const bob = await signIn(t, "bob");

    await expectRejectedWith(
      bob.query(api.readiness.attentionPanel, { eventSlug, now: NOW }),
      "forbidden",
    );
    await expectRejectedWith(
      bob.query(api.readiness.recentChanges, { eventSlug }),
      "forbidden",
    );
    await expectRejectedWith(
      bob.query(api.readiness.upNext, { eventSlug, now: NOW }),
      "forbidden",
    );
  });

  test("a stranger cannot reach the event at all", async () => {
    const t = setupTest();
    const { eventSlug } = await seed(t);
    const mallory = await signIn(t, "mallory");

    await expectRejectedWith(
      mallory.query(api.readiness.attentionPanel, { eventSlug, now: NOW }),
      "forbidden",
    );
    await expectRejectedWith(
      mallory.query(api.readiness.recentChanges, { eventSlug }),
      "forbidden",
    );
    await expectRejectedWith(
      mallory.query(api.readiness.upNext, { eventSlug, now: NOW }),
      "forbidden",
    );
  });
});

// ── The blocked panel's counts (on the refusing dashboard query) ─────────

describe("dashboard blockers", () => {
  test("draft content, unscheduled sessions and blocked sessions are counted", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      // A draft, speakerless session: blocked AND draft AND unscheduled.
      await ctx.db.insert("sessions", {
        eventId,
        title: "Draft talk",
        source: "direct",
        status: "planned",
        contentStatus: "draft",
      });
      // Approved, but nobody is presenting it either.
      await ctx.db.insert("sessions", {
        eventId,
        title: "Approved talk",
        source: "direct",
        status: "planned",
        contentStatus: "approved",
      });
      // Cancelled sessions are off the board entirely.
      await ctx.db.insert("sessions", {
        eventId,
        title: "Cancelled talk",
        source: "direct",
        status: "cancelled",
        contentStatus: "draft",
      });
    });

    const data = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: NOW,
    });
    expect(data.blockers.contentDrafts).toBe(1);
    expect(data.blockers.unscheduled).toBe(2);
    expect(data.blockers.scheduleConflicts).toBe(0);
    // Both planned sessions have no speaker, which is a blocking reason.
    expect(data.blockers.blockedSessions).toBe(2);
    expect(data.blockers.blockedSessions).toBe(
      data.sessions.filter((s) => s.readiness.status === "blocked").length,
    );
    // F5: the rows the control center prints are composed here, not in TSX.
    const byId = new Map(data.blockers.rows.map((r) => [r.id, r]));
    expect(byId.get("contentDrafts")?.sentence).toBe(
      "1 session is held out of the public program until the content is approved.",
    );
    expect(byId.get("contentDrafts")?.tone).toBe("blocked");
    expect(byId.get("contentDrafts")?.link).toEqual({
      tab: "sessions",
      search: { content: "draft" },
    });
    expect(byId.get("unscheduled")?.sentence).toBe(
      "2 planned sessions have no released slot, so they cannot appear on the public schedule.",
    );
    expect(byId.get("unscheduled")?.tone).toBe("attention");
    expect(byId.get("scheduleConflicts")?.sentence).toBe(
      "No session collides with another.",
    );
    expect(byId.get("scheduleConflicts")?.tone).toBe("success");
  });

  test("it REFUSES an over-ceiling event rather than under-reporting blockers", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 1001; i += 1) {
        await ctx.db.insert("sessions", {
          eventId,
          title: `Talk ${i}`,
          source: "direct",
          status: "planned",
        });
      }
    });

    // The contrast that makes the per-panel split necessary: THIS panel
    // refuses where the attention panel above truncates.
    await expectRejectedWith(
      alice.query(api.tasks.dashboard, { eventSlug, now: NOW }),
      "event_too_large",
    );
    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: NOW,
    });
    expect(panel.rows.length).toBeGreaterThan(0);
  });
});
