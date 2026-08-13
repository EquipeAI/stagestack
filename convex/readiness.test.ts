/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
// W4 — one readiness vocabulary.
//
// The rules worth breaking the build over:
//   • every reason code is reachable, and each prints ONE sentence composed in
//     the model (a surface that re-words publication state in TSX is a bug);
//   • the reasons never disagree with what publishing would actually do —
//     asserted against `publish.preview` (computeProgram) and the served blob,
//     never against a re-implementation of the gates;
//   • the nav counts truncate (`capped`) instead of refusing, and are derived
//     from the same producer as the sentences.
// ─────────────────────────────────────────────────────────────────────────

const SLOT_START = Date.parse("2026-09-01T10:00:00Z");

async function drainScheduled(t: TestT): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

/**
 * An event with one planned, approved session that has a confirmed speaker and
 * a released slot — i.e. everything except the two publication toggles and the
 * per-session flag. Each test then removes exactly one thing.
 */
async function seed(t: TestT) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

  const { eventId, sessionId } = await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
      .unique();
    if (event === null) throw new Error("no event");
    const sessionId = await ctx.db.insert("sessions", {
      eventId: event._id,
      title: "Agents in Production",
      description: "War stories.",
      source: "direct",
      status: "planned",
      contentStatus: "approved",
      releasedSlot: {
        startsAt: SLOT_START,
        endsAt: SLOT_START + 45 * 60_000,
        releasedAt: SLOT_START,
        sequence: 0,
      },
    });
    const contactId = await ctx.db.insert("eventContacts", {
      eventId: event._id,
      orgId: event.orgId,
      firstName: "Grace",
      lastName: "Hopper",
    });
    await ctx.db.insert("sessionParticipants", {
      sessionId,
      eventId: event._id,
      eventContactId: contactId,
      role: "speaker",
      state: "confirmed",
    });
    return { eventId: event._id, sessionId };
  });

  return { alice, orgSlug, eventSlug, eventId, sessionId };
}

/** Turn on everything: public page, schedule, and this session's flag. */
async function publishEverything(
  alice: Awaited<ReturnType<typeof signIn>>,
  eventSlug: string,
  sessionId: Id<"sessions">,
) {
  await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
  await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });
  await alice.mutation(api.publish.setSession, {
    eventSlug,
    sessionId,
    published: true,
  });
}

async function publicationFor(
  alice: Awaited<ReturnType<typeof signIn>>,
  eventSlug: string,
  sessionId: Id<"sessions">,
) {
  const rows = await alice.query(api.readiness.publication, { eventSlug });
  const row = rows.find((r) => r.sessionId === sessionId);
  if (row === undefined) throw new Error("session missing from publication");
  return row.publication;
}

const codes = (publication: { reasons: Array<{ code: string }> }) =>
  publication.reasons.map((r) => r.code);

