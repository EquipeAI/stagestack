import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  apiKeyEventCaller,
  apiKeyOrgCaller,
  resolveCallerFromApiKey,
} from "./lib/functions";
import { sanitizeToolError } from "./lib/mcpServer";
import { CONTACT_SCAN, PARTICIPANT_SCAN, SESSION_SCAN } from "./lib/readCaps";
import { ORG_EVENT_SCAN } from "./model/events";
import {
  LAST_USED_THROTTLE_MS,
  MAX_ACTIVE_KEYS_PER_ORG,
  MCP_GENERIC_REFUSAL,
  agentAudit,
} from "./model/apiKeys";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
  type TestT,
  type TestUserT,
} from "./test.helpers";

// ─────────────────────────────────────────────────────────────────────────
// Agent access (D1 + D2). The interesting assertions here are the negative
// ones: a key is a durable credential handed to software, so what it CANNOT
// do matters more than what it can.
// ─────────────────────────────────────────────────────────────────────────

/** A handle on the SAME bucket convex/mcp.ts consumes — name and config have
 * to match or this points at a different row. */
const mcpBucket = new RateLimiter(components.rateLimiter, {
  mcpCalls: { kind: "token bucket", rate: 300, period: MINUTE, capacity: 600 },
});

const MCP_BUCKET_CAPACITY = 600;

type Fixture = {
  t: TestT;
  alice: TestUserT;
  bob: TestUserT;
  orgSlug: string;
  eventSlug: string;
  otherEventSlug: string;
};

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const orgSlug = await createOrg(alice, "Devflow");
  const eventSlug = await createEvent(alice, orgSlug, "Devflow Conf 2027");
  const otherEventSlug = await createEvent(alice, orgSlug, "Devflow Summit");
  await grantEventRole(t, eventSlug, "bob", "reviewer");
  return { t, alice, bob, orgSlug, eventSlug, otherEventSlug };
}

async function mint(
  as: TestUserT,
  orgSlug: string,
  overrides: {
    name?: string;
    ceiling?: "read" | "organizer";
    eventSlug?: string;
    expiresAt?: number;
  } = {},
): Promise<{ plaintext: string; keyId: Id<"apiKeys"> }> {
  const minted = await as.mutation(api.apiKeys.mint, {
    orgSlug,
    name: overrides.name ?? "Claude Code",
    ceiling: overrides.ceiling ?? "organizer",
    eventSlug: overrides.eventSlug,
    expiresAt: overrides.expiresAt,
  });
  return { plaintext: minted.plaintext, keyId: minted.key.keyId };
}

describe("api key management", () => {
  test("mint returns the plaintext exactly once and stores only a hash", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { plaintext, keyId } = await mint(alice, orgSlug, {
      name: "Laptop",
    });

    expect(plaintext).toMatch(/^ssk_[0-9a-f]{64}$/);

    const stored = await t.run(async (ctx) => ctx.db.get("apiKeys", keyId));
    expect(stored?.keyHash).not.toContain(plaintext.slice(4));
    expect(stored?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.prefix).toBe(`ssk_…${plaintext.slice(-4)}`);
    expect(stored?.lastUsedAt).toBeUndefined();

    // The list surface never carries the hash — nor anything the plaintext
    // could be rebuilt from.
    const listed = await alice.query(api.apiKeys.list, { orgSlug });
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(stored!.keyHash);
    expect(Object.keys(listed[0])).not.toContain("keyHash");
    expect(listed[0]).toMatchObject({
      name: "Laptop",
      ceiling: "organizer",
      eventSlug: null,
      lastUsedAt: null,
      revokedAt: null,
    });
  });

  test("two keys never collide", async () => {
    const { alice, orgSlug } = await fixture();
    const a = await mint(alice, orgSlug, { name: "one" });
    const b = await mint(alice, orgSlug, { name: "two" });
    expect(a.plaintext).not.toBe(b.plaintext);
  });

  test("rename and revoke", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { keyId } = await mint(alice, orgSlug, { name: "Old" });

    await alice.mutation(api.apiKeys.rename, { orgSlug, keyId, name: "New" });
    expect(
      (await alice.query(api.apiKeys.list, { orgSlug }))[0].name,
    ).toBe("New");

    const before = Date.now();
    await alice.mutation(api.apiKeys.revoke, { orgSlug, keyId });
    // The timestamp is the SERVER's, not one the client got to choose.
    const revokedAt = (await alice.query(api.apiKeys.list, { orgSlug }))[0]
      .revokedAt;
    expect(revokedAt).not.toBeNull();
    expect(revokedAt!).toBeGreaterThanOrEqual(before);

    // Idempotent: revoking twice keeps the FIRST timestamp, so the record of
    // when access actually ended survives a double click.
    await alice.mutation(api.apiKeys.revoke, { orgSlug, keyId });
    expect(
      (await alice.query(api.apiKeys.list, { orgSlug }))[0].revokedAt,
    ).toBe(revokedAt);

    const actions = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).map((r) => r.action),
    );
    expect(actions).toContain("apiKey.mint");
    expect(actions).toContain("apiKey.revoke");
  });

  test("event-scoped mint binds to an event in this org", async () => {
    const { alice, orgSlug, eventSlug } = await fixture();
    const minted = await alice.mutation(api.apiKeys.mint, {
      orgSlug,
      name: "One event",
      ceiling: "read",
      eventSlug,
    });
    expect(minted.key.eventSlug).toBe(eventSlug);

    await expectRejectedWith(
      alice.mutation(api.apiKeys.mint, {
        orgSlug,
        name: "Nope",
        ceiling: "read",
        eventSlug: "does-not-exist",
      }),
      "not_found",
    );
  });

  test("an expiry in the past is refused at mint", async () => {
    const { alice, orgSlug } = await fixture();
    const now = Date.now();
    await expectRejectedWith(
      alice.mutation(api.apiKeys.mint, {
        orgSlug,
        name: "Stale",
        ceiling: "read",
        expiresAt: now - 1,
      }),
      "invalid_expiry",
    );
  });

  test("only org admins may mint, list, rename or revoke", async () => {
    const { alice, bob, orgSlug } = await fixture();
    const { keyId } = await mint(alice, orgSlug);

    await expectRejectedWith(
      bob.mutation(api.apiKeys.mint, {
        orgSlug,
        name: "Sneaky",
        ceiling: "organizer",
      }),
      "forbidden",
    );
    await expectRejectedWith(bob.query(api.apiKeys.list, { orgSlug }), "forbidden");
    await expectRejectedWith(
      bob.mutation(api.apiKeys.rename, { orgSlug, keyId, name: "Mine" }),
      "forbidden",
    );
    await expectRejectedWith(
      bob.mutation(api.apiKeys.revoke, { orgSlug, keyId }),
      "forbidden",
    );
  });

  test("an org cannot hold more active keys than it can manage", async () => {
    const { alice, orgSlug, t } = await fixture();
    const now = Date.now();
    const keyIds: Array<Id<"apiKeys">> = [];
    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_ORG; i += 1) {
      keyIds.push((await mint(alice, orgSlug, { name: `key ${i}` })).keyId);
    }
    await expectRejectedWith(
      alice.mutation(api.apiKeys.mint, {
        orgSlug,
        name: "one too many",
        ceiling: "read",
      }),
      "api_key_limit",
    );

    // Revoking frees a slot; an expired key does not hold one either.
    await alice.mutation(api.apiKeys.revoke, {
      orgSlug,
      keyId: keyIds[0],
    });
    const replacement = await mint(alice, orgSlug, { name: "replacement" });
    expect(replacement.plaintext).toMatch(/^ssk_/);

    await t.run(async (ctx) => {
      await ctx.db.patch("apiKeys", keyIds[1], { expiresAt: now - 1 });
    });
    expect(
      (await mint(alice, orgSlug, { name: "after expiry" })).plaintext,
    ).toMatch(/^ssk_/);
  });

  test("a key id from another organization is not found", async () => {
    const { alice, orgSlug } = await fixture();
    const { keyId } = await mint(alice, orgSlug);
    const otherOrg = await createOrg(alice, "Other Co");
    await expectRejectedWith(
      alice.mutation(api.apiKeys.rename, {
        orgSlug: otherOrg,
        keyId,
        name: "Stolen",
      }),
      "not_found",
    );
  });
});

