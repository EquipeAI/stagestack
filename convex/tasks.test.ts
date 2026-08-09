import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
  type TestT,
  type TestUserT,
} from "./test.helpers";

// Speaker ops: tasks & readiness (M4). The rules worth breaking the build over:
// requirements instantiate concrete obligations (on creation AND on every later
// release), evidence is observed rather than judged, only organizers operate
// the review gate, uploads are versioned and approval is version-specific, and
// readiness is derived from those rows with its reasons exposed.

const DUE = Date.parse("2026-08-20T00:00:00Z");
const NOW = Date.parse("2026-08-01T00:00:00Z");
const LATER = Date.parse("2026-08-25T00:00:00Z");

// ── Reading the raw tables ───────────────────────────────────────────────

async function instanceRows(t: TestT): Promise<Array<Doc<"taskInstances">>> {
  return await t.run(async (ctx) => ctx.db.query("taskInstances").collect());
}

async function uploadRows(t: TestT): Promise<Array<Doc<"uploads">>> {
  return await t.run(async (ctx) => ctx.db.query("uploads").collect());
}

async function messageRows(t: TestT): Promise<Array<Doc<"messages">>> {
  return await t.run(async (ctx) => ctx.db.query("messages").collect());
}

async function auditActions(t: TestT): Promise<string[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("auditLog").collect();
    return rows.map((r) => r.action);
  });
}

async function participantsOf(t: TestT, sessionId: Id<"sessions">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("sessionParticipants")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .collect(),
  );
}

async function storeBlob(t: TestT): Promise<Id<"_storage">> {
  return await t.run(async (ctx) => ctx.storage.store(new Blob(["file"])));
}

async function userIdFor(t: TestT, key: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", `https://test.clerk.example.com|${key}`),
      )
      .unique();
    if (user === null) throw new Error(`no user ${key}`);
    return user._id;
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────

/** An organizer with an event, ready for direct invitations. */
async function eventSetup(t: TestT) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
  return { alice, orgSlug, eventSlug };
}

async function inviteSpeaker(
  alice: TestUserT,
  eventSlug: string,
  speaker: {
    firstName: string;
    lastName: string;
    email: string;
    bio?: string;
  },
  title: string,
) {
  return await alice.mutation(api.sessions.createDirect, {
    eventSlug,
    title,
    speaker,
  });
}

/**
 * A released CFP acceptance with TWO speakers: `bob` submitted (so he is the
 * primary manager of a session he does not appear in), `carol` and `dave`
 * present it.
 */