describe("publication reasons — one case per code", () => {
  test("session_cancelled: a cancelled session is out of the lineup", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    await publishEverything(alice, eventSlug, sessionId);
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionId, { status: "cancelled" });
    });

    const publication = await publicationFor(alice, eventSlug, sessionId);
    expect(codes(publication)).toEqual(["session_cancelled"]);
    expect(publication.reasons[0].sentence).toBe("The session is cancelled.");
    // W10: the repair now names the workspace tab that shows the status.
    expect(publication.reasons[0].repair).toEqual({
      tab: "sessions",
      params: { sessionId },
      sessionTab: "overview",
    });
    expect(publication.inLineup).toBe(false);
  });

  test("content_draft: unapproved content holds the session back", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    await publishEverything(alice, eventSlug, sessionId);
    await alice.mutation(api.sessions.setContentStatus, {
      eventSlug,
      sessionId,
      to: "draft",
    });

    const publication = await publicationFor(alice, eventSlug, sessionId);
    expect(codes(publication)).toEqual(["content_draft"]);
    expect(publication.reasons[0].sentence).toBe("Content is Draft.");
    // W10: content approval is repaired on the workspace's content tab.
    expect(publication.reasons[0].repair).toEqual({
      tab: "sessions",
      params: { sessionId },
      sessionTab: "content",
    });
    // The exact sentence the plan asked for, composed by one producer.
    expect(publication.summary).toBe(
      "Not public: content is Draft. Speaker and schedule are ready.",
    );
  });

  test("session_not_published: the per-session toggle defaults off", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });

    const publication = await publicationFor(alice, eventSlug, sessionId);
    expect(codes(publication)).toEqual(["session_not_published"]);
    expect(publication.reasons[0].sentence).toBe("Its publish toggle is off.");
    expect(publication.reasons[0].repair).toEqual({
      tab: "publish",
      params: { sessionId },
    });
  });

  test("lineup_not_published: the public page gates the whole lineup", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId,
      published: true,
    });

    const publication = await publicationFor(alice, eventSlug, sessionId);
    expect(codes(publication)).toEqual(["lineup_not_published"]);
    expect(publication.reasons[0].sentence).toBe("The public page is off.");
    // Event-wide repair: no session param to deep-link with.
    expect(publication.reasons[0].repair).toEqual({ tab: "publish" });
    // Lineup and agenda publish independently, so this released session is
    // STILL in the served schedule — the summary says exactly that.
    expect(publication.reasons[0].blocks).toBe("lineup");
    expect(publication.inAgenda).toBe(true);
    expect(publication.summary).toBe(
      "Public in agenda, not lineup: the public page is off.",
    );
  });

  test("slot_not_released: in the lineup, absent from the agenda", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    await publishEverything(alice, eventSlug, sessionId);
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionId, { releasedSlot: undefined });
    });

    const publication = await publicationFor(alice, eventSlug, sessionId);
    expect(codes(publication)).toEqual(["slot_not_released"]);
    expect(publication.reasons[0].blocks).toBe("agenda");
    expect(publication.reasons[0].repair).toEqual({
      tab: "agenda",
      params: { sessionId },
    });
    expect(publication.inLineup).toBe(true);
    expect(publication.inAgenda).toBe(false);
    // The plan's second sentence, verbatim.
    expect(publication.summary).toBe(
      "Public in lineup, not agenda: its session is approved and lineup-enabled, " +
        "but the slot has not been released.",
    );
  });

  test("agenda_not_published: the schedule as a whole is held back", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId,
      published: true,
    });

    const publication = await publicationFor(alice, eventSlug, sessionId);
    expect(codes(publication)).toEqual(["agenda_not_published"]);
    expect(publication.reasons[0].sentence).toBe(
      "The schedule is not published.",
    );
    expect(publication.reasons[0].repair).toEqual({ tab: "publish" });
    expect(publication.summary).toBe(
      "Public in lineup, not agenda: its session is approved and lineup-enabled, " +
        "but the schedule is not published.",
    );
  });

  test("several blockers read as one sentence, in dependency order", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionId, {
        contentStatus: "draft",
        releasedSlot: undefined,
      });
    });

    const publication = await publicationFor(alice, eventSlug, sessionId);
    expect(codes(publication)).toEqual([
      "content_draft",
      "session_not_published",
      "lineup_not_published",
      "slot_not_released",
      "agenda_not_published",
    ]);
    // Only the blockers that hold BOTH surfaces back reach the summary — the
    // per-surface ones are moot while the session cannot be public at all —
    // and what is already done is named so nobody re-checks finished work.
    expect(publication.summary).toBe(
      "Not public: content is Draft and its publish toggle is off. Speaker is ready.",
    );
  });
});

describe("publication — the all-ready case", () => {
  test("no reasons, the all-clear sentence, and the public program agrees", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    await publishEverything(alice, eventSlug, sessionId);

    const publication = await publicationFor(alice, eventSlug, sessionId);
    expect(publication.reasons).toEqual([]);
    expect(publication.summary).toBe("Public in lineup and agenda.");
    expect(publication.inLineup).toBe(true);
    expect(publication.inAgenda).toBe(true);
    expect(publication.toBeAnnounced).toBe(false);

    // Empty reasons must mean the projection really does carry it — asserted
    // against computeProgram and the served blob, not a re-derivation. The
    // projection rides on `publish.state` (F6).
    const preview = (await alice.query(api.publish.state, { eventSlug })).preview;
    expect(preview.lineup.map((s: { sessionId: string }) => s.sessionId)).toContain(
      sessionId,
    );
    expect(
      preview.agenda.flatMap((entry) =>
        entry.kind === "session" ? [entry.sessionId] : [],
      ),
    ).toContain(sessionId);

    await drainScheduled(t);
    const served = (await t.query(api.publish.publicProgram, {
      slug: eventSlug,
    }))!;
    expect(served.lineup.map((s: { sessionId: string }) => s.sessionId)).toContain(
      sessionId,
    );
  });

  test("an unconfirmed speaker never blocks publication — it says so instead", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, sessionId } = await seed(t);
    await publishEverything(alice, eventSlug, sessionId);
    await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("eventContacts", {
        eventId,
        orgId: (await ctx.db.get("events", eventId))!.orgId,
        firstName: "Alan",
        lastName: "Turing",
      });
      await ctx.db.insert("sessionParticipants", {
        sessionId,
        eventId,
        eventContactId: contactId,
        role: "speaker",
        state: "awaiting",
      });
    });

    const publication = await publicationFor(alice, eventSlug, sessionId);
    expect(publication.reasons).toEqual([]);
    expect(publication.toBeAnnounced).toBe(true);
    expect(publication.summary).toBe(
      "Public in lineup and agenda. Speakers are shown as to be announced until they confirm.",
    );
    // ...and the projection agrees that it publishes, TBA and all.
    const preview = (await alice.query(api.publish.state, { eventSlug })).preview;
    expect(preview.lineup).toHaveLength(1);
    expect(preview.lineup[0].toBeAnnounced).toBe(true);
  });
});

