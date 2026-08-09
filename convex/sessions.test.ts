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

// Decisions & sessions (M2). The two rules worth breaking the build over:
// queue placement never reaches the submitter, and a corrected acceptance
// cancels its session instead of deleting it.

const ANSWERS: Record<string, string> = {
  firstName: "Bob",
  lastName: "Speaker",
  email: "bob@example.com",
  talkTitle: "Convex in anger",
  abstract: "Everything we learned shipping a reactive backend.",
};

async function messageRows(t: TestT) {
  return await t.run(async (ctx) => ctx.db.query("messages").collect());
}

async function sessionRows(t: TestT) {
  return await t.run(async (ctx) => ctx.db.query("sessions").collect());
}

async function participantRows(t: TestT) {
  return await t.run(async (ctx) =>
    ctx.db.query("sessionParticipants").collect(),
  );
}

async function proposalStatus(
  t: TestT,
  proposalId: Id<"proposals">,
): Promise<string> {
  return await t.run(async (ctx) => {
    const row = await ctx.db.get("proposals", proposalId);
    if (row === null) throw new Error("no proposal");
    return row.status;
  });
}

/** One organizer, one submitted proposal, one submitter. */
async function submittedProposal(t: TestT) {
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
  await alice.mutation(api.cfp.publishForm, { eventSlug });
  await alice.mutation(api.events.updateSettings, {
    eventSlug,
    patch: { cfpPublished: true },
  });
  const proposalId = await bob.mutation(api.cfp.startProposal, { eventSlug });
  await bob.mutation(api.cfp.saveAnswers, { proposalId, answers: ANSWERS });
  await bob.mutation(api.cfp.setSpeakers, {
    proposalId,
    speakers: [
      {
        firstName: "Bob",
        lastName: "Speaker",
        email: "bob@example.com",
        tagline: "CTO, Acme",
        isPrimary: true,
      },
    ],
  });
  await bob.mutation(api.cfp.submitProposal, { proposalId });
  return { alice, bob, orgSlug, eventSlug, proposalId };
}

async function stage(
  as: TestUserT,
  eventSlug: string,
  proposalId: Id<"proposals">,
  to: "acceptQueue" | "declineQueue" | "pending",
) {
  return await as.mutation(api.sessions.setStatus, {
    eventSlug,
    proposalIds: [proposalId],
    to,
  });
}

describe("sessions.setStatus (staging)", () => {
  test("staging is invisible to the submitter and never emails them", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await submittedProposal(t);
    const before = (await messageRows(t)).length;

    const results = await stage(alice, eventSlug, proposalId, "acceptQueue");
    expect(results).toEqual([{ proposalId, ok: true }]);

    // The organizer sees the true status...
    const listed = await alice.query(api.cfp.listProposals, { eventSlug });
    expect(listed[0].proposal.status).toBe("acceptQueue");
    expect(await proposalStatus(t, proposalId)).toBe("acceptQueue");

    // ...the submitter sees "pending" — THE masking rule (MILESTONES M2).
    const mine = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(mine.proposal.status).toBe("pending");
    expect(
      (await bob.query(api.cfp.myProposals, {}))[0].proposal.status,
    ).toBe("pending");

    // Nothing was sent.
    expect(await messageRows(t)).toHaveLength(before);
    expect(await auditActions(t)).toContain("decision.stage");
  });

  test("editing a queued proposal drops the staged decision and notifies organizers", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await submittedProposal(t);
    await stage(alice, eventSlug, proposalId, "acceptQueue");
    const before = (await messageRows(t)).length;

    // Editing stays allowed while queued...
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { ...ANSWERS, abstract: "Now with more detail." },
    });
    // ...and invalidates the staged verdict.
    expect(await proposalStatus(t, proposalId)).toBe("pending");
    const notices = (await messageRows(t)).slice(before);
    expect(notices).toHaveLength(1);
    expect(notices[0].toEmail).toBe("alice@example.com");
    expect(notices[0].subject).toBe(
      "Updated proposal for Acme Summit: Convex in anger",
    );
    expect(await auditActions(t)).toContain("decision.unstaged");

    // Releasing now correctly refuses: there is no staged decision left.
    const released = await alice.mutation(api.sessions.release, {
      eventSlug,
      proposalIds: [proposalId],
    });
    expect(released).toEqual([
      { proposalId, ok: false, error: "invalid_status" },
    ]);
  });

  test("a queued proposal can still be withdrawn, which removes it from the queue", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await submittedProposal(t);
    await stage(alice, eventSlug, proposalId, "declineQueue");
    await bob.mutation(api.cfp.withdrawProposal, { proposalId });
    expect(await proposalStatus(t, proposalId)).toBe("withdrawn");
  });

  test("draft and withdrawn proposals come back as per-id errors", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await submittedProposal(t);
    const draftId = await bob.mutation(api.cfp.startProposal, { eventSlug });

    const results = await alice.mutation(api.sessions.setStatus, {
      eventSlug,
      proposalIds: [proposalId, draftId],
      to: "acceptQueue",
    });
    expect(results).toEqual([
      { proposalId, ok: true },
      { proposalId: draftId, ok: false, error: "invalid_status" },
    ]);
  });

  test("NEGATIVE: a reviewer cannot stage or release", async () => {
    const t = setupTest();
    const { eventSlug, proposalId } = await submittedProposal(t);
    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");

    await expectRejectedWith(
      stage(rita, eventSlug, proposalId, "acceptQueue"),
      "forbidden",
    );
    await expectRejectedWith(
      rita.mutation(api.sessions.release, {
        eventSlug,
        proposalIds: [proposalId],
      }),
      "forbidden",
    );
  });
});