async function acceptedTwoSpeakers(t: TestT, eventSlug: string) {
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
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
      {
        firstName: "Dave",
        lastName: "Cospeaker",
        email: "dave@example.com",
        isPrimary: false,
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
  return { alice, bob, sessionId };
}

async function manualRequirement(
  alice: TestUserT,
  eventSlug: string,
  extra: { reviewRequired?: boolean; title?: string } = {},
) {
  return await alice.mutation(api.tasks.createRequirement, {
    eventSlug,
    title: extra.title ?? "Sign the speaker release",
    scope: "participant",
    evidence: "manual",
    reviewRequired: extra.reviewRequired ?? false,
    dueAt: DUE,
  });
}

// ── Instantiation ────────────────────────────────────────────────────────

describe("requirement creation", () => {
  test("backfills every existing participant and evaluates profile evidence", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
        bio: "Dana has shipped things.",
      },
      "Opening keynote",
    );
    const evan = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Evan", lastName: "Newcomer", email: "evan@example.com" },
      "Closing talk",
    );

    const { instances } = await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Speaker bio",
      description: "150 words, third person.",
      scope: "participant",
      evidence: "profileField",
      fieldKey: "bio",
      reviewRequired: false,
      dueAt: DUE,
    });
    expect(instances).toBe(2);

    const rows = await alice.query(api.tasks.listInstances, { eventSlug });
    expect(rows).toHaveLength(2);
    // Dana already has a bio: the requirement is satisfied the moment it is
    // defined, and (no review gate) that means terminal `complete`.
    expect(rows.find((r) => r.speakerName === "Dana Keynote")).toMatchObject({
      status: "complete",
      requirementTitle: "Speaker bio",
      sessionTitle: "Opening keynote",
      dueAt: DUE,
    });
    expect(rows.find((r) => r.speakerName === "Evan Newcomer")).toMatchObject({
      status: "pending",
      sessionTitle: "Closing talk",
      eventContactId: evan.eventContactId,
    });

    expect(await auditActions(t)).toContain("task.requirementCreate");
  });

  test("participant scope is per speaker, session scope is per session", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { sessionId } = await acceptedTwoSpeakers(t, eventSlug);
    expect(await participantsOf(t, sessionId)).toHaveLength(2);

    const perSpeaker = await manualRequirement(alice, eventSlug, {
      title: "Travel details",
    });
    expect(perSpeaker.instances).toBe(2);

    const perSession = await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Final slide deck",
      scope: "session",
      evidence: "file",
      reviewRequired: false,
      dueAt: DUE,
    });
    expect(perSession.instances).toBe(1);

    const rows = await alice.query(api.tasks.listInstances, { eventSlug });
    const deck = rows.filter((r) => r.requirementTitle === "Final slide deck");
    expect(deck).toHaveLength(1);
    // One shared obligation: no participantId (its identity is per session).
    expect(deck[0].participantId).toBeUndefined();
    // Fix 6: it still carries an accountable assignee (a represented speaker's
    // snapshot, routing the shared obligation to the primary manager) so a
    // self-managed speaker can see it and the overdue audience keeps it.
    expect(deck[0].eventContactId).toBeDefined();
    expect(["Carol Speaker", "Dave Cospeaker"]).toContain(deck[0].speakerName);

    const travel = rows.filter((r) => r.requirementTitle === "Travel details");
    expect(travel.map((r) => r.speakerName).sort()).toEqual([
      "Carol Speaker",
      "Dave Cospeaker",
    ]);
  });

  test("a later acceptance release instantiates the active requirements", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    // Requirement defined FIRST, with nothing to attach to yet.
    const { instances } = await manualRequirement(alice, eventSlug);
    expect(instances).toBe(0);

    await acceptedTwoSpeakers(t, eventSlug);
    expect(await instanceRows(t)).toHaveLength(2);

    // And a direct invitation released afterwards gets one too.
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    expect(await instanceRows(t)).toHaveLength(3);
  });

  test("deactivating stops future instantiation but keeps existing work", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { requirementId } = await manualRequirement(alice, eventSlug);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    expect(await instanceRows(t)).toHaveLength(1);

    await alice.mutation(api.tasks.updateRequirement, {
      eventSlug,
      requirementId,
      patch: { active: false },
    });
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Evan", lastName: "Newcomer", email: "evan@example.com" },
      "Closing talk",
    );
    expect(await instanceRows(t)).toHaveLength(1);
  });

  test("a due-date change spares instances with an override", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { requirementId } = await manualRequirement(alice, eventSlug);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Evan", lastName: "Newcomer", email: "evan@example.com" },
      "Closing talk",
    );
    const rows = await alice.query(api.tasks.listInstances, { eventSlug });
    const dana = rows.find((r) => r.speakerName === "Dana Keynote")!;
    const override = Date.parse("2026-09-10T00:00:00Z");
    await alice.mutation(api.tasks.setInstanceDue, {
      eventSlug,
      instanceId: dana.instanceId,
      dueAt: override,
    });

    const { repropagated } = await alice.mutation(api.tasks.updateRequirement, {
      eventSlug,
      requirementId,
      patch: { dueAt: LATER },
    });
    expect(repropagated).toBe(1);

    const after = await alice.query(api.tasks.listInstances, { eventSlug });
    expect(
      after.find((r) => r.speakerName === "Dana Keynote")?.dueAt,
    ).toBe(override);
    expect(
      after.find((r) => r.speakerName === "Evan Newcomer")?.dueAt,
    ).toBe(LATER);
  });

  test("a profile-field requirement must name a known field", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await expectRejectedWith(
      alice.mutation(api.tasks.createRequirement, {
        eventSlug,
        title: "Something",
        scope: "participant",
        evidence: "profileField",
        fieldKey: "shoeSize",
        reviewRequired: false,
        dueAt: DUE,
      }),
      "invalid_field_key",
    );
  });
});

