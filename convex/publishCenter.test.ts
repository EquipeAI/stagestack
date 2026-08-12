/// <reference types="vite/client" />
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  auditActions,
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
  type TestT,
} from "./test.helpers";

// ─────────────────────────────────────────────────────────────────────────
// W10 — the publish center's backend.
//
// What these pin down:
//   • the diff says exactly what publishing will do, per channel, down to
//     WHICH field changed — and an unchanged program diffs to nothing;
//   • the diff and the publish AGREE: publishing after a diff produces exactly
//     the served blob the diff described (asserted against the blob, not
//     against a re-run of the diff);
//   • bulk publish's eligibility is the mutation's own producer, so the
//     arithmetic stated before the click is what the click does;
//   • "Last published by …" has exactly ONE composer in the repository;
//   • every new query and the new mutation refuse a non-organizer.
// ─────────────────────────────────────────────────────────────────────────

const SLOT_START = Date.parse("2026-09-01T10:00:00Z");

async function drainScheduled(t: TestT): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function servedProgram(t: TestT, slug: string) {
  await drainScheduled(t);
  return await t.query(api.publish.publicProgram, { slug });
}

/**
 * An event with two planned, approved sessions — one slotted and released, one
 * not — plus a released agenda item. Enough for both channels to have their own
 * eligible set and their own exclusions.
 */
async function seed(t: TestT) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

  const ids = await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
      .unique();
    if (event === null) throw new Error("no event");
    const roomId = await ctx.db.insert("rooms", {
      eventId: event._id,
      name: "Main Hall",
      capacity: 200,
      order: 0,
    });
    const scheduled = await ctx.db.insert("sessions", {
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
        roomId,
        releasedAt: SLOT_START,
        sequence: 0,
      },
    });
    const unscheduled = await ctx.db.insert("sessions", {
      eventId: event._id,
      title: "Beyond the Prompt",
      source: "direct",
      status: "planned",
      contentStatus: "approved",
    });
    const contactId = await ctx.db.insert("eventContacts", {
      eventId: event._id,
      orgId: event.orgId,
      firstName: "Grace",
      lastName: "Hopper",
    });
    await ctx.db.insert("sessionParticipants", {
      sessionId: scheduled,
      eventId: event._id,
      eventContactId: contactId,
      role: "speaker",
      state: "confirmed",
    });
    const itemId = await ctx.db.insert("agendaItems", {
      eventId: event._id,
      title: "Coffee break",
      startsAt: SLOT_START + 60 * 60_000,
      endsAt: SLOT_START + 90 * 60_000,
      roomId,
    });
    return { eventId: event._id, roomId, scheduled, unscheduled, itemId };
  });

  return { alice, orgSlug, eventSlug, ...ids };
}

type Alice = Awaited<ReturnType<typeof signIn>>;

const titles = (rows: Array<{ title: string }>) =>
  rows.map((r) => r.title).sort();

