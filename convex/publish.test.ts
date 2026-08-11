/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  setupTest,
  signIn,
  grantEventRole,
  type TestT,
} from "./test.helpers";

/**
 * A publication flag flip SCHEDULES the projection rebuild instead of running an
 * O(event) recompute inside the user-facing mutation, so a test that reads the
 * served blob has to let the queued job run first. Same drain shape as
 * comms.test.ts's `runSweep`: `runAfter(0)` needs real event-loop turns.
 */
async function drainScheduled(t: TestT): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

/** The served projection, read after the scheduled rebuild has landed. */
async function servedProgram(t: TestT, slug: string) {
  await drainScheduled(t);
  return await t.query(api.publish.publicProgram, { slug });
}

async function eventIdOf(t: TestT, slug: string): Promise<Id<"events">> {
  return await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (event === null) throw new Error(`no event ${slug}`);
    return event._id;
  });
}

// Build an event with one accepted session that has a confirmed speaker and
// one still-awaiting co-speaker, returning the ids the tests act on.
async function seedProgram(t: ReturnType<typeof setupTest>) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

  const { sessionId, confirmedContactId } = await t.run(async (ctx) => {
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
    });
    const confirmedContactId = await ctx.db.insert("eventContacts", {
      eventId: event._id,
      orgId: event.orgId,
      firstName: "Grace",
      lastName: "Hopper",
      tagline: "Rear Admiral",
      bio: "Compilers, and speaking about them.",
    });
    const awaitingContactId = await ctx.db.insert("eventContacts", {
      eventId: event._id,
      orgId: event.orgId,
      firstName: "Alan",
      lastName: "Turing",
    });
    await ctx.db.insert("sessionParticipants", {
      sessionId,
      eventId: event._id,
      eventContactId: confirmedContactId,
      role: "speaker",
      state: "confirmed",
    });
    await ctx.db.insert("sessionParticipants", {
      sessionId,
      eventId: event._id,
      eventContactId: awaitingContactId,
      role: "speaker",
      state: "awaiting",
    });
    return { sessionId, confirmedContactId };
  });

  return { alice, orgSlug, eventSlug, sessionId, confirmedContactId };
}

describe("publish — lineup", () => {
  test("nothing is public until lineup + the session are both published", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);

    // Before any publish, the public read serves nothing.
    expect(await servedProgram(t, eventSlug)).toBeNull();

    // Enabling the lineup alone still shows no sessions (per-session flag off).
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    let program = (await servedProgram(t, eventSlug))!;
    expect(program).not.toBeNull();
    expect(program.lineup).toEqual([]);

    // Publishing the session brings it into the lineup.
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });
    program = (await servedProgram(t, eventSlug))!;
    expect(program.lineup).toHaveLength(1);
    expect(program.lineup[0].title).toBe("Agents in Production");
  });

  test("only confirmed speakers appear; an awaiting co-speaker forces TBA", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });
    const program = (await servedProgram(t, eventSlug))!;
    const session = program.lineup[0];
    // Grace confirmed → named; Alan awaiting → never in the blob.
    expect(session.speakers.map((s: { name: string }) => s.name)).toEqual([
      "Grace Hopper",
    ]);
    expect(session.toBeAnnounced).toBe(true);
    // No contact details cross the wire.
    expect(JSON.stringify(program)).not.toContain("Turing");
  });

  test("unpublishing the session removes it and republishes the blob", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: false,
    });
    const program = (await servedProgram(t, eventSlug))!;
    expect(program.lineup).toEqual([]);
  });

  test("turning the whole public page off serves null again", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: false });
    expect(await servedProgram(t, eventSlug)).toBeNull();
  });
});