describe("resolveCallerFromApiKey", () => {
  test("an unknown key is refused", async () => {
    const { t } = await fixture();
    await expectRejectedWith(
      t.run(async (ctx) =>
        resolveCallerFromApiKey(ctx, `ssk_${"0".repeat(64)}`, Date.now()),
      ),
      "api_key_invalid",
    );
  });

  test("a malformed bearer string never reaches the index", async () => {
    const { t } = await fixture();
    await expectRejectedWith(
      t.run(async (ctx) => resolveCallerFromApiKey(ctx, "hunter2", Date.now())),
      "api_key_invalid",
    );
  });

  test("a revoked key is refused", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { plaintext, keyId } = await mint(alice, orgSlug);
    await alice.mutation(api.apiKeys.revoke, { orgSlug, keyId });
    await expectRejectedWith(
      t.run(async (ctx) =>
        resolveCallerFromApiKey(ctx, plaintext, Date.now()),
      ),
      "api_key_revoked",
    );
  });

  test("an expired key is refused", async () => {
    const { alice, orgSlug, t } = await fixture();
    const now = Date.now();
    const { plaintext } = await mint(alice, orgSlug, {
      expiresAt: now + 1000,
    });
    // Good up to the instant it expires...
    await t.run(async (ctx) =>
      resolveCallerFromApiKey(ctx, plaintext, now + 999),
    );
    // ...and dead at it.
    await expectRejectedWith(
      t.run(async (ctx) =>
        resolveCallerFromApiKey(ctx, plaintext, now + 1000),
      ),
      "api_key_expired",
    );
  });

  test("a removed member's key is dead", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);

    await t.run(async (ctx) => {
      const membership = await ctx.db.query("members").first();
      await ctx.db.delete("members", membership!._id);
    });

    await expectRejectedWith(
      t.run(async (ctx) =>
        resolveCallerFromApiKey(ctx, plaintext, Date.now()),
      ),
      "forbidden",
    );
  });

  test("a read-ceiling key is refused on a write capability", async () => {
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug, { ceiling: "read" });

    await t.run(async (ctx) => {
      const identity = await resolveCallerFromApiKey(ctx, plaintext, Date.now());
      // Reads still resolve at the minter's real role — a read key that could
      // not read organizer surfaces would answer nothing.
      const reading = await apiKeyEventCaller(ctx, identity, eventSlug, "read");
      expect(reading.role).toBe("organizer");
    });

    await expectRejectedWith(
      t.run(async (ctx) => {
        const identity = await resolveCallerFromApiKey(
          ctx,
          plaintext,
          Date.now(),
        );
        return await apiKeyEventCaller(ctx, identity, eventSlug, "write");
      }),
      "forbidden",
    );
    await expectRejectedWith(
      t.run(async (ctx) => {
        const identity = await resolveCallerFromApiKey(
          ctx,
          plaintext,
          Date.now(),
        );
        return apiKeyOrgCaller(identity, "write");
      }),
      "forbidden",
    );
  });

  test("an organizer-ceiling key still cannot exceed the live role", async () => {
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug, { ceiling: "organizer" });

    // Alice loses org admin and keeps only a reviewer seat on the event.
    await t.run(async (ctx) => {
      const membership = await ctx.db.query("members").first();
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      await ctx.db.insert("eventMembers", {
        eventId: event!._id,
        orgId: membership!.orgId,
        userId: membership!.userId,
        role: "reviewer",
      });
      await ctx.db.delete("members", membership!._id);
    });

    await t.run(async (ctx) => {
      const identity = await resolveCallerFromApiKey(ctx, plaintext, Date.now());
      const caller = await apiKeyEventCaller(ctx, identity, eventSlug, "write");
      // The ceiling permits writes; the LIVE role is what they are checked
      // against, and it is now reviewer.
      expect(caller.role).toBe("reviewer");
      expect(identity.orgCaller.orgRole).toBeNull();
    });
  });

  test("an event-scoped key is refused outside its event", async () => {
    const { alice, orgSlug, eventSlug, otherEventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug, {
      eventSlug,
      ceiling: "read",
    });

    await t.run(async (ctx) => {
      const identity = await resolveCallerFromApiKey(ctx, plaintext, Date.now());
      const caller = await apiKeyEventCaller(ctx, identity, eventSlug, "read");
      expect(caller.event.slug).toBe(eventSlug);
    });

    await expectRejectedWith(
      t.run(async (ctx) => {
        const identity = await resolveCallerFromApiKey(
          ctx,
          plaintext,
          Date.now(),
        );
        return await apiKeyEventCaller(ctx, identity, otherEventSlug, "read");
      }),
      "forbidden",
    );
    // And it never widens back out to the whole organization.
    await expectRejectedWith(
      t.run(async (ctx) => {
        const identity = await resolveCallerFromApiKey(
          ctx,
          plaintext,
          Date.now(),
        );
        return apiKeyOrgCaller(identity, "read");
      }),
      "forbidden",
    );
  });

  test("writes through the key path audit with viaAgent", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);

    await t.run(async (ctx) => {
      const identity = await resolveCallerFromApiKey(ctx, plaintext, Date.now());
      await agentAudit(ctx, identity, {
        action: "session.updateContent",
        targetType: "session",
        targetId: "s1",
      });
    });

    const row = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).find(
        (r) => r.action === "session.updateContent",
      ),
    );
    expect(row?.viaAgent).toBe(true);
    expect(row?.actorUserId).toBeDefined();
  });
});