describe("sessions.release", () => {
  test("accept: session + snapshots + participants + org contact + email", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await submittedProposal(t);
    await stage(alice, eventSlug, proposalId, "acceptQueue");

    const results = await alice.mutation(api.sessions.release, {
      eventSlug,
      proposalIds: [proposalId],
    });
    expect(results).toEqual([{ proposalId, ok: true }]);
    expect(await proposalStatus(t, proposalId)).toBe("accepted");
    // Now that it's released, the submitter sees the real decision.
    expect(
      (await bob.query(api.cfp.getMyProposal, { proposalId })).proposal.status,
    ).toBe("accepted");

    const sessions = await sessionRows(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      title: "Convex in anger",
      description: ANSWERS.abstract,
      source: "cfp",
      status: "planned",
      proposalId,
    });

    // Event snapshot copied from the proposal speaker, linked to a new org
    // directory contact.
    const contacts = await t.run(async (ctx) => ({
      event: await ctx.db.query("eventContacts").collect(),
      org: await ctx.db.query("contacts").collect(),
    }));
    expect(contacts.event).toHaveLength(1);
    expect(contacts.event[0]).toMatchObject({
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
      tagline: "CTO, Acme",
    });
    expect(contacts.org).toHaveLength(1);
    expect(contacts.event[0].contactId).toBe(contacts.org[0]._id);

    const participants = await participantRows(t);
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({
      state: "awaiting",
      role: "speaker",
      sessionId: sessions[0]._id,
    });

    const accepted = (await messageRows(t)).filter(
      (m) => m.kind === "decision.accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].toEmail).toBe("bob@example.com");
    expect(accepted[0].subject).toBe(
      "Your proposal was accepted: Convex in anger",
    );

    // The organizer's session list joins participants to their snapshots.
    const listed = await alice.query(api.sessions.list, { eventSlug });
    expect(listed).toHaveLength(1);
    expect(listed[0].participants).toEqual([
      {
        participantId: participants[0]._id,
        eventContactId: contacts.event[0]._id,
        firstName: "Bob",
        lastName: "Speaker",
        role: "speaker",
        state: "awaiting",
      },
    ]);
    expect(await auditActions(t)).toContain("decision.release");
  });

  test("decline: status + email, and no session is created", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalId } = await submittedProposal(t);
    await stage(alice, eventSlug, proposalId, "declineQueue");
    await alice.mutation(api.sessions.release, {
      eventSlug,
      proposalIds: [proposalId],
    });

    expect(await proposalStatus(t, proposalId)).toBe("declined");
    expect(await sessionRows(t)).toEqual([]);
    const declined = (await messageRows(t)).filter(
      (m) => m.kind === "decision.declined",
    );
    expect(declined).toHaveLength(1);
    expect(declined[0].subject).toBe("About your proposal: Convex in anger");
  });

  test("a non-queued id fails alone; the rest of the batch still releases", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await submittedProposal(t);
    // A second, still-pending proposal from the same submitter.
    const pendingId = await bob.mutation(api.cfp.startProposal, { eventSlug });
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId: pendingId,
      answers: { ...ANSWERS, talkTitle: "Second talk" },
    });
    await bob.mutation(api.cfp.setSpeakers, {
      proposalId: pendingId,
      speakers: [{ firstName: "Bob", lastName: "Speaker", isPrimary: true }],
    });
    await bob.mutation(api.cfp.submitProposal, { proposalId: pendingId });
    await stage(alice, eventSlug, proposalId, "acceptQueue");

    const results = await alice.mutation(api.sessions.release, {
      eventSlug,
      proposalIds: [pendingId, proposalId],
    });
    expect(results).toEqual([
      { proposalId: pendingId, ok: false, error: "invalid_status" },
      { proposalId, ok: true },
    ]);
    expect(await proposalStatus(t, pendingId)).toBe("pending");
    expect(await proposalStatus(t, proposalId)).toBe("accepted");
    expect(await sessionRows(t)).toHaveLength(1);
  });
});