describe("publish — content approval", () => {
  test("a published draft stays draft and out of preview/live output until explicitly approved (CNT-12)", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);
    const startsAt = Date.parse("2026-09-01T17:00:00Z");
    const endsAt = Date.parse("2026-09-01T18:00:00Z");

    // Reproduce the publish-console path with a real draft that is also
    // eligible for both lineup and agenda output.
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionId as Id<"sessions">, {
        contentStatus: "draft",
        releasedSlot: {
          startsAt,
          endsAt,
          releasedAt: Date.parse("2026-08-01T00:00:00Z"),
          sequence: 0,
        },
      });
    });
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });

    // Listing intent and editorial approval are independent. The flag is on,
    // but the draft is absent from both sections of the live preview.
    const state = await alice.query(api.publish.state, { eventSlug });
    expect(state.publishedSessionIds).toContain(sessionId);
    let preview = await alice.query(api.publish.preview, { eventSlug });
    expect(preview.lineup).toEqual([]);
    expect(preview.agenda).toEqual([]);

    // The stored projection powers both the public page/query and HTTP API.
    let program = (await servedProgram(t, eventSlug))!;
    expect(program.lineup).toEqual([]);
    expect(program.agenda).toEqual([]);
    let http = await t.fetch(`/api/events/${eventSlug}/program`);
    expect(http.status).toBe(200);
    expect(await http.json()).toMatchObject({ lineup: [], agenda: [] });

    // Publishing must not hide an approval mutation in the session row.
    expect(
      await t.run(async (ctx) => {
        const session = await ctx.db.get("sessions", sessionId);
        return {
          contentStatus: session?.contentStatus,
          contentStatusSetBy: session?.contentStatusSetBy,
          contentStatusSetAt: session?.contentStatusSetAt,
        };
      }),
    ).toEqual({
      contentStatus: "draft",
      contentStatusSetBy: undefined,
      contentStatusSetAt: undefined,
    });

    // Once explicitly approved, the already-enabled flag takes effect on the
    // next rebuild without requiring a second publish toggle.
    await alice.mutation(api.sessions.setContentStatus, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      to: "approved",
    });
    preview = await alice.query(api.publish.preview, { eventSlug });
    expect(
      preview.lineup.map((session: { title: string }) => session.title),
    ).toEqual(["Agents in Production"]);
    expect(preview.agenda).toMatchObject([
      { kind: "session", title: "Agents in Production", startsAt, endsAt },
    ]);
    program = (await servedProgram(t, eventSlug))!;
    expect(
      program.lineup.map((session: { title: string }) => session.title),
    ).toEqual(["Agents in Production"]);
    expect(program.agenda).toMatchObject([
      { kind: "session", title: "Agents in Production", startsAt, endsAt },
    ]);
    http = await t.fetch(`/api/events/${eventSlug}/program`);
    expect(http.status).toBe(200);
    expect(await http.json()).toMatchObject({
      lineup: [{ title: "Agents in Production" }],
      agenda: [{ kind: "session", title: "Agents in Production" }],
    });
  });
});

describe("publish — agenda independence", () => {
  test("the agenda grid carries only released+slotted sessions", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });
    // Agenda on, but the session has no released slot yet → agenda empty.
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });
    let program = (await servedProgram(t, eventSlug))!;
    expect(program.agendaPublished).toBe(true);
    expect(program.agenda).toEqual([]);
    // Lineup still shows the (unscheduled) session.
    expect(program.lineup).toHaveLength(1);

    // Give it a released slot; now it joins the agenda.
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionId as Id<"sessions">, {
        startsAt: Date.parse("2026-09-01T17:00:00Z"),
        endsAt: Date.parse("2026-09-01T18:00:00Z"),
        releasedSlot: {
          startsAt: Date.parse("2026-09-01T17:00:00Z"),
          endsAt: Date.parse("2026-09-01T18:00:00Z"),
          releasedAt: Date.parse("2026-08-01T00:00:00Z"),
          sequence: 0,
        },
      });
    });
    // Republish so the stored blob reflects the new slot.
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });
    program = (await servedProgram(t, eventSlug))!;
    expect(program.agenda).toHaveLength(1);
    expect(program.agenda[0].kind).toBe("session");
  });
});

