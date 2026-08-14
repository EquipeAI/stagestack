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
import { LIBRARY_SCAN } from "./model/agenda";
import { TASK_REVIEW_CAP } from "./mcp";
import { ORG_EVENT_SCAN } from "./model/events";
import {
  LAST_USED_THROTTLE_MS,
  MAX_ACTIVE_KEYS_PER_ORG,
  MCP_GENERIC_REFUSAL,
  withAgentAudit,
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

  test("withAgentAudit marks what the capability wrote, and only that", async () => {
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const eventId = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      return event!._id;
    });

    // A row that already exists is HISTORY: it must come back untouched, or
    // the flag would retroactively blame an agent for a person's action.
    const historic = await t.run(async (ctx) =>
      ctx.db.insert("auditLog", {
        orgId: (await ctx.db.get("events", eventId))!.orgId,
        eventId,
        actorUserId: (await ctx.db.query("users").first())!._id,
        action: "event.updateSettings",
      }),
    );

    const marked = await t.run(async (ctx) => {
      const identity = await resolveCallerFromApiKey(ctx, plaintext, Date.now());
      return await withAgentAudit(ctx, identity, eventId, async () => {
        await ctx.db.insert("auditLog", {
          orgId: identity.key.orgId,
          eventId,
          actorUserId: identity.user._id,
          action: "sessions.updateContent",
          meta: { fields: ["title"] },
        });
        return "done";
      });
    });
    expect(marked).toMatchObject({ result: "done", marked: 1 });

    const rows = await t.run(async (ctx) => ctx.db.query("auditLog").collect());
    const written = rows.find((r) => r.action === "sessions.updateContent");
    expect(written?.viaAgent).toBe(true);
    // The capability's own meta survives; the key's prefix is added to it.
    expect(written?.meta).toMatchObject({ fields: ["title"] });
    expect((written?.meta as { apiKeyPrefix?: string }).apiKeyPrefix).toMatch(
      /^ssk_…/,
    );
    expect(rows.find((r) => r._id === historic)?.viaAgent).toBeUndefined();
  });

  test("withAgentAudit flags nothing when the capability wrote nothing", async () => {
    const { alice, orgSlug, eventSlug, t } = await fixture();
    const { plaintext } = await mint(alice, orgSlug);
    const eventId = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      return event!._id;
    });

    const outcome = await t.run(async (ctx) => {
      const identity = await resolveCallerFromApiKey(ctx, plaintext, Date.now());
      return await withAgentAudit(ctx, identity, eventId, async () => null);
    });
    expect(outcome.marked).toBe(0);
    expect(
      (await t.run(async (ctx) => ctx.db.query("auditLog").collect())).some(
        (r) => r.viaAgent === true,
      ),
    ).toBe(false);
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
      "list_task_reviews",
      "update_session_content",
      "schedule_session",
      "approve_task",
      "request_task_changes",
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

// ─────────────────────────────────────────────────────────────────────────
// Write tools (D3). The write half of the agent surface, and the half where
// a mistake is not recoverable by reloading the page. Each tool gets: the
// happy path through an organizer-ceiling key, the read-ceiling refusal the
// plan mandates, the event-scope refusal, and the audit row that says an
// agent did it. Plus the one that matters most — an organizer-CEILING key
// whose minter is only a reviewer now is still refused by the model layer.
// ─────────────────────────────────────────────────────────────────────────

type WriteFixture = Fixture & {
  sessionId: Id<"sessions">;
  taskId: Id<"taskInstances">;
  eventContactId: Id<"eventContacts">;
};

const FAR_FUTURE = Date.parse("2030-01-01T00:00:00Z");
const SLOT_START = Date.parse("2026-09-01T10:00:00Z");
const SLOT_END = Date.parse("2026-09-01T11:00:00Z");

/** The fixture's event, plus one session with a speaker, one submitted task
 * awaiting review, and one room — the three things D3's tools act on. */
