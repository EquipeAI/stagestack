import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { expectRejectedWith, setupTest } from "./test.helpers";

const anonKey = (suffix: string) =>
  `abcdefghijklmnopqrstuvwxyz012345${suffix}`.slice(0, 40);

describe("cfp.startDraft", () => {
  test("creates a draft from an unauthenticated caller", async () => {
    const t = setupTest();
    const key = anonKey("-aa");
    const id = await t.mutation(api.cfp.startDraft, {
      talkTitle: "  Shipping Convex in anger  ",
      anonKey: key,
    });

    const drafts = await t.run(async (ctx) =>
      ctx.db.query("cfpDrafts").collect(),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]._id).toBe(id);
    expect(drafts[0].talkTitle).toBe("Shipping Convex in anger");
    expect(drafts[0].anonKey).toBe(key);
    expect(drafts[0].status).toBe("draft");
  });

  test("rejects a malformed anonKey", async () => {
    const t = setupTest();
    for (const bad of ["short", "a".repeat(31), "a".repeat(129), `${"a".repeat(31)}$`]) {
      await expectRejectedWith(
        t.mutation(api.cfp.startDraft, { talkTitle: "Fine title", anonKey: bad }),
        "invalid_anon_key",
      );
    }
    expect(
      await t.run(async (ctx) => ctx.db.query("cfpDrafts").collect()),
    ).toEqual([]);
  });

  test("rejects an empty title and a title longer than 200 chars", async () => {
    const t = setupTest();
    await expectRejectedWith(
      t.mutation(api.cfp.startDraft, {
        talkTitle: "   ",
        anonKey: anonKey("-bb"),
      }),
      "invalid_talk_title",
    );
    await expectRejectedWith(
      t.mutation(api.cfp.startDraft, {
        talkTitle: "x".repeat(201),
        anonKey: anonKey("-bb"),
      }),
      "invalid_talk_title",
    );
  });

  test("rate limits the 6th draft from the same anonKey (token bucket, rate 5/min)", async () => {
    const t = setupTest();
    const key = anonKey("-cc");
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.cfp.startDraft, {
        talkTitle: `Talk ${i}`,
        anonKey: key,
      });
    }
    await expectRejectedWith(
      t.mutation(api.cfp.startDraft, { talkTitle: "Talk 6", anonKey: key }),
      "rate_limited",
    );

    // A different client key still has its own bucket.
    await t.mutation(api.cfp.startDraft, {
      talkTitle: "Other client",
      anonKey: anonKey("-dd"),
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("cfpDrafts").collect()),
    ).toHaveLength(6);
  });
});