describe("publish — staleness (stored blob)", () => {
  test("editorial edits serve the OLD blob until an explicit republish", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });
    await drainScheduled(t);
    const versionBefore = await t.run(async (ctx) => {
      const rows = await ctx.db.query("publishedPrograms").collect();
      return rows[0].version;
    });
    // A rebuild has landed and matches current state, so nothing is pending.
    expect((await alice.query(api.publish.state, { eventSlug })).stale).toBe(
      false,
    );

    // A title edit and a new confirmation are EDITORIAL changes: they land in
    // the working state but must not reach the served blob on their own
    // (decision log #12 — the public path serves the stored blob verbatim).
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionId as Id<"sessions">, {
        title: "Agents in Production, v2",
      });
      const participants = await ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) =>
          q.eq("sessionId", sessionId as Id<"sessions">),
        )
        .collect();
      const alan = participants.find((p) => p.state === "awaiting");
      if (alan === undefined) throw new Error("no awaiting participant");
      await ctx.db.patch("sessionParticipants", alan._id, {
        state: "confirmed",
      });
    });

    let program = (await servedProgram(t, eventSlug))!;
    expect(program.lineup[0].title).toBe("Agents in Production");
    expect(
      program.lineup[0].speakers.map((s: { name: string }) => s.name),
    ).toEqual(["Grace Hopper"]);
    expect(program.lineup[0].toBeAnnounced).toBe(true);
    expect(
      await t.run(async (ctx) => {
        const rows = await ctx.db.query("publishedPrograms").collect();
        return rows[0].version;
      }),
    ).toBe(versionBefore);
    // ...but the console can SEE that the served bytes are behind: this is the
    // same signal a scheduled rebuild that failed to land shows up as.
    expect((await alice.query(api.publish.state, { eventSlug })).stale).toBe(
      true,
    );

    // Only the organizer's explicit republish moves the served projection.
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });
    program = (await servedProgram(t, eventSlug))!;
    expect(program.lineup[0].title).toBe("Agents in Production, v2");
    expect(
      program.lineup[0].speakers.map((s: { name: string }) => s.name),
    ).toEqual(["Grace Hopper", "Alan Turing"]);
    expect(program.lineup[0].toBeAnnounced).toBe(false);
  });
});

describe("publish — agenda items", () => {
  const ITEM_START = Date.parse("2026-09-01T12:00:00Z");
  const ITEM_END = Date.parse("2026-09-01T13:00:00Z");

  test("an item appears only when the agenda AND the item are both published", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seedProgram(t);
    const roomId = await alice.mutation(api.library.add, {
      eventSlug,
      table: "rooms",
      item: { name: "Atrium" },
    });
    const itemId = await alice.mutation(api.agenda.createAgendaItem, {
      eventSlug,
      title: "Lunch",
      startsAt: ITEM_START,
      endsAt: ITEM_END,
      roomId: roomId as Id<"rooms">,
      description: "Buffet",
    });
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });

    // The per-item flag defaults to false: nothing leaks by accident.
    let program = (await servedProgram(t, eventSlug))!;
    expect(program.agenda).toEqual([]);

    await alice.mutation(api.publish.setAgendaItem, {
      eventSlug,
      itemId,
      published: true,
    });
    program = (await servedProgram(t, eventSlug))!;
    expect(program.agenda).toEqual([
      {
        kind: "item",
        itemId,
        title: "Lunch",
        startsAt: ITEM_START,
        endsAt: ITEM_END,
        roomName: "Atrium",
        description: "Buffet",
      },
    ]);

    // Unpublishing the item removes it from the grid...
    await alice.mutation(api.publish.setAgendaItem, {
      eventSlug,
      itemId,
      published: false,
    });
    program = (await servedProgram(t, eventSlug))!;
    expect(program.agenda).toEqual([]);

    // ...and a published item stays out while the agenda itself is off.
    await alice.mutation(api.publish.setAgendaItem, {
      eventSlug,
      itemId,
      published: true,
    });
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: false });
    program = (await servedProgram(t, eventSlug))!;
    expect(program.agendaPublished).toBe(false);
    expect(program.agenda).toEqual([]);
  });

  test("cross-event session and item ids are refused as not_found", async () => {
    const t = setupTest();
    const { alice, orgSlug, eventSlug } = await seedProgram(t);
    const otherSlug = await createEvent(alice, orgSlug, "Other Summit");
    const otherItemId = await alice.mutation(api.agenda.createAgendaItem, {
      eventSlug: otherSlug,
      title: "Break",
      startsAt: ITEM_START,
      endsAt: ITEM_END,
    });
    const otherSessionId = await t.run(async (ctx) => {
      const other = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", otherSlug))
        .unique();
      if (other === null) throw new Error("no other event");
      return await ctx.db.insert("sessions", {
        eventId: other._id,
        title: "Foreign session",
        source: "direct",
        status: "planned",
      });
    });

    await expectRejectedWith(
      alice.mutation(api.publish.setAgendaItem, {
        eventSlug,
        itemId: otherItemId,
        published: true,
      }),
      "not_found",
    );
    await expectRejectedWith(
      alice.mutation(api.publish.setSession, {
        eventSlug,
        sessionId: otherSessionId,
        published: true,
      }),
      "not_found",
    );
    // The failed flips rolled back whole: nothing was published for the event.
    expect(await servedProgram(t, eventSlug)).toBeNull();
  });
});

