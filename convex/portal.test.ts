import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  auditActions,
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
  type TestT,
  type TestUserT,
} from "./test.helpers";

// Speaker portal (M3). The rules worth breaking the build over: access comes
// only from a Clerk-VERIFIED email matching an event snapshot, a profile edit
// touches exactly one event's snapshot plus the org directory, and a completed
// manager handoff moves management away from the previous manager.

const ISSUER = "https://test.clerk.example.com";

// Portal claiming requires the Clerk `email_verified` claim; an absent claim
// reads as unverified, so every identity that enters the portal carries it.
const VERIFIED = { emailVerified: true };

async function userIdFor(t: TestT, key: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", `${ISSUER}|${key}`),
      )
      .unique();
    if (user === null) throw new Error(`no user ${key}`);
    return user._id;
  });
}

async function messageRows(t: TestT) {
  return await t.run(async (ctx) => ctx.db.query("messages").collect());
}

async function auditRows(t: TestT) {
  return await t.run(async (ctx) => ctx.db.query("auditLog").collect());
}

async function handoffRows(t: TestT) {
  return await t.run(async (ctx) => ctx.db.query("managerHandoffs").collect());
}

/** The publish/withdraw/decline paths now SCHEDULE the projection rebuild
 * (a speaker's portal click must not pay for an O(event) recompute), so a test
 * that reads the served blob has to let the queued job run. Same drain shape as
 * comms.test.ts's `runSweep`: `runAfter(0)` needs real event-loop turns. */
async function drainScheduled(t: TestT): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

/** The served projection, read after the scheduled rebuild has landed. */
async function servedProgram(t: TestT, slug: string) {
  await drainScheduled(t);
  return await t.query(api.publish.publicProgram, { slug });
}

async function participantsOf(t: TestT, sessionId: Id<"sessions">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("sessionParticipants")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .collect(),
  );
}

async function eventContact(t: TestT, id: Id<"eventContacts">) {
  return await t.run(async (ctx) => {
    const row = await ctx.db.get("eventContacts", id);
    if (row === null) throw new Error("no eventContact");
    return row;
  });
}

function pngBlob(): Blob {
  const binary = atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" });
}

async function uploadPortalHeadshot(
  t: TestT,
  as: TestUserT,
  eventSlug: string,
  eventContactId: Id<"eventContacts">,
): Promise<Id<"_storage">> {
  const body = pngBlob();
  const ticket = await as.mutation(api.portal.beginHeadshotUpload, {
    eventSlug,
    eventContactId,
    contentType: body.type,
    size: body.size,
  });
  const response = await as.fetch(`/api/headshots/${ticket.uploadId}`, {
    method: "POST",
    headers: { "Content-Type": body.type },
    body,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  await as.mutation(api.portal.attachHeadshot, {
    eventSlug,
    eventContactId,
    uploadId: ticket.uploadId,
  });
  const upload = await t.run(async (ctx) =>
    ctx.db.get("headshotUploads", ticket.uploadId),
  );
  if (upload?.storageId === undefined) throw new Error("storage id missing");
  return upload.storageId;
}

/** An organizer, an event, and a directly invited speaker whose email matches
 * the `dana` test identity. */
async function directSetup(t: TestT) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
  const { sessionId, eventContactId } = await alice.mutation(
    api.sessions.createDirect,
    {
      eventSlug,
      title: "Opening keynote",
      description: "How we got here.",
      format: "Keynote",
      speaker: {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
    },
  );
  return { alice, orgSlug, eventSlug, sessionId, eventContactId };
}

/** A released CFP acceptance: `bob` submitted, `carol` speaks, so bob is the
 * primary manager of a session he does not appear in. */
async function acceptedProposalSetup(t: TestT) {
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob", VERIFIED);
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
  await alice.mutation(api.cfp.publishForm, { eventSlug });
  await alice.mutation(api.events.updateSettings, {
    eventSlug,
    patch: { cfpPublished: true },
  });
  const proposalId = await bob.mutation(api.cfp.startProposal, { eventSlug });
  await bob.mutation(api.cfp.saveAnswers, {
    proposalId,
    answers: {
      firstName: "Carol",
      lastName: "Speaker",
      email: "carol@example.com",
      talkTitle: "Convex in anger",
      abstract: "Everything we learned shipping a reactive backend.",
    },
  });
  await bob.mutation(api.cfp.setSpeakers, {
    proposalId,
    speakers: [
      {
        firstName: "Carol",
        lastName: "Speaker",
        email: "carol@example.com",
        isPrimary: true,
      },
    ],
  });
  await bob.mutation(api.cfp.submitProposal, { proposalId });
  await alice.mutation(api.sessions.setStatus, {
    eventSlug,
    proposalIds: [proposalId],
    to: "acceptQueue",
  });
  await alice.mutation(api.sessions.release, {
    eventSlug,
    proposalIds: [proposalId],
  });
  const sessionId = await t.run(async (ctx) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId))
      .first();
    if (session === null) throw new Error("no session");
    return session._id;
  });
  return { alice, bob, orgSlug, eventSlug, proposalId, sessionId };
}

