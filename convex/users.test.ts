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
    expect(rows[0].tokenIdentifier).toBe(identityFor("alice").tokenIdentifier);
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
        identityFor("alice", {
          email: "ALICE+new@example.com",
          name: "Alice A",
        }),
      )
      .mutation(api.users.ensure, {});

    expect(second).toBe(first);
    const rows = await t.run(async (ctx) => ctx.db.query("users").collect());
    expect(rows).toHaveLength(1);
    // Emails are lower-cased on write.
    expect(rows[0].email).toBe("alice+new@example.com");
    expect(rows[0].name).toBe("Alice A");
  });

  test("derives a canonical person name and self-heals a legacy email-as-name row", async () => {
    const t = setupTest();
    const emailOnly = t.withIdentity(
      identityFor("jordan", {
        name: undefined,
        givenName: undefined,
        familyName: undefined,
        nickname: undefined,
      }),
    );
    const userId = await emailOnly.mutation(api.users.ensure, {});
    await t.run(async (ctx) => {
      expect((await ctx.db.get("users", userId))?.name).toBeUndefined();
      // Reproduce the old `identity.name ?? identity.email` persisted value.
      await ctx.db.patch("users", userId, { name: "jordan@example.com" });
    });

    const healedId = await t
      .withIdentity(
        identityFor("jordan", {
          name: undefined,
          givenName: " Jordan ",
          familyName: " Alvarez ",
          nickname: "J",
        }),
      )
      .mutation(api.users.ensure, { displayName: "Ignored Client Name" });
    expect(healedId).toBe(userId);
    const healed = await t.run(async (ctx) => ctx.db.get("users", userId));
    expect(healed?.name).toBe("Jordan Alvarez");
    expect(healed?.email).toBe("jordan@example.com");
  });

  test("uses the authenticated client's Clerk display name only when token name claims are absent", async () => {
    const t = setupTest();
    const as = t.withIdentity(
      identityFor("priya", {
        name: undefined,
        givenName: undefined,
        familyName: undefined,
        nickname: undefined,
      }),
    );
    const userId = await as.mutation(api.users.ensure, {
      displayName: "  Priya   Raman  ",
    });
    expect(
      await t.run(async (ctx) => (await ctx.db.get("users", userId))?.name),
    ).toBe("Priya Raman");
  });

  test("never persists token or client display values that are actually the email", async () => {
    const t = setupTest();
    const as = t.withIdentity(
      identityFor("mail-name", {
        name: "MAIL-NAME@EXAMPLE.COM",
        givenName: undefined,
        familyName: undefined,
        nickname: undefined,
      }),
    );
    const userId = await as.mutation(api.users.ensure, {
      displayName: "mail-name@example.com",
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get("users", userId))?.name).toBeUndefined();
    });
  });

  test("a claimless refresh preserves a human name but clears a legacy email name", async () => {
    const t = setupTest();
    const named = t.withIdentity(
      identityFor("preserved", {
        name: "Existing Human",
        givenName: undefined,
        familyName: undefined,
        nickname: undefined,
      }),
    );
    const userId = await named.mutation(api.users.ensure, {});
    const claimless = t.withIdentity(
      identityFor("preserved", {
        name: undefined,
        givenName: undefined,
        familyName: undefined,
        nickname: undefined,
      }),
    );
    await claimless.mutation(api.users.ensure, {});
    expect(
      await t.run(async (ctx) => (await ctx.db.get("users", userId))?.name),
    ).toBe("Existing Human");

    await t.run(async (ctx) => {
      await ctx.db.patch("users", userId, { name: "preserved@example.com" });
    });
    await claimless.mutation(api.users.ensure, {});
    expect(
      (await t.run(async (ctx) => (await ctx.db.get("users", userId))?.name)) ??
        undefined,
    ).toBeUndefined();
  });

  test("lets only the authenticated account set a normalized display-only name", async () => {
    const t = setupTest();
    const namelessClaims = {
      name: undefined,
      givenName: undefined,
      familyName: undefined,
      nickname: undefined,
    };
    const jordan = await signIn(t, "jordan", namelessClaims);
    const priya = await signIn(t, "priya", namelessClaims);

    expect(await jordan.query(api.users.currentProfile, {})).toEqual({
      displayName: null,
      needsDisplayName: true,
    });
    await jordan.mutation(api.users.setDisplayName, {
      displayName: "  Jordan   Alvarez  ",
    });
    expect(await jordan.query(api.users.currentProfile, {})).toEqual({
      displayName: "Jordan Alvarez",
      needsDisplayName: false,
    });
    expect(await priya.query(api.users.currentProfile, {})).toEqual({
      displayName: null,
      needsDisplayName: true,
    });

    // A later claimless provisioning pass preserves the app-owned label.
    await jordan.mutation(api.users.ensure, {});
    expect((await jordan.query(api.users.currentProfile, {})).displayName).toBe(
      "Jordan Alvarez",
    );

    // A real provider name remains canonical when Clerk later supplies one.
    const namedJordan = t.withIdentity(
      identityFor("jordan", { ...namelessClaims, name: "Jordan A." }),
    );
    await namedJordan.mutation(api.users.ensure, {});
    expect(
      (await namedJordan.query(api.users.currentProfile, {})).displayName,
    ).toBe("Jordan A.");
  });

  test("rejects unsafe display names and never accepts a target user id", async () => {
    const t = setupTest();
    const as = await signIn(t, "nameless", {
      name: undefined,
      givenName: undefined,
      familyName: undefined,
      nickname: undefined,
    });
    for (const displayName of [
      "   ",
      "nameless@example.com",
      "Jordan\u0000Alvarez",
      "x".repeat(201),
    ]) {
      await expectRejectedWith(
        as.mutation(api.users.setDisplayName, { displayName }),
        "invalid_display_name",
      );
    }
    expect(await as.query(api.users.currentProfile, {})).toEqual({
      displayName: null,
      needsDisplayName: true,
    });
  });

  test("rejects an unauthenticated caller", async () => {
    const t = setupTest();
    await expectRejectedWith(
      t.mutation(api.users.ensure, {}),
      "not_authenticated",
    );
    await expectRejectedWith(
      t.query(api.users.currentProfile, {}),
      "not_authenticated",
    );
    await expectRejectedWith(
      t.mutation(api.users.setDisplayName, { displayName: "Mallory" }),
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