describe("publish diff — what publishing would change", () => {
  test("nothing published yet: every entry is an addition, per channel", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seed(t);

    const diff = await alice.query(api.publish.diff, { eventSlug });
    expect(diff.neverPublished).toBe(true);
    // The lineup would carry both sessions; the schedule only the released
    // one, plus the agenda item.
    expect(titles(diff.lineup.added)).toEqual([
      "Agents in Production",
      "Beyond the Prompt",
    ]);
    expect(titles(diff.agenda.added)).toEqual([
      "Agents in Production",
      "Coffee break",
    ]);
    expect(diff.lineup.changed).toEqual([]);
    expect(diff.lineup.removed).toEqual([]);
    expect(diff.lineup.empty).toBe(false);
    expect(diff.lineup.sentence).toBe(
      "Publishing the lineup adds 2 sessions, changes 0, removes 0.",
    );
    expect(diff.agenda.sentence).toBe(
      "Publishing the schedule adds 2 entries, changes 0, removes 0.",
    );
  });

  test("a published program with nothing pending diffs to nothing, honestly", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seed(t);
    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "lineup",
    });
    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "agenda",
    });
    await drainScheduled(t);

    const diff = await alice.query(api.publish.diff, { eventSlug });
    expect(diff.neverPublished).toBe(false);
    expect(diff.lineup.empty).toBe(true);
    expect(diff.agenda.empty).toBe(true);
    expect(diff.lineup.sentence).toBe("No changes to publish.");
    expect(diff.agenda.sentence).toBe("No changes to publish.");
    // The unpublish direction is the served count, not the diff.
    expect(diff.lineup.unpublishSentence).toBe(
      "Unpublishing the lineup removes 2 sessions from the public page.",
    );
  });

  test("field-level changes: title, slot and speakers are named separately", async () => {
    const t = setupTest();
    const { alice, eventSlug, scheduled, roomId } = await seed(t);
    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "lineup",
    });
    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "agenda",
    });
    await drainScheduled(t);

    // An editorial edit that is NOT propagated: the served blob waits for an
    // explicit republish, which is exactly what the diff exists to describe.
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", scheduled, {
        title: "Agents in Production, 2026",
      });
    });
    let diff = await alice.query(api.publish.diff, { eventSlug });
    expect(diff.lineup.changed).toEqual([
      {
        id: scheduled,
        title: "Agents in Production, 2026",
        changes: ["title"],
      },
    ]);
    expect(diff.lineup.sentence).toBe(
      "Publishing the lineup adds 0 sessions, changes 1 (title), removes 0.",
    );

    // Move the slot: the same session, a different time and room.
    const other = await t.run(async (ctx) => {
      const event = await ctx.db.get("rooms", roomId);
      if (event === null) throw new Error("no room");
      const otherRoom = await ctx.db.insert("rooms", {
        eventId: event.eventId,
        name: "Studio B",
        capacity: 40,
        order: 1,
      });
      await ctx.db.patch("sessions", scheduled, {
        releasedSlot: {
          startsAt: SLOT_START + 2 * 60 * 60_000,
          endsAt: SLOT_START + 3 * 60 * 60_000,
          roomId: otherRoom,
          releasedAt: SLOT_START,
          sequence: 1,
        },
      });
      return otherRoom;
    });
    expect(other).toBeDefined();
    diff = await alice.query(api.publish.diff, { eventSlug });
    expect(diff.agenda.changed[0].changes).toEqual(["title", "slot"]);
    expect(diff.agenda.sentence).toBe(
      "Publishing the schedule adds 0 entries, changes 1 (title, slot), removes 0.",
    );

    // A withdrawal the organizer has not republished yet changes the speaker
    // line — the public program's most sensitive field.
    await t.run(async (ctx) => {
      const participant = await ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", scheduled))
        .unique();
      if (participant === null) throw new Error("no participant");
      await ctx.db.patch("sessionParticipants", participant._id, {
        state: "withdrawn",
      });
    });
    diff = await alice.query(api.publish.diff, { eventSlug });
    // The slot change from the step above is still pending too — a diff that
    // forgot it would be exactly the kind of quiet lie this exists to prevent.
    expect(diff.lineup.changed[0].changes).toEqual([
      "title",
      "speakers",
      "slot",
    ]);
  });

  test("removals: a session held back by content approval leaves the program", async () => {
    const t = setupTest();
    const { alice, eventSlug, unscheduled } = await seed(t);
    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "lineup",
    });
    await drainScheduled(t);

    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", unscheduled, { contentStatus: "draft" });
    });
    const diff = await alice.query(api.publish.diff, { eventSlug });
    expect(titles(diff.lineup.removed)).toEqual(["Beyond the Prompt"]);
    expect(diff.lineup.added).toEqual([]);
    expect(diff.lineup.sentence).toBe(
      "Publishing the lineup adds 0 sessions, changes 0, removes 1.",
    );
  });

  test("the diff describes a channel that is still OFF, not the empty array it serves", async () => {
    const t = setupTest();
    const { alice, eventSlug, scheduled } = await seed(t);
    // Lineup only: the schedule stays unpublished.
    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "lineup",
    });
    await drainScheduled(t);
    const state = await alice.query(api.publish.state, { eventSlug });
    expect(state.agendaPublished).toBe(false);

    const diff = await alice.query(api.publish.diff, { eventSlug });
    // The served agenda is empty, and so is a straight recompute — but the
    // question is what PUBLISHING would do, and the answer is two entries.
    expect(titles(diff.agenda.added)).toEqual([
      "Agents in Production",
      "Coffee break",
    ]);
    expect(diff.agenda.added.some((row) => row.id.includes(scheduled))).toBe(
      true,
    );
  });
});