describe("portal.enter (verified-email auto-claim)", () => {
  test("links only the matching unclaimed snapshot on this event", async () => {
    const t = setupTest();
    const { eventSlug, eventContactId } = await directSetup(t);

    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });

    const context = await dana.query(api.portal.context, { eventSlug });
    expect(context.hasAccess).toBe(true);
    expect(context.event).toMatchObject({ name: "Acme Summit" });
    expect(context.speaking).toHaveLength(1);
    expect(context.speaking[0]).toMatchObject({
      sessionTitle: "Opening keynote",
      sessionDescription: "How we got here.",
      format: "Keynote",
      state: "awaiting",
    });
    expect(context.speaking[0].eventContact).toMatchObject({
      _id: eventContactId,
      firstName: "Dana",
      lastName: "Keynote",
      headshotUrl: null,
    });
    // A directly invited speaker manages nothing and owns no proposals.
    expect(context.managing).toEqual([]);
    expect(context.myProposalsSummary).toEqual([]);

    expect(await eventContact(t, eventContactId)).toMatchObject({
      userId: await userIdFor(t, "dana"),
    });
    const claims = (await auditRows(t)).filter(
      (row) => row.action === "portal.claim",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].viaAgent).toBe(false);

    // Re-entering is idempotent: no second claim row.
    await dana.mutation(api.portal.enter, { eventSlug });
    expect(
      (await auditRows(t)).filter((row) => row.action === "portal.claim"),
    ).toHaveLength(1);
  });

  test("a snapshot with a split tagline still loads the portal", async () => {
    // Regression: snapshot time splits "Title, Company" into structured
    // jobTitle/company (2c55f84), and `portal.context`'s returns validator
    // rejected the extra fields — every speaker whose tagline split saw
    // "This portal could not be loaded" (Aug 2026 eval).
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Opening keynote",
      speaker: {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
        tagline: "Principal Engineer, Acme",
      },
    });

    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });
    const context = await dana.query(api.portal.context, { eventSlug });
    expect(context.speaking[0].eventContact).toMatchObject({
      tagline: "Principal Engineer, Acme",
      jobTitle: "Principal Engineer",
      company: "Acme",
    });

    // A full-profile save must round-trip the structured fields, not clear
    // them (`updateMyProfile` treats omitted optionals as removals).
    await dana.mutation(api.portal.updateMyProfile, {
      eventSlug,
      eventContactId: context.speaking[0].eventContact._id,
      profile: {
        firstName: "Dana",
        lastName: "Keynote",
        tagline: "Principal Engineer, Acme",
        jobTitle: "Principal Engineer",
        company: "Acme",
      },
    });
    const after = await dana.query(api.portal.context, { eventSlug });
    expect(after.speaking[0].eventContact).toMatchObject({
      jobTitle: "Principal Engineer",
      company: "Acme",
    });
  });

  test("an unverified email can neither claim a snapshot nor complete a handoff", async () => {
    const t = setupTest();
    const { eventSlug, eventContactId } = await directSetup(t);

    // Absent claim (JWT template without email_verified) reads as unverified.
    const danaNoClaim = await signIn(t, "dana");
    await expectRejectedWith(
      danaNoClaim.mutation(api.portal.enter, { eventSlug }),
      "email_unverified",
    );
    // An explicit false claim — the attack: anyone can ADD dana@example.com
    // to their Clerk account without proving they own the mailbox.
    const danaUnverified = await signIn(t, "dana", { emailVerified: false });
    await expectRejectedWith(
      danaUnverified.mutation(api.portal.enter, { eventSlug }),
      "email_unverified",
    );
    expect((await eventContact(t, eventContactId)).userId).toBeUndefined();

    // Verifying the address unlocks the claim.
    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });
    expect((await eventContact(t, eventContactId)).userId).toBe(
      await userIdFor(t, "dana"),
    );
  });

  test("a signed-in stranger gets an empty portal, not an error", async () => {
    const t = setupTest();
    const { eventSlug, eventContactId } = await directSetup(t);

    const eve = await signIn(t, "eve", VERIFIED);
    await eve.mutation(api.portal.enter, { eventSlug });
    const context = await eve.query(api.portal.context, { eventSlug });
    expect(context.hasAccess).toBe(false);
    expect(context.speaking).toEqual([]);
    expect(context.managing).toEqual([]);
    // Dana's snapshot was NOT claimed by the stranger.
    expect((await eventContact(t, eventContactId)).userId).toBeUndefined();
  });
});