describe("mcp authentication", () => {
  test("authenticate reports the key's scope and touches lastUsedAt", async () => {
    const { alice, orgSlug, t } = await fixture();
    const now = Date.now();
    const { plaintext, keyId } = await mint(alice, orgSlug, { name: "Desk" });

    expect(
      await t.mutation(internal.mcp.authenticate, { presentedKey: plaintext, now }),
    ).toMatchObject({
      orgSlug,
      keyName: "Desk",
      ceiling: "organizer",
      eventSlug: null,
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get("apiKeys", keyId)))?.lastUsedAt,
    ).toBe(now);

    // Throttled: a burst of tool calls must not become a write per call.
    await t.mutation(internal.mcp.authenticate, {
      presentedKey: plaintext,
      now: now + LAST_USED_THROTTLE_MS - 1,
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get("apiKeys", keyId)))?.lastUsedAt,
    ).toBe(now);

    await t.mutation(internal.mcp.authenticate, {
      presentedKey: plaintext,
      now: now + LAST_USED_THROTTLE_MS,
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get("apiKeys", keyId)))?.lastUsedAt,
    ).toBe(now + LAST_USED_THROTTLE_MS);
  });

  test("a revoked key stops authenticating", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { plaintext, keyId } = await mint(alice, orgSlug);
    await alice.mutation(api.apiKeys.revoke, { orgSlug, keyId });
    await expectRejectedWith(
      t.mutation(internal.mcp.authenticate, {
        presentedKey: plaintext,
        now: Date.now(),
      }),
      "api_key_revoked",
    );
  });

  test("the per-key budget is SPENT, not merely observed", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { plaintext, keyId } = await mint(alice, orgSlug);
    const now = Date.now();

    await t.mutation(internal.mcp.authenticate, { presentedKey: plaintext, now });

    // Leave exactly one token. If `authenticate` only CHECKED the bucket, the
    // two calls below would both succeed — nothing else moves this key's row.
    await t.run(async (ctx) => {
      const spent = await mcpBucket.limit(ctx, "mcpCalls", {
        key: keyId,
        count: MCP_BUCKET_CAPACITY - 2,
      });
      expect(spent.ok).toBe(true);
    });

    await t.mutation(internal.mcp.authenticate, { presentedKey: plaintext, now });
    await expectRejectedWith(
      t.mutation(internal.mcp.authenticate, { presentedKey: plaintext, now }),
      "rate_limited",
    );
  });

  test("the budget is per key, so one agent cannot starve another", async () => {
    const { alice, orgSlug, t } = await fixture();
    const first = await mint(alice, orgSlug, { name: "one" });
    const second = await mint(alice, orgSlug, { name: "two" });
    const now = Date.now();

    await t.run(async (ctx) => {
      await mcpBucket.limit(ctx, "mcpCalls", {
        key: first.keyId,
        count: MCP_BUCKET_CAPACITY,
      });
    });
    await expectRejectedWith(
      t.mutation(internal.mcp.authenticate, {
        presentedKey: first.plaintext,
        now,
      }),
      "rate_limited",
    );
    expect(
      await t.mutation(internal.mcp.authenticate, {
        presentedKey: second.plaintext,
        now,
      }),
    ).toMatchObject({ keyName: "two" });
  });
});