describe("sessions.correct", () => {
  async function accepted(t: TestT) {
    const ctx = await submittedProposal(t);
    await stage(ctx.alice, ctx.eventSlug, ctx.proposalId, "acceptQueue");
    await ctx.alice.mutation(api.sessions.release, {
      eventSlug: ctx.eventSlug,
      proposalIds: [ctx.proposalId],
    });
    return ctx;
  }

  test("accepted → declined cancels the session instead of deleting it", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalId } = await accepted(t);
    const sessionId = (await sessionRows(t))[0]._id;

    await alice.mutation(api.sessions.correct, {
      eventSlug,
      proposalId: proposalId,
      to: "declined",
      note: "We double-booked the slot and have to withdraw the acceptance.",
    });

    expect(await proposalStatus(t, proposalId)).toBe("declined");
    const sessions = await sessionRows(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]._id).toBe(sessionId);
    expect(sessions[0].status).toBe("cancelled");
    expect(sessions[0].cancelledAt).toBeGreaterThan(0);
    // Participants are retained so the correction stays reversible.
    expect(await participantRows(t)).toHaveLength(1);

    const corrections = (await messageRows(t)).filter(
      (m) => m.kind === "decision.corrected",
    );
    expect(corrections).toHaveLength(1);
    expect(corrections[0].subject).toBe(
      "Correction about your proposal: Convex in anger",
    );
    const audits = await auditActions(t);
    expect(audits).toContain("decision.correct");
    // Both decisions survive in the trail.
    expect(audits.filter((a) => a.startsWith("decision."))).toEqual(
      expect.arrayContaining([
        "decision.stage",
        "decision.release",
        "decision.correct",
      ]),
    );
  });

  test("declined → accepted restores the same session and resets participants", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalId } = await accepted(t);
    const sessionId = (await sessionRows(t))[0]._id;
    // A speaker had already confirmed before the mistaken decline.
    await t.run(async (ctx) => {
      const participant = await ctx.db.query("sessionParticipants").first();
      await ctx.db.patch("sessionParticipants", participant!._id, {
        state: "confirmed",
      });
    });

    await alice.mutation(api.sessions.correct, {
      eventSlug,
      proposalId: proposalId,
      to: "declined",
      note: "Sent in error.",
    });
    await alice.mutation(api.sessions.correct, {
      eventSlug,
      proposalId: proposalId,
      to: "accepted",
      note: "Reinstated — the decline was ours, not yours.",
    });

    expect(await proposalStatus(t, proposalId)).toBe("accepted");
    const sessions = await sessionRows(t);
    // Restored, not duplicated.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]._id).toBe(sessionId);
    expect(sessions[0].status).toBe("planned");
    expect(sessions[0].cancelledAt).toBeUndefined();

    const participants = await participantRows(t);
    expect(participants).toHaveLength(1);
    // Fresh confirmation is required after a restore (MILESTONES M2).
    expect(participants[0].state).toBe("awaiting");
    expect(participants[0].stateSetAt).toBeGreaterThan(0);
  });

  test("rejects a same-value correction, an undecided proposal, and an empty note", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalId } = await accepted(t);

    await expectRejectedWith(
      alice.mutation(api.sessions.correct, {
        eventSlug,
        proposalId: proposalId,
        to: "accepted",
        note: "No change.",
      }),
      "invalid_status",
    );
    await expectRejectedWith(
      alice.mutation(api.sessions.correct, {
        eventSlug,
        proposalId: proposalId,
        to: "declined",
        note: "   ",
      }),
      "invalid_note",
    );

    const bob = await signIn(t, "bob");
    const pendingId = await bob.mutation(api.cfp.startProposal, { eventSlug });
    await expectRejectedWith(
      alice.mutation(api.sessions.correct, {
        eventSlug,
        proposalId: pendingId,
        to: "declined",
        note: "Not decided yet.",
      }),
      "invalid_status",
    );
  });
});