// ── Manual completion ────────────────────────────────────────────────────

describe("manual completion", () => {
  test("the organizer, the claimed speaker and the manager may all complete it", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { bob } = await acceptedTwoSpeakers(t, eventSlug);
    await manualRequirement(alice, eventSlug);
    const carol = await signIn(t, "carol");
    await carol.mutation(api.portal.enter, { eventSlug });

    const rows = await alice.query(api.tasks.listInstances, { eventSlug });
    const carolTask = rows.find((r) => r.speakerName === "Carol Speaker")!;
    const daveTask = rows.find((r) => r.speakerName === "Dave Cospeaker")!;

    // 1. The speaker themself, through the portal.
    await carol.mutation(api.portal.completeTask, {
      eventSlug,
      instanceId: carolTask.instanceId,
    });
    // 2. The primary manager, on the other speaker's behalf.
    await bob.mutation(api.portal.completeTask, {
      eventSlug,
      instanceId: daveTask.instanceId,
    });

    const after = await alice.query(api.tasks.listInstances, { eventSlug });
    const carolAfter = after.find((r) => r.instanceId === carolTask.instanceId)!;
    const daveAfter = after.find((r) => r.instanceId === daveTask.instanceId)!;
    // No review gate, so "provided" IS complete.
    expect(carolAfter.status).toBe("complete");
    expect(carolAfter.completedBy).toBe(await userIdFor(t, "carol"));
    expect(daveAfter.status).toBe("complete");
    // The manager did the work; the task is still owed BY Dave.
    expect(daveAfter.completedBy).toBe(await userIdFor(t, "bob"));
    expect(daveAfter.speakerName).toBe("Dave Cospeaker");

    // 3. The organizer, on a fresh instance.
    await alice.mutation(api.tasks.reopen, {
      eventSlug,
      instanceId: daveTask.instanceId,
    });
    await alice.mutation(api.tasks.markProvided, {
      eventSlug,
      instanceId: daveTask.instanceId,
    });
    const final = (await alice.query(api.tasks.listInstances, { eventSlug }))
      .find((r) => r.instanceId === daveTask.instanceId)!;
    expect(final.status).toBe("complete");
    expect(final.completedBy).toBe(await userIdFor(t, "alice"));
  });

  test("a stranger cannot see or complete someone else's task", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await acceptedTwoSpeakers(t, eventSlug);
    await manualRequirement(alice, eventSlug);
    const rows = await alice.query(api.tasks.listInstances, { eventSlug });

    const mallory = await signIn(t, "mallory");
    await mallory.mutation(api.portal.enter, { eventSlug });
    // Ownership misses read as not_found so task ids stay unprobeable.
    await expectRejectedWith(
      mallory.mutation(api.portal.completeTask, {
        eventSlug,
        instanceId: rows[0].instanceId,
      }),
      "not_found",
    );
    expect(await mallory.query(api.portal.myTasks, { eventSlug })).toEqual([]);
  });

  test("manual completion is refused on file evidence", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Slides",
      scope: "participant",
      evidence: "file",
      reviewRequired: false,
      dueAt: DUE,
    });
    const rows = await alice.query(api.tasks.listInstances, { eventSlug });
    await expectRejectedWith(
      alice.mutation(api.tasks.markProvided, {
        eventSlug,
        instanceId: rows[0].instanceId,
      }),
      "invalid_evidence",
    );
  });
});

// ── Profile-field evidence ───────────────────────────────────────────────