describe("publish — HTTP read API", () => {
  test("GET serves the published blob with CORS and cache headers", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });
    await drainScheduled(t);

    const res = await t.fetch(`/api/events/${eventSlug}/program`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // The projection only changes on an explicit publish → short public cache.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    const body = (await res.json()) as {
      event: { slug: string };
      lineup: Array<{ title: string }>;
    };
    expect(body.event.slug).toBe(eventSlug);
    expect(body.lineup.map((s) => s.title)).toEqual(["Agents in Production"]);
    // Same privacy filter as the query path: no unconfirmed names.
    expect(JSON.stringify(body)).not.toContain("Turing");
  });

  test("an unpublished event 404s as not_published; a malformed path as not_found", async () => {
    const t = setupTest();
    const { eventSlug } = await seedProgram(t);

    const res = await t.fetch(`/api/events/${eventSlug}/program`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_published" });
    // Even errors are CORS-readable, so an embed can show a clean message.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBeNull();

    const bad = await t.fetch(`/api/events/${eventSlug}/nope`);
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: "not_found" });
  });

  test("OPTIONS preflight answers 204 with the CORS grant", async () => {
    const t = setupTest();
    const res = await t.fetch("/api/events/whatever/program", {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});

describe("publish — archived events", () => {
  test("archiving stops the serve and refuses publish writes; un-archiving restores the stored blob", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });

    await alice.mutation(api.events.setArchived, { eventSlug, archived: true });

    // The read path serves nothing for an archived event (query AND http)...
    expect(await servedProgram(t, eventSlug)).toBeNull();
    expect((await t.fetch(`/api/events/${eventSlug}/program`)).status).toBe(
      404,
    );

    // ...and every publish control is an M2+ write, so it is refused.
    for (const call of [
      alice.mutation(api.publish.setLineup, { eventSlug, enabled: false }),
      alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true }),
      alice.mutation(api.publish.setSession, {
        eventSlug,
        sessionId: sessionId as Id<"sessions">,
        published: false,
      }),
    ]) {
      await expectRejectedWith(call, "event_archived");
    }

    // Un-archiving serves the stored blob again, untouched.
    await alice.mutation(api.events.setArchived, {
      eventSlug,
      archived: false,
    });
    const program = (await servedProgram(t, eventSlug))!;
    expect(program.lineup).toHaveLength(1);
  });
});

describe("publish — production-path projection", () => {
  const T10 = Date.parse("2026-09-01T10:00:00Z");
  const T11 = Date.parse("2026-09-01T11:00:00Z");

  test("a session driven through accept → approval → agenda release publishes with the real shapes", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    // The whole production path, no raw inserts: CFP submit → accept queue →
    // decision release → confirmation → content approval → board placement →
    // slot release. If computeProgram ever drifts from what these writers
    // actually store, this is the test that breaks.
    await alice.mutation(api.cfp.publishForm, { eventSlug });
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { cfpPublished: true },
    });
    const bob = await signIn(t, "bob");
    const proposalId = await bob.mutation(api.cfp.startProposal, { eventSlug });
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: {
        firstName: "Carol",
        lastName: "Speaker",
        email: "carol@example.com",
        talkTitle: "Convex in anger",
        abstract: "Everything we learned shipping a reactive backend.",
      },
    });
    await bob.mutation(api.cfp.setSpeakers, {
      proposalId,
      speakers: [
        {
          firstName: "Carol",
          lastName: "Speaker",
          email: "carol@example.com",
          tagline: "CTO, Acme",
          isPrimary: true,
        },
      ],
    });
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    await alice.mutation(api.sessions.setStatus, {
      eventSlug,
      proposalIds: [proposalId],
      to: "acceptQueue",
    });
    await alice.mutation(api.sessions.release, {
      eventSlug,
      proposalIds: [proposalId],
    });
    const { sessionId, participantId } = await t.run(async (ctx) => {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId))
        .unique();
      if (session === null) throw new Error("no session");
      const participant = await ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
        .unique();
      if (participant === null) throw new Error("no participant");
      return { sessionId: session._id, participantId: participant._id };
    });
    await alice.mutation(api.sessions.setParticipationState, {
      eventSlug,
      participantId,
      to: "confirmed",
    });
    const roomId = await alice.mutation(api.library.add, {
      eventSlug,
      table: "rooms",
      item: { name: "Main Stage" },
    });
    await alice.mutation(api.agenda.scheduleSession, {
      eventSlug,
      sessionId,
      slot: { startsAt: T10, endsAt: T11, roomId: roomId as Id<"rooms"> },
    });
    expect(
      await alice.mutation(api.agenda.release, {
        eventSlug,
        sessionIds: [sessionId],
      }),
    ).toEqual([{ sessionId, ok: true }]);
    await alice.mutation(api.sessions.setContentStatus, {
      eventSlug,
      sessionId,
      to: "approved",
    });

    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId,
      published: true,
    });
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });

    const program = (await servedProgram(t, eventSlug))!;
    expect(program.lineup).toHaveLength(1);
    expect(program.lineup[0]).toMatchObject({
      sessionId,
      title: "Convex in anger",
      description: "Everything we learned shipping a reactive backend.",
      startsAt: T10,
      endsAt: T11,
      roomName: "Main Stage",
      toBeAnnounced: false,
    });
    expect(program.lineup[0].speakers).toEqual([
      {
        name: "Carol Speaker",
        tagline: "CTO, Acme",
        // Derived from the tagline at snapshot time (eval: structured
        // title/company were blank on converted speakers).
        jobTitle: "CTO",
        company: "Acme",
        speakerId: expect.any(String),
      },
    ]);
    expect(program.agenda).toHaveLength(1);
    expect(program.agenda[0]).toMatchObject({
      kind: "session",
      sessionId,
      startsAt: T10,
    });
    // Contact details and manager identity never cross the wire.
    const wire = JSON.stringify(program);
    expect(wire).not.toContain("carol@example.com");
    expect(wire).not.toContain("bob@example.com");
  });
});

