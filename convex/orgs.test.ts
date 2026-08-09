import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import {
  auditActions,
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
} from "./test.helpers";

describe("orgs.create / orgs.myHome", () => {
  test("creator becomes owner and myHome reports the org with its events", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    expect(orgSlug).toBe("acme-conf-co");

    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit 2026");

    const home = await alice.query(api.orgs.myHome, {});
    expect(home).toHaveLength(1);
    expect(home[0].role).toBe("owner");
    expect(home[0].org.slug).toBe(orgSlug);
    expect(home[0].events.map((e) => e.slug)).toEqual([eventSlug]);

    const membership = await t.run(async (ctx) =>
      ctx.db.query("members").collect(),
    );
    expect(membership).toHaveLength(1);
    expect(membership[0].role).toBe("owner");
  });

  test("two orgs with the same name get distinct slugs", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob");
    expect(await createOrg(alice, "Acme Conf Co")).toBe("acme-conf-co");
    expect(await createOrg(bob, "Acme Conf Co")).toBe("acme-conf-co-2");
    expect(await createOrg(bob, "Acme  Conf  Co!")).toBe("acme-conf-co-3");
  });

  test("rejects an empty name and an unauthenticated caller", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    await expectRejectedWith(
      alice.mutation(api.orgs.create, { name: "   " }),
      "invalid_name",
    );
    await expectRejectedWith(
      t.mutation(api.orgs.create, { name: "Nope" }),
      "not_authenticated",
    );
  });

  test("myHome shows event-scoped access with a null org role", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const carol = await signIn(t, "carol");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await createEvent(alice, orgSlug, "Acme Winter");

    await grantEventRole(t, eventSlug, "carol", "reviewer");

    const home = await carol.query(api.orgs.myHome, {});
    expect(home).toHaveLength(1);
    expect(home[0].role).toBeNull();
    // Only the event they were granted, not the whole org.
    expect(home[0].events.map((e) => e.slug)).toEqual([eventSlug]);
  });

  test("org creation writes an audit row", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    await createOrg(alice, "Acme Conf Co");
    expect(await auditActions(t)).toEqual(["org.create"]);
  });
});
