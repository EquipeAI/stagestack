import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import {
  createOrg,
  expectRejectedWith,
  setupTest,
  signIn,
} from "./test.helpers";

const profile = (over: Record<string, unknown> = {}) => ({
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@example.com",
  tagline: "Rear Admiral, USN",
  ...over,
});

describe("contacts", () => {
  test("create, list, and search-filter the org directory", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");

    const graceId = await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile(),
    });
    await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile({
        firstName: "Alan",
        lastName: "Turing",
        email: "  ALAN@Example.com ",
        tagline: "Cryptanalyst",
      }),
    });

    const all = await alice.query(api.contacts.list, { orgSlug });
    // Sorted by "first last".
    expect(all.map((c) => c.firstName)).toEqual(["Alan", "Grace"]);
    // Emails are trimmed + lower-cased.
    expect(all[0].email).toBe("alan@example.com");

    const filtered = await alice.query(api.contacts.list, {
      orgSlug,
      search: "hopper",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]._id).toBe(graceId);

    const byTagline = await alice.query(api.contacts.list, {
      orgSlug,
      search: "cryptanalyst",
    });
    expect(byTagline.map((c) => c.lastName)).toEqual(["Turing"]);
  });

  test("rejects a duplicate email in the same org, and a malformed email", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    await alice.mutation(api.contacts.create, { orgSlug, profile: profile() });

    await expectRejectedWith(
      alice.mutation(api.contacts.create, {
        orgSlug,
        profile: profile({ firstName: "Other" }),
      }),
      "duplicate_email",
    );
    await expectRejectedWith(
      alice.mutation(api.contacts.create, {
        orgSlug,
        profile: profile({ email: "not-an-email" }),
      }),
      "invalid_email",
    );
  });

  test("the same email is allowed in a different org", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob");
    const orgA = await createOrg(alice, "Acme Conf Co");
    const orgB = await createOrg(bob, "Beta Events");

    await alice.mutation(api.contacts.create, {
      orgSlug: orgA,
      profile: profile(),
    });
    const idB = await bob.mutation(api.contacts.create, {
      orgSlug: orgB,
      profile: profile(),
    });
    expect(idB).toBeTruthy();

    expect(await bob.query(api.contacts.list, { orgSlug: orgB })).toHaveLength(1);
  });

  test("update rewrites the profile and rejects a cross-org contact id", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob");
    const orgA = await createOrg(alice, "Acme Conf Co");
    const orgB = await createOrg(bob, "Beta Events");

    const id = await alice.mutation(api.contacts.create, {
      orgSlug: orgA,
      profile: profile(),
    });
    await alice.mutation(api.contacts.update, {
      orgSlug: orgA,
      contactId: id,
      profile: profile({ tagline: "Compiler pioneer", phone: "+1 555 0100" }),
    });
    const [updated] = await alice.query(api.contacts.list, { orgSlug: orgA });
    expect(updated.tagline).toBe("Compiler pioneer");
    expect(updated.phone).toBe("+1 555 0100");

    // Bob owns orgB but the contact lives in orgA.
    await expectRejectedWith(
      bob.mutation(api.contacts.update, {
        orgSlug: orgB,
        contactId: id,
        profile: profile({ tagline: "Hijacked" }),
      }),
      "not_found",
    );
  });

  test("NEGATIVE: a user from another org cannot list or create in this org", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob");
    const orgA = await createOrg(alice, "Acme Conf Co");
    await createOrg(bob, "Beta Events");

    await expectRejectedWith(
      bob.query(api.contacts.list, { orgSlug: orgA }),
      "forbidden",
    );
    await expectRejectedWith(
      bob.mutation(api.contacts.create, { orgSlug: orgA, profile: profile() }),
      "forbidden",
    );
    await expectRejectedWith(
      t.query(api.contacts.list, { orgSlug: orgA }),
      "not_authenticated",
    );
  });
});
