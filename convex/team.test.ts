import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
  type TestT,
} from "./test.helpers";

async function tokenFor(t: TestT, email: string): Promise<string> {
  return await t.run(async (ctx) => {
    const invite = await ctx.db
      .query("invitations")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (invite === null) throw new Error(`no invitation for ${email}`);
    return invite.token;
  });
}

describe("team.inviteToEvent / acceptInvitation", () => {
  test("creates a pending invitation and a fresh user accepts it into eventMembers", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    const invitationId = await alice.mutation(api.team.inviteToEvent, {
      eventSlug,
      email: "  Rita@Example.COM ",
      role: "reviewer",
    });
    expect(invitationId).toBeTruthy();

    const preview = await t.query(api.team.previewInvitation, {
      token: await tokenFor(t, "rita@example.com"),
    });
    expect(preview).toMatchObject({
      orgName: "Acme Conf Co",
      eventName: "Acme Summit",
      role: "reviewer",
      status: "pending",
    });

    const listed = await alice.query(api.team.listForEvent, { eventSlug });
    expect(listed.invitations).toHaveLength(1);
    expect(listed.members).toHaveLength(1);
    expect(listed.members[0]).toMatchObject({
      role: "owner",
      scope: "organization",
    });

    const rita = await signIn(t, "rita");
    const token = await tokenFor(t, "rita@example.com");
    const result = await rita.mutation(api.team.acceptInvitation, { token });
    expect(result).toEqual({ orgSlug, eventSlug });

    const membership = await t.run(async (ctx) =>
      ctx.db.query("eventMembers").collect(),
    );
    expect(membership).toHaveLength(1);
    expect(membership[0].role).toBe("reviewer");

    // Rita can now read the event as a reviewer.
    const evt = await rita.query(api.events.get, { eventSlug });
    expect(evt.role).toBe("reviewer");

    // Accepting twice fails: the invite is no longer pending.
    await expectRejectedWith(
      rita.mutation(api.team.acceptInvitation, { token }),
      "invalid_invitation",
    );
  });

  test("rejects a revoked invitation and an expired invitation", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    const revokedId = await alice.mutation(api.team.inviteToEvent, {
      eventSlug,
      email: "revoked@example.com",
      role: "reviewer",
    });
    const revokedToken = await tokenFor(t, "revoked@example.com");
    await alice.mutation(api.team.revokeInvitation, {
      eventSlug,
      invitationId: revokedId,
    });
    const revokedUser = await signIn(t, "revoked");
    await expectRejectedWith(
      revokedUser.mutation(api.team.acceptInvitation, { token: revokedToken }),
      "invalid_invitation",
    );

    const expiredId = await alice.mutation(api.team.inviteToEvent, {
      eventSlug,
      email: "expired@example.com",
      role: "organizer",
    });
    const expiredToken = await tokenFor(t, "expired@example.com");
    await t.run(async (ctx) => {
      await ctx.db.patch("invitations", expiredId, {
        expiresAt: Date.now() - 1000,
      });
    });
    expect(
      await t.query(api.team.previewInvitation, { token: expiredToken }),
    ).toMatchObject({ status: "expired" });

    const expiredUser = await signIn(t, "expired");
    await expectRejectedWith(
      expiredUser.mutation(api.team.acceptInvitation, { token: expiredToken }),
      "invitation_expired",
    );

    // An unknown token previews as null.
    expect(
      await t.query(api.team.previewInvitation, { token: "nope" }),
    ).toBeNull();
  });

  test("rejects a duplicate pending invite and a malformed email", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    await alice.mutation(api.team.inviteToEvent, {
      eventSlug,
      email: "rita@example.com",
      role: "reviewer",
    });
    await expectRejectedWith(
      alice.mutation(api.team.inviteToEvent, {
        eventSlug,
        email: "rita@example.com",
        role: "organizer",
      }),
      "already_invited",
    );
    await expectRejectedWith(
      alice.mutation(api.team.inviteToEvent, {
        eventSlug,
        email: "not-an-email",
        role: "reviewer",
      }),
      "invalid_email",
    );
  });

  test("NEGATIVE: a reviewer cannot invite to the event", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const rita = await signIn(t, "rita");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await grantEventRole(t, eventSlug, "rita", "reviewer");

    await expectRejectedWith(
      rita.mutation(api.team.inviteToEvent, {
        eventSlug,
        email: "friend@example.com",
        role: "organizer",
      }),
      "forbidden",
    );
  });
});