describe("portal.updateMyProfile", () => {
  test("attaches a valid photo immediately, refreshes linked records, and completes headshot evidence", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await directSetup(t);
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Speaker headshot",
      scope: "participant",
      evidence: "profileField",
      fieldKey: "headshot",
      reviewRequired: false,
      dueAt: Date.parse("2026-08-20T00:00:00Z"),
    });
    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });
    const storageId = await uploadPortalHeadshot(
      t,
      dana,
      eventSlug,
      eventContactId,
    );

    const context = await dana.query(api.portal.context, { eventSlug });
    expect(context.speaking[0].eventContact).toMatchObject({
      headshotId: storageId,
    });
    expect(context.speaking[0].eventContact.headshotUrl).toContain("http");
    const snapshot = await eventContact(t, eventContactId);
    const directory = await t.run(async (ctx) =>
      snapshot.contactId === undefined
        ? null
        : ctx.db.get("contacts", snapshot.contactId),
    );
    expect(snapshot.headshotId).toBe(storageId);
    expect(directory?.headshotId).toBe(storageId);
    expect(await alice.query(api.tasks.listInstances, { eventSlug })).toEqual([
      expect.objectContaining({ status: "complete" }),
    ]);
    expect(await auditActions(t)).toContain("portal.attachHeadshot");
  });

  test("removing an event photo preserves a newer cross-event directory photo", async () => {
    const t = setupTest();
    const { alice, orgSlug, eventSlug, eventContactId } = await directSetup(t);
    const otherSlug = await createEvent(alice, orgSlug, "Acme Winter");
    const { eventContactId: otherContactId } = await alice.mutation(
      api.sessions.createDirect,
      {
        eventSlug: otherSlug,
        title: "Winter fireside",
        speaker: {
          firstName: "Dana",
          lastName: "Keynote",
          email: "dana@example.com",
        },
      },
    );
    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });
    const oldEventPhoto = await uploadPortalHeadshot(
      t,
      dana,
      eventSlug,
      eventContactId,
    );
    await dana.mutation(api.portal.enter, { eventSlug: otherSlug });
    const newerDirectoryPhoto = await uploadPortalHeadshot(
      t,
      dana,
      otherSlug,
      otherContactId,
    );
    expect(newerDirectoryPhoto).not.toBe(oldEventPhoto);

    await dana.mutation(api.portal.removeMyHeadshot, {
      eventSlug,
      eventContactId,
    });

    const oldSnapshot = await eventContact(t, eventContactId);
    const otherSnapshot = await eventContact(t, otherContactId);
    const directory = await t.run(async (ctx) =>
      oldSnapshot.contactId === undefined
        ? null
        : ctx.db.get("contacts", oldSnapshot.contactId),
    );
    expect(oldSnapshot.headshotId).toBeUndefined();
    expect(otherSnapshot.headshotId).toBe(newerDirectoryPhoto);
    expect(directory?.headshotId).toBe(newerDirectoryPhoto);
  });

  test("refreshes the snapshot and the org directory, never another event", async () => {
    const t = setupTest();
    const { alice, orgSlug, eventSlug, eventContactId } = await directSetup(t);
    // The same person on a second event of the same org: one org contact,
    // two independent snapshots.
    const otherSlug = await createEvent(alice, orgSlug, "Acme Winter");
    const { eventContactId: otherContactId } = await alice.mutation(
      api.sessions.createDirect,
      {
        eventSlug: otherSlug,
        title: "Winter fireside",
        speaker: {
          firstName: "Dana",
          lastName: "Keynote",
          email: "dana@example.com",
        },
      },
    );

    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });
    await dana.mutation(api.portal.updateMyProfile, {
      eventSlug,
      eventContactId,
      profile: {
        firstName: "Dana",
        lastName: "Keynote",
        tagline: "  Principal Engineer, Acme  ",
        bio: "Twelve years of distributed systems.",
        links: { website: "https://dana.example" },
      },
    });

    const snapshot = await eventContact(t, eventContactId);
    expect(snapshot).toMatchObject({
      tagline: "Principal Engineer, Acme",
      bio: "Twelve years of distributed systems.",
      links: { website: "https://dana.example" },
    });

    // The org's current reusable profile followed the edit...
    const contacts = await t.run(async (ctx) =>
      ctx.db.query("contacts").collect(),
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      tagline: "Principal Engineer, Acme",
      bio: "Twelve years of distributed systems.",
    });
    expect(snapshot.contactId).toBe(contacts[0]._id);

    // ...but the other event's snapshot did not (MILESTONES M0/M3).
    const other = await eventContact(t, otherContactId);
    expect(other.tagline).toBeUndefined();
    expect(other.bio).toBeUndefined();

    expect(await auditActions(t)).toContain("portal.updateProfile");
  });

  test("rejects a profile link that isn't an http(s) URL", async () => {
    const t = setupTest();
    const { eventSlug, eventContactId } = await directSetup(t);
    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });

    // A javascript: scheme would become a clickable XSS vector on public pages
    // (M7), so it is refused rather than stored.
    await expectRejectedWith(
      dana.mutation(api.portal.updateMyProfile, {
        eventSlug,
        eventContactId,
        profile: {
          firstName: "Dana",
          lastName: "Keynote",
          links: { website: "javascript:alert(1)" },
        },
      }),
      "invalid_link",
    );
    // A bare host with no scheme is also refused.
    await expectRejectedWith(
      dana.mutation(api.portal.updateMyProfile, {
        eventSlug,
        eventContactId,
        profile: {
          firstName: "Dana",
          lastName: "Keynote",
          links: { twitter: "dana.example" },
        },
      }),
      "invalid_link",
    );
  });

  test("NEGATIVE: another user cannot edit, confirm, or upload for a claimed profile", async () => {
    const t = setupTest();
    const { eventSlug, sessionId, eventContactId } = await directSetup(t);
    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });
    const participantId = (await participantsOf(t, sessionId))[0]._id;

    const mallory = await signIn(t, "mallory", VERIFIED);
    await mallory.mutation(api.portal.enter, { eventSlug });

    for (const call of [
      mallory.mutation(api.portal.updateMyProfile, {
        eventSlug,
        eventContactId,
        profile: { firstName: "Mallory", lastName: "Malicious" },
      }),
      mallory.mutation(api.portal.beginHeadshotUpload, {
        eventSlug,
        eventContactId,
        contentType: "image/png",
        size: 10,
      }),
      mallory.mutation(api.portal.confirmParticipation, {
        eventSlug,
        participantId,
        to: "confirmed",
      }),
      mallory.mutation(api.portal.withdrawParticipation, {
        eventSlug,
        participantId,
      }),
      mallory.mutation(api.portal.updateSessionContent, {
        eventSlug,
        sessionId,
        patch: { title: "Hijacked" },
      }),
    ]) {
      // Ownership misses are not_found, never forbidden: ids must not be
      // probeable.
      await expectRejectedWith(call, "not_found");
    }
    expect((await participantsOf(t, sessionId))[0].state).toBe("awaiting");
    expect((await eventContact(t, eventContactId)).firstName).toBe("Dana");
  });
});

