import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { createEvent, createOrg, setupTest, signIn } from "./test.helpers";

describe("audit log", () => {
  test("org create, event create and settings update each write one row with the actor", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { name: "Acme Summit 2026", website: "https://acme.example" },
    });

    const { rows, userId, orgId, eventId } = await t.run(async (ctx) => {
      const user = await ctx.db.query("users").first();
      const org = await ctx.db.query("organizations").first();
      const event = await ctx.db.query("events").first();
      return {
        rows: await ctx.db.query("auditLog").collect(),
        userId: user?._id,
        orgId: org?._id,
        eventId: event?._id,
      };
    });

    expect(rows.map((r) => r.action)).toEqual([
      "org.create",
      "event.create",
      "event.updateSettings",
    ]);
    for (const row of rows) {
      expect(row.orgId).toBe(orgId);
      expect(row.actorUserId).toBe(userId);
    }
    expect(rows[0].eventId).toBeUndefined();
    expect(rows[1].eventId).toBe(eventId);
    expect(rows[2].eventId).toBe(eventId);
    expect(rows[2].meta).toEqual({ fields: ["name", "website"] });
  });

  test("library, contact and team actions are audited too", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    const trackId = await alice.mutation(api.library.add, {
      eventSlug,
      table: "tracks",
      item: { name: "Platform" },
    });
    await alice.mutation(api.library.update, {
      eventSlug,
      table: "tracks",
      id: trackId,
      patch: { name: "Platform Engineering" },
    });
    await alice.mutation(api.library.remove, {
      eventSlug,
      table: "tracks",
      id: trackId,
    });
    await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: { firstName: "Grace", lastName: "Hopper" },
    });
    await alice.mutation(api.team.inviteToEvent, {
      eventSlug,
      email: "rita@example.com",
      role: "reviewer",
    });

    const actions = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).map((r) => r.action),
    );
    expect(actions).toEqual([
      "org.create",
      "event.create",
      "library.tracks.add",
      "library.tracks.update",
      "library.tracks.remove",
      "contact.create",
      "team.invite",
    ]);
  });
});