describe("publish diff — agreement with the publish that follows", () => {
  test("publishing after a diff produces exactly the diff, asserted on the served blob", async () => {
    const t = setupTest();
    const { alice, eventSlug, scheduled, unscheduled } = await seed(t);
    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "lineup",
    });
    await drainScheduled(t);

    // Three pending facts at once: a rename, a new session, and one dropping
    // out of the program. One diff has to describe all three.
    const added = await t.run(async (ctx) => {
      await ctx.db.patch("sessions", scheduled, { title: "Agents, Revised" });
      await ctx.db.patch("sessions", unscheduled, { contentStatus: "draft" });
      const event = await ctx.db.get("sessions", scheduled);
      if (event === null) throw new Error("no session");
      return await ctx.db.insert("sessions", {
        eventId: event.eventId,
        title: "Zero to Eval",
        source: "direct",
        status: "planned",
        contentStatus: "approved",
      });
    });

    const before = (await servedProgram(t, eventSlug))!;
    const diff = await alice.query(api.publish.diff, { eventSlug });
    expect(titles(diff.lineup.added)).toEqual(["Zero to Eval"]);
    expect(titles(diff.lineup.changed)).toEqual(["Agents, Revised"]);
    expect(titles(diff.lineup.removed)).toEqual(["Beyond the Prompt"]);

    // Now publish everything eligible and read the SERVED bytes.
    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "lineup",
    });
    const after = (await servedProgram(t, eventSlug))!;

    const beforeIds = new Set(
      before.lineup.map((s: { sessionId: string }) => s.sessionId),
    );
    const afterIds = new Set(
      after.lineup.map((s: { sessionId: string }) => s.sessionId),
    );
    // Exactly the added ids appeared, exactly the removed ids left.
    expect([...afterIds].filter((id) => !beforeIds.has(id))).toEqual([added]);
    expect([...beforeIds].filter((id) => !afterIds.has(id))).toEqual([
      unscheduled,
    ]);
    // And the changed row changed in the field the diff named.
    expect(diff.lineup.changed[0].changes).toEqual(["title"]);
    expect(
      after.lineup.find(
        (s: { sessionId: string }) => s.sessionId === scheduled,
      )?.title,
    ).toBe("Agents, Revised");

    // Having applied it, there is nothing left to publish.
    const settled = await alice.query(api.publish.diff, { eventSlug });
    expect(settled.lineup.empty).toBe(true);
  });
});

describe("publish diff — agreement on the SCHEDULE channel", () => {
  test("bulk publishing the schedule lands exactly the diff, agenda items included", async () => {
    const t = setupTest();
    const { alice, eventSlug, scheduled, itemId } = await seed(t);

    // Publish the schedule once so there is a served blob to diff against,
    // then move the slot and add a second agenda item — a change and an
    // addition on the channel whose entries are not all sessions.
    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "agenda",
    });
    await drainScheduled(t);

    const secondItem = await t.run(async (ctx) => {
      const session = await ctx.db.get("sessions", scheduled);
      if (session === null) throw new Error("no session");
      await ctx.db.patch("sessions", scheduled, {
        releasedSlot: {
          startsAt: SLOT_START + 3 * 60 * 60_000,
          endsAt: SLOT_START + 4 * 60 * 60_000,
          releasedAt: SLOT_START,
          sequence: 2,
        },
      });
      return await ctx.db.insert("agendaItems", {
        eventId: session.eventId,
        title: "Closing remarks",
        startsAt: SLOT_START + 5 * 60 * 60_000,
        endsAt: SLOT_START + 6 * 60 * 60_000,
      });
    });

    const before = (await servedProgram(t, eventSlug))!;
    const diff = await alice.query(api.publish.diff, { eventSlug });
    expect(titles(diff.agenda.added)).toEqual(["Closing remarks"]);
    expect(titles(diff.agenda.changed)).toEqual(["Agents in Production"]);
    expect(diff.agenda.changed[0].changes).toEqual(["slot"]);
    expect(diff.agenda.removed).toEqual([]);

    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "agenda",
    });
    const after = (await servedProgram(t, eventSlug))!;

    const key = (entry: { kind: string; sessionId?: string; itemId?: string }) =>
      entry.kind === "session" ? `session:${entry.sessionId}` : `item:${entry.itemId}`;
    const beforeKeys = new Set(before.agenda.map(key));
    const afterKeys = new Set(after.agenda.map(key));
    // Exactly the added entry appeared; nothing else came or went.
    expect([...afterKeys].filter((k) => !beforeKeys.has(k))).toEqual([
      `item:${secondItem}`,
    ]);
    expect([...beforeKeys].filter((k) => !afterKeys.has(k))).toEqual([]);
    // And the changed session moved in the field the diff named.
    const moved = after.agenda.find(
      (entry: { kind: string; sessionId?: string }) =>
        entry.kind === "session" && entry.sessionId === scheduled,
    );
    expect(moved?.startsAt).toBe(SLOT_START + 3 * 60 * 60_000);
    // The untouched item is still there, unchanged.
    expect(afterKeys.has(`item:${itemId}`)).toBe(true);

    const settled = await alice.query(api.publish.diff, { eventSlug });
    expect(settled.agenda.empty).toBe(true);
  });
});