describe("participation state", () => {
  test("a speaker confirms their own participation", async () => {
    const t = setupTest();
    const { eventSlug, sessionId } = await directSetup(t);
    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });
    const participantId = (await participantsOf(t, sessionId))[0]._id;

    await dana.mutation(api.portal.confirmParticipation, {
      eventSlug,
      participantId,
      to: "confirmed",
    });

    const participant = (await participantsOf(t, sessionId))[0];
    expect(participant.state).toBe("confirmed");
    expect(participant.stateSetBy).toBe(await userIdFor(t, "dana"));
    expect(participant.stateSetAt).toBeGreaterThan(0);

    const entry = (await auditRows(t)).find(
      (row) => row.action === "participation.setState",
    );
    expect(entry?.meta).toMatchObject({
      from: "awaiting",
      to: "confirmed",
      onBehalf: false,
    });

    // Confirmed → declined is a legitimate change of mind.
    await dana.mutation(api.portal.confirmParticipation, {
      eventSlug,
      participantId,
      to: "declined",
    });
    expect((await participantsOf(t, sessionId))[0].state).toBe("declined");
  });

  test("the primary manager confirms on behalf of their speaker", async () => {
    const t = setupTest();
    const { bob, eventSlug, sessionId, proposalId } =
      await acceptedProposalSetup(t);
    await bob.mutation(api.portal.enter, { eventSlug });

    const context = await bob.query(api.portal.context, { eventSlug });
    expect(context.hasAccess).toBe(true);
    // Bob speaks at nothing; he manages the session his proposal became.
    expect(context.speaking).toEqual([]);
    expect(context.managing).toHaveLength(1);
    expect(context.managing[0]).toMatchObject({
      sessionId,
      title: "Convex in anger",
      source: "cfp",
      status: "planned",
      viaProposalId: proposalId,
    });
    // Co-speaker rows carry a name and a state — never contact details.
    expect(context.managing[0].participants).toEqual([
      {
        participantId: (await participantsOf(t, sessionId))[0]._id,
        firstName: "Carol",
        lastName: "Speaker",
        state: "awaiting",
      },
    ]);
    expect(context.myProposalsSummary).toEqual([
      { proposalId, title: "Convex in anger", status: "accepted" },
    ]);

    const participantId = context.managing[0].participants[0].participantId;
    await bob.mutation(api.portal.confirmParticipation, {
      eventSlug,
      participantId,
      to: "confirmed",
    });

    const participant = (await participantsOf(t, sessionId))[0];
    expect(participant.state).toBe("confirmed");
    expect(participant.stateSetBy).toBe(await userIdFor(t, "bob"));
    const entry = (await auditRows(t)).find(
      (row) => row.action === "participation.setState",
    );
    // Carol never signed in, so this was recorded on her behalf (M3).
    expect(entry?.meta).toMatchObject({ to: "confirmed", onBehalf: true });
  });

  test("an organizer can record and reset a decision", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await directSetup(t);
    const participantId = (await participantsOf(t, sessionId))[0]._id;

    await alice.mutation(api.sessions.setParticipationState, {
      eventSlug,
      participantId,
      to: "declined",
    });
    expect((await participantsOf(t, sessionId))[0]).toMatchObject({
      state: "declined",
      stateSetBy: await userIdFor(t, "alice"),
    });

    // Only organizers may reset to Awaiting Response.
    await alice.mutation(api.sessions.setParticipationState, {
      eventSlug,
      participantId,
      to: "awaiting",
    });
    expect((await participantsOf(t, sessionId))[0].state).toBe("awaiting");

    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    await expectRejectedWith(
      rita.mutation(api.sessions.setParticipationState, {
        eventSlug,
        participantId,
        to: "confirmed",
      }),
      "forbidden",
    );
  });

  test("a withdrawn participation can no longer be confirmed", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await directSetup(t);
    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });
    const participantId = (await participantsOf(t, sessionId))[0]._id;

    await dana.mutation(api.portal.withdrawParticipation, {
      eventSlug,
      participantId,
    });
    await expectRejectedWith(
      dana.mutation(api.portal.confirmParticipation, {
        eventSlug,
        participantId,
        to: "confirmed",
      }),
      "invalid_state",
    );
    await expectRejectedWith(
      alice.mutation(api.sessions.setParticipationState, {
        eventSlug,
        participantId,
        to: "awaiting",
      }),
      "invalid_state",
    );
  });
});