describe("sessions.createDirect", () => {
  test("creates a session, snapshot, awaiting participant and invitation email", async () => {
    const t = setupTest();
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
          email: "  Dana@Example.COM ",
          tagline: "Principal Engineer",
        },
      },
    );

    const sessions = await sessionRows(t);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      _id: sessionId,
      title: "Opening keynote",
      source: "direct",
      status: "planned",
    });
    expect(sessions[0].proposalId).toBeUndefined();

    const contacts = await t.run(async (ctx) => ({
      event: await ctx.db.query("eventContacts").collect(),
      org: await ctx.db.query("contacts").collect(),
    }));
    expect(contacts.event[0]._id).toBe(eventContactId);
    expect(contacts.event[0].email).toBe("dana@example.com");
    expect(contacts.org).toHaveLength(1);

    const participants = await participantRows(t);
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({
      state: "awaiting",
      role: "speaker",
    });
    expect(participants[0].managerUserId).toBeUndefined();

    const invites = (await messageRows(t)).filter(
      (m) => m.kind === "invitation.direct",
    );
    expect(invites).toHaveLength(1);
    expect(invites[0].toEmail).toBe("dana@example.com");
    expect(invites[0].subject).toBe("Invitation to speak at Acme Summit");
    expect(await auditActions(t)).toContain("session.directInvite");

    // A second session for the same person reuses the snapshot.
    await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Closing panel",
      speaker: {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("eventContacts").collect()),
    ).toHaveLength(1);
    expect(await participantRows(t)).toHaveLength(2);
  });

  test("NEGATIVE: a reviewer cannot create a direct session, and a bad email is refused", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");

    await expectRejectedWith(
      rita.mutation(api.sessions.createDirect, {
        eventSlug,
        title: "Sneaky session",
        speaker: {
          firstName: "Rita",
          lastName: "Reviewer",
          email: "rita@example.com",
        },
      }),
      "forbidden",
    );
    await expectRejectedWith(
      alice.mutation(api.sessions.createDirect, {
        eventSlug,
        title: "Bad email",
        speaker: { firstName: "No", lastName: "Mail", email: "nope" },
      }),
      "invalid_email",
    );
    expect(await sessionRows(t)).toEqual([]);
  });
});

describe("archived events", () => {
  test("M2 writes are refused while reads and un-archiving keep working", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalId } = await submittedProposal(t);
    await stage(alice, eventSlug, proposalId, "acceptQueue");
    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    const ritaId = await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_tokenIdentifier", (q) =>
          q.eq("tokenIdentifier", "https://test.clerk.example.com|rita"),
        )
        .unique();
      return user!._id;
    });

    await alice.mutation(api.events.setArchived, { eventSlug, archived: true });

    for (const call of [
      alice.mutation(api.sessions.release, {
        eventSlug,
        proposalIds: [proposalId],
      }),
      alice.mutation(api.sessions.setStatus, {
        eventSlug,
        proposalIds: [proposalId],
        to: "pending",
      }),
      alice.mutation(api.sessions.createDirect, {
        eventSlug,
        title: "Nope",
        speaker: {
          firstName: "Dana",
          lastName: "Keynote",
          email: "dana@example.com",
        },
      }),
      alice.mutation(api.reviews.assign, {
        eventSlug,
        proposalIds: [proposalId],
        reviewerUserId: ritaId,
      }),
    ]) {
      await expectRejectedWith(call, "event_archived");
    }

    // Reads still work...
    expect(await alice.query(api.sessions.list, { eventSlug })).toEqual([]);
    expect(await alice.query(api.reviews.progress, { eventSlug })).toEqual({});
    // ...and archiving itself is not an M2 write, so it can be undone.
    await alice.mutation(api.events.setArchived, { eventSlug, archived: false });
    expect(
      await alice.mutation(api.sessions.release, {
        eventSlug,
        proposalIds: [proposalId],
      }),
    ).toEqual([{ proposalId, ok: true }]);
  });
});