describe("bulk publish — the size guard refuses in full", () => {
  test("an oversized bulk publish rolls back every flag AND its audit row", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventId } = await seed(t);

    // Ten ~100KB sessions push the projection past the 900KB guard. Bulk
    // publish is a GROWING action, so it must refuse — and take everything it
    // wrote in the same transaction down with it.
    await t.run(async (ctx) => {
      for (let i = 0; i < 10; i += 1) {
        await ctx.db.insert("sessions", {
          eventId,
          title: `Big session ${i}`,
          description: "x".repeat(95_000 + i * 1_000),
          source: "direct",
          status: "planned",
          contentStatus: "approved",
        });
      }
    });

    const auditBefore = await auditActions(t);
    let thrown: unknown;
    try {
      await alice.mutation(api.publish.bulkPublish, {
        eventSlug,
        channel: "lineup",
      });
    } catch (error) {
      thrown = error;
    }
    const data = (thrown as { data?: { code?: string; message?: string } })
      .data;
    expect(data?.code).toBe("program_too_large");
    // The refusal names the largest sessions, so the fix is in the sentence.
    expect(data?.message).toContain("Big session 9");

    // TOTAL rollback. The channel switch: untouched.
    const event = await t.run(async (ctx) => await ctx.db.get("events", eventId));
    expect(event?.publicPageEnabled).not.toBe(true);
    // Every entry flag: untouched (the mutation writes one per eligible row
    // before the guard runs, and not one of them may survive the refusal).
    const flags = await t.run(async (ctx) =>
      await ctx.db
        .query("publicationFlags")
        .withIndex("by_eventId_and_target", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(flags).toEqual([]);
    // The audit row: never written.
    expect(await auditActions(t)).toEqual(auditBefore);
    expect(await auditActions(t)).not.toContain("publish.bulkLineup");
    // And nothing is served.
    expect(await servedProgram(t, eventSlug)).toBeNull();

    // The state the console reads agrees: still off, still never published.
    const state = await alice.query(api.publish.state, { eventSlug });
    expect(state.lineupPublished).toBe(false);
    expect(state.version).toBeNull();
  });
});

