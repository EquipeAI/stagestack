/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
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
// W9 — the per-record workspace queries.
//
// What is worth breaking the build over:
//   • they are ORGANIZER surfaces. A reviewer on the event must be refused,
//     and so must an organizer of a *different* event reaching for a record
//     by id — the workspaces are the first surface that takes a record id
//     straight from the URL, so the scoping check is the whole ballgame;
//   • the publication half is VERBATIM `readiness.publication`. The session
//     workspace exists so a blocker has somewhere to link to, and a second
//     wording of the same blocker would defeat the point;
//   • the reads are keyed to the one record. A workspace that scanned the
//     event would be the roster query with extra steps.
// ─────────────────────────────────────────────────────────────────────────

const SLOT_START = Date.parse("2026-09-01T10:00:00Z");

async function seed(t: TestT) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

  const { eventId, sessionId, contactId } = await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
      .unique();
    if (event === null) throw new Error("no event");
    const sessionId = await ctx.db.insert("sessions", {
      eventId: event._id,
      title: "Agents in Production",
      description: "War stories.",
      format: "Talk",
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
      email: "grace@example.com",
      bio: "Compiler pioneer.",
      tagline: "Rear Admiral, US Navy",
    });
    await ctx.db.insert("sessionParticipants", {
      sessionId,
      eventId: event._id,
      eventContactId: contactId,
      role: "speaker",
      state: "confirmed",
    });
    return { eventId: event._id, sessionId, contactId };
  });

  return { t, alice, orgSlug, eventSlug, eventId, sessionId, contactId };
}

describe("workspaces:session", () => {
  test("the publication half is the readiness producer, verbatim", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    // A middling state on purpose: agenda on, lineup off, so the summary is
    // one of the interesting shapes rather than the all-clear.
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });

    const board = await alice.query(api.readiness.publication, { eventSlug });
    const fromBoard = board.find((row) => row.sessionId === sessionId);
    const workspace = await alice.query(api.workspaces.session, {
      eventSlug,
      sessionId,
    });

    expect(fromBoard).toBeDefined();
    // Not "looks similar" — the same object, sentences, codes and repair
    // targets included. This is the assertion the deep-link contract rests on.
    expect(workspace.publication).toEqual(fromBoard?.publication);
    expect(workspace.publication.reasons.length).toBeGreaterThan(0);
    for (const reason of workspace.publication.reasons) {
      expect(reason.sentence).not.toBe("");
      expect(["sessions", "agenda", "publish"]).toContain(reason.repair.tab);
    }
  });

  test("publication tracks the toggles the same way the board does", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId,
      published: true,
    });

    const workspace = await alice.query(api.workspaces.session, {
      eventSlug,
      sessionId,
    });
    expect(workspace.publication.inLineup).toBe(true);
    expect(workspace.publication.inAgenda).toBe(true);
    expect(workspace.publication.reasons).toEqual([]);

    const board = await alice.query(api.readiness.publication, { eventSlug });
    expect(workspace.publication).toEqual(
      board.find((row) => row.sessionId === sessionId)?.publication,
    );
  });

  test("carries the speakers, the room and the source proposal", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, sessionId } = await seed(t);
    const { proposalId } = await t.run(async (ctx) => {
      const user = await ctx.db.query("users").first();
      if (user === null) throw new Error("no user");
      const proposalId = await ctx.db.insert("proposals", {
        eventId,
        submitterUserId: user._id,
        status: "accepted",
        title: "Agents in Production",
        answers: {},
        formVersion: 1,
        updatedAt: SLOT_START,
        submittedAt: SLOT_START,
      });
      const roomId = await ctx.db.insert("rooms", {
        eventId,
        name: "Grand Hall",
        capacity: 400,
        order: 0,
      });
      await ctx.db.patch("sessions", sessionId, {
        proposalId,
        source: "cfp",
        roomId,
      });
      return { proposalId };
    });

    const workspace = await alice.query(api.workspaces.session, {
      eventSlug,
      sessionId,
    });
    expect(workspace.session.title).toBe("Agents in Production");
    expect(workspace.roomName).toBe("Grand Hall");
    expect(workspace.proposal?.proposalId).toBe(proposalId);
    expect(workspace.proposal?.status).toBe("accepted");
    expect(workspace.participants).toHaveLength(1);
    expect(workspace.participants[0].firstName).toBe("Grace");
    expect(workspace.participants[0].state).toBe("confirmed");
  });

  test("a direct session reports no source proposal rather than guessing", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    const workspace = await alice.query(api.workspaces.session, {
      eventSlug,
      sessionId,
    });
    expect(workspace.proposal).toBeNull();
    expect(workspace.roomName).toBeNull();
  });
});