describe("publish — event identity", () => {
  test("a slug/name rename rewrites the served blob immediately", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });

    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { name: "Acme Summit Redux", slug: "acme-redux" },
    });

    // The blob now carries the new identity at the new slug...
    const program = (await servedProgram(t, "acme-redux"))!;
    expect(program.event.name).toBe("Acme Summit Redux");
    expect(program.event.slug).toBe("acme-redux");
    expect(program.lineup).toHaveLength(1);
    // ...and the old slug no longer resolves.
    expect(await servedProgram(t, eventSlug)).toBeNull();
  });

  test("a rename before any publish stays unpublished", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seedProgram(t);
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { name: "Quiet Rename" },
    });
    expect(await servedProgram(t, eventSlug)).toBeNull();
    const rows = await t.run(async (ctx) =>
      ctx.db.query("publishedPrograms").collect(),
    );
    expect(rows).toEqual([]);
  });
});

describe("publish — size guard", () => {
  async function legacyOversizedProjection(t: TestT) {
    const seeded = await seedProgram(t);
    await seeded.alice.mutation(api.publish.setLineup, {
      eventSlug: seeded.eventSlug,
      enabled: true,
    });
    await seeded.alice.mutation(api.publish.setSession, {
      eventSlug: seeded.eventSlug,
      sessionId: seeded.sessionId,
      published: true,
    });
    await drainScheduled(t);

    const eventId = await eventIdOf(t, seeded.eventSlug);
    const legacy = await t.run(async (ctx) => {
      const published = await ctx.db
        .query("publishedPrograms")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .unique();
      if (published === null) throw new Error("program was not published");

      // Simulate a projection written before the 900KiB soft guard existed,
      // while keeping both source and served state identical. It remains below
      // Convex's 1MiB document cap.
      const description = "x".repeat(925_000);
      await ctx.db.patch("sessions", seeded.sessionId, { description });
      const current = published.program as {
        [key: string]: unknown;
        lineup: Array<{
          [key: string]: unknown;
          sessionId: string;
          description?: string;
        }>;
      };
      const program = {
        ...current,
        lineup: current.lineup.map((session) =>
          session.sessionId === seeded.sessionId
            ? { ...session, description }
            : session,
        ),
      };
      await ctx.db.patch("publishedPrograms", published._id, { program });

      const participants = await ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", seeded.sessionId))
        .collect();
      const confirmed = participants.find(
        (participant) =>
          participant.eventContactId === seeded.confirmedContactId,
      );
      if (confirmed === undefined) throw new Error("confirmed speaker missing");

      return {
        bytes: new TextEncoder().encode(JSON.stringify(program)).length,
        participantId: confirmed._id,
        version: published.version,
      };
    });
    expect(legacy.bytes).toBeGreaterThan(900 * 1024);
    expect(legacy.bytes).toBeLessThan(1024 * 1024);
    return { ...seeded, eventId, ...legacy };
  }

  async function publishedVersion(t: TestT, eventId: Id<"events">) {
    return await t.run(async (ctx) => {
      const published = await ctx.db
        .query("publishedPrograms")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .unique();
      if (published === null) throw new Error("program was not published");
      return published.version;
    });
  }

  test("an oversized program is refused naming the largest sessions; unpublishing shrinks it back under", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seedProgram(t);

    // Ten ~100KB sessions push the blob past the ~900KB guard (the document
    // itself caps at 1MiB). Inserted directly: the guard is about the blob,
    // not about how the content got in.
    const bigIds = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      const ids: Array<Id<"sessions">> = [];
      for (let i = 0; i < 10; i += 1) {
        const id = await ctx.db.insert("sessions", {
          eventId: event._id,
          title: `Big session ${i}`,
          description: "x".repeat(95_000 + i * 1_000),
          source: "direct",
          status: "planned",
        });
        await ctx.db.insert("publicationFlags", {
          eventId: event._id,
          targetType: "session",
          targetId: id,
          published: true,
          updatedAt: Date.now(),
        });
        ids.push(id);
      }
      return ids;
    });

    let thrown: unknown;
    try {
      await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    } catch (error) {
      thrown = error;
    }
    const data = (thrown as { data?: { code?: string; message?: string } })
      .data;
    expect(data?.code).toBe("program_too_large");
    // The message names the largest sessions so the fix is actionable.
    expect(data?.message).toContain("Big session 9");
    // The whole mutation rolled back: nothing got published.
    expect(await servedProgram(t, eventSlug)).toBeNull();

    // Unpublishing big sessions removes their content from the recompute in
    // the same transaction, so the flag flip always lands.
    for (const sessionId of bigIds.slice(1)) {
      await alice.mutation(api.publish.setSession, {
        eventSlug,
        sessionId,
        published: false,
      });
    }
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    const program = (await servedProgram(t, eventSlug))!;
    expect(program.lineup.map((s: { title: string }) => s.title)).toEqual([
      "Big session 0",
    ]);
  });

  test("a scheduled privacy removal may strictly shrink a legacy oversized projection", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, participantId, version, bytes } =
      await legacyOversizedProjection(t);

    // Oversized no-op replacements remain refused: only a strict reduction is
    // allowed to cross the soft guard.
    await expectRejectedWith(
      t.mutation(internal.publish.rebuild, { eventId }),
      "program_too_large",
    );
    expect(await publishedVersion(t, eventId)).toBe(version);

    // Declining the confirmed speaker queues the normal privacy rebuild. The
    // resulting projection is still oversized, but smaller, so it must replace
    // the stale blob instead of leaving the speaker public.
    await alice.mutation(api.sessions.setParticipationState, {
      eventSlug,
      participantId,
      to: "declined",
    });
    const program = (await servedProgram(t, eventSlug))!;
    const afterBytes = new TextEncoder().encode(JSON.stringify(program)).length;
    expect(afterBytes).toBeGreaterThan(900 * 1024);
    expect(afterBytes).toBeLessThan(bytes);
    expect(JSON.stringify(program)).not.toContain("Grace Hopper");
    expect(await publishedVersion(t, eventId)).toBe(version + 1);
    expect((await alice.query(api.publish.state, { eventSlug })).stale).toBe(
      false,
    );
  });

  test("an inline profile removal may strictly shrink a legacy oversized projection", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId, confirmedContactId, version, bytes } =
      await legacyOversizedProjection(t);

    // Profile writes rebuild inline so the public and private views commit in
    // one transaction. Clearing the bio is a tiny strict reduction that still
    // leaves this legacy projection above 900KiB.
    await alice.mutation(api.speakers.updateProfile, {
      eventSlug,
      eventContactId: confirmedContactId,
      patch: { bio: "" },
    });
    const program = (await servedProgram(t, eventSlug))!;
    const afterBytes = new TextEncoder().encode(JSON.stringify(program)).length;
    expect(afterBytes).toBeGreaterThan(900 * 1024);
    expect(afterBytes).toBeLessThan(bytes);
    expect(JSON.stringify(program)).not.toContain(
      "Compilers, and speaking about them.",
    );
    expect(await publishedVersion(t, eventId)).toBe(version + 1);
    expect((await alice.query(api.publish.state, { eventSlug })).stale).toBe(
      false,
    );
  });
});

