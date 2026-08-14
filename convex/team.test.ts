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

/** Accepting an invitation authorizes on the LIVE token's verified address
 * (model/team.acceptInvitation), so a redeemer identity must carry the claim. */
const VERIFIED = { emailVerified: true };

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
      now: Date.now(),
    });
    expect(preview).toMatchObject({
      orgName: "Acme Conf Co",
      eventName: "Acme Summit",
      role: "reviewer",
      status: "pending",
    });

    const listed = await alice.query(api.team.listForEvent, {
      eventSlug,
      now: Date.now(),
    });
    expect(listed.invitations).toHaveLength(1);
    expect(listed.members).toHaveLength(1);
    expect(listed.members[0]).toMatchObject({
      role: "owner",
      scope: "organization",
    });

    const rita = await signIn(t, "rita", VERIFIED);
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
    // The preview's expiry comes from the injected `now`, not the server clock:
    // the same live invitation reads pending before its TTL and expired after.
    const expiresAt = await t.run(async (ctx) => {
      const invite = await ctx.db.get("invitations", expiredId);
      if (invite === null) throw new Error("invitation vanished");
      return invite.expiresAt;
    });
    expect(
      await t.query(api.team.previewInvitation, {
        token: expiredToken,
        now: expiresAt - 1,
      }),
    ).toMatchObject({ status: "pending" });
    expect(
      await t.query(api.team.previewInvitation, {
        token: expiredToken,
        now: expiresAt + 1,
      }),
    ).toMatchObject({ status: "expired" });

    // acceptInvitation is a mutation and reads the real clock, so the row has
    // to actually be stale for it to refuse.
    await t.run(async (ctx) => {
      await ctx.db.patch("invitations", expiredId, {
        expiresAt: Date.now() - 1000,
      });
    });
    const expiredUser = await signIn(t, "expired");
    await expectRejectedWith(
      expiredUser.mutation(api.team.acceptInvitation, { token: expiredToken }),
      "invitation_expired",
    );

    // An unknown token previews as null.
    expect(
      await t.query(api.team.previewInvitation, {
        token: "nope",
        now: Date.now(),
      }),
    ).toBeNull();
  });

  test("NEGATIVE: a wrong-email account cannot redeem the token, and the invite stays pending", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    const invitationId = await alice.mutation(api.team.inviteToEvent, {
      eventSlug,
      email: "rita@example.com",
      role: "reviewer",
    });
    const token = await tokenFor(t, "rita@example.com");

    // The token is a bearer credential; a leaked/forwarded link in the hands of
    // any other signed-in account must not buy membership.
    const mallory = await signIn(t, "mallory", VERIFIED);
    const auditBefore = await t.run(async (ctx) =>
      ctx.db.query("auditLog").collect(),
    );
    await expectRejectedWith(
      mallory.mutation(api.team.acceptInvitation, { token }),
      "invitation_email_mismatch",
    );

    // No membership was granted, in either scope.
    const [eventMembers, members] = await t.run(async (ctx) => [
      await ctx.db.query("eventMembers").collect(),
      await ctx.db.query("members").collect(),
    ]);
    expect(eventMembers).toHaveLength(0);
    // Only alice's founding ownership row survives — mallory gained nothing.
    expect(members.map((m) => m.role)).toEqual(["owner"]);

    // The refusal wrote no audit row …
    const auditAfter = await t.run(async (ctx) =>
      ctx.db.query("auditLog").collect(),
    );
    expect(auditAfter).toHaveLength(auditBefore.length);

    // … and did not burn the real invitee's invitation.
    const invite = await t.run(async (ctx) =>
      ctx.db.get("invitations", invitationId),
    );
    expect(invite?.status).toBe("pending");

    // Which the right account then proves by accepting it.
    const rita = await signIn(t, "rita", VERIFIED);
    expect(await rita.mutation(api.team.acceptInvitation, { token })).toEqual({
      orgSlug,
      eventSlug,
    });
  });

  test("the email match is case- and whitespace-insensitive", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    const invitationId = await alice.mutation(api.team.inviteToEvent, {
      eventSlug,
      email: "rita@example.com",
      role: "reviewer",
    });
    const token = await tokenFor(t, "rita@example.com");
    // Stored casing must not decide the match: an invite row written before
    // normalisation existed (or by an import) still binds to the same person.
    await t.run(async (ctx) => {
      await ctx.db.patch("invitations", invitationId, {
        email: "  Rita@Example.COM ",
      });
    });

    const rita = await signIn(t, "rita", VERIFIED);
    expect(await rita.mutation(api.team.acceptInvitation, { token })).toEqual({
      orgSlug,
      eventSlug,
    });
    const eventMembers = await t.run(async (ctx) =>
      ctx.db.query("eventMembers").collect(),
    );
    expect(eventMembers).toHaveLength(1);
    expect(eventMembers[0].role).toBe("reviewer");
  });

  test("NEGATIVE: an unverified address cannot redeem the invitation even when it matches", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    const invitationId = await alice.mutation(api.team.inviteToEvent, {
      eventSlug,
      email: "rita@example.com",
      role: "reviewer",
    });
    const token = await tokenFor(t, "rita@example.com");

    // Anyone can *type* someone else's address into their Clerk account; only
    // the verified claim proves they own it. An absent claim reads unverified.
    const unverified = await signIn(t, "rita", { emailVerified: false });
    await expectRejectedWith(
      unverified.mutation(api.team.acceptInvitation, { token }),
      "email_unverified",
    );
    const noClaim = await signIn(t, "rita");
    await expectRejectedWith(
      noClaim.mutation(api.team.acceptInvitation, { token }),
      "email_unverified",
    );

    const [eventMembers, invite] = await t.run(async (ctx) => [
      await ctx.db.query("eventMembers").collect(),
      await ctx.db.get("invitations", invitationId),
    ]);
    expect(eventMembers).toHaveLength(0);
    expect(invite?.status).toBe("pending");
  });

  test("NEGATIVE: a stale stored users.email cannot stand in for the live token", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    await alice.mutation(api.team.inviteToEvent, {
      eventSlug,
      email: "rita@example.com",
      role: "reviewer",
    });
    const token = await tokenFor(t, "rita@example.com");

    // `users.email` is delivery data, not an authorization key: a row carrying
    // the invited address (stale, imported, or written before the address moved)
    // must not admit an identity whose live token says someone else.
    const mallory = await signIn(t, "mallory", VERIFIED);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "mallory@example.com"))
        .unique();
      if (row === null) throw new Error("no users row for mallory");
      await ctx.db.patch("users", row._id, { email: "rita@example.com" });
    });
    await expectRejectedWith(
      mallory.mutation(api.team.acceptInvitation, { token }),
      "invitation_email_mismatch",
    );

    const eventMembers = await t.run(async (ctx) =>
      ctx.db.query("eventMembers").collect(),
    );
    expect(eventMembers).toHaveLength(0);
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
      await t.query(api.team.previewInvitation, { token, now: Date.now() }),
    ).toMatchObject({ eventName: null, role: "admin", status: "pending" });

    const adam = await signIn(t, "adam", VERIFIED);
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
    const adam = await signIn(t, "adam", VERIFIED);
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