describe("workspaces:speaker", () => {
  test("one contact's snapshot, participations and profile gaps", async () => {
    const t = setupTest();
    const { alice, eventSlug, contactId, sessionId } = await seed(t);

    const workspace = await alice.query(api.workspaces.speaker, {
      eventSlug,
      eventContactId: contactId,
    });
    expect(workspace.firstName).toBe("Grace");
    expect(workspace.email).toBe("grace@example.com");
    expect(workspace.sessions).toHaveLength(1);
    expect(workspace.sessions[0].sessionId).toBe(sessionId);
    expect(workspace.sessions[0].state).toBe("confirmed");
    expect(workspace.sessions[0].released).toBe(true);
    expect(workspace.sessions[0].contentStatus).toBe("approved");
    // The bio and tagline are set; the headshot is not, so exactly one profile
    // gap is reported and it is the true one.
    expect(workspace.readiness.missingBio).toBe(false);
    expect(workspace.readiness.missingTagline).toBe(false);
    expect(workspace.readiness.missingHeadshot).toBe(true);
    expect(workspace.readiness.reasons).toContain(
      "No headshot — the program falls back to initials.",
    );
  });

  test("an empty bio counts as missing, not as a bio", async () => {
    const t = setupTest();
    const { alice, eventSlug, contactId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("eventContacts", contactId, { bio: "   " });
    });
    const workspace = await alice.query(api.workspaces.speaker, {
      eventSlug,
      eventContactId: contactId,
    });
    expect(workspace.readiness.missingBio).toBe(true);
  });

  test("a speaker with no sessions is a workspace, not an error", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);
    const loneId = await t.run(async (ctx) => {
      const event = await ctx.db.get("events", eventId);
      if (event === null) throw new Error("no event");
      return await ctx.db.insert("eventContacts", {
        eventId,
        orgId: event.orgId,
        firstName: "Ada",
        lastName: "Lovelace",
      });
    });
    const workspace = await alice.query(api.workspaces.speaker, {
      eventSlug,
      eventContactId: loneId,
    });
    expect(workspace.sessions).toEqual([]);
    expect(workspace.claimed).toBe(false);
  });
});

// ── Negative authorization ───────────────────────────────────────────────
//
// The workspaces take a record id from the URL, so every refusal below is a
// URL somebody can type. None of them may answer.