describe("publish — projection is built from ONE read of the graph", () => {
  test("a speaker in two sessions appears in both, with their headshot, exactly once each", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    // Grace speaks in BOTH sessions and has a headshot: the shape that used to
    // cost one participants query per session, one contact `get` per speaker
    // slot and one `storage.getUrl` per slot. Hoisting those reads must not
    // change a byte of the projection.
    const { sessions } = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      const headshotId = await ctx.storage.store(
        new Blob(["headshot"], { type: "image/png" }),
      );
      const grace = await ctx.db.insert("eventContacts", {
        eventId: event._id,
        orgId: event.orgId,
        firstName: "Grace",
        lastName: "Hopper",
        tagline: "Rear Admiral",
        headshotId,
        links: { website: "https://grace.example" },
      });
      const alan = await ctx.db.insert("eventContacts", {
        eventId: event._id,
        orgId: event.orgId,
        firstName: "Alan",
        lastName: "Turing",
      });
      const ids: Array<Id<"sessions">> = [];
      for (const [title, contacts] of [
        ["A talk", [grace]],
        ["B talk", [grace, alan]],
      ] as const) {
        const sessionId = await ctx.db.insert("sessions", {
          eventId: event._id,
          title,
          source: "direct",
          status: "planned",
        });
        for (const eventContactId of contacts) {
          await ctx.db.insert("sessionParticipants", {
            sessionId,
            eventId: event._id,
            eventContactId,
            role: "speaker",
            state: "confirmed",
          });
        }
        ids.push(sessionId);
      }
      return { sessions: ids };
    });

    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    for (const sessionId of sessions) {
      await alice.mutation(api.publish.setSession, {
        eventSlug,
        sessionId,
        published: true,
      });
    }
    const program = (await servedProgram(t, eventSlug))!;

    const headshotUrl = program.lineup[0].speakers[0].headshotUrl;
    expect(typeof headshotUrl).toBe("string");
    // The whole projection, asserted exactly: same speakers, same order, same
    // memoized URL in both sessions, no duplicate entry for the shared speaker.
    expect(program.lineup).toEqual([
      {
        sessionId: sessions[0],
        title: "A talk",
        speakers: [
          {
            speakerId: expect.any(String),
            name: "Grace Hopper",
            tagline: "Rear Admiral",
            headshotUrl,
            links: { website: "https://grace.example" },
          },
        ],
        toBeAnnounced: false,
      },
      {
        sessionId: sessions[1],
        title: "B talk",
        speakers: [
          {
            speakerId: expect.any(String),
            name: "Grace Hopper",
            tagline: "Rear Admiral",
            headshotUrl,
            links: { website: "https://grace.example" },
          },
          { speakerId: expect.any(String), name: "Alan Turing" },
        ],
        toBeAnnounced: false,
      },
    ]);
  });
});