describe("team lists take the clock as an argument", () => {
  test("pending invitations drop out of both lists at the injected `now`", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await alice.mutation(api.team.inviteToEvent, {
      eventSlug,
      email: "rita@example.com",
      role: "reviewer",
    });
    await alice.mutation(api.team.inviteOrgAdmin, {
      orgSlug,
      email: "adam@example.com",
      role: "admin",
    });
    const { earliest, latest } = await t.run(async (ctx) => {
      const invites = await ctx.db.query("invitations").collect();
      const expiries = invites.map((i) => i.expiresAt);
      return { earliest: Math.min(...expiries), latest: Math.max(...expiries) };
    });

    const beforeEvent = await alice.query(api.team.listForEvent, {
      eventSlug,
      now: earliest - 1,
    });
    expect(beforeEvent.invitations).toHaveLength(1);
    const afterEvent = await alice.query(api.team.listForEvent, {
      eventSlug,
      now: latest + 1,
    });
    expect(afterEvent.invitations).toEqual([]);
    // Members are not time-derived, so the same call still returns the team.
    expect(afterEvent.members).toHaveLength(1);

    expect(
      (await alice.query(api.team.listForOrg, { orgSlug, now: earliest - 1 }))
        .invitations,
    ).toHaveLength(1);
    expect(
      (await alice.query(api.team.listForOrg, { orgSlug, now: latest + 1 }))
        .invitations,
    ).toEqual([]);
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

    const listed = await alice.query(api.team.listForEvent, {
      eventSlug,
      now: Date.now(),
    });
    expect(listed.invitations).toEqual([]);
    expect(
      await t.query(api.team.previewInvitation, {
        token: await tokenFor(t, "rita@example.com"),
        now: Date.now(),
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

    const eventMemberId = await t.run(async (ctx) => {
      const row = await ctx.db.query("eventMembers").first();
      if (row === null) throw new Error("no eventMembers row");
      return row._id;
    });

    await expectRejectedWith(
      alice.mutation(api.team.removeEventMember, {
        eventSlug: eventB,
        eventMemberId,
      }),
      "not_found",
    );

    await alice.mutation(api.team.removeEventMember, {
      eventSlug: eventA,
      eventMemberId,
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("eventMembers").collect()),
    ).toEqual([]);
  });
});