describe("workspaces — who is refused", () => {
  test("a reviewer on the event cannot open either workspace", async () => {
    const t = setupTest();
    const { eventSlug, contactId, sessionId } = await seed(t);
    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");

    await expectRejectedWith(
      rita.query(api.workspaces.speaker, { eventSlug, eventContactId: contactId }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.query(api.workspaces.session, { eventSlug, sessionId }),
      "forbidden",
    );
  });

  test("a signed-out visitor is refused", async () => {
    const t = setupTest();
    const { eventSlug, contactId, sessionId } = await seed(t);
    await expectRejectedWith(
      t.query(api.workspaces.speaker, { eventSlug, eventContactId: contactId }),
      "not_authenticated",
    );
    await expectRejectedWith(
      t.query(api.workspaces.session, { eventSlug, sessionId }),
      "not_authenticated",
    );
  });

  test("an organizer of another event cannot read this event's records", async () => {
    const t = setupTest();
    const { eventSlug, contactId, sessionId } = await seed(t);
    const mallory = await signIn(t, "mallory");
    const otherOrg = await createOrg(mallory, "Rival Events");
    await createEvent(mallory, otherOrg, "Rival Summit");

    await expectRejectedWith(
      mallory.query(api.workspaces.speaker, {
        eventSlug,
        eventContactId: contactId,
      }),
      "forbidden",
    );
    await expectRejectedWith(
      mallory.query(api.workspaces.session, { eventSlug, sessionId }),
      "forbidden",
    );
  });

  test("an id from another event is not found, never answered", async () => {
    const t = setupTest();
    const { alice, orgSlug, contactId, sessionId } = await seed(t);
    const otherSlug = await createEvent(alice, orgSlug, "Second Summit");

    // Alice organizes BOTH events, so this is not an access failure — it is
    // the cross-event scoping check, which is the one a URL typo hits.
    await expectRejectedWith(
      alice.query(api.workspaces.speaker, {
        eventSlug: otherSlug,
        eventContactId: contactId,
      }),
      "not_found",
    );
    await expectRejectedWith(
      alice.query(api.workspaces.session, {
        eventSlug: otherSlug,
        sessionId,
      }),
      "not_found",
    );
  });
});

// ── Forged edges ─────────────────────────────────────────────────────────
//
// Authorization answers "may this caller open this record". These answer the
// question after it: having opened a record they may see, what do the edges
// OUT of it drag in? Every join below is seeded by hand as a row the product
// would never write, because that is exactly the shape a bug or a bad import
// leaves behind — and a workspace that renders it turns a data error into a
// cross-event disclosure.

describe("workspaces — a malformed cross-event edge is dropped, never rendered", () => {
  /** A second event under a second org, with a session and a contact in it. */
  async function otherEvent(t: TestT) {
    const mallory = await signIn(t, "mallory");
    const orgSlug = await createOrg(mallory, "Rival Events");
    const eventSlug = await createEvent(mallory, orgSlug, "Rival Summit");
    return await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no rival event");
      const sessionId = await ctx.db.insert("sessions", {
        eventId: event._id,
        title: "RIVAL SECRET KEYNOTE",
        source: "direct",
        status: "planned",
      });
      const contactId = await ctx.db.insert("eventContacts", {
        eventId: event._id,
        orgId: event.orgId,
        firstName: "Rival",
        lastName: "Person",
      });
      const roomId = await ctx.db.insert("rooms", {
        eventId: event._id,
        name: "RIVAL ROOM",
        order: 0,
      });
      const proposalId = await ctx.db.insert("proposals", {
        eventId: event._id,
        submitterUserId: (await ctx.db.query("users").first())!._id,
        status: "accepted",
        title: "RIVAL PROPOSAL",
        answers: {},
        formVersion: 1,
        updatedAt: 0,
      });
      return { eventId: event._id, sessionId, contactId, roomId, proposalId };
    });
  }

  test("a participation pointing at another event's session is not listed", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, contactId } = await seed(t);
    const rival = await otherEvent(t);
    await t.run(async (ctx) => {
      // The participation claims THIS event while its session belongs to the
      // other one — so the event-id check on the participation alone passes,
      // and only re-checking the session catches it.
      await ctx.db.insert("sessionParticipants", {
        sessionId: rival.sessionId,
        eventId,
        eventContactId: contactId,
        role: "speaker",
        state: "confirmed",
      });
    });

    const workspace = await alice.query(api.workspaces.speaker, {
      eventSlug,
      eventContactId: contactId,
    });
    expect(workspace.sessions.map((s) => s.title)).not.toContain(
      "RIVAL SECRET KEYNOTE",
    );
    expect(workspace.sessions).toHaveLength(1);
  });

  test("a participation on another event is not listed even by its own id", async () => {
    const t = setupTest();
    const { alice, eventSlug, contactId } = await seed(t);
    const rival = await otherEvent(t);
    await t.run(async (ctx) => {
      // The mirror case: the participation names the other event, and it is
      // reachable because the by_eventContactId index is not event-scoped.
      await ctx.db.insert("sessionParticipants", {
        sessionId: rival.sessionId,
        eventId: rival.eventId,
        eventContactId: contactId,
        role: "speaker",
        state: "confirmed",
      });
    });

    const workspace = await alice.query(api.workspaces.speaker, {
      eventSlug,
      eventContactId: contactId,
    });
    expect(workspace.sessions).toHaveLength(1);
  });

  test("a participant whose contact lives on another event is not named", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, sessionId } = await seed(t);
    const rival = await otherEvent(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("sessionParticipants", {
        sessionId,
        eventId,
        eventContactId: rival.contactId,
        role: "speaker",
        state: "confirmed",
      });
    });

    const workspace = await alice.query(api.workspaces.session, {
      eventSlug,
      sessionId,
    });
    expect(
      workspace.participants.map((p) => `${p.firstName} ${p.lastName}`),
    ).not.toContain("Rival Person");
    expect(workspace.participants).toHaveLength(1);
  });

  test("a room and a proposal from another event are not named", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seed(t);
    const rival = await otherEvent(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionId, {
        roomId: rival.roomId,
        proposalId: rival.proposalId,
        source: "cfp",
      });
    });

    const workspace = await alice.query(api.workspaces.session, {
      eventSlug,
      sessionId,
    });
    expect(workspace.roomName).toBeNull();
    expect(workspace.proposal).toBeNull();
  });
});