describe("publish — refuses an event past its read caps", () => {
  test("an at-cap read throws event_too_large instead of silently dropping rows", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seedProgram(t);
    // 501 rooms overflows the 500-row library read. A `.take(500)` would have
    // published a program built from a truncated graph and said nothing.
    await t.run(async (ctx) => {
      const eventId = (await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique())!._id;
      for (let i = 0; i < 501; i += 1) {
        await ctx.db.insert("rooms", { eventId, name: `Room ${i}`, order: i });
      }
    });

    let thrown: unknown;
    try {
      await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    } catch (error) {
      thrown = error;
    }
    const data = (thrown as { data?: { code?: string; message?: string } })
      .data;
    expect(data?.code).toBe("event_too_large");
    // Actionable, in the same voice as the size guard.
    expect(data?.message).toContain("more than 500 rooms");
    // Refused whole: nothing was published from the truncated graph.
    expect(await servedProgram(t, eventSlug)).toBeNull();
  });
});

describe("publish — a rebuild that does not land is visible", () => {
  /** Publish one small session and let the scheduled rebuild land. */
  async function published(t: TestT) {
    const seeded = await seedProgram(t);
    await seeded.alice.mutation(api.publish.setLineup, {
      eventSlug: seeded.eventSlug,
      enabled: true,
    });
    await seeded.alice.mutation(api.publish.setSession, {
      eventSlug: seeded.eventSlug,
      sessionId: seeded.sessionId as Id<"sessions">,
      published: true,
    });
    await drainScheduled(t);
    return seeded;
  }

  async function publishedRow(t: TestT) {
    return await t.run(async (ctx) => {
      const rows = await ctx.db.query("publishedPrograms").collect();
      expect(rows).toHaveLength(1);
      return rows[0];
    });
  }

  test("a failed rebuild keeps the last good blob and reads as stale", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await published(t);
    const before = await publishedRow(t);

    // Content the projection cannot hold, inserted directly so no organizer
    // mutation gets the chance to refuse it: the scheduled rebuild is what hits
    // the size guard now.
    await t.run(async (ctx) => {
      const eventId = (await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique())!._id;
      for (let i = 0; i < 10; i += 1) {
        const id = await ctx.db.insert("sessions", {
          eventId,
          title: `Big session ${i}`,
          description: "x".repeat(95_000),
          source: "direct",
          status: "planned",
        });
        await ctx.db.insert("publicationFlags", {
          eventId,
          targetType: "session",
          targetId: id,
          published: true,
          updatedAt: Date.now(),
        });
      }
    });

    await expectRejectedWith(
      t.mutation(internal.publish.rebuild, {
        eventId: await eventIdOf(t, eventSlug),
      }),
      "program_too_large",
    );

    // The public keeps the last good projection — never a half-written or
    // truncated one...
    const program = (await servedProgram(t, eventSlug))!;
    expect(program.lineup.map((s: { title: string }) => s.title)).toEqual([
      "Agents in Production",
    ]);
    expect((await publishedRow(t)).version).toBe(before.version);
    // ...and the organizer console can tell that the served bytes are behind.
    expect((await alice.query(api.publish.state, { eventSlug })).stale).toBe(
      true,
    );
  });

  test("a rebuild with nothing to change writes nothing and does NOT read as stale", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await published(t);
    const before = await publishedRow(t);

    // The coalescing case: several flips queue several rebuilds, and every one
    // after the first recomputes identical bytes. "Already correct" must not
    // bump the version, and must not look like the failure above.
    await t.mutation(internal.publish.rebuild, {
      eventId: await eventIdOf(t, eventSlug),
      publishedBy: before.publishedBy,
    });
    const after = await publishedRow(t);
    expect(after.version).toBe(before.version);
    expect(after.publishedAt).toBe(before.publishedAt);
    expect((await alice.query(api.publish.state, { eventSlug })).stale).toBe(
      false,
    );
  });
});