describe("publication — agreement with what publish actually does", () => {
  test("a lineup blocker means the projection does not serve the session", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    await publishEverything(alice, eventSlug, sessionId);
    // Every lineup blocker, one at a time: the reasons and the projection must
    // move together in every case.
    const withdraw: Array<{ step: () => Promise<void>; alsoAgenda: boolean }> = [
      {
        step: async () => {
          await alice.mutation(api.sessions.setContentStatus, {
            eventSlug,
            sessionId,
            to: "draft",
          });
        },
        alsoAgenda: true,
      },
      {
        step: async () => {
          await alice.mutation(api.sessions.setContentStatus, {
            eventSlug,
            sessionId,
            to: "approved",
          });
          await alice.mutation(api.publish.setSession, {
            eventSlug,
            sessionId,
            published: false,
          });
        },
        alsoAgenda: true,
      },
      {
        // Turning the public page off empties the LINEUP only: a released
        // session goes on being served in a published schedule. The sentence
        // must move exactly as far as the projection does, and no further.
        step: async () => {
          await alice.mutation(api.publish.setSession, {
            eventSlug,
            sessionId,
            published: true,
          });
          await alice.mutation(api.publish.setLineup, {
            eventSlug,
            enabled: false,
          });
        },
        alsoAgenda: false,
      },
    ];
    for (const { step, alsoAgenda } of withdraw) {
      await step();
      const publication = await publicationFor(alice, eventSlug, sessionId);
      const preview = (await alice.query(api.publish.state, { eventSlug })).preview;
      expect(publication.inLineup).toBe(false);
      expect(publication.reasons.length).toBeGreaterThan(0);
      expect(preview.lineup).toEqual([]);
      expect(publication.inAgenda).toBe(!alsoAgenda);
      expect(preview.agenda).toHaveLength(alsoAgenda ? 0 : 1);
    }
  });

  test("publishState's live counts and the vocabulary describe one world", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    await publishEverything(alice, eventSlug, sessionId);
    const state = await alice.query(api.publish.state, { eventSlug });
    expect(state.publishedSessionIds).toEqual([sessionId]);
    expect(state.releasedSessions).toBe(1);

    const publication = await publicationFor(alice, eventSlug, sessionId);
    expect(publication.reasons).toEqual([]);

    // Unpublishing the schedule moves BOTH: the console flag and the sentence.
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: false });
    expect(
      (await alice.query(api.publish.state, { eventSlug })).agendaPublished,
    ).toBe(false);
    expect(codes(await publicationFor(alice, eventSlug, sessionId))).toEqual([
      "agenda_not_published",
    ]);
  });
});