describe("mcp read tools", () => {
  test("list_events and get_event answer for an org-wide key", async () => {
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();

    const events = await t.query(internal.mcp.listEvents, { presentedKey: plaintext, now });
    expect(events.scope).toBe("organization");
    expect(events.events.map((e: { slug: string }) => e.slug).sort()).toEqual(
      ["devflow-conf-2027", "devflow-summit"].sort(),
    );

    const one = await t.query(internal.mcp.getEvent, {
        presentedKey: plaintext,
        now,
        eventSlug,
      });
    expect(one.event.slug).toBe(eventSlug);
    expect(one.yourRole).toBe("organizer");
    expect(one.organization.slug).toBe(orgSlug);
  });

  test("an event-scoped key sees exactly one event, everywhere", async () => {
    const { alice, orgSlug, eventSlug, otherEventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug, {
      eventSlug,
      ceiling: "read",
    });
    const now = Date.now();

    const events = await t.query(internal.mcp.listEvents, { presentedKey: plaintext, now });
    expect(events.scope).toBe("event");
    expect(events.events).toHaveLength(1);
    expect(events.events[0].slug).toBe(eventSlug);

    await expectRejectedWith(
      t.query(internal.mcp.getEvent, {
        presentedKey: plaintext,
        now,
        eventSlug: otherEventSlug,
      }),
      "forbidden",
    );

    // Search is narrowed too: the cross-event group can name only this event.
    const found = await t.query(internal.mcp.search, {
        presentedKey: plaintext,
        now,
        term: "devflow",
      });
    const slugs = found.groups.flatMap((g: { hits: Array<{ eventSlug: string }> }) =>
      g.hits.map((h) => h.eventSlug),
    );
    expect(slugs.length).toBeGreaterThan(0);
    expect(new Set(slugs)).toEqual(new Set([eventSlug]));
  });

  test("the event reads answer for an organizer key", async () => {
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();
    const args = { presentedKey: plaintext, now, eventSlug };

    expect(
      await t.query(internal.mcp.listProposals, args),
    ).toMatchObject({ eventSlug, capped: false, proposals: [] });
    expect(
      await t.query(internal.mcp.listSessions, args),
    ).toMatchObject({ eventSlug, sessions: [] });
    expect(await t.query(internal.mcp.reviewProgress, args)).toMatchObject(
      { eventSlug, scope: "whole event" },
    );
    expect(
      (await t.query(internal.mcp.taskDashboard, args)).totals,
    ).toBeDefined();
    expect(
      (await t.query(internal.mcp.agendaBoard, args)).eventSlug,
    ).toBe(eventSlug);

    const publish = await t.query(internal.mcp.publishState, args);
    expect(publish.state.lineupPublished).toBe(false);
    expect(publish.diff.neverPublished).toBe(true);
  });

  test("a malformed proposal id is a refusal, not a crash", async () => {
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    await expectRejectedWith(
      t.query(internal.mcp.getProposal, {
        presentedKey: plaintext,
        now: Date.now(),
        eventSlug,
        proposalId: "not-an-id",
      }),
      "not_found",
    );
  });

  test("a key whose minter is now only a reviewer sees only a reviewer's scope", async () => {
    const { alice, orgSlug, eventSlug, otherEventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();

    // Demote: org admin gone, reviewer seat on one event only.
    await t.run(async (ctx) => {
      const membership = await ctx.db.query("members").first();
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      await ctx.db.insert("eventMembers", {
        eventId: event!._id,
        orgId: membership!.orgId,
        userId: membership!.userId,
        role: "reviewer",
      });
      await ctx.db.delete("members", membership!._id);
    });

    // The one event they still sit on, and nothing else in the org.
    const events = await t.query(internal.mcp.listEvents, { presentedKey: plaintext, now });
    expect(events.events.map((e: { slug: string }) => e.slug)).toEqual([
      eventSlug,
    ]);
    await expectRejectedWith(
      t.query(internal.mcp.getEvent, {
        presentedKey: plaintext,
        now,
        eventSlug: otherEventSlug,
      }),
      "forbidden",
    );

    // Organizer-only reads refuse; the reviewer's own board still answers.
    const args = { presentedKey: plaintext, now, eventSlug };
    await expectRejectedWith(t.query(internal.mcp.listSessions, args), "forbidden");
    await expectRejectedWith(t.query(internal.mcp.listProposals, args), "forbidden");
    await expectRejectedWith(t.query(internal.mcp.agendaBoard, args), "forbidden");
    await expectRejectedWith(t.query(internal.mcp.publishState, args), "forbidden");
    expect(
      await t.query(internal.mcp.reviewProgress, args),
    ).toMatchObject({ eventSlug, scope: "your assignments only" });
  });

  test("a key never reaches another organization the minter belongs to", async () => {
    // The bug this test exists for: search used to read every membership the
    // MINTER holds, so an org-A key returned org-B hits — and the summary
    // counted them.
    const { alice, orgSlug, t } = await fixture();
    const otherOrg = await createOrg(alice, "Rival Corp");
    await createEvent(alice, otherOrg, "Rival Devflow Summit");
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();

    // Alice really can see both organizations when SHE asks.
    const asAlice = await alice.query(api.search.everything, {
      term: "devflow",
    });
    expect(
      asAlice.groups.flatMap((g) => g.hits.map((h) => h.eventSlug)),
    ).toContain("rival-devflow-summit");

    // Her org-A key cannot.
    const scoped = await t.query(internal.mcp.search, {
      presentedKey: plaintext,
      now,
      term: "devflow",
    });
    const slugs = scoped.groups.flatMap((g) => g.hits.map((h) => h.eventSlug));
    expect(slugs).not.toContain("rival-devflow-summit");
    expect(new Set(slugs)).toEqual(
      new Set(["devflow-conf-2027", "devflow-summit"]),
    );
    // The sentences count the SAME set the hits came from — no pre-filter
    // total leaking through the summary.
    expect(scoped.summary).toContain("2");
    const eventGroup = scoped.groups.find((g) => g.kind === "event");
    expect(eventGroup?.sentence).toBe("2 event matches.");
    expect(eventGroup?.capped).toBe(false);

    // And listing agrees with searching.
    const listed = await t.query(internal.mcp.listEvents, {
      presentedKey: plaintext,
      now,
    });
    expect(listed.events.map((e) => e.slug)).not.toContain(
      "rival-devflow-summit",
    );
  });

  test("tools emit projections, not documents", async () => {
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();

    const listed = await t.query(internal.mcp.listEvents, {
      presentedKey: plaintext,
      now,
    });
    // No internal ids, no creation times, no storage handles reach an agent.
    const text = JSON.stringify(listed);
    expect(text).not.toContain("_id");
    expect(text).not.toContain("_creationTime");
    expect(text).not.toContain("orgId");
    expect(Object.keys(listed.events[0]).sort()).toEqual(
      [
        "archived",
        "cfpPublished",
        "endsAt",
        "name",
        "publicPageEnabled",
        "slug",
        "startsAt",
        "timezone",
      ].sort(),
    );

    const one = await t.query(internal.mcp.getEvent, {
      presentedKey: plaintext,
      now,
      eventSlug,
    });
    expect(JSON.stringify(one)).not.toContain("_creationTime");
  });

  test("every tool refuses a revoked key, mid-session", async () => {
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext, keyId } = await mint(alice, orgSlug);
    const now = Date.now();

    expect(
      (
        await t.query(internal.mcp.getEvent, {
          presentedKey: plaintext,
          now,
          eventSlug,
        })
      ).event.slug,
    ).toBe(eventSlug);

    await alice.mutation(api.apiKeys.revoke, { orgSlug, keyId });

    await expectRejectedWith(
      t.query(internal.mcp.getEvent, { presentedKey: plaintext, now, eventSlug }),
      "api_key_revoked",
    );
    await expectRejectedWith(
      t.query(internal.mcp.listEvents, { presentedKey: plaintext, now }),
      "api_key_revoked",
    );
    await expectRejectedWith(
      t.query(internal.mcp.search, { presentedKey: plaintext, now, term: "dev" }),
      "api_key_revoked",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The /mcp HTTP boundary, driven exactly as an MCP client drives it. These
// are the tests that prove what an OUTSIDE caller can read — the internal
// queries above prove what the capability layer allows.
// ─────────────────────────────────────────────────────────────────────────

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  // A real HTTP client always sends Host; convex-test builds its Request from
  // a URL and does not, and the endpoint's DNS-rebinding check refuses a
  // request with no Host at all. `some.convex.site` is the origin convex-test
  // serves HTTP actions from, mirrored by CONVEX_SITE_URL in vitest.config.ts.
  Host: "some.convex.site",
};

/** Post one JSON-RPC message to /mcp and return the parsed body. The SDK
 * answers in SSE framing by default, so the payload is the `data:` line. */
async function mcpPost(
  t: TestT,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; message: unknown }> {
  const response = await t.fetch("/mcp", {
    method: "POST",
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const line = text
    .split("\n")
    .find((l) => l.startsWith("data: "));
  return {
    status: response.status,
    message: JSON.parse(line === undefined ? text : line.slice(6)),
  };
}

function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

describe("mcp http boundary", () => {
  test("initialize, tools/list and tools/call over HTTP", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);

    const init = await mcpPost(
      t,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      },
      bearer(plaintext),
    );
    expect(init.status).toBe(200);
    expect(init.message).toMatchObject({
      result: { serverInfo: { name: "stagestack" } },
    });

    const tools = await mcpPost(
      t,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      bearer(plaintext),
    );
    const names = (
      tools.message as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((tool) => tool.name);
    expect(names).toEqual([
      "search",
      "list_events",
      "get_event",
      "list_proposals",
      "get_proposal",
      "review_progress",
      "list_sessions",
      "task_dashboard",
      "agenda_board",
      "publish_state",
    ]);

    const called = await mcpPost(
      t,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_events", arguments: {} },
      },
      bearer(plaintext),
    );
    const content = (
      called.message as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      }
    ).result;
    expect(content.isError).toBeUndefined();
    expect(JSON.parse(content.content[0].text).events[0].slug).toBe(
      "devflow-conf-2027",
    );
  });

  test("a failing tool says the registered sentence, never the model's text", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug, { ceiling: "read" });

    // A refusal the registry KNOWS keeps its registered sentence...
    const refused = await mcpPost(
      t,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_event",
          arguments: { eventSlug: "no-such-event" },
        },
      },
      bearer(plaintext),
    );
    const notFoundResult = (
      refused.message as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      }
    ).result;
    expect(notFoundResult.isError).toBe(true);
    expect(notFoundResult.content[0].text).toBe("No such record.");
    // The model's own wording ("No such event.") does not travel.
    expect(notFoundResult.content[0].text).not.toContain("event");

  });

  test("the sanitizer maps registered codes and swallows everything else", async () => {
    // The generic branch, proved deterministically rather than by contriving a
    // live failure: these are exactly the shapes a Convex throw arrives in.
    expect(sanitizeToolError(new ConvexError({ code: "forbidden", message: "x" })))
      .toBe("This API key does not have access to that.");
    expect(
      sanitizeToolError(
        new ConvexError({
          code: "not_found",
          // The model's own wording, which must NOT travel.
          message: "No such proposal on this event.",
        }),
      ),
    ).toBe("No such record.");
    // Unregistered ConvexError code → generic. A model refusal never written
    // for agents cannot publish itself to one by throwing.
    expect(
      sanitizeToolError(
        new ConvexError({ code: "invalid_timezone", message: "Timezone must be…" }),
      ),
    ).toBe(MCP_GENERIC_REFUSAL);
    // A plain system error → generic, message never read.
    expect(
      sanitizeToolError(new Error("Table 'proposals' does not exist: kx7f5n1…")),
    ).toBe(MCP_GENERIC_REFUSAL);
    expect(sanitizeToolError("string throw")).toBe(MCP_GENERIC_REFUSAL);
    expect(sanitizeToolError(null)).toBe(MCP_GENERIC_REFUSAL);
  });

  test("the boundary refuses before it reads: no key, bad key, bad origin", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { plaintext, keyId } = await mint(alice, orgSlug);
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

    const noKey = await mcpPost(t, list);
    expect(noKey.status).toBe(401);
    expect(noKey.message).toMatchObject({
      error: { message: "Provide an API key as an Authorization: Bearer header." },
    });

    const unknown = await mcpPost(t, list, bearer(`ssk_${"0".repeat(64)}`));
    expect(unknown.status).toBe(401);
    expect(unknown.message).toMatchObject({
      error: { message: "That API key is not valid." },
    });

    // Origin validation runs BEFORE the credential is even looked at.
    const rebinding = await t.fetch("/mcp", {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        ...bearer(plaintext),
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify(list),
    });
    expect(rebinding.status).toBe(403);

    await alice.mutation(api.apiKeys.revoke, { orgSlug, keyId });
    const revoked = await mcpPost(t, list, bearer(plaintext));
    expect(revoked.status).toBe(401);
    expect(revoked.message).toMatchObject({
      error: { message: "That API key was revoked." },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Read ceilings and the mint budget. These seed at the real production caps
// rather than shrinking them for the test: a ceiling that is only ever
// exercised at a test-only value is a ceiling nobody has actually checked.
// ─────────────────────────────────────────────────────────────────────────

/** Insert `count` bare event rows in this org, bypassing the create
 * capability (which mints slugs and seeds forms — irrelevant to a cap). */
async function seedEvents(
  t: TestT,
  orgSlug: string,
  count: number,
): Promise<Array<Id<"events">>> {
  return await t.run(async (ctx) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", orgSlug))
      .unique();
    const ids: Array<Id<"events">> = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(
        await ctx.db.insert("events", {
          orgId: org!._id,
          name: `Filler ${i}`,
          slug: `filler-${i}-${orgSlug}`,
          startsAt: 0,
          endsAt: 1,
          timezone: "UTC",
          cfpPublished: false,
        }),
      );
    }
    return ids;
  });
}

describe("read ceilings are stated honestly", () => {
  test("list_events: exact cap is complete, one past it is capped", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();
    const read = () =>
      t.query(internal.mcp.listEvents, { presentedKey: plaintext, now });

    // The fixture already made two events.
    await seedEvents(t, orgSlug, ORG_EVENT_SCAN - 2);
    const atCap = await read();
    expect(atCap.events).toHaveLength(ORG_EVENT_SCAN);
    expect(atCap.capped).toBe(false);

    await seedEvents(t, orgSlug, 1);
    expect((await read()).capped).toBe(true);
  });

  test("list_events: the event-member branch is honest at its own cap", async () => {
    // A key whose minter is no longer an org admin reads through the
    // membership branch — the one that used to infer truncation from an
    // already-truncated array, and so called exactly-at-cap "capped".
    const { alice, orgSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();
    const seats = await seedEvents(t, orgSlug, ORG_EVENT_SCAN);

    await t.run(async (ctx) => {
      const membership = await ctx.db.query("members").first();
      for (const eventId of seats) {
        await ctx.db.insert("eventMembers", {
          eventId,
          orgId: membership!.orgId,
          userId: membership!.userId,
          role: "organizer",
        });
      }
      await ctx.db.delete("members", membership!._id);
    });

    const atCap = await t.query(internal.mcp.listEvents, {
      presentedKey: plaintext,
      now,
    });
    expect(atCap.events).toHaveLength(ORG_EVENT_SCAN);
    expect(atCap.capped).toBe(false);

    // One more seat for the SAME user, and the read admits it stopped short.
    const [extra] = await seedEvents(t, orgSlug, 1);
    await t.run(async (ctx) => {
      const key = await ctx.db.query("apiKeys").first();
      const seat = await ctx.db
        .query("eventMembers")
        .withIndex("by_userId", (q) =>
          q.eq("userId", key!.createdByUserId),
        )
        .first();
      await ctx.db.insert("eventMembers", {
        eventId: extra,
        orgId: seat!.orgId,
        userId: seat!.userId,
        role: "organizer",
      });
    });
    expect(
      (await t.query(internal.mcp.listEvents, { presentedKey: plaintext, now }))
        .capped,
    ).toBe(true);
  });

  test("list_sessions: every contributing read feeds the flag", async () => {
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();
    const args = { presentedKey: plaintext, now, eventSlug };

    const eventId = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      return event!._id;
    });
    const orgId = await t.run(async (ctx) => {
      const org = await ctx.db
        .query("organizations")
        .withIndex("by_slug", (q) => q.eq("slug", orgSlug))
        .unique();
      return org!._id;
    });

    const seedSessions = (count: number) =>
      t.run(async (ctx) => {
        for (let i = 0; i < count; i += 1) {
          await ctx.db.insert("sessions", {
            eventId,
            title: `Session ${i}`,
            source: "direct",
            status: "planned",
          });
        }
      });

    await seedSessions(SESSION_SCAN);
    const atCap = await t.query(internal.mcp.listSessions, args);
    expect(atCap.sessions).toHaveLength(SESSION_SCAN);
    expect(atCap.capped).toBe(false);
    expect(atCap.note).toBeUndefined();

    await seedSessions(1);
    const overCap = await t.query(internal.mcp.listSessions, args);
    expect(overCap.capped).toBe(true);
    expect(overCap.note).toContain("size ceiling");
  });

  test("list_sessions: unrelated contacts past the cap do not fake a truncation", async () => {
    // The precision bug: `capped` used to take the contact page's own flag,
    // so an event with one COMPLETE session and a large contact directory
    // reported a truncated programme it had actually returned in full.
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();

    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      // The speaker we DO reference is inserted first, so it sits well inside
      // the contact page however far past the ceiling the rest run.
      const contactId = await ctx.db.insert("eventContacts", {
        eventId: event!._id,
        orgId: event!.orgId,
        firstName: "Referenced",
        lastName: "Speaker",
      });
      const sessionId = await ctx.db.insert("sessions", {
        eventId: event!._id,
        title: "One complete session",
        source: "direct",
        status: "planned",
      });
      await ctx.db.insert("sessionParticipants", {
        sessionId,
        eventId: event!._id,
        eventContactId: contactId,
        role: "speaker",
        state: "confirmed",
      });
      // ...and a directory that comfortably overruns the contact scan.
      for (let i = 0; i <= CONTACT_SCAN; i += 1) {
        await ctx.db.insert("eventContacts", {
          eventId: event!._id,
          orgId: event!.orgId,
          firstName: `Unrelated ${i}`,
          lastName: "Contact",
        });
      }
    });

    const read = await t.query(internal.mcp.listSessions, {
      presentedKey: plaintext,
      now,
      eventSlug,
    });
    expect(read.sessions).toHaveLength(1);
    expect(read.sessions[0].speakers).toEqual([
      { name: "Referenced Speaker", role: "speaker", state: "confirmed" },
    ]);
    // Complete answer, complete claim.
    expect(read.capped).toBe(false);
    expect(read.note).toBeUndefined();
  });

  test("list_sessions: a speaker whose contact is out of reach IS flagged", async () => {
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();

    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      // This time the directory comes FIRST, so the referenced contact lands
      // past the ceiling and the join cannot name the speaker.
      for (let i = 0; i <= CONTACT_SCAN; i += 1) {
        await ctx.db.insert("eventContacts", {
          eventId: event!._id,
          orgId: event!.orgId,
          firstName: `Unrelated ${i}`,
          lastName: "Contact",
        });
      }
      const contactId = await ctx.db.insert("eventContacts", {
        eventId: event!._id,
        orgId: event!.orgId,
        firstName: "Out",
        lastName: "OfReach",
      });
      const sessionId = await ctx.db.insert("sessions", {
        eventId: event!._id,
        title: "Session with an unnameable speaker",
        source: "direct",
        status: "planned",
      });
      await ctx.db.insert("sessionParticipants", {
        sessionId,
        eventId: event!._id,
        eventContactId: contactId,
        role: "speaker",
        state: "confirmed",
      });
    });

    const read = await t.query(internal.mcp.listSessions, {
      presentedKey: plaintext,
      now,
      eventSlug,
    });
    expect(read.sessions).toHaveLength(1);
    // The speaker is there but nameless — which is exactly what `capped` is
    // for, and what the old contact-page flag would have reported for the
    // wrong reason.
    expect(read.sessions[0].speakers[0].name).toBe("");
    expect(read.capped).toBe(true);
    expect(read.note).toContain("speakers");
  });

  test("list_sessions: a truncated PARTICIPANT read cannot hide", async () => {
    // The reopened bug: sessions fit, so `capped` said false while speakers
    // silently fell off the far end of the participant scan.
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();

    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      const contactId = await ctx.db.insert("eventContacts", {
        eventId: event!._id,
        orgId: event!.orgId,
        firstName: "Many",
        lastName: "Hats",
      });
      const sessionId = await ctx.db.insert("sessions", {
        eventId: event!._id,
        title: "One session, a great many speakers",
        source: "direct",
        status: "planned",
      });
      for (let i = 0; i <= PARTICIPANT_SCAN; i += 1) {
        await ctx.db.insert("sessionParticipants", {
          sessionId,
          eventId: event!._id,
          eventContactId: contactId,
          role: "speaker",
          state: "awaiting",
        });
      }
    });

    const read = await t.query(internal.mcp.listSessions, {
      presentedKey: plaintext,
      now,
      eventSlug,
    });
    expect(read.sessions).toHaveLength(1);
    expect(read.capped).toBe(true);
  });
});

