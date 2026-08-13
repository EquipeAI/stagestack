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
// W1 — global search, the command palette's one backend capability.
//
// What is worth breaking the build over:
//   • the reviewer scope. A reviewer must reach their own assignments and
//     NOTHING else: no session, no speaker (a name IS a contact detail), no
//     proposal they were not assigned. The palette is a new door into every
//     table at once, so this is the whole ballgame;
//   • tenancy. Another organization's event, sessions and speakers must not
//     surface for a term that matches them perfectly;
//   • the capped flag. A group showing a prefix must SAY it is showing a
//     prefix — the counts elsewhere in this product are floors when they are
//     floors, and this one is no different.
// ─────────────────────────────────────────────────────────────────────────

async function seedEvent(
  t: TestT,
  eventSlug: string,
): Promise<Id<"events">> {
  return await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
      .unique();
    if (event === null) throw new Error(`no event ${eventSlug}`);
    return event._id;
  });
}

async function addSession(t: TestT, eventId: Id<"events">, title: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      eventId,
      title,
      format: "Talk",
      source: "direct",
      status: "planned",
      contentStatus: "approved",
    }),
  );
}

async function addSpeaker(
  t: TestT,
  eventId: Id<"events">,
  firstName: string,
  lastName: string,
) {
  return await t.run(async (ctx) => {
    const event = await ctx.db.get("events", eventId);
    if (event === null) throw new Error("no event");
    return ctx.db.insert("eventContacts", {
      eventId,
      orgId: event.orgId,
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}@example.com`,
      tagline: "Rear Admiral, US Navy",
    });
  });
}

async function addProposal(
  t: TestT,
  eventId: Id<"events">,
  title: string,
  submitterKey = "alice",
) {
  return await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", `https://test.clerk.example.com|${submitterKey}`),
      )
      .unique();
    if (user === null) throw new Error(`no user ${submitterKey}`);
    return ctx.db.insert("proposals", {
      eventId,
      submitterUserId: user._id,
      status: "pending",
      title,
      answers: {},
      formVersion: 1,
      updatedAt: 0,
    });
  });
}

async function assignReview(
  t: TestT,
  eventId: Id<"events">,
  proposalId: Id<"proposals">,
  reviewerKey: string,
) {
  await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", `https://test.clerk.example.com|${reviewerKey}`),
      )
      .unique();
    if (user === null) throw new Error(`no user ${reviewerKey}`);
    await ctx.db.insert("reviews", {
      eventId,
      proposalId,
      reviewerUserId: user._id,
      status: "assigned",
      updatedAt: 0,
    });
  });
}

type Results = {
  groups: Array<{
    kind: string;
    label: string;
    hits: Array<{ kind: string; id: string; title: string; query?: string }>;
    capped: boolean;
    sentence: string;
  }>;
  summary: string;
};

function group(results: Results, kind: string) {
  return results.groups.find((g) => g.kind === kind);
}

function titles(results: Results, kind: string): Array<string> {
  return (group(results, kind)?.hits ?? []).map((hit) => hit.title);
}

/** Every title anywhere in the answer — what a reviewer could read off it. */
function everyTitle(results: Results): Array<string> {
  return results.groups.flatMap((g) => g.hits.map((hit) => hit.title));
}

async function seed() {
  const t = setupTest();
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Agent Summit");
  const eventId = await seedEvent(t, eventSlug);
  return { t, alice, orgSlug, eventSlug, eventId };
}

