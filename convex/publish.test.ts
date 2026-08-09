/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  setupTest,
  signIn,
  grantEventRole,
} from "./test.helpers";

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
    expect(
      await t.query(api.publish.publicProgram, { slug: eventSlug }),
    ).toBeNull();

    // Enabling the lineup alone still shows no sessions (per-session flag off).
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    let program = (await t.query(api.publish.publicProgram, { slug: eventSlug }))!;
    expect(program).not.toBeNull();
    expect(program.lineup).toEqual([]);

    // Publishing the session brings it into the lineup.
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionId as Id<"sessions">,
      published: true,
    });
    program = (await t.query(api.publish.publicProgram, { slug: eventSlug }))!;
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
    const program = (await t.query(api.publish.publicProgram, { slug: eventSlug }))!;
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
    const program = (await t.query(api.publish.publicProgram, { slug: eventSlug }))!;
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
    expect(
      await t.query(api.publish.publicProgram, { slug: eventSlug }),
    ).toBeNull();
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
    let program = (await t.query(api.publish.publicProgram, { slug: eventSlug }))!;
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
    program = (await t.query(api.publish.publicProgram, { slug: eventSlug }))!;
    expect(program.agenda).toHaveLength(1);
    expect(program.agenda[0].kind).toBe("session");
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
    const program = (await t.query(api.publish.publicProgram, { slug: eventSlug }))!;
    expect(program.lineup).toHaveLength(1);
  });
});