describe("the mint budget cannot be paged past", () => {
  test("dead rows never crowd out the active count", async () => {
    const { alice, orgSlug, t } = await fixture();
    // 250 revoked keys — more than any bounded `by_orgId` page — plus a full
    // complement of live ones. The old count read the first 200 rows by
    // index order, saw only corpses, and let the ceiling through.
    await t.run(async (ctx) => {
      const org = await ctx.db
        .query("organizations")
        .withIndex("by_slug", (q) => q.eq("slug", orgSlug))
        .unique();
      const user = await ctx.db.query("users").first();
      for (let i = 0; i < 250; i += 1) {
        await ctx.db.insert("apiKeys", {
          orgId: org!._id,
          keyHash: `dead-${i}`,
          prefix: "ssk_…dead",
          name: `dead ${i}`,
          createdByUserId: user!._id,
          ceiling: "read",
          revokedAt: 1,
        });
      }
    });

    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_ORG; i += 1) {
      await mint(alice, orgSlug, { name: `live ${i}` });
    }
    await expectRejectedWith(
      alice.mutation(api.apiKeys.mint, {
        orgSlug,
        name: "one too many",
        ceiling: "read",
      }),
      "api_key_limit",
    );
  });
});

describe("the clock is the server's", () => {
  test("the public wrappers do not accept a caller-supplied now", async () => {
    const { alice, orgSlug } = await fixture();
    const { keyId } = await mint(alice, orgSlug);
    const forged = Date.now() + 365 * 24 * 3600 * 1000;

    // The argument validator refuses the field outright, so there is no
    // post-dating a mint past the ceiling or backdating a revocation.
    await expect(
      alice.mutation(api.apiKeys.mint, {
        orgSlug,
        name: "post-dated",
        ceiling: "read",
        now: forged,
      } as unknown as { orgSlug: string; name: string; ceiling: "read" }),
    ).rejects.toThrow();
    await expect(
      alice.mutation(api.apiKeys.revoke, {
        orgSlug,
        keyId,
        now: forged,
      } as unknown as { orgSlug: string; keyId: Id<"apiKeys"> }),
    ).rejects.toThrow();
  });

  test("a future expiry cannot be made to look expired, or the reverse", async () => {
    const { alice, orgSlug, t } = await fixture();
    // Fill the org with keys that expire far in the future. A caller who
    // could choose `now` would claim they had all lapsed and mint past the
    // ceiling; with the server's clock the ceiling holds.
    const far = Date.now() + 365 * 24 * 3600 * 1000;
    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_ORG; i += 1) {
      await mint(alice, orgSlug, { name: `live ${i}`, expiresAt: far });
    }
    await expectRejectedWith(
      alice.mutation(api.apiKeys.mint, {
        orgSlug,
        name: "post-dated",
        ceiling: "read",
      }),
      "api_key_limit",
    );

    // And an expiry in the past is still refused against server time.
    await t.run(async (ctx) => {
      const key = await ctx.db.query("apiKeys").first();
      await ctx.db.patch("apiKeys", key!._id, { revokedAt: Date.now() });
    });
    await expectRejectedWith(
      alice.mutation(api.apiKeys.mint, {
        orgSlug,
        name: "already stale",
        ceiling: "read",
        expiresAt: Date.now() - 1,
      }),
      "invalid_expiry",
    );
  });
});

