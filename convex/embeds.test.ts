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
  type TestT,
} from "./test.helpers";

// Embeds (W3): named widget instances over the published projection, plus
// the content-approval gate (W5) and the iCal feed.

async function drainScheduled(t: TestT): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

/** One event, two published sessions on different tracks, lineup on. */
async function seedPublished(t: TestT) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
  const { sessionIds } = await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
      .unique();
    if (event === null) throw new Error("no event");
    const infra = await ctx.db.insert("tracks", {
      eventId: event._id,
      name: "Infra",
      order: 0,
    });
    const ai = await ctx.db.insert("tracks", {
      eventId: event._id,
      name: "AI",
      order: 1,
    });
    const a = await ctx.db.insert("sessions", {
      eventId: event._id,
      title: "Infra talk",
      trackId: infra,
      source: "direct",
      status: "planned",
    });
    const b = await ctx.db.insert("sessions", {
      eventId: event._id,
      title: "AI talk",
      trackId: ai,
      source: "direct",
      status: "planned",
    });
    return { sessionIds: [a, b] };
  });
  await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
  for (const sessionId of sessionIds) {
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId,
      published: true,
    });
  }
  await drainScheduled(t);
  return { alice, eventSlug, sessionIds };
}

describe("embeds", () => {
  test("create → resolve serves the published blob with the track filter; disable → null", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seedPublished(t);

    const embedId = await alice.mutation(api.embeds.create, {
      eventSlug,
      name: "Infra sessions",
      widget: "sessions",
      config: { trackName: "Infra" },
    });
    const listed = await alice.query(api.embeds.list, { eventSlug });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "Infra sessions",
      widget: "sessions",
      enabled: true,
    });

    // Anonymous resolve: only the Infra-track session survives the filter.
    const resolved = (await t.query(api.embeds.resolve, { embedId }))!;
    expect(resolved.widget).toBe("sessions");
    expect(
      resolved.program.lineup.map((s: { title: string }) => s.title),
    ).toEqual(["Infra talk"]);

    // Disabled embeds read as null (per-embed kill switch).
    await alice.mutation(api.embeds.update, {
      eventSlug,
      embedId,
      enabled: false,
    });
    expect(await t.query(api.embeds.resolve, { embedId })).toBeNull();
    // Junk ids too.
    expect(
      await t.query(api.embeds.resolve, { embedId: "nonsense" }),
    ).toBeNull();
  });

  test("a name with a control character is refused at create and update", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seedPublished(t);
    await expectRejectedWith(
      alice.mutation(api.embeds.create, {
        eventSlug,
        name: "Hacked\r\nX-Evil: yes",
        widget: "sessions",
        config: {},
      }),
      "invalid_name",
    );

    const embedId = await alice.mutation(api.embeds.create, {
      eventSlug,
      name: "Clean sessions",
      widget: "sessions",
      config: {},
    });
    await expectRejectedWith(
      alice.mutation(api.embeds.update, {
        eventSlug,
        embedId,
        name: "Also\r\nBad",
      }),
      "invalid_name",
    );
  });

  test("draft content status pulls a session from public output; approve restores it (CNT-12)", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionIds } = await seedPublished(t);

    let program = (await t.query(api.publish.publicProgram, {
      slug: eventSlug,
    }))!;
    expect(program.lineup).toHaveLength(2);

    await alice.mutation(api.sessions.setContentStatus, {
      eventSlug,
      sessionId: sessionIds[1] as Id<"sessions">,
      to: "draft",
    });
    // Re-enabling an already-enabled publication flag is the deployed defect:
    // it must not double as an editorial approval action.
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId: sessionIds[1] as Id<"sessions">,
      published: true,
    });
    await drainScheduled(t);
    program = (await t.query(api.publish.publicProgram, { slug: eventSlug }))!;
    expect(program.lineup.map((s: { title: string }) => s.title)).toEqual([
      "Infra talk",
    ]);
    expect(
      await t.run(
        async (ctx) =>
          (await ctx.db.get("sessions", sessionIds[1] as Id<"sessions">))
            ?.contentStatus,
      ),
    ).toBe("draft");

    const embedId = await alice.mutation(api.embeds.create, {
      eventSlug,
      name: "Approved sessions only",
      widget: "sessions",
      config: {},
    });
    let resolved = (await t.query(api.embeds.resolve, { embedId }))!;
    expect(
      resolved.program.lineup.map((s: { title: string }) => s.title),
    ).toEqual(["Infra talk"]);

    await alice.mutation(api.sessions.setContentStatus, {
      eventSlug,
      sessionId: sessionIds[1] as Id<"sessions">,
      to: "approved",
    });
    await drainScheduled(t);
    program = (await t.query(api.publish.publicProgram, { slug: eventSlug }))!;
    expect(program.lineup).toHaveLength(2);
    resolved = (await t.query(api.embeds.resolve, { embedId }))!;
    expect(
      resolved.program.lineup.map((s: { title: string }) => s.title),
    ).toEqual(["AI talk", "Infra talk"]);
  });

  test("the program.ics feed serves a VCALENDAR of released agenda entries", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionIds } = await seedPublished(t);
    // Give one session a released slot + turn the agenda on.
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionIds[0] as Id<"sessions">, {
        releasedSlot: {
          startsAt: Date.parse("2027-05-12T17:00:00Z"),
          endsAt: Date.parse("2027-05-12T18:00:00Z"),
          releasedAt: Date.now(),
          sequence: 0,
        },
      });
    });
    await alice.mutation(api.publish.setAgenda, { eventSlug, enabled: true });
    await drainScheduled(t);

    const response = await t.fetch(`/api/events/${eventSlug}/program.ics`, {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/calendar");
    const body = await response.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("SUMMARY:Infra talk");
    expect(body).toContain("DTSTART:20270512T170000Z");
  });
});