describe("portal.withdrawParticipation", () => {
  test("alerts organizers, keeps the session planned, and is idempotent", async () => {
    const t = setupTest();
    const { eventSlug, sessionId } = await directSetup(t);
    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });
    const participantId = (await participantsOf(t, sessionId))[0]._id;

    await dana.mutation(api.portal.withdrawParticipation, {
      eventSlug,
      participantId,
    });

    const participant = (await participantsOf(t, sessionId))[0];
    expect(participant.state).toBe("withdrawn");
    expect(participant.stateSetBy).toBe(await userIdFor(t, "dana"));

    const alerts = (await messageRows(t)).filter(
      (m) => m.kind === "portal.withdrawal",
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].toEmail).toBe("alice@example.com");
    expect(alerts[0].subject).toBe(
      "Withdrawal: Dana Keynote — Opening keynote",
    );
    expect(await auditActions(t)).toContain("portal.withdraw");

    // The session itself is never auto-cancelled (MILESTONES M3).
    const session = await t.run(async (ctx) =>
      ctx.db.get("sessions", sessionId),
    );
    expect(session?.status).toBe("planned");

    // A second withdrawal must not alert the organizers again.
    await dana.mutation(api.portal.withdrawParticipation, {
      eventSlug,
      participantId,
    });
    expect(
      (await messageRows(t)).filter((m) => m.kind === "portal.withdrawal"),
    ).toHaveLength(1);
  });
});