describe("team.inviteOrgAdmin", () => {
  test("an org admin invite grants a members row on accept", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    await createEvent(alice, orgSlug, "Acme Summit");

    await alice.mutation(api.team.inviteOrgAdmin, {
      orgSlug,
      email: "adam@example.com",
      role: "admin",
    });
    const token = await tokenFor(t, "adam@example.com");
    expect(
      await t.query(api.team.previewInvitation, { token }),
    ).toMatchObject({ eventName: null, role: "admin", status: "pending" });

    const adam = await signIn(t, "adam");
    const result = await adam.mutation(api.team.acceptInvitation, { token });
    expect(result).toEqual({ orgSlug, eventSlug: null });

    const members = await t.run(async (ctx) =>
      ctx.db.query("members").collect(),
    );
    expect(members.map((m) => m.role).sort()).toEqual(["admin", "owner"]);

    const home = await adam.query(api.orgs.myHome, {});
    expect(home[0].role).toBe("admin");
    // Org-wide role sees every event in the org.
    expect(home[0].events).toHaveLength(1);
  });

  test("NEGATIVE: an event-scoped organizer cannot invite an org admin", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const dave = await signIn(t, "dave");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await grantEventRole(t, eventSlug, "dave", "organizer");

    await expectRejectedWith(
      dave.mutation(api.team.inviteOrgAdmin, {
        orgSlug,
        email: "someone@example.com",
        role: "admin",
      }),
      "forbidden",
    );
  });

  test("NEGATIVE: an admin cannot grant ownership", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    await alice.mutation(api.team.inviteOrgAdmin, {
      orgSlug,
      email: "adam@example.com",
      role: "admin",
    });
    const adam = await signIn(t, "adam");
    await adam.mutation(api.team.acceptInvitation, {
      token: await tokenFor(t, "adam@example.com"),
    });

    await expectRejectedWith(
      adam.mutation(api.team.inviteOrgAdmin, {
        orgSlug,
        email: "owner2@example.com",
        role: "owner",
      }),
      "forbidden",
    );
  });
});

describe("team.revokeInvitation", () => {
  test(
    "an organizer of event A cannot revoke event B's invitation",
    async () => {
      const t = setupTest();
      const alice = await signIn(t, "alice");
      const dave = await signIn(t, "dave");
      const orgSlug = await createOrg(alice, "Acme Conf Co");
      const eventA = await createEvent(alice, orgSlug, "Event A");
      const eventB = await createEvent(alice, orgSlug, "Event B");
      await grantEventRole(t, eventA, "dave", "organizer");

      const inviteB = await alice.mutation(api.team.inviteToEvent, {
        eventSlug: eventB,
        email: "victim@example.com",
        role: "organizer",
      });
      // Dave provably has no access to event B...
      await expectRejectedWith(
        dave.query(api.events.get, { eventSlug: eventB }),
        "forbidden",
      );
      // ...so revoking its invitation through event A should be rejected.
      await expectRejectedWith(
        dave.mutation(api.team.revokeInvitation, {
          eventSlug: eventA,
          invitationId: inviteB,
        }),
        "not_found",
      );
    },
  );

  test("an organizer can revoke an invitation for their own event", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    const invitationId = await alice.mutation(api.team.inviteToEvent, {
      eventSlug,
      email: "rita@example.com",
      role: "reviewer",
    });
    await alice.mutation(api.team.revokeInvitation, {
      eventSlug,
      invitationId,
    });

    const listed = await alice.query(api.team.listForEvent, { eventSlug });
    expect(listed.invitations).toEqual([]);
    expect(
      await t.query(api.team.previewInvitation, {
        token: await tokenFor(t, "rita@example.com"),
      }),
    ).toMatchObject({ status: "revoked" });
  });
});

describe("team.removeEventMember", () => {
  test("an organizer removes an event member, and cross-event ids are rejected", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    await signIn(t, "rita");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventA = await createEvent(alice, orgSlug, "Event A");
    const eventB = await createEvent(alice, orgSlug, "Event B");
    await grantEventRole(t, eventA, "rita", "reviewer");

    const memberDocId = await t.run(async (ctx) => {
      const row = await ctx.db.query("eventMembers").first();
      if (row === null) throw new Error("no eventMembers row");
      return row._id;
    });

    await expectRejectedWith(
      alice.mutation(api.team.removeEventMember, {
        eventSlug: eventB,
        memberDocId,
      }),
      "not_found",
    );

    await alice.mutation(api.team.removeEventMember, {
      eventSlug: eventA,
      memberDocId,
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("eventMembers").collect()),
    ).toEqual([]);
  });
});