describe("bulk publish — the plan is the enforcement", () => {
  test("the stated eligibility is what the mutation publishes", async () => {
    const t = setupTest();
    const { alice, eventSlug, scheduled, unscheduled, itemId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", unscheduled, { contentStatus: "draft" });
    });

    const plan = await alice.query(api.publish.bulkPlan, {
      eventSlug,
      channel: "lineup",
    });
    expect(plan.eligible).toBe(1);
    expect(plan.targets.map((row) => row.id)).toEqual([scheduled]);
    expect(plan.excluded).toEqual([
      {
        sessionId: unscheduled,
        title: "Beyond the Prompt",
        // W4's sentence, verbatim — not a second wording of the same fact.
        sentence: "Content is Draft.",
      },
    ]);
    expect(plan.enablesChannel).toBe(true);
    expect(plan.sentence).toBe(
      "1 entry is eligible for the lineup. 1 session is excluded: 1 because content is Draft. " +
        "The public page is off, so this turns it on too.",
    );

    const result = await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "lineup",
    });
    expect(result.published).toBe(plan.eligible);
    expect(result.excluded).toBe(plan.excluded.length);
    expect(result.title).toBe("Published 1 to the lineup");

    // The blob agrees with both.
    const program = (await servedProgram(t, eventSlug))!;
    expect(titles(program.lineup)).toEqual(["Agents in Production"]);

    // The agenda's own arithmetic is different: the unreleased session is
    // excluded for a different reason, and the agenda item is eligible.
    const agendaPlan = await alice.query(api.publish.bulkPlan, {
      eventSlug,
      channel: "agenda",
    });
    expect(agendaPlan.targets.map((row) => row.id).sort()).toEqual(
      [scheduled, itemId].sort(),
    );
    expect(agendaPlan.excluded.map((row) => row.sentence)).toEqual([
      "Content is Draft.",
    ]);
    // The session flag is already on from the lineup run: honest arithmetic
    // counts it as already published rather than as work done twice.
    expect(agendaPlan.alreadyPublished).toBe(1);
  });

  test("running it twice is a no-op with an honest outcome", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seed(t);
    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "lineup",
    });
    const again = await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "lineup",
    });
    expect(again.status).toBe("noop");
    expect(again.published).toBe(0);
    expect(again.title).toBe("Nothing to publish to the lineup");
    expect(again.lines).toContain(
      "2 were already published and left alone.",
    );
  });

  test("a cancelled session is neither eligible nor reported as excluded work", async () => {
    const t = setupTest();
    const { alice, eventSlug, unscheduled } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", unscheduled, { status: "cancelled" });
    });
    const plan = await alice.query(api.publish.bulkPlan, {
      eventSlug,
      channel: "lineup",
    });
    expect(plan.eligible).toBe(1);
    expect(plan.excluded).toEqual([]);
  });
});

describe("attribution — one composer", () => {
  test('only convex/model/controlCenter.ts composes "Last published"', () => {
    // Grep-level on purpose: a second composer renders perfectly well and is
    // only detectable as two sources for one sentence.
    const roots = ["convex", join("apps", "web", "src")];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "_generated") {
          continue;
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (entry.name.includes(".test.")) continue;
        if (readFileSync(path, "utf8").includes("Last published")) {
          hits.push(path);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(hits).toEqual([join("convex", "model", "controlCenter.ts")]);
  });

  test("the publish center reads that producer's sentence, attribution included", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await seed(t);
    await alice.mutation(api.publish.bulkPublish, {
      eventSlug,
      channel: "lineup",
    });
    await drainScheduled(t);

    const next = await alice.query(api.readiness.upNext, {
      eventSlug,
      now: Date.now(),
    });
    const lineup = next.channels.find((c) => c.id === "lineup");
    expect(lineup?.published).toBe(true);
    expect(lineup?.sentence).toContain("Last published by");
    expect(next.version).toBe(1);
  });
});

describe("authorization — the new surfaces are organizer-only", () => {
  const cases: Array<[string, (as: Alice, eventSlug: string) => Promise<unknown>]> =
    [
      ["publish.diff", (as, eventSlug) => as.query(api.publish.diff, { eventSlug })],
      [
        "publish.bulkPlan",
        (as, eventSlug) =>
          as.query(api.publish.bulkPlan, { eventSlug, channel: "lineup" }),
      ],
      [
        "publish.bulkPublish",
        (as, eventSlug) =>
          as.mutation(api.publish.bulkPublish, { eventSlug, channel: "lineup" }),
      ],
    ];

  for (const [name, call] of cases) {
    test(`${name} refuses a reviewer`, async () => {
      const t = setupTest();
      const { eventSlug } = await seed(t);
      const bob = await signIn(t, "bob");
      await grantEventRole(t, eventSlug, "bob", "reviewer");
      await expectRejectedWith(call(bob, eventSlug), "forbidden");
    });

    test(`${name} refuses a stranger`, async () => {
      const t = setupTest();
      const { eventSlug } = await seed(t);
      const mallory = await signIn(t, "mallory");
      await expectRejectedWith(call(mallory, eventSlug), "forbidden");
    });
  }
});

/** Ids the seed hands back are typed for the assertions above. */
export type _Ids = Id<"sessions">;