describe("published blob follows privacy transitions", () => {
  /** Publish the lineup + the session so the blob carries Dana's profile. */
  async function publishDana(t: TestT) {
    const { alice, eventSlug, sessionId } = await directSetup(t);
    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });
    const participantId = (await participantsOf(t, sessionId))[0]._id;
    await dana.mutation(api.portal.confirmParticipation, {
      eventSlug,
      participantId,
      to: "confirmed",
    });
    await alice.mutation(api.sessions.setContentStatus, {
      eventSlug,
      sessionId,
      to: "approved",
    });
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId,
      published: true,
    });
    const program = (await servedProgram(t, eventSlug))!;
    expect(JSON.stringify(program)).toContain("Dana Keynote");
    return { alice, dana, eventSlug, sessionId, participantId };
  }

  async function publishedVersion(t: TestT): Promise<number> {
    return await t.run(async (ctx) => {
      const rows = await ctx.db.query("publishedPrograms").collect();
      expect(rows).toHaveLength(1);
      return rows[0].version;
    });
  }

  test("a withdrawal rewrites the served blob without an explicit republish", async () => {
    const t = setupTest();
    const { dana, eventSlug, participantId } = await publishDana(t);
    const before = await publishedVersion(t);

    // The withdrawal alert promises "their name and profile are suppressed
    // from public output" — no explicit republish may be required for that.
    // The withdrawal mutation itself only QUEUES the rewrite (a speaker's click
    // must not rebuild the whole program), but it queues it unconditionally, so
    // draining the scheduler is all it takes.
    await dana.mutation(api.portal.withdrawParticipation, {
      eventSlug,
      participantId,
    });
    // Before the queued rebuild runs the blob is still the old one — the
    // suppression is pending, not lost...
    expect(await publishedVersion(t)).toBe(before);
    // ...and once it runs, Dana is gone from the public program.
    const program = (await servedProgram(t, eventSlug))!;
    expect(JSON.stringify(program)).not.toContain("Dana");
    expect(program.lineup).toHaveLength(1);
    expect(program.lineup[0].toBeAnnounced).toBe(true);
    expect(await publishedVersion(t)).toBe(before + 1);
  });

  test("a decline (portal or organizer) rewrites the served blob", async () => {
    const t = setupTest();
    const { alice, eventSlug, participantId } = await publishDana(t);

    // Organizer records the decline on Dana's behalf.
    await alice.mutation(api.sessions.setParticipationState, {
      eventSlug,
      participantId,
      to: "declined",
    });
    const program = (await servedProgram(t, eventSlug))!;
    expect(JSON.stringify(program)).not.toContain("Dana");
    expect(program.lineup[0].toBeAnnounced).toBe(true);
  });

  test("a portal decline rewrites the served blob too", async () => {
    const t = setupTest();
    const { dana, eventSlug, participantId } = await publishDana(t);

    // Same suppression, recorded by the speaker themself in the portal — the
    // other scheduled privacy path in model/portal.ts.
    await dana.mutation(api.portal.confirmParticipation, {
      eventSlug,
      participantId,
      to: "declined",
    });
    const program = (await servedProgram(t, eventSlug))!;
    expect(JSON.stringify(program)).not.toContain("Dana");
    expect(program.lineup[0].toBeAnnounced).toBe(true);
  });

  test("a decline on a never-published event publishes nothing", async () => {
    const t = setupTest();
    const { eventSlug, sessionId } = await directSetup(t);
    const dana = await signIn(t, "dana", VERIFIED);
    await dana.mutation(api.portal.enter, { eventSlug });
    await dana.mutation(api.portal.confirmParticipation, {
      eventSlug,
      participantId: (await participantsOf(t, sessionId))[0]._id,
      to: "declined",
    });
    // Even after the queued rebuild runs: a never-published event stays
    // unpublished (only an explicit publish may create the row).
    await drainScheduled(t);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("publishedPrograms").collect(),
    );
    expect(rows).toEqual([]);
  });
});

describe("manager backstage audience", () => {
  test("the manager sees the backstage link only once a speaker confirmed", async () => {
    const t = setupTest();
    const { bob, eventSlug, sessionId } = await acceptedProposalSetup(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionId, {
        virtualLinks: { backstage: "https://backstage.example/room" },
      });
    });
    await bob.mutation(api.portal.enter, { eventSlug });

    // Carol is still awaiting → no backstage for the manager either (M6:
    // "Confirmed participants and their primary managers").
    let context = await bob.query(api.portal.context, { eventSlug });
    expect(context.managing).toHaveLength(1);
    expect(context.managing[0].backstageUrl).toBeUndefined();

    await bob.mutation(api.portal.confirmParticipation, {
      eventSlug,
      participantId: context.managing[0].participants[0].participantId,
      to: "confirmed",
    });
    context = await bob.query(api.portal.context, { eventSlug });
    expect(context.managing[0].backstageUrl).toBe(
      "https://backstage.example/room",
    );
  });
});