describe("profile-field evidence", () => {
  test("a portal profile edit provides and un-provides the task", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Headshot",
      scope: "participant",
      evidence: "profileField",
      fieldKey: "headshot",
      reviewRequired: false,
      dueAt: DUE,
    });
    const statusNow = async (): Promise<string> =>
      (await alice.query(api.tasks.listInstances, { eventSlug }))[0].status;
    expect(await statusNow()).toBe("pending");

    const dana = await signIn(t, "dana");
    await dana.mutation(api.portal.enter, { eventSlug });
    const headshotId = await storeBlob(t);
    await dana.mutation(api.portal.updateMyProfile, {
      eventSlug,
      eventContactId,
      profile: { firstName: "Dana", lastName: "Keynote", headshotId },
    });
    expect(await statusNow()).toBe("complete");

    // Removing the field is a genuine removal, not a review decision — the
    // obligation comes back.
    await dana.mutation(api.portal.updateMyProfile, {
      eventSlug,
      eventContactId,
      profile: { firstName: "Dana", lastName: "Keynote" },
    });
    expect(await statusNow()).toBe("pending");
  });

  test("filling in a bio satisfies a bio requirement", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Speaker bio",
      scope: "participant",
      evidence: "profileField",
      fieldKey: "bio",
      reviewRequired: false,
      dueAt: DUE,
    });
    const dana = await signIn(t, "dana");
    await dana.mutation(api.portal.enter, { eventSlug });
    await dana.mutation(api.portal.updateMyProfile, {
      eventSlug,
      eventContactId,
      profile: {
        firstName: "Dana",
        lastName: "Keynote",
        bio: "Dana builds reactive backends.",
      },
    });
    const rows = await alice.query(api.tasks.listInstances, { eventSlug });
    expect(rows[0].status).toBe("complete");
  });
});

// ── Review gate ──────────────────────────────────────────────────────────

describe("organizer review", () => {
  test("provided → approved, and a change request needs a note and notifies", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await manualRequirement(alice, eventSlug, { reviewRequired: true });
    const dana = await signIn(t, "dana");
    await dana.mutation(api.portal.enter, { eventSlug });
    const instanceId = (
      await alice.query(api.tasks.listInstances, { eventSlug })
    )[0].instanceId;

    await dana.mutation(api.portal.completeTask, { eventSlug, instanceId });
    let rows = await alice.query(api.tasks.listInstances, { eventSlug });
    // With review enabled, observation parks at "provided" — never a claim
    // that the work is any good.
    expect(rows[0].status).toBe("provided");

    await alice.mutation(api.tasks.approve, { eventSlug, instanceId });
    rows = await alice.query(api.tasks.listInstances, { eventSlug });
    expect(rows[0].status).toBe("approved");

    await expectRejectedWith(
      alice.mutation(api.tasks.requestChanges, {
        eventSlug,
        instanceId,
        note: "   ",
      }),
      "invalid_note",
    );

    await alice.mutation(api.tasks.requestChanges, {
      eventSlug,
      instanceId,
      note: "Please use the current release form.",
    });
    rows = await alice.query(api.tasks.listInstances, { eventSlug });
    expect(rows[0]).toMatchObject({
      status: "changesRequested",
      reviewNote: "Please use the current release form.",
    });

    const notice = (await messageRows(t)).find(
      (m) => m.kind === "task.changesRequested",
    );
    expect(notice).toBeDefined();
    // The claimed speaker is the responsible person here.
    expect(notice?.toEmail).toBe("dana@example.com");

    const actions = await auditActions(t);
    expect(actions).toContain("task.approve");
    expect(actions).toContain("task.requestChanges");
  });

  test("only organizers operate the review gate", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await manualRequirement(alice, eventSlug, { reviewRequired: true });
    const instanceId = (
      await alice.query(api.tasks.listInstances, { eventSlug })
    )[0].instanceId;

    const erin = await signIn(t, "erin");
    await grantEventRole(t, eventSlug, "erin", "reviewer");
    await expectRejectedWith(
      erin.mutation(api.tasks.createRequirement, {
        eventSlug,
        title: "Nope",
        scope: "participant",
        evidence: "manual",
        reviewRequired: false,
        dueAt: DUE,
      }),
      "forbidden",
    );
    await expectRejectedWith(
      erin.mutation(api.tasks.approve, { eventSlug, instanceId }),
      "forbidden",
    );
    await expectRejectedWith(
      erin.mutation(api.tasks.markNotApplicable, {
        eventSlug,
        instanceId,
        reason: "nope",
      }),
      "forbidden",
    );
  });
});

// ── Not applicable ───────────────────────────────────────────────────────