async function writeFixture(): Promise<WriteFixture> {
  const base = await fixture();
  const { alice, eventSlug } = base;
  const { sessionId, eventContactId } = await alice.mutation(
    api.sessions.createDirect,
    {
      eventSlug,
      title: "Opening keynote",
      description: "The first draft of the abstract.",
      speaker: {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
    },
  );
  await alice.mutation(api.tasks.createRequirement, {
    eventSlug,
    title: "Sign the speaker release",
    scope: "participant",
    evidence: "manual",
    reviewRequired: true,
    dueAt: Date.parse("2026-08-20T00:00:00Z"),
  });
  const taskId = await base.t.run(async (ctx) => {
    const instance = await ctx.db.query("taskInstances").first();
    if (instance === null) throw new Error("no task instance");
    return instance._id;
  });
  await alice.mutation(api.tasks.markProvided, { eventSlug, instanceId: taskId });
  await alice.mutation(api.library.add, {
    eventSlug,
    table: "rooms",
    item: { name: "Main Hall", capacity: 300 },
  });
  return { ...base, sessionId, taskId, eventContactId };
}

async function auditRows(t: TestT) {
  return await t.run(async (ctx) => ctx.db.query("auditLog").collect());
}

/** Demote the key's minter to a reviewer seat on the event: the ceiling still
 * permits writes, the LIVE role no longer does. */
async function demoteToReviewer(t: TestT, eventSlug: string): Promise<void> {
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
}

describe("mcp write tools", () => {
  test("update_session_content edits through the capability, with history", async () => {
    const { alice, orgSlug, eventSlug, sessionId, t } = await writeFixture();
    const { plaintext } = await mint(alice, orgSlug, { ceiling: "organizer" });

    const result = await t.mutation(internal.mcp.updateSessionContent, {
      presentedKey: plaintext,
      eventSlug,
      sessionId,
      title: "Opening keynote: what we learned",
      description: "A rewritten abstract.",
    });
    expect(result).toMatchObject({
      eventSlug,
      title: "Opening keynote: what we learned",
      description: "A rewritten abstract.",
      revisionRecorded: true,
      contentStatus: "draft",
    });

    // The row really moved, and the SAME revision history the web editor
    // writes is what makes this reversible.
    const session = await t.run(async (ctx) => ctx.db.get("sessions", sessionId));
    expect(session?.title).toBe("Opening keynote: what we learned");
    const revisions = await t.run(async (ctx) =>
      ctx.db.query("sessionRevisions").collect(),
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0].before.title).toBe("Opening keynote");

    // ONE row, one act: the capability's own, marked. No `agent.*` twin, so
    // the control center cannot render one edit as two sentences.
    const rows = await auditRows(t);
    const written = rows.filter((r) => r.action === "sessions.updateContent");
    expect(written).toHaveLength(1);
    expect(written[0].viaAgent).toBe(true);
    expect(written[0].targetId).toBe(sessionId);
    expect(rows.some((r) => r.action.startsWith("agent."))).toBe(false);

    // A projection, never a document.
    expect(JSON.stringify(result)).not.toContain("_creationTime");
  });

  test("approve_task and request_task_changes move the review gate", async () => {
    const { alice, orgSlug, eventSlug, taskId, t } = await writeFixture();
    const { plaintext } = await mint(alice, orgSlug);

    // Discovery first: the id the write tools need comes from the queue read.
    const queue = await t.query(internal.mcp.listTaskReviews, {
      presentedKey: plaintext,
      now: Date.now(),
      eventSlug,
    });
    expect(queue.status).toBe("provided");
    expect(queue.capped).toBe(false);
    expect(queue.tasks).toHaveLength(1);
    expect(queue.tasks[0]).toMatchObject({
      taskId,
      requirementTitle: "Sign the speaker release",
      sessionTitle: "Opening keynote",
      speakerName: "Dana Keynote",
      status: "provided",
    });

    const approved = await t.mutation(internal.mcp.approveTask, {
      presentedKey: plaintext,
      eventSlug,
      taskId,
    });
    expect(approved).toMatchObject({
      eventSlug,
      taskId,
      status: "approved",
      requirementTitle: "Sign the speaker release",
    });

    const sentBack = await t.mutation(internal.mcp.requestTaskChanges, {
      presentedKey: plaintext,
      eventSlug,
      taskId,
      note: "Please use the countersigned copy.",
    });
    expect(sentBack).toMatchObject({
      status: "changesRequested",
      reviewNote: "Please use the countersigned copy.",
    });

    const actions = (await auditRows(t)).filter((r) => r.viaAgent === true);
    expect(actions.map((r) => r.action)).toEqual([
      "task.approve",
      "task.requestChanges",
    ]);

    // The state machine is the capability's, not the tool's: approving work
    // that is no longer awaiting review is refused.
    await expectRejectedWith(
      t.mutation(internal.mcp.approveTask, {
        presentedKey: plaintext,
        eventSlug,
        taskId,
      }),
      "invalid_status",
    );
  });

  test("schedule_session places by room NAME, and clears with a null slot", async () => {
    const { alice, orgSlug, eventSlug, sessionId, t } = await writeFixture();
    const { plaintext } = await mint(alice, orgSlug);

    const placed = await t.mutation(internal.mcp.scheduleSession, {
      presentedKey: plaintext,
      eventSlug,
      sessionId,
      slot: { startsAt: SLOT_START, endsAt: SLOT_END, room: "main hall" },
    });
    expect(placed).toMatchObject({
      scheduled: true,
      startsAt: SLOT_START,
      endsAt: SLOT_END,
      room: "Main Hall",
      title: "Opening keynote",
    });

    // A name nobody has is a refusal, never a placement in no room at all.
    await expectRejectedWith(
      t.mutation(internal.mcp.scheduleSession, {
        presentedKey: plaintext,
        eventSlug,
        sessionId,
        slot: { startsAt: SLOT_START, endsAt: SLOT_END, room: "Ballroom C" },
      }),
      "not_found",
    );

    const cleared = await t.mutation(internal.mcp.scheduleSession, {
      presentedKey: plaintext,
      eventSlug,
      sessionId,
      slot: null,
    });
    expect(cleared).toMatchObject({
      scheduled: false,
      startsAt: null,
      endsAt: null,
      room: null,
    });

    const viaAgent = (await auditRows(t))
      .filter((r) => r.viaAgent === true)
      .map((r) => r.action);
    expect(viaAgent).toEqual(["agenda.place", "agenda.unschedule"]);

    // Placement is a draft: the board moved and NOBODY was told about a slot.
    // (The fixture's direct speaker invitation is the only mail in the log —
    // asserting on kinds rather than a count keeps this test about what
    // scheduling does, not about what setting the fixture up does.)
    const kinds = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).map((m) => m.kind),
    );
    expect(kinds.some((kind) => kind.startsWith("agenda"))).toBe(false);
    expect(kinds.some((kind) => kind.includes("slot"))).toBe(false);
  });

  test("a read-ceiling key is refused by EVERY write tool", async () => {
    const { alice, orgSlug, eventSlug, sessionId, taskId, t } =
      await writeFixture();
    const { plaintext } = await mint(alice, orgSlug, { ceiling: "read" });

    // The same key reads the same event perfectly well…
    expect(
      (
        await t.query(internal.mcp.listTaskReviews, {
          presentedKey: plaintext,
          now: Date.now(),
          eventSlug,
        })
      ).tasks,
    ).toHaveLength(1);

    // …and cannot change one byte of it.
    await expectRejectedWith(
      t.mutation(internal.mcp.updateSessionContent, {
        presentedKey: plaintext,
        eventSlug,
        sessionId,
        title: "Nope",
      }),
      "forbidden",
    );
    await expectRejectedWith(
      t.mutation(internal.mcp.scheduleSession, {
        presentedKey: plaintext,
        eventSlug,
        sessionId,
        slot: { startsAt: SLOT_START, endsAt: SLOT_END },
      }),
      "forbidden",
    );
    await expectRejectedWith(
      t.mutation(internal.mcp.approveTask, {
        presentedKey: plaintext,
        eventSlug,
        taskId,
      }),
      "forbidden",
    );
    await expectRejectedWith(
      t.mutation(internal.mcp.requestTaskChanges, {
        presentedKey: plaintext,
        eventSlug,
        taskId,
        note: "Nope",
      }),
      "forbidden",
    );

    // Nothing moved, and no audit row claims otherwise.
    const session = await t.run(async (ctx) => ctx.db.get("sessions", sessionId));
    expect(session?.title).toBe("Opening keynote");
    expect((await auditRows(t)).some((r) => r.viaAgent === true)).toBe(false);
  });

  test("an event-scoped key cannot write outside its event", async () => {
    const { alice, orgSlug, eventSlug, otherEventSlug, sessionId, t } =
      await writeFixture();
    const { plaintext } = await mint(alice, orgSlug, {
      eventSlug: otherEventSlug,
      ceiling: "organizer",
    });

    await expectRejectedWith(
      t.mutation(internal.mcp.updateSessionContent, {
        presentedKey: plaintext,
        eventSlug,
        sessionId,
        title: "Reaching across",
      }),
      "forbidden",
    );
    // And naming its OWN event does not smuggle in another event's session:
    // the capability scopes the session to the caller's event.
    await expectRejectedWith(
      t.mutation(internal.mcp.updateSessionContent, {
        presentedKey: plaintext,
        eventSlug: otherEventSlug,
        sessionId,
        title: "Reaching across",
      }),
      "not_found",
    );
  });

  test("an organizer-ceiling key still cannot exceed the minter's live role", async () => {
    const { alice, orgSlug, eventSlug, sessionId, taskId, t } =
      await writeFixture();
    const { plaintext } = await mint(alice, orgSlug, { ceiling: "organizer" });
    await demoteToReviewer(t, eventSlug);

    // The ceiling says "writes allowed"; `requireOrganizer` in convex/model/*
    // says no. The model layer is what refuses, exactly as it would for a
    // signed-in reviewer clicking the same button.
    await expectRejectedWith(
      t.mutation(internal.mcp.updateSessionContent, {
        presentedKey: plaintext,
        eventSlug,
        sessionId,
        title: "Reviewer reach",
      }),
      "forbidden",
    );
    await expectRejectedWith(
      t.mutation(internal.mcp.approveTask, {
        presentedKey: plaintext,
        eventSlug,
        taskId,
      }),
      "forbidden",
    );
    await expectRejectedWith(
      t.mutation(internal.mcp.scheduleSession, {
        presentedKey: plaintext,
        eventSlug,
        sessionId,
        slot: null,
      }),
      "forbidden",
    );
  });

  test("a malformed or foreign id is a refusal, not a crash", async () => {
    const { alice, orgSlug, eventSlug, t } = await writeFixture();
    const { plaintext } = await mint(alice, orgSlug);

    await expectRejectedWith(
      t.mutation(internal.mcp.updateSessionContent, {
        presentedKey: plaintext,
        eventSlug,
        sessionId: "not-an-id",
        title: "x",
      }),
      "not_found",
    );
    await expectRejectedWith(
      t.mutation(internal.mcp.approveTask, {
        presentedKey: plaintext,
        eventSlug,
        taskId: "not-an-id",
      }),
      "not_found",
    );
  });

  test("a write that changes nothing records nothing", async () => {
    const { alice, orgSlug, eventSlug, sessionId, t } = await writeFixture();
    const { plaintext } = await mint(alice, orgSlug);

    // Same title it already has, and a session already off the board: both
    // capabilities return early without writing. An agent that asks twice must
    // not manufacture a history of changes that never happened.
    await t.mutation(internal.mcp.updateSessionContent, {
      presentedKey: plaintext,
      eventSlug,
      sessionId,
      title: "Opening keynote",
    });
    await t.mutation(internal.mcp.scheduleSession, {
      presentedKey: plaintext,
      eventSlug,
      sessionId,
      slot: null,
    });

    expect((await auditRows(t)).some((r) => r.viaAgent === true)).toBe(false);
  });

  test("the audited note is the one the capability stored, not the one asked for", async () => {
    const { alice, orgSlug, eventSlug, taskId, t } = await writeFixture();
    const { plaintext } = await mint(alice, orgSlug);

    // Whitespace-heavy and one character under the capability's 2000-char
    // limit — so it is accepted, and normalization is exactly the trim. What
    // is stored, mailed and audited must be one value, byte for byte.
    const asked = `  \n ${"x".repeat(1999)} \t  `;
    await t.mutation(internal.mcp.requestTaskChanges, {
      presentedKey: plaintext,
      eventSlug,
      taskId,
      note: asked,
    });

    const instance = await t.run(async (ctx) =>
      ctx.db.get("taskInstances", taskId),
    );
    const row = (await auditRows(t)).find(
      (r) => r.action === "task.requestChanges",
    );
    const audited = (row?.meta as { note?: string }).note;
    expect(row?.viaAgent).toBe(true);
    expect(audited).toBe(instance?.reviewNote);
    expect(audited).not.toBe(asked);
    // And nothing anywhere is holding the raw argument.
    expect(JSON.stringify(row?.meta)).not.toContain(asked);

    // Past the limit the capability REFUSES rather than truncating, so there
    // is never a stored note the speaker was not actually sent.
    await expectRejectedWith(
      t.mutation(internal.mcp.requestTaskChanges, {
        presentedKey: plaintext,
        eventSlug,
        taskId,
        note: "x".repeat(2001),
      }),
      "invalid_note",
    );
  });

  test("schedule_session refuses an ambiguous or foreign room name", async () => {
    const { alice, orgSlug, eventSlug, otherEventSlug, sessionId, t } =
      await writeFixture();
    const { plaintext } = await mint(alice, orgSlug);
    const place = (room: string) =>
      t.mutation(internal.mcp.scheduleSession, {
        presentedKey: plaintext,
        eventSlug,
        sessionId,
        slot: { startsAt: SLOT_START, endsAt: SLOT_END, room },
      });

    // A room on ANOTHER event of the same org is not this event's room.
    await alice.mutation(api.library.add, {
      eventSlug: otherEventSlug,
      table: "rooms",
      item: { name: "Annexe" },
    });
    await expectRejectedWith(place("Annexe"), "not_found");

    // Two rooms whose names differ only by case and padding fold to the same
    // reference: refuse rather than pick one and place the session wrongly.
    await alice.mutation(api.library.add, {
      eventSlug,
      table: "rooms",
      item: { name: "  main hall " },
    });
    await expectRejectedWith(place("Main Hall"), "ambiguous_room");


    // Nothing was placed by either attempt.
    const session = await t.run(async (ctx) => ctx.db.get("sessions", sessionId));
    expect(session?.startsAt).toBeUndefined();
  });

  test("room resolution refuses past its ceiling instead of guessing", async () => {
    const { alice, orgSlug, eventSlug, sessionId, t } = await writeFixture();
    const { plaintext } = await mint(alice, orgSlug);
    const eventId = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      return event!._id;
    });

    // The fixture made one; fill to exactly the ceiling and the read is still
    // complete, so a real room still resolves.
    await t.run(async (ctx) => {
      for (let i = 1; i < LIBRARY_SCAN; i += 1) {
        await ctx.db.insert("rooms", {
          eventId,
          name: `Room ${i}`,
          order: i,
        });
      }
    });
    expect(
      (
        await t.mutation(internal.mcp.scheduleSession, {
          presentedKey: plaintext,
          eventSlug,
          sessionId,
          slot: { startsAt: SLOT_START, endsAt: SLOT_END, room: "Main Hall" },
        })
      ).room,
    ).toBe("Main Hall");

    // One past it and the answer is refused, NOT "no such room" — a partial
    // read cannot tell a missing room from an unread one, nor a unique name
    // from a duplicated one.
    await t.run(async (ctx) => {
      await ctx.db.insert("rooms", {
        eventId,
        name: `Room ${LIBRARY_SCAN}`,
        order: LIBRARY_SCAN,
      });
    });
    await expectRejectedWith(
      t.mutation(internal.mcp.scheduleSession, {
        presentedKey: plaintext,
        eventSlug,
        sessionId,
        slot: { startsAt: SLOT_START, endsAt: SLOT_END, room: "Main Hall" },
      }),
      "event_too_large",
    );
  });

  test("list_task_reviews is honest at its own ceiling", async () => {
    const { alice, orgSlug, eventSlug, sessionId, t } = await writeFixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();
    const read = () =>
      t.query(internal.mcp.listTaskReviews, {
        presentedKey: plaintext,
        now,
        eventSlug,
      });

    const seed = (count: number, status: "provided" | "pending") =>
      t.run(async (ctx) => {
        const instance = (await ctx.db.query("taskInstances").first())!;
        for (let i = 0; i < count; i += 1) {
          await ctx.db.insert("taskInstances", {
            requirementId: instance.requirementId,
            eventId: instance.eventId,
            sessionId,
            status,
            dueAt: instance.dueAt,
            updatedAt: instance.updatedAt,
          });
        }
      });

    // Tasks in OTHER states must not crowd the queue out of its own page:
    // this is the bug a filter-after-read has, and the index range does not.
    await seed(TASK_REVIEW_CAP * 2, "pending");
    const withNoise = await read();
    expect(withNoise.capped).toBe(false);
    expect(withNoise.tasks).toHaveLength(1);

    // Exactly at the cap is complete; one past it says so.
    await seed(TASK_REVIEW_CAP - 1, "provided");
    const atCap = await read();
    expect(atCap.tasks).toHaveLength(TASK_REVIEW_CAP);
    expect(atCap.capped).toBe(false);

    await seed(1, "provided");
    const over = await read();
    expect(over.tasks).toHaveLength(TASK_REVIEW_CAP);
    expect(over.capped).toBe(true);
    expect(over.note).toContain(String(TASK_REVIEW_CAP));
  });

  test("the queue's page is the most URGENT tasks, not the oldest rows", async () => {
    const { alice, orgSlug, eventSlug, sessionId, t } = await writeFixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();

    // A full page of tasks due in the distant future, created first…
    const template = await t.run(async (ctx) => {
      const instance = (await ctx.db.query("taskInstances").first())!;
      for (let i = 0; i < TASK_REVIEW_CAP; i += 1) {
        await ctx.db.insert("taskInstances", {
          requirementId: instance.requirementId,
          eventId: instance.eventId,
          sessionId,
          status: "provided",
          dueAt: FAR_FUTURE + i,
          updatedAt: instance.updatedAt,
        });
      }
      return instance;
    });

    // …and ONE task created last that is due first. Ordered by creation it is
    // the 202nd row and would fall off the page; ordered by due date it is the
    // single most urgent thing the organizer has.
    const urgent = await t.run(async (ctx) =>
      ctx.db.insert("taskInstances", {
        requirementId: template.requirementId,
        eventId: template.eventId,
        sessionId,
        status: "provided",
        dueAt: 1,
        updatedAt: template.updatedAt,
      }),
    );

    const queue = await t.query(internal.mcp.listTaskReviews, {
      presentedKey: plaintext,
      now,
      eventSlug,
    });
    expect(queue.capped).toBe(true);
    expect(queue.tasks).toHaveLength(TASK_REVIEW_CAP);
    expect(queue.tasks[0].taskId).toBe(urgent);
    expect(queue.tasks[0].dueAt).toBe(1);
    // And the page really is the front of the due-date order: the last row in
    // it is due before anything left behind.
    const lastInPage = queue.tasks[queue.tasks.length - 1].dueAt;
    expect(lastInPage).toBeLessThan(FAR_FUTURE + TASK_REVIEW_CAP - 1);
  });

  test("upload counts are exact, and cost one row per task", async () => {
    const { alice, orgSlug, eventSlug, sessionId, t } = await writeFixture();
    const { plaintext } = await mint(alice, orgSlug);
    const now = Date.now();

    // A file task with a real version history, built through the capability
    // that owns the numbering — so the count is checked against the invariant
    // `reviewQueue` relies on, not against the test's own arithmetic.
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Slides",
      scope: "participant",
      evidence: "file",
      reviewRequired: true,
      dueAt: Date.parse("2026-08-18T00:00:00Z"),
    });
    const fileTask = await t.run(async (ctx) => {
      const requirement = await ctx.db
        .query("requirements")
        .filter((q) => q.eq(q.field("title"), "Slides"))
        .first();
      const instance = await ctx.db
        .query("taskInstances")
        .withIndex("by_requirementId", (q) =>
          q.eq("requirementId", requirement!._id),
        )
        .first();
      return { requirementId: requirement!._id, instanceId: instance!._id };
    });
    for (let version = 1; version <= 5; version += 1) {
      const storageId = await t.run(async (ctx) =>
        ctx.storage.store(new Blob([`deck v${version}`])),
      );
      await alice.mutation(api.tasks.attachUpload, {
        eventSlug,
        instanceId: fileTask.instanceId,
        storageId,
        filename: `deck-v${version}.pdf`,
      });
    }

    // Fill the page with file tasks that each carry a version history. Under a
    // read-every-version count this page is uploads × tasks documents — the
    // arithmetic that puts a full page past Convex's scanned-document ceiling
    // (see model/tasks.ts). Counting from the newest row makes it one per task.
    await t.run(async (ctx) => {
      const seed = (await ctx.db.query("taskInstances").first())!;
      for (let i = 0; i < TASK_REVIEW_CAP; i += 1) {
        const instanceId = await ctx.db.insert("taskInstances", {
          requirementId: fileTask.requirementId,
          eventId: seed.eventId,
          sessionId,
          status: "provided",
          dueAt: FAR_FUTURE + i,
          updatedAt: seed.updatedAt,
        });
        // Sequential and append-only, exactly as `attachUpload` writes them.
        for (let version = 1; version <= 3; version += 1) {
          await ctx.db.insert("uploads", {
            eventId: seed.eventId,
            taskInstanceId: instanceId,
            storageId: await ctx.storage.store(new Blob(["x"])),
            filename: `f${version}.pdf`,
            version,
            uploadedBy: seed.completedBy ?? (await ctx.db.query("users").first())!._id,
          });
        }
      }
    });

    const queue = await t.query(internal.mcp.listTaskReviews, {
      presentedKey: plaintext,
      now,
      eventSlug,
    });
    expect(queue.tasks).toHaveLength(TASK_REVIEW_CAP);
    // The real history: five attachments, five versions, five counted.
    const slides = queue.tasks.find((task) => task.taskId === fileTask.instanceId);
    expect(slides).toMatchObject({ requirementTitle: "Slides", uploadCount: 5 });
    // …and every seeded file task reports its own three, not a shared guess.
    // (The manual task the fixture submitted is in this page too, and counts
    // nothing — evidence kind decides whether a version count means anything.)
    const seeded = queue.tasks.filter(
      (task) =>
        task.requirementTitle === "Slides" &&
        task.taskId !== fileTask.instanceId,
    );
    expect(seeded).toHaveLength(TASK_REVIEW_CAP - 2);
    expect(seeded.every((task) => task.uploadCount === 3)).toBe(true);
    expect(
      queue.tasks
        .filter((task) => task.evidence === "manual")
        .every((task) => task.uploadCount === 0),
    ).toBe(true);
    // A manual task has no versions to count and pays nothing to say so.
    expect(
      (
        await t.query(internal.mcp.listTaskReviews, {
          presentedKey: plaintext,
          now,
          eventSlug,
          status: "pending",
        })
      ).tasks.every((task) => task.uploadCount === 0),
    ).toBe(true);
  });

  test("a revoked key stops writing mid-session", async () => {
    const { alice, orgSlug, eventSlug, sessionId, t } = await writeFixture();
    const { plaintext, keyId } = await mint(alice, orgSlug);

    await t.mutation(internal.mcp.updateSessionContent, {
      presentedKey: plaintext,
      eventSlug,
      sessionId,
      title: "First edit",
    });
    await alice.mutation(api.apiKeys.revoke, { orgSlug, keyId });
    await expectRejectedWith(
      t.mutation(internal.mcp.updateSessionContent, {
        presentedKey: plaintext,
        eventSlug,
        sessionId,
        title: "Second edit",
      }),
      "api_key_revoked",
    );
    const session = await t.run(async (ctx) => ctx.db.get("sessions", sessionId));
    expect(session?.title).toBe("First edit");
  });
});