describe("portal.updateSessionContent", () => {
  test("the primary manager edits shared session content", async () => {
    const t = setupTest();
    const { bob, eventSlug, sessionId } = await acceptedProposalSetup(t);
    await bob.mutation(api.portal.enter, { eventSlug });

    await bob.mutation(api.portal.updateSessionContent, {
      eventSlug,
      sessionId,
      patch: {
        title: "  Convex in anger, revisited  ",
        description: "A rewrite of the abstract.",
        format: "Workshop",
      },
    });

    const session = await t.run(async (ctx) =>
      ctx.db.get("sessions", sessionId),
    );
    expect(session).toMatchObject({
      title: "Convex in anger, revisited",
      description: "A rewrite of the abstract.",
      format: "Workshop",
    });
    expect(await auditActions(t)).toContain("portal.updateSession");

    // The speaker is not the manager here: content stays the manager's.
    const carol = await signIn(t, "carol", VERIFIED);
    await carol.mutation(api.portal.enter, { eventSlug });
    expect(
      (await carol.query(api.portal.context, { eventSlug })).managing,
    ).toEqual([]);
    await expectRejectedWith(
      carol.mutation(api.portal.updateSessionContent, {
        eventSlug,
        sessionId,
        patch: { title: "Mine now" },
      }),
      "not_found",
    );
    // ...but she does own her own participation.
    await carol.mutation(api.portal.confirmParticipation, {
      eventSlug,
      participantId: (await participantsOf(t, sessionId))[0]._id,
      to: "confirmed",
    });
    expect((await participantsOf(t, sessionId))[0].state).toBe("confirmed");
  });
});

describe("manager handoff", () => {
  test("completes on entry, moves management, and drops the old manager", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, sessionId } = await acceptedProposalSetup(t);
    await bob.mutation(api.portal.enter, { eventSlug });
    expect(
      (await bob.query(api.portal.context, { eventSlug })).managing,
    ).toHaveLength(1);

    await alice.mutation(api.sessions.startManagerHandoff, {
      eventSlug,
      sessionId,
      email: "  Mona@Example.com ",
    });
    const invites = (await messageRows(t)).filter(
      (m) => m.kind === "portal.handoffInvite",
    );
    expect(invites).toHaveLength(1);
    expect(invites[0].toEmail).toBe("mona@example.com");
    expect(await auditActions(t)).toContain("portal.handoffStarted");
    // The current manager keeps access until acceptance (MILESTONES M3).
    expect(
      (await bob.query(api.portal.context, { eventSlug })).managing,
    ).toHaveLength(1);

    const mona = await signIn(t, "mona", VERIFIED);
    await mona.mutation(api.portal.enter, { eventSlug });

    const monaId = await userIdFor(t, "mona");
    expect((await participantsOf(t, sessionId))[0].managerUserId).toBe(monaId);
    const handoffs = await handoffRows(t);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      status: "completed",
      completedBy: monaId,
    });
    expect(handoffs[0].completedAt).toBeGreaterThan(0);

    expect(
      (await mona.query(api.portal.context, { eventSlug })).managing,
    ).toHaveLength(1);
    // The previous manager loses the session even though his accepted
    // proposal is still his.
    const bobContext = await bob.query(api.portal.context, { eventSlug });
    expect(bobContext.managing).toEqual([]);
    expect(bobContext.myProposalsSummary).toHaveLength(1);

    const notices = (await messageRows(t)).filter(
      (m) => m.kind === "portal.handoffCompleted",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].toEmail).toBe("alice@example.com");
    expect(await auditActions(t)).toContain("portal.handoffCompleted");
  });

  test("an unverified invitee cannot complete a pending handoff", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await acceptedProposalSetup(t);
    const bobId = await userIdFor(t, "bob");
    await alice.mutation(api.sessions.startManagerHandoff, {
      eventSlug,
      sessionId,
      email: "mona@example.com",
    });

    const mona = await signIn(t, "mona"); // no email_verified claim
    await expectRejectedWith(
      mona.mutation(api.portal.enter, { eventSlug }),
      "email_unverified",
    );
    expect((await participantsOf(t, sessionId))[0].managerUserId).toBe(bobId);
    expect((await handoffRows(t))[0].status).toBe("pending");
  });

  test("an expired or revoked handoff never completes", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, sessionId } = await acceptedProposalSetup(t);
    const bobId = await userIdFor(t, "bob");

    const handoffId = await alice.mutation(api.sessions.startManagerHandoff, {
      eventSlug,
      sessionId,
      email: "mona@example.com",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch("managerHandoffs", handoffId, {
        expiresAt: Date.now() - 1000,
      });
    });

    const mona = await signIn(t, "mona", VERIFIED);
    await mona.mutation(api.portal.enter, { eventSlug });
    expect((await participantsOf(t, sessionId))[0].managerUserId).toBe(bobId);
    expect((await handoffRows(t))[0].status).toBe("pending");
    expect(
      (await mona.query(api.portal.context, { eventSlug })).hasAccess,
    ).toBe(false);

    // Revoking is the organizer's escape hatch, and a re-send supersedes the
    // live invitation rather than adding a second one.
    await alice.mutation(api.sessions.revokeHandoff, { eventSlug, handoffId });
    expect((await handoffRows(t))[0].status).toBe("revoked");
    await expectRejectedWith(
      alice.mutation(api.sessions.revokeHandoff, { eventSlug, handoffId }),
      "invalid_status",
    );

    await alice.mutation(api.sessions.startManagerHandoff, {
      eventSlug,
      sessionId,
      email: "mona@example.com",
    });
    await alice.mutation(api.sessions.startManagerHandoff, {
      eventSlug,
      sessionId,
      email: "nina@example.com",
    });
    const live = (await handoffRows(t)).filter((h) => h.status === "pending");
    expect(live).toHaveLength(1);
    expect(live[0].email).toBe("nina@example.com");
    expect(await bob.query(api.portal.context, { eventSlug })).toMatchObject({
      hasAccess: true,
    });
  });
});