describe("search:everything", () => {
  test("finds a session, a speaker and a proposal in the open event", async () => {
    const { t, alice, eventSlug, eventId } = await seed();
    await addSession(t, eventId, "Agents in Production");
    await addSpeaker(t, eventId, "Grace", "Hopper");
    await addProposal(t, eventId, "Agentic testing");

    const results = (await alice.query(api.search.everything, {
      term: "ag",
      eventSlug,
    })) as Results;

    expect(titles(results, "session")).toEqual(["Agents in Production"]);
    expect(titles(results, "proposal")).toEqual(["Agentic testing"]);
    // The event itself matches "ag" through "Agent Summit".
    expect(titles(results, "event")).toEqual(["Acme Agent Summit"]);

    const byName = (await alice.query(api.search.everything, {
      term: "hopper",
      eventSlug,
    })) as Results;
    expect(titles(byName, "speaker")).toEqual(["Grace Hopper"]);
  });

  test("matching is case-insensitive and matches inside the title", async () => {
    const { t, alice, eventSlug, eventId } = await seed();
    await addSession(t, eventId, "Scaling Postgres");

    const results = (await alice.query(api.search.everything, {
      term: "POSTG",
      eventSlug,
    })) as Results;
    expect(titles(results, "session")).toEqual(["Scaling Postgres"]);
  });

  test("a proposal hit carries the proposals table's own filter", async () => {
    const { t, alice, eventSlug, eventId } = await seed();
    await addProposal(t, eventId, "Agentic testing");

    const results = (await alice.query(api.search.everything, {
      term: "agentic",
      eventSlug,
    })) as Results;
    expect(group(results, "proposal")?.hits[0].query).toBe("Agentic testing");
  });

  test("a group showing a prefix says so and never claims a total", async () => {
    const { t, alice, eventSlug, eventId } = await seed();
    for (let i = 0; i < 7; i += 1) {
      await addSession(t, eventId, `Workshop ${i}`);
    }

    const results = (await alice.query(api.search.everything, {
      term: "workshop",
      eventSlug,
    })) as Results;
    const sessions = group(results, "session");
    expect(sessions?.hits).toHaveLength(5);
    expect(sessions?.capped).toBe(true);
    expect(sessions?.sentence).toBe(
      "Showing the first 5 of more session matches — Sessions has the full list.",
    );
    expect(results.summary.startsWith("At least ")).toBe(true);
  });

  test("an uncapped group states the count it actually read", async () => {
    const { t, alice, eventSlug, eventId } = await seed();
    await addSession(t, eventId, "Workshop one");

    const results = (await alice.query(api.search.everything, {
      term: "workshop",
      eventSlug,
    })) as Results;
    expect(group(results, "session")?.capped).toBe(false);
    expect(group(results, "session")?.sentence).toBe("1 session match.");
  });

  test("a capped scan that matched nothing admits the unread remainder instead of saying no matches", async () => {
    // REGRESSION (codex, W1): the group was dropped whenever it had no hits,
    // taking its `capped` with it — so an exact title sitting past the 500th
    // session rendered as "Nothing matches", which the read cannot know.
    const { t, alice, eventSlug, eventId } = await seed();
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i += 1) {
        await ctx.db.insert("sessions", {
          eventId,
          title: `Filler ${i}`,
          format: "Talk",
          source: "direct",
          status: "planned",
        });
      }
    });
    // The 501st, which the scan never reaches.
    await addSession(t, eventId, "Zebra keynote");

    const results = (await alice.query(api.search.everything, {
      term: "zebra",
      eventSlug,
    })) as Results;

    const sessions = group(results, "session");
    expect(sessions?.hits).toEqual([]);
    expect(sessions?.capped).toBe(true);
    expect(sessions?.sentence).toBe(
      "Searched the first 500 sessions — no matches there; more sessions exist than could be searched. Sessions has the full list.",
    );
    expect(results.summary).toBe(
      "Nothing matches “zebra” in the rows that could be searched — more exist than one pass reads.",
    );
  });

  test("a group with no hits is not counted as a group of results", async () => {
    const { t, alice, eventSlug, eventId } = await seed();
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i += 1) {
        await ctx.db.insert("sessions", {
          eventId,
          title: `Filler ${i}`,
          format: "Talk",
          source: "direct",
          status: "planned",
        });
      }
    });
    await addProposal(t, eventId, "Zebra economics");

    const results = (await alice.query(api.search.everything, {
      term: "zebra",
      eventSlug,
    })) as Results;

    expect(titles(results, "proposal")).toEqual(["Zebra economics"]);
    expect(group(results, "session")?.hits).toEqual([]);
    // One result, in one group — the capped session admission is not a second.
    expect(results.summary).toBe(
      "At least 1 result in 1 group. Use the arrow keys to pick one, Enter to open it.",
    );
  });

  test("more memberships than one pass reads is admitted, not silently dropped", async () => {
    // REGRESSION (codex, W1): the membership scans were bare `.take(50)` /
    // `.take(200)`, so an event in the 51st organization was unreachable AND
    // unmentioned.
    const t = setupTest();
    const alice = await signIn(t, "alice");
    let lastOrg = "";
    for (let i = 0; i < 51; i += 1) {
      lastOrg = await createOrg(alice, `Org number ${i}`);
    }
    // In the organization whose membership row the scan never reaches.
    await createEvent(alice, lastOrg, "Zebra Summit");

    const results = (await alice.query(api.search.everything, {
      term: "zebra",
    })) as Results;

    const events = group(results, "event");
    expect(events?.hits).toEqual([]);
    expect(events?.capped).toBe(true);
    expect(events?.sentence).toContain("more events exist than could be searched");
    expect(results.summary).toBe(
      "Nothing matches “zebra” in the rows that could be searched — more exist than one pass reads.",
    );
  });

  test("a term shorter than two characters is refused in words, not results", async () => {
    const { alice, eventSlug } = await seed();
    const results = (await alice.query(api.search.everything, {
      term: "a",
      eventSlug,
    })) as Results;
    expect(results.groups).toEqual([]);
    expect(results.summary).toBe("Type at least 2 characters to search.");
  });

  test("nothing matching says so, in the organizer's own words", async () => {
    const { alice, eventSlug } = await seed();
    const results = (await alice.query(api.search.everything, {
      term: "zebra",
      eventSlug,
    })) as Results;
    expect(results.groups).toEqual([]);
    expect(results.summary).toBe("Nothing matches “zebra”.");
  });

  test("without an event, only events are searched", async () => {
    const { t, alice, eventId } = await seed();
    await addSession(t, eventId, "Acme deep dive");

    const results = (await alice.query(api.search.everything, {
      term: "acme",
    })) as Results;
    expect(results.groups.map((g) => g.kind)).toEqual(["event"]);
  });

  test("NEGATIVE: a reviewer sees their assignments and nothing else", async () => {
    const { t, eventSlug, eventId } = await seed();
    await addSession(t, eventId, "Agents in Production");
    await addSpeaker(t, eventId, "Agatha", "Christie");
    const mine = await addProposal(t, eventId, "Agentic testing");
    await addProposal(t, eventId, "Agents at the edge");

    const reviewer = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    await assignReview(t, eventId, mine, "rita");

    const results = (await reviewer.query(api.search.everything, {
      term: "ag",
      eventSlug,
    })) as Results;

    expect(titles(results, "review")).toEqual(["Agentic testing"]);
    // No organizer surface is even read for a reviewer.
    expect(group(results, "session")).toBeUndefined();
    expect(group(results, "speaker")).toBeUndefined();
    expect(group(results, "proposal")).toBeUndefined();
    // …and nothing they were not assigned is readable anywhere in the answer.
    const seen = everyTitle(results);
    expect(seen).not.toContain("Agents at the edge");
    expect(seen).not.toContain("Agents in Production");
    expect(seen).not.toContain("Agatha Christie");
  });

  test("NEGATIVE: a reviewer cannot search another event's records by slug", async () => {
    const { t, alice, orgSlug } = await seed();
    const otherSlug = await createEvent(alice, orgSlug, "Acme Ops Day");
    const otherId = await seedEvent(t, otherSlug);
    await addSession(t, otherId, "Agents everywhere");

    const reviewer = await signIn(t, "rita");
    await expectRejectedWith(
      reviewer.query(api.search.everything, {
        term: "agents",
        eventSlug: otherSlug,
      }),
      "forbidden",
    );
  });

  test("NEGATIVE: another organization's records never surface", async () => {
    const { t, eventId } = await seed();
    await addSession(t, eventId, "Agents in Production");
    await addSpeaker(t, eventId, "Grace", "Hopper");

    const bob = await signIn(t, "bob");
    const bobOrg = await createOrg(bob, "Rival Events");
    const bobEvent = await createEvent(bob, bobOrg, "Rival Roadshow");

    const results = (await bob.query(api.search.everything, {
      term: "a",
      eventSlug: bobEvent,
    })) as Results;
    expect(results.summary).toBe("Type at least 2 characters to search.");

    const wide = (await bob.query(api.search.everything, {
      term: "ac",
      eventSlug: bobEvent,
    })) as Results;
    expect(everyTitle(wide)).toEqual([]);

    const byName = (await bob.query(api.search.everything, {
      term: "hopper",
      eventSlug: bobEvent,
    })) as Results;
    expect(everyTitle(byName)).toEqual([]);
  });

  test("NEGATIVE: an organizer of another event cannot reach this one by slug", async () => {
    const { t, eventSlug } = await seed();
    const bob = await signIn(t, "bob");
    await createOrg(bob, "Rival Events");

    await expectRejectedWith(
      bob.query(api.search.everything, { term: "agents", eventSlug }),
      "forbidden",
    );
  });

  test("NEGATIVE: signed out is refused", async () => {
    const { t, eventSlug } = await seed();
    await expectRejectedWith(
      t.query(api.search.everything, { term: "agents", eventSlug }),
      "not_authenticated",
    );
  });

  test("NEGATIVE: a withdrawn proposal leaves a reviewer's palette", async () => {
    const { t, eventSlug, eventId } = await seed();
    const mine = await addProposal(t, eventId, "Agentic testing");
    const reviewer = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    await assignReview(t, eventId, mine, "rita");
    await t.run(async (ctx) => {
      await ctx.db.patch("proposals", mine, { status: "withdrawn" });
    });

    const results = (await reviewer.query(api.search.everything, {
      term: "agentic",
      eventSlug,
    })) as Results;
    expect(everyTitle(results)).toEqual([]);
  });

  test("a speaker row carries professional identity, never contact details", async () => {
    const { t, alice, eventSlug, eventId } = await seed();
    await addSpeaker(t, eventId, "Grace", "Hopper");

    const results = (await alice.query(api.search.everything, {
      term: "grace",
      eventSlug,
    })) as Results;
    const hit = group(results, "speaker")?.hits[0] as
      | { title: string; subtitle?: string }
      | undefined;
    expect(hit?.subtitle).toBe("Rear Admiral, US Navy");
    expect(JSON.stringify(results)).not.toContain("grace@example.com");
  });
});