describe("mcp write tools over HTTP", () => {
  test("tools/call writes, and a read key's write comes back sanitized", async () => {
    const { alice, orgSlug, eventSlug, sessionId, t } = await writeFixture();
    const { plaintext } = await mint(alice, orgSlug, { ceiling: "organizer" });

    const called = await mcpPost(
      t,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "update_session_content",
          arguments: {
            eventSlug,
            sessionId,
            title: "Edited by an agent over HTTP",
          },
        },
      },
      bearer(plaintext),
    );
    const result = (
      called.message as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      }
    ).result;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      eventSlug,
      title: "Edited by an agent over HTTP",
      revisionRecorded: true,
    });
    const session = await t.run(async (ctx) => ctx.db.get("sessions", sessionId));
    expect(session?.title).toBe("Edited by an agent over HTTP");

    // The read-ceiling refusal, as an agent actually experiences it: the
    // registered sentence, never the model's own wording.
    const readKey = await mint(alice, orgSlug, {
      name: "Read only",
      ceiling: "read",
    });
    const refused = await mcpPost(
      t,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "approve_task",
          arguments: { eventSlug, taskId: "whatever" },
        },
      },
      bearer(readKey.plaintext),
    );
    const refusal = (
      refused.message as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      }
    ).result;
    expect(refusal.isError).toBe(true);
    expect(refusal.content[0].text).toBe(
      "This API key does not have access to that.",
    );
  });

  test("a JSON-RPC batch is refused before it can spend one token on three writes", async () => {
    const { alice, orgSlug, eventSlug, sessionId, t } = await writeFixture();
    const { plaintext, keyId } = await mint(alice, orgSlug);

    const call = (id: number, title: string) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "update_session_content",
        arguments: { eventSlug, sessionId, title },
      },
    });
    const batched = await mcpPost(
      t,
      [call(1, "First"), call(2, "Second"), call(3, "Third")],
      bearer(plaintext),
    );

    expect(batched.status).toBe(400);
    expect(batched.message).toMatchObject({
      error: {
        message:
          "Send one JSON-RPC message per request — batched arrays are not supported.",
      },
    });

    // None of the three ran…
    const session = await t.run(async (ctx) => ctx.db.get("sessions", sessionId));
    expect(session?.title).toBe("Opening keynote");
    // …and the refusal happened before authentication, so it never touched the
    // key either (lastUsedAt is written by `authenticate`).
    expect(
      (await t.run(async (ctx) => ctx.db.get("apiKeys", keyId)))?.lastUsedAt,
    ).toBeUndefined();

    // The same three calls, sent one per request, all work — refusing batches
    // costs a client nothing but the batching.
    for (const [index, title] of ["First", "Second", "Third"].entries()) {
      const one = await mcpPost(t, call(index + 1, title), bearer(plaintext));
      expect(
        (one.message as { result: { isError?: boolean } }).result.isError,
      ).toBeUndefined();
    }
    expect(
      (await t.run(async (ctx) => ctx.db.get("sessions", sessionId)))?.title,
    ).toBe("Third");
  });
});