describe("attention counts", () => {
  test("each session is charged to the tab that would move it forward", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, sessionId } = await seed(t);
    // A second session, still Draft: its next stop is the Sessions tab.
    const draftSessionId = await t.run(async (ctx) => {
      return await ctx.db.insert("sessions", {
        eventId,
        title: "Draft talk",
        source: "direct",
        status: "planned",
        contentStatus: "draft",
      });
    });
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });

    let attention = await alice.query(api.readiness.attention, { eventSlug });
    expect(attention.capped).toBe(false);
    // Approved + released but not flagged → Publish; draft → Sessions.
    expect(attention.counts.publish).toBe(1);
    expect(attention.counts.sessions).toBe(1);
    expect(attention.counts.agenda).toBe(0);

    // Flip the first session's toggle: it stops asking for attention entirely,
    // and never lands in a second tab's badge.
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId,
      published: true,
    });
    // Approve the draft one, publish it, but leave it unscheduled → Agenda.
    await alice.mutation(api.sessions.setContentStatus, {
      eventSlug,
      sessionId: draftSessionId,
      to: "approved",
    });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: draftSessionId,
      published: true,
    });
    attention = await alice.query(api.readiness.attention, { eventSlug });
    expect(attention.counts.publish).toBe(0);
    expect(attention.counts.sessions).toBe(0);
    expect(attention.counts.agenda).toBe(1);
  });

  test("cancelled sessions are off the board; speakers and tasks count their own work", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, sessionId } = await seed(t);
    await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("eventContacts", {
        eventId,
        orgId: (await ctx.db.get("events", eventId))!.orgId,
        firstName: "Alan",
        lastName: "Turing",
      });
      await ctx.db.insert("sessionParticipants", {
        sessionId,
        eventId,
        eventContactId: contactId,
        role: "speaker",
        state: "awaiting",
      });
      const cancelled = await ctx.db.insert("sessions", {
        eventId,
        title: "Pulled talk",
        source: "direct",
        status: "cancelled",
      });
      const requirementId = await ctx.db.insert("requirements", {
        eventId,
        title: "Upload slides",
        scope: "session",
        evidence: "manual",
        reviewRequired: false,
        dueAt: SLOT_START,
        active: true,
      });
      await ctx.db.insert("taskInstances", {
        eventId,
        requirementId,
        sessionId: cancelled,
        status: "pending",
        dueAt: SLOT_START,
        updatedAt: SLOT_START,
      });
      await ctx.db.insert("taskInstances", {
        eventId,
        requirementId,
        sessionId,
        status: "approved",
        dueAt: SLOT_START,
        updatedAt: SLOT_START,
      });
    });

    const attention = await alice.query(api.readiness.attention, { eventSlug });
    expect(attention.counts.speakers).toBe(1);
    // Open task only; the approved one is settled.
    expect(attention.counts.tasks).toBe(1);
    // The cancelled session contributes to no publication badge.
    expect(
      attention.counts.sessions +
        attention.counts.agenda +
        attention.counts.publish,
    ).toBe(1);
  });

  test("proposals and the caller's own review queue", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    const bob = await signIn(t, "bob");
    await grantEventRole(t, eventSlug, "bob", "reviewer");
    const [aliceUserId, bobUserId] = await t.run(async (ctx) => {
      const users = await ctx.db.query("users").collect();
      return [
        users.find((u) => u.email === "alice@example.com")!._id,
        users.find((u) => u.email === "bob@example.com")!._id,
      ];
    });
    await t.run(async (ctx) => {
      const pending = await ctx.db.insert("proposals", {
        eventId,
        submitterUserId: bobUserId,
        status: "pending",
        title: "A pending idea",
        answers: {},
        formVersion: 1,
        updatedAt: SLOT_START,
      });
      await ctx.db.insert("proposals", {
        eventId,
        submitterUserId: bobUserId,
        status: "accepted",
        title: "Already decided",
        answers: {},
        formVersion: 1,
        updatedAt: SLOT_START,
      });
      // One review for Alice (unstarted) and one for Bob — a badge must never
      // count somebody else's queue.
      await ctx.db.insert("reviews", {
        eventId,
        proposalId: pending,
        reviewerUserId: aliceUserId,
        status: "assigned",
        updatedAt: SLOT_START,
      });
      await ctx.db.insert("reviews", {
        eventId,
        proposalId: pending,
        reviewerUserId: bobUserId,
        status: "assigned",
        updatedAt: SLOT_START,
      });
    });

    const attention = await alice.query(api.readiness.attention, { eventSlug });
    expect(attention.counts.proposals).toBe(1);
    expect(attention.counts.reviews).toBe(1);
  });

  test("past a read cap the counts truncate — the navigation never 500s", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    // One row past the 500-session ceiling of the counts query. The full
    // publication board refuses at ITS cap; the nav rail must not.
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i += 1) {
        await ctx.db.insert("sessions", {
          eventId,
          title: `Filler ${i}`,
          source: "direct",
          status: "planned",
        });
      }
    });

    const attention = await alice.query(api.readiness.attention, { eventSlug });
    expect(attention.capped).toBe(true);
    // A floor, not a total: 501 planned sessions read as 500.
    expect(attention.counts.publish).toBe(500);
    // And the refusing, whole-event board still answers at this size.
    expect(
      (await alice.query(api.readiness.publication, { eventSlug })).length,
    ).toBe(501);
  });
});

describe("authorization", () => {
  test("a reviewer cannot read the publication board or the counts", async () => {
    const t = setupTest();
    const { eventSlug } = await seed(t);
    await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    const rita = t.withIdentity({
      tokenIdentifier: "https://test.clerk.example.com|rita",
      subject: "rita",
      issuer: "https://test.clerk.example.com",
    });

    await expectRejectedWith(
      rita.query(api.readiness.publication, { eventSlug }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.query(api.readiness.attention, { eventSlug }),
      "forbidden",
    );
  });

  test("a stranger cannot read either query", async () => {
    const t = setupTest();
    const { eventSlug } = await seed(t);
    const mallory = await signIn(t, "mallory");

    await expectRejectedWith(
      mallory.query(api.readiness.publication, { eventSlug }),
      "forbidden",
    );
    await expectRejectedWith(
      mallory.query(api.readiness.attention, { eventSlug }),
      "forbidden",
    );
  });
});