// ── Bounded reads ────────────────────────────────────────────────────────

describe("workspaces — bounded reads", () => {
  test("a speaker's participations are read by index, not by event scan", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, contactId } = await seed(t);
    // Noise: 40 other speakers, each on their own session. A query that read
    // the event's participation table would grow with this; one keyed to the
    // contact does not.
    await t.run(async (ctx) => {
      const event = await ctx.db.get("events", eventId);
      if (event === null) throw new Error("no event");
      for (let i = 0; i < 40; i += 1) {
        const sessionId = await ctx.db.insert("sessions", {
          eventId,
          title: `Filler ${i}`,
          source: "direct",
          status: "planned",
        });
        const otherId = await ctx.db.insert("eventContacts", {
          eventId,
          orgId: event.orgId,
          firstName: "Filler",
          lastName: String(i),
        });
        await ctx.db.insert("sessionParticipants", {
          sessionId,
          eventId,
          eventContactId: otherId,
          role: "speaker",
          state: "awaiting",
        });
      }
    });

    const workspace = await alice.query(api.workspaces.speaker, {
      eventSlug,
      eventContactId: contactId,
    });
    // Still exactly the one participation that is actually theirs.
    expect(workspace.sessions).toHaveLength(1);
  });

  test("a very busy speaker is truncated and says so — never refused", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, contactId } = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 205; i += 1) {
        const sessionId = await ctx.db.insert("sessions", {
          eventId,
          title: `Overload ${i}`,
          source: "direct",
          status: "planned",
        });
        await ctx.db.insert("sessionParticipants", {
          sessionId,
          eventId,
          eventContactId: contactId,
          role: "speaker",
          state: "awaiting",
        });
      }
    });

    // Nothing in the domain caps how many sessions one person is on — a track
    // host or an MC is legitimately on dozens. Refusing would make a real
    // person's workspace permanently unopenable, taking their identity,
    // readiness, tasks and comms history down with a list that is merely long.
    const workspace = await alice.query(api.workspaces.speaker, {
      eventSlug,
      eventContactId: contactId,
    });
    expect(workspace.sessions).toHaveLength(200);
    expect(workspace.sessionsTruncated).toBe(true);
    // The rest of the record is unaffected and still exact.
    expect(workspace.firstName).toBe("Grace");
    expect(workspace.readiness.missingHeadshot).toBe(true);
  });

  test("a normal speaker is not marked truncated", async () => {
    const t = setupTest();
    const { alice, eventSlug, contactId } = await seed(t);
    const workspace = await alice.query(api.workspaces.speaker, {
      eventSlug,
      eventContactId: contactId,
    });
    expect(workspace.sessionsTruncated).toBe(false);
  });

  test("a session at the enforced participant cap still renders", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, sessionId } = await seed(t);
    // MAX_PARTICIPANTS_PER_SESSION is 100 (model/sessions.ts, model/portal.ts).
    // A session sitting AT the product's own cap must open, so the workspace's
    // ceiling is above it, not equal to it.
    await t.run(async (ctx) => {
      const event = await ctx.db.get("events", eventId);
      if (event === null) throw new Error("no event");
      for (let i = 0; i < 99; i += 1) {
        const otherId = await ctx.db.insert("eventContacts", {
          eventId,
          orgId: event.orgId,
          firstName: "Panelist",
          lastName: String(i),
        });
        await ctx.db.insert("sessionParticipants", {
          sessionId,
          eventId,
          eventContactId: otherId,
          role: "speaker",
          state: "awaiting",
        });
      }
    });

    const workspace = await alice.query(api.workspaces.session, {
      eventSlug,
      sessionId,
    });
    expect(workspace.participants).toHaveLength(100);
  });

  test("a session beyond anything the product writes is refused", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, sessionId } = await seed(t);
    await t.run(async (ctx) => {
      const event = await ctx.db.get("events", eventId);
      if (event === null) throw new Error("no event");
      for (let i = 0; i < 155; i += 1) {
        const otherId = await ctx.db.insert("eventContacts", {
          eventId,
          orgId: event.orgId,
          firstName: "Panelist",
          lastName: String(i),
        });
        await ctx.db.insert("sessionParticipants", {
          sessionId,
          eventId,
          eventContactId: otherId,
          role: "speaker",
          state: "awaiting",
        });
      }
    });

    await expectRejectedWith(
      alice.query(api.workspaces.session, { eventSlug, sessionId }),
      "event_too_large",
    );
  });
});