describe("not applicable", () => {
  test("requires a reason and counts as satisfied", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await manualRequirement(alice, eventSlug);
    const instanceId = (
      await alice.query(api.tasks.listInstances, { eventSlug })
    )[0].instanceId;

    await expectRejectedWith(
      alice.mutation(api.tasks.markNotApplicable, {
        eventSlug,
        instanceId,
        reason: "",
      }),
      "invalid_reason",
    );

    await alice.mutation(api.tasks.markNotApplicable, {
      eventSlug,
      instanceId,
      reason: "Local speaker — no travel form needed.",
    });
    const rows = await alice.query(api.tasks.listInstances, { eventSlug });
    expect(rows[0]).toMatchObject({
      status: "notApplicable",
      naReason: "Local speaker — no travel form needed.",
    });
    expect(await auditActions(t)).toContain("task.markNotApplicable");

    const board = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: NOW,
    });
    expect(board.speakers[0].outstandingTasks).toBe(0);
  });
});

// ── Versioned uploads ────────────────────────────────────────────────────

describe("file evidence", () => {
  test("a new version returns an approved task to review and keeps the old rows", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Signed release",
      scope: "participant",
      evidence: "file",
      reviewRequired: true,
      dueAt: DUE,
    });
    const dana = await signIn(t, "dana");
    await dana.mutation(api.portal.enter, { eventSlug });
    const instanceId = (
      await alice.query(api.tasks.listInstances, { eventSlug })
    )[0].instanceId;

    const v1 = await dana.mutation(api.portal.uploadForTask, {
      eventSlug,
      instanceId,
      storageId: await storeBlob(t),
      filename: "release-v1.pdf",
    });
    expect(v1.version).toBe(1);
    expect(
      (await alice.query(api.tasks.listInstances, { eventSlug }))[0].status,
    ).toBe("provided");

    await alice.mutation(api.tasks.approve, { eventSlug, instanceId });
    expect(
      (await alice.query(api.tasks.listInstances, { eventSlug }))[0].status,
    ).toBe("approved");

    const v2 = await dana.mutation(api.portal.uploadForTask, {
      eventSlug,
      instanceId,
      storageId: await storeBlob(t),
      filename: "release-v2.pdf",
    });
    expect(v2.version).toBe(2);
    // Approval is version-specific: the replacement is unreviewed.
    expect(
      (await alice.query(api.tasks.listInstances, { eventSlug }))[0],
    ).toMatchObject({ status: "provided", uploadCount: 2 });

    // Prior file, its actor and its approval all survive.
    const stored = await uploadRows(t);
    expect(stored).toHaveLength(2);
    expect(stored.find((u) => u.version === 1)?.approvedAt).toBeTypeOf(
      "number",
    );
    expect(stored.find((u) => u.version === 2)?.approvedAt).toBeUndefined();

    const listed = await alice.query(api.tasks.listUploads, {
      eventSlug,
      instanceId,
    });
    expect(listed.map((u) => u.filename)).toEqual([
      "release-v2.pdf",
      "release-v1.pdf",
    ]);
  });
});

// ── Portal task list ─────────────────────────────────────────────────────

describe("portal.myTasks", () => {
  test("shows the caller's own tasks and the ones they manage", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { bob } = await acceptedTwoSpeakers(t, eventSlug);
    await manualRequirement(alice, eventSlug);

    const carol = await signIn(t, "carol");
    await carol.mutation(api.portal.enter, { eventSlug });
    const mine = await carol.query(api.portal.myTasks, { eventSlug });
    expect(mine).toHaveLength(1);
    // Their own task carries no "on behalf of" name.
    expect(mine[0]).toMatchObject({
      requirementTitle: "Sign the speaker release",
      evidence: "manual",
      scope: "participant",
      status: "pending",
      sessionTitle: "Convex in anger",
      forSpeaker: null,
      uploads: [],
    });

    // The manager sees both speakers' obligations, named.
    const managed = await bob.query(api.portal.myTasks, { eventSlug });
    expect(managed).toHaveLength(2);
    expect(
      managed.map((task) => task.forSpeaker?.firstName).sort(),
    ).toEqual(["Carol", "Dave"]);
  });
});