describe("host validation fails closed", () => {
  /** Run `body` with CONVEX_SITE_URL removed, restoring it afterwards.
   * Mirrors the env-swap idiom in comms.test.ts / reviews.test.ts rather than
   * `vi.stubEnv`, which the suite does not otherwise use. */
  async function withoutSiteUrl(body: () => Promise<void>): Promise<void> {
    const previous = process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_SITE_URL;
    try {
      await body();
    } finally {
      if (previous === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = previous;
    }
  }

  test("without CONVEX_SITE_URL only loopback is admitted", async () => {
    const { alice, orgSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

    // Sanity: with the variable set, the deployment's own host is admitted.
    expect((await mcpPost(t, list, bearer(plaintext))).status).toBe(200);

    await withoutSiteUrl(async () => {
      // The very host that worked a line ago is now refused — the fallback
      // does NOT read the allowlist off the request it is meant to check.
      const spoofed = await t.fetch("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Host: "some.convex.site",
          ...bearer(plaintext),
        },
        body: JSON.stringify(list),
      });
      expect(spoofed.status).toBe(403);

      // A local harness still works.
      const loopback = await t.fetch("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Host: "127.0.0.1",
          ...bearer(plaintext),
        },
        body: JSON.stringify(list),
      });
      expect(loopback.status).toBe(200);
    });

    // Restored: the normal host works again, so the swap left nothing behind.
    expect((await mcpPost(t, list, bearer(plaintext))).status).toBe(200);
  });
});