describe("sessions.invitePortal", () => {
  test("emails the speaker a claim link, and refuses a contact with no email", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await directSetup(t);

    await alice.mutation(api.sessions.invitePortal, {
      eventSlug,
      eventContactId,
    });
    const invites = (await messageRows(t)).filter(
      (m) => m.kind === "portal.invite",
    );
    expect(invites).toHaveLength(1);
    expect(invites[0].toEmail).toBe("dana@example.com");
    expect(invites[0].subject).toBe("Your speaker portal for Acme Summit");
    expect(await auditActions(t)).toContain("portal.invite");

    const bareId = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      return await ctx.db.insert("eventContacts", {
        eventId: event!._id,
        orgId: event!.orgId,
        firstName: "No",
        lastName: "Mail",
      });
    });
    await expectRejectedWith(
      alice.mutation(api.sessions.invitePortal, {
        eventSlug,
        eventContactId: bareId,
      }),
      "invalid_email",
    );
  });
});

describe("sessions.previewPortalContext", () => {
  test("organizers preview a speaker's view; reviewers cannot", async () => {
    const t = setupTest();
    const { alice, orgSlug, eventSlug, eventContactId } = await directSetup(t);

    const preview = await alice.query(api.sessions.previewPortalContext, {
      eventSlug,
      eventContactId,
    });
    expect(preview.contactName).toBe("Dana Keynote");
    expect(preview.hasAccess).toBe(true);
    expect(preview.speaking).toHaveLength(1);
    expect(preview.speaking[0].sessionTitle).toBe("Opening keynote");
    // An unclaimed snapshot has no account behind it, so nothing is managed.
    expect(preview.managing).toEqual([]);
    expect(preview.myProposalsSummary).toEqual([]);

    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    await expectRejectedWith(
      rita.query(api.sessions.previewPortalContext, {
        eventSlug,
        eventContactId,
      }),
      "forbidden",
    );

    // A snapshot from a different event is not previewable here.
    const otherSlug = await createEvent(alice, orgSlug, "Acme Winter");
    const { eventContactId: otherContactId } = await alice.mutation(
      api.sessions.createDirect,
      {
        eventSlug: otherSlug,
        title: "Winter fireside",
        speaker: {
          firstName: "Otto",
          lastName: "Other",
          email: "otto@example.com",
        },
      },
    );
    await expectRejectedWith(
      alice.query(api.sessions.previewPortalContext, {
        eventSlug,
        eventContactId: otherContactId,
      }),
      "not_found",
    );
  });
});