// ── Readiness ────────────────────────────────────────────────────────────

describe("session readiness", () => {
  test("an unanswered invitation needs attention, with the reason exposed", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    const board = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: NOW,
    });
    expect(board.sessions).toHaveLength(1);
    expect(board.sessions[0].readiness.status).toBe("needsAttention");
    expect(board.sessions[0].readiness.reasons.join(" ")).toContain(
      "not answered their invitation",
    );
    expect(board.totals.awaiting).toBe(1);
  });

  test("a withdrawn sole speaker blocks the session", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { sessionId } = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    const dana = await signIn(t, "dana");
    await dana.mutation(api.portal.enter, { eventSlug });
    const [participant] = await participantsOf(t, sessionId);
    await dana.mutation(api.portal.withdrawParticipation, {
      eventSlug,
      participantId: participant._id,
    });

    const board = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: NOW,
    });
    const readiness = board.sessions[0].readiness;
    expect(readiness.status).toBe("blocked");
    expect(readiness.reasons.join(" ")).toContain("withdrawn");
    expect(readiness.reasons.join(" ")).toContain("No speaker is attached");
    expect(board.totals.withdrawn).toBe(1);
  });

  test("confirmed speakers with settled tasks read as ready", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { sessionId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
        bio: "Dana has shipped things.",
      },
      "Opening keynote",
    );
    await manualRequirement(alice, eventSlug);
    const [participant] = await participantsOf(t, sessionId);
    await alice.mutation(api.sessions.setParticipationState, {
      eventSlug,
      participantId: participant._id,
      to: "confirmed",
    });
    const instanceId = (
      await alice.query(api.tasks.listInstances, { eventSlug })
    )[0].instanceId;
    await alice.mutation(api.tasks.markProvided, { eventSlug, instanceId });

    const board = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: NOW,
    });
    expect(board.sessions[0].readiness).toEqual({
      status: "ready",
      reasons: [],
    });
    expect(board.totals.confirmed).toBe(1);
  });

  test("an overdue task raises urgency without changing the status vocabulary", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await manualRequirement(alice, eventSlug);
    // `now` is an argument, so "overdue" is whatever the client's clock says.
    const board = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: LATER,
    });
    expect(board.totals.overdue).toBe(1);
    expect(board.speakers[0].overdueTasks).toBe(1);
    expect(board.sessions[0].readiness.reasons.join(" ")).toContain("overdue");
  });
});

// ── Dashboard ────────────────────────────────────────────────────────────

describe("speaker-tracking dashboard", () => {
  test("counts the speakers missing a bio or a headshot", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
        bio: "Dana has shipped things.",
      },
      "Opening keynote",
    );
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Evan", lastName: "Newcomer", email: "evan@example.com" },
      "Closing talk",
    );

    const board = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: NOW,
    });
    expect(board.totals.acceptedSpeakers).toBe(2);
    // Neither has a headshot; only Evan is missing a bio.
    expect(board.totals.missingProfile).toBe(2);
    const dana = board.speakers.find((s) => s.name === "Dana Keynote")!;
    const evan = board.speakers.find((s) => s.name === "Evan Newcomer")!;
    expect(dana).toMatchObject({
      missingBio: false,
      missingHeadshot: true,
      claimed: false,
      state: "awaiting",
    });
    expect(evan).toMatchObject({ missingBio: true, missingHeadshot: true });

    // Claiming portal access shows up immediately.
    const danaUser = await signIn(t, "dana");
    await danaUser.mutation(api.portal.enter, { eventSlug });
    const after = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: NOW,
    });
    expect(after.speakers.find((s) => s.name === "Dana Keynote")?.claimed).toBe(
      true,
    );
  });

  test("reviewers cannot read the dashboard", async () => {
    const t = setupTest();
    const { eventSlug } = await eventSetup(t);
    const erin = await signIn(t, "erin");
    await grantEventRole(t, eventSlug, "erin", "reviewer");
    await expectRejectedWith(
      erin.query(api.tasks.dashboard, { eventSlug, now: NOW }),
      "forbidden",
    );
  });
});