describe("publish — authorization", () => {
  test("reviewers cannot read state or publish", async () => {
    const t = setupTest();
    const { eventSlug } = await seedProgram(t);
    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    await expectRejectedWith(
      rita.query(api.publish.state, { eventSlug }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.mutation(api.publish.setLineup, { eventSlug, enabled: true }),
      "forbidden",
    );
  });

  test("the public read is unauthenticated", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });
    // No identity at all — still resolves.
    const program = (await servedProgram(t, eventSlug))!;
    expect(program.lineup).toHaveLength(1);
  });
});

describe("publish — freshness (W4)", () => {
  test("a confirmation recorded through the product refreshes the served blob without a republish", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedProgram(t);
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });
    await drainScheduled(t);

    let program = (await servedProgram(t, eventSlug))!;
    expect(
      program.lineup[0].speakers.map((s: { name: string }) => s.name),
    ).toEqual(["Grace Hopper"]);

    // The organizer records Alan's confirmation through the real mutation —
    // no explicit republish follows, yet the public blob names him.
    const alanId = await t.run(async (ctx) => {
      const participants = await ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) =>
          q.eq("sessionId", sessionId as Id<"sessions">),
        )
        .collect();
      return participants.find((p) => p.state === "awaiting")!._id;
    });
    await alice.mutation(api.sessions.setParticipationState, {
      eventSlug,
      participantId: alanId,
      to: "confirmed",
    });

    program = (await servedProgram(t, eventSlug))!;
    expect(
      program.lineup[0].speakers.map((s: { name: string }) => s.name),
    ).toEqual(["Grace Hopper", "Alan Turing"]);
    expect(program.lineup[0].toBeAnnounced).toBe(false);
    expect((await alice.query(api.publish.state, { eventSlug })).stale).toBe(
      false,
    );
  });
});
