import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import {
  expectRejectedWith,
  identityFor,
  setupTest,
  signIn,
} from "./test.helpers";

describe("users.ensure", () => {
  test("creates a row keyed on tokenIdentifier", async () => {
    const t = setupTest();
    const as = t.withIdentity(identityFor("alice"));
    const userId = await as.mutation(api.users.ensure, {});

    const rows = await t.run(async (ctx) => ctx.db.query("users").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(userId);
    expect(rows[0].tokenIdentifier).toBe(
      identityFor("alice").tokenIdentifier,
    );
    expect(rows[0].clerkSubject).toBe("alice");
    expect(rows[0].email).toBe("alice@example.com");
  });

  test("second call patches the profile and returns the same id", async () => {
    const t = setupTest();
    const first = await t
      .withIdentity(identityFor("alice"))
      .mutation(api.users.ensure, {});
    const second = await t
      .withIdentity(
        identityFor("alice", { email: "ALICE+new@example.com", name: "Alice A" }),
      )
      .mutation(api.users.ensure, {});

    expect(second).toBe(first);
    const rows = await t.run(async (ctx) => ctx.db.query("users").collect());
    expect(rows).toHaveLength(1);
    // Emails are lower-cased on write.
    expect(rows[0].email).toBe("alice+new@example.com");
    expect(rows[0].name).toBe("Alice A");
  });

  test("rejects an unauthenticated caller", async () => {
    const t = setupTest();
    await expectRejectedWith(
      t.mutation(api.users.ensure, {}),
      "not_authenticated",
    );
  });

  test("distinct identities get distinct rows", async () => {
    const t = setupTest();
    await signIn(t, "alice");
    await signIn(t, "bob");
    const rows = await t.run(async (ctx) => ctx.db.query("users").collect());
    expect(rows.map((r) => r.clerkSubject).sort()).toEqual(["alice", "bob"]);
  });
});
