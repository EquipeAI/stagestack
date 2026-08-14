import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { MAX_SPEAKER_CUSTOM_VALUES_BYTES } from "./model/speakers";
import { completeHeadshotContactPage } from "./model/tasks";
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

function portalHeadshotBlob(): Blob {
  const binary = atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" });
}

async function uploadPortalHeadshot(
  as: TestUserT,
  eventSlug: string,
  eventContactId: Id<"eventContacts">,
  filename: string,
): Promise<Id<"headshotUploads">> {
  const body = portalHeadshotBlob();
  const ticket = await as.mutation(api.portal.beginHeadshotUpload, {
    eventSlug,
    eventContactId,
    contentType: body.type,
    size: body.size,
    filename,
  });
  const response = await as.fetch(`/api/headshots/${ticket.uploadId}`, {
    method: "POST",
    headers: { "Content-Type": body.type },
    body,
  });
  expect(response.status).toBe(200);
  return ticket.uploadId;
}

async function attachPortalHeadshot(
  as: TestUserT,
  eventSlug: string,
  eventContactId: Id<"eventContacts">,
  filename = "headshot.png",
): Promise<Id<"headshotUploads">> {
  const uploadId = await uploadPortalHeadshot(
    as,
    eventSlug,
    eventContactId,
    filename,
  );
  await as.mutation(api.portal.attachHeadshot, {
    eventSlug,
    eventContactId,
    uploadId,
  });
  return uploadId;
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

  test("retrying an identical create returns the existing requirement, not a duplicate", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );

    const first = await manualRequirement(alice, eventSlug, {
      title: "Travel details",
    });
    expect(first.instances).toBe(1);
    // The double-submit / network retry: identical args, second call.
    const retry = await manualRequirement(alice, eventSlug, {
      title: "Travel details",
    });
    expect(retry.requirementId).toBe(first.requirementId);
    // Backfill already ran; the retry creates nothing new.
    expect(retry.instances).toBe(0);

    const requirements = await t.run(async (ctx) =>
      ctx.db.query("requirements").collect(),
    );
    expect(requirements).toHaveLength(1);
    expect(await instanceRows(t)).toHaveLength(1);

    // A genuinely different definition is NOT swallowed by the guard.
    const other = await manualRequirement(alice, eventSlug, {
      title: "Dietary preferences",
    });
    expect(other.requirementId).not.toBe(first.requirementId);
    expect(
      await t.run(async (ctx) => ctx.db.query("requirements").collect()),
    ).toHaveLength(2);
  });

  test("a speaker with two sessions owes a participant-scope task once", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    // Same email → same eventContact on both sessions (the Marcus scenario
    // from the Aug 2026 eval run).
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Marcus", lastName: "Doubles", email: "marcus@example.com" },
      "Morning talk",
    );
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Marcus", lastName: "Doubles", email: "marcus@example.com" },
      "Afternoon workshop",
    );

    // Backfill direction: the requirement lands on an existing two-session
    // speaker exactly once.
    const perSpeaker = await manualRequirement(alice, eventSlug, {
      title: "Travel details",
    });
    expect(perSpeaker.instances).toBe(1);

    // Session scope stays per session: two sessions, two deck obligations.
    const perSession = await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Final slide deck",
      scope: "session",
      evidence: "file",
      reviewRequired: false,
      dueAt: DUE,
    });
    expect(perSession.instances).toBe(2);

    // Release direction: a THIRD session for the same speaker instantiates the
    // session-scope requirement but not another speaker-level task…
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Marcus", lastName: "Doubles", email: "marcus@example.com" },
      "Evening panel",
    );
    const rows = await alice.query(api.tasks.listInstances, { eventSlug });
    expect(
      rows.filter((r) => r.requirementTitle === "Travel details"),
    ).toHaveLength(1);
    expect(
      rows.filter((r) => r.requirementTitle === "Final slide deck"),
    ).toHaveLength(3);

    // …while a different speaker still gets their own.
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Closing keynote",
    );
    const after = await alice.query(api.tasks.listInstances, { eventSlug });
    const travel = after.filter((r) => r.requirementTitle === "Travel details");
    expect(travel.map((r) => r.speakerName).sort()).toEqual([
      "Dana Keynote",
      "Marcus Doubles",
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
    expect(after.find((r) => r.speakerName === "Dana Keynote")?.dueAt).toBe(
      override,
    );
    expect(after.find((r) => r.speakerName === "Evan Newcomer")?.dueAt).toBe(
      LATER,
    );
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
    const carol = await signIn(t, "carol", { emailVerified: true });
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
    const carolAfter = after.find(
      (r) => r.instanceId === carolTask.instanceId,
    )!;
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
    const final = (
      await alice.query(api.tasks.listInstances, { eventSlug })
    ).find((r) => r.instanceId === daveTask.instanceId)!;
    expect(final.status).toBe("complete");
    expect(final.completedBy).toBe(await userIdFor(t, "alice"));
  });

  test("a stranger cannot see or complete someone else's task", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await acceptedTwoSpeakers(t, eventSlug);
    await manualRequirement(alice, eventSlug);
    const rows = await alice.query(api.tasks.listInstances, { eventSlug });

    const mallory = await signIn(t, "mallory", { emailVerified: true });
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

    const dana = await signIn(t, "dana", { emailVerified: true });
    await dana.mutation(api.portal.enter, { eventSlug });
    await attachPortalHeadshot(dana, eventSlug, eventContactId);
    expect(await statusNow()).toBe("complete");

    // Removing the field is a genuine removal, not a review decision — the
    // obligation comes back.
    await dana.mutation(api.portal.removeMyHeadshot, {
      eventSlug,
      eventContactId,
    });
    expect(await statusNow()).toBe("pending");
  });

  test("an organizer profile edit recomputes bio evidence", async () => {
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
    await alice.mutation(api.speakers.updateProfile, {
      eventSlug,
      eventContactId,
      patch: {
        bio: "Dana builds reactive backends.",
      },
    });
    const rows = await alice.query(api.tasks.listInstances, { eventSlug });
    expect(rows[0].status).toBe("complete");
  });
});

// ── Secure headshots in the organizer files library (SPK-10) ─────────────

describe("headshot files library", () => {
  test("retains safe source provenance and exposes a MIME-correct current download only to event organizers", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
      "Opening keynote",
    );
    const dana = await signIn(t, "dana", {
      emailVerified: true,
      name: undefined,
    });
    await dana.mutation(api.portal.enter, { eventSlug });

    const uploadId = await attachPortalHeadshot(
      dana,
      eventSlug,
      eventContactId,
      "headshot.png",
    );
    const ticket = await t.run(async (ctx) =>
      ctx.db.get("headshotUploads", uploadId),
    );
    expect(ticket).toMatchObject({
      originalFilename: "headshot.png",
      uploadedByUserId: await userIdFor(t, "dana"),
      status: "attached",
      sanitizedContentType: "image/webp",
    });
    expect(ticket?.attachedAt).toBeTypeOf("number");
    const metadata = await t.run(async (ctx) => {
      if (ticket?.storageId === undefined) throw new Error("no headshot blob");
      return await ctx.db.system.get(ticket.storageId);
    });
    expect(metadata?.contentType).toBe("image/webp");

    const [file] = await alice.query(api.tasks.filesLibraryV2, { eventSlug });
    expect(file).toMatchObject({
      fileId: `headshot:${eventContactId}`,
      kind: "headshot",
      instanceId: null,
      sessionId: null,
      requirementTitle: "Speaker headshot",
      sessionTitle: "Speaker profile",
      speakerName: "Dana Keynote",
      sourceFilename: "headshot.png",
      filename: "headshot.webp",
      version: 1,
      versionCount: 1,
      uploadedByName: "Dana Keynote",
      uploadedAt: ticket?.attachedAt,
      commentCount: 0,
    });
    expect(file.url).toMatch(/^https?:\/\//);

    const bundle = await alice.query(api.tasks.exportBundleV2, {
      eventSlug,
      fileIds: [file.fileId],
    });
    expect(bundle).toEqual([
      {
        filename: "headshot.webp",
        url: file.url,
        sessionTitle: "Speaker profile",
        speakerName: "Dana Keynote",
        requirementTitle: "Speaker headshot",
      },
    ]);

    const source = portalHeadshotBlob();
    await expectRejectedWith(
      dana.mutation(api.portal.beginHeadshotUpload, {
        eventSlug,
        eventContactId,
        contentType: source.type,
        size: source.size,
        filename: "../headshot.png",
      }),
      "invalid_headshot",
    );

    const reviewer = await signIn(t, "reviewer");
    await grantEventRole(t, eventSlug, "reviewer", "reviewer");
    await expectRejectedWith(
      reviewer.query(api.tasks.filesLibraryV2, { eventSlug }),
      "forbidden",
    );
    const bob = await signIn(t, "bob");
    const otherOrg = await createOrg(bob, "Other Events");
    const otherEvent = await createEvent(bob, otherOrg, "Other Summit");
    await expectRejectedWith(
      bob.query(api.tasks.filesLibraryV2, { eventSlug }),
      "forbidden",
    );
    expect(
      await bob.query(api.tasks.filesLibraryV2, { eventSlug: otherEvent }),
    ).toEqual([]);
  });

  test("lists only the current headshot while preserving attached version history and excluding discarded tickets", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
      "Opening keynote",
    );
    const dana = await signIn(t, "dana", {
      emailVerified: true,
      name: undefined,
    });
    await dana.mutation(api.portal.enter, { eventSlug });

    const firstId = await attachPortalHeadshot(
      dana,
      eventSlug,
      eventContactId,
      "headshot.png",
    );
    const source = portalHeadshotBlob();
    const discarded = await dana.mutation(api.portal.beginHeadshotUpload, {
      eventSlug,
      eventContactId,
      contentType: source.type,
      size: source.size,
      filename: "discarded.png",
    });
    await dana.mutation(api.portal.discardHeadshotUpload, {
      eventSlug,
      eventContactId,
      uploadId: discarded.uploadId,
    });
    const currentId = await attachPortalHeadshot(
      dana,
      eventSlug,
      eventContactId,
      "portrait.png",
    );

    const rows = await alice.query(api.tasks.filesLibraryV2, { eventSlug });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileId: `headshot:${eventContactId}`,
      sourceFilename: "portrait.png",
      filename: "portrait.webp",
      version: 2,
      versionCount: 2,
    });
    const tickets = await t.run(async (ctx) => ({
      first: await ctx.db.get("headshotUploads", firstId),
      discarded: await ctx.db.get("headshotUploads", discarded.uploadId),
      current: await ctx.db.get("headshotUploads", currentId),
    }));
    expect(tickets.first?.status).toBe("replaced");
    expect(tickets.first?.attachedAt).toBeTypeOf("number");
    expect(tickets.discarded).toMatchObject({
      status: "discarded",
      originalFilename: "discarded.png",
    });
    expect(tickets.discarded?.attachedAt).toBeUndefined();
    expect(tickets.current?.status).toBe("attached");
    expect(
      (
        await alice.query(api.tasks.exportBundleV2, { eventSlug, fileIds: [] })
      ).map((file) => file.filename),
    ).toEqual(["portrait.webp"]);
  });

  test("gives legacy headshots a safe WebP download name without inventing source provenance", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
      "Opening keynote",
    );
    const dana = await signIn(t, "dana", { emailVerified: true });
    await dana.mutation(api.portal.enter, { eventSlug });
    const uploadId = await attachPortalHeadshot(
      dana,
      eventSlug,
      eventContactId,
    );
    await t.run(async (ctx) => {
      await ctx.db.patch("headshotUploads", uploadId, {
        originalFilename: undefined,
      });
    });

    const [file] = await alice.query(api.tasks.filesLibraryV2, { eventSlug });
    expect(file).toMatchObject({
      sourceFilename: null,
      filename: "headshot.webp",
      version: 1,
      versionCount: 1,
      uploadedByName: "Dana Keynote",
    });
    expect(file.uploadedAt).toBeTypeOf("number");
    expect(file.url).toMatch(/^https?:\/\//);
  });

  test("lists copied and legacy current headshots without leaking provenance across events", async () => {
    const t = setupTest();
    const { alice, orgSlug, eventSlug: sourceEvent } = await eventSetup(t);
    const { eventContactId: sourceContactId } = await inviteSpeaker(
      alice,
      sourceEvent,
      {
        firstName: "Dana",
        lastName: "Source",
        email: "dana@example.com",
      },
      "Source session",
    );
    const dana = await signIn(t, "dana", {
      emailVerified: true,
      name: undefined,
    });
    await dana.mutation(api.portal.enter, { eventSlug: sourceEvent });
    const sourceUploadId = await attachPortalHeadshot(
      dana,
      sourceEvent,
      sourceContactId,
      "private-source.png",
    );
    const sourceTicket = await t.run(async (ctx) =>
      ctx.db.get("headshotUploads", sourceUploadId),
    );
    if (sourceTicket?.storageId === undefined) {
      throw new Error("source headshot was not stored");
    }

    const targetEvent = await createEvent(alice, orgSlug, "Target Summit");
    const { eventContactId: copiedContactId } = await inviteSpeaker(
      alice,
      targetEvent,
      {
        firstName: "Dana",
        lastName: "Copied",
        email: "dana@example.com",
      },
      "Copied profile session",
    );
    const { eventContactId: pngContactId } = await inviteSpeaker(
      alice,
      targetEvent,
      {
        firstName: "Lee",
        lastName: "Legacy PNG",
        email: "lee-png@example.com",
      },
      "Legacy PNG profile session",
    );
    const { eventContactId: jpegContactId } = await inviteSpeaker(
      alice,
      targetEvent,
      {
        firstName: "Jay",
        lastName: "Legacy JPEG",
        email: "jay-jpeg@example.com",
      },
      "Legacy JPEG profile session",
    );
    await t.run(async (ctx) => {
      const pngStorageId = await ctx.storage.store(
        new Blob(["legacy-png"], { type: "image/png" }),
      );
      const jpegStorageId = await ctx.storage.store(
        new Blob(["legacy-jpeg"], { type: "image/jpeg" }),
      );
      await ctx.db.patch("eventContacts", copiedContactId, {
        headshotId: sourceTicket.storageId,
      });
      await ctx.db.patch("eventContacts", pngContactId, {
        headshotId: pngStorageId,
      });
      await ctx.db.patch("eventContacts", jpegContactId, {
        headshotId: jpegStorageId,
      });
    });

    const [sourceFile] = await alice.query(api.tasks.filesLibraryV2, {
      eventSlug: sourceEvent,
    });
    expect(sourceFile).toMatchObject({
      sourceFilename: "private-source.png",
      uploadedByName: "Dana Source",
    });

    const targetFiles = await alice.query(api.tasks.filesLibraryV2, {
      eventSlug: targetEvent,
    });
    expect(targetFiles).toHaveLength(3);
    const byContact = new Map(targetFiles.map((file) => [file.fileId, file]));
    const expectedFilenames = new Map([
      [copiedContactId, "headshot.webp"],
      [pngContactId, "headshot.png"],
      [jpegContactId, "headshot.jpg"],
    ]);
    for (const [contactId, filename] of expectedFilenames) {
      const file = byContact.get(`headshot:${contactId}`);
      expect(file).toMatchObject({
        kind: "headshot",
        sourceFilename: null,
        filename,
        version: null,
        versionCount: null,
        uploadedByName: null,
        uploadedAt: null,
      });
      expect(file?.url).toMatch(/^https?:\/\//);
    }
    const copiedFile = byContact.get(`headshot:${copiedContactId}`);
    if (copiedFile === undefined) throw new Error("copied headshot missing");
    expect(
      await alice.query(api.tasks.exportBundleV2, {
        eventSlug: targetEvent,
        fileIds: [copiedFile.fileId],
      }),
    ).toEqual([
      {
        filename: "headshot.webp",
        url: copiedFile.url,
        sessionTitle: "Speaker profile",
        speakerName: "Dana Copied",
        requirementTitle: "Speaker headshot",
      },
    ]);
    expect(
      (
        await alice.query(api.tasks.exportBundleV2, {
          eventSlug: targetEvent,
          fileIds: targetFiles.map((file) => file.fileId),
        })
      )
        .map((file) => file.filename)
        .sort(),
    ).toEqual(["headshot.jpg", "headshot.png", "headshot.webp"]);
  });

  test("keeps unsupported or missing legacy storage visible but unavailable", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId: unsupportedContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Uma",
        lastName: "Unsupported",
        email: "uma@example.com",
      },
      "Unsupported profile session",
    );
    const { eventContactId: missingContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Mina",
        lastName: "Missing",
        email: "mina@example.com",
      },
      "Missing profile session",
    );
    await t.run(async (ctx) => {
      const unsupportedStorageId = await ctx.storage.store(
        new Blob(["not an image"], { type: "application/octet-stream" }),
      );
      const missingStorageId = await ctx.storage.store(
        new Blob(["deleted image"], { type: "image/png" }),
      );
      await ctx.storage.delete(missingStorageId);
      await ctx.db.patch("eventContacts", unsupportedContactId, {
        headshotId: unsupportedStorageId,
      });
      await ctx.db.patch("eventContacts", missingContactId, {
        headshotId: missingStorageId,
      });
    });

    const files = await alice.query(api.tasks.filesLibraryV2, { eventSlug });
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file).toMatchObject({
        kind: "headshot",
        sourceFilename: null,
        filename: "headshot",
        version: null,
        versionCount: null,
        uploadedByName: null,
        uploadedAt: null,
        url: null,
      });
    }
  });

  test("ignores more than 2,000 unattached ticket attempts while returning the current headshot", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
      "Opening keynote",
    );
    const dana = await signIn(t, "dana", { emailVerified: true });
    await dana.mutation(api.portal.enter, { eventSlug });
    await attachPortalHeadshot(dana, eventSlug, eventContactId, "current.png");
    const danaId = await userIdFor(t, "dana");
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("event missing");
      const irrelevantStatuses = ["pending", "discarded", "rejected"] as const;
      for (let index = 0; index < 2_001; index += 1) {
        await ctx.db.insert("headshotUploads", {
          orgId: event.orgId,
          eventId: event._id,
          eventContactId,
          uploadedByUserId: danaId,
          purpose: "speakerHeadshot",
          expectedContentType: "image/png",
          expectedSize: 1,
          originalFilename: `attempt-${index}.png`,
          status: irrelevantStatuses[index % irrelevantStatuses.length],
          createdAt: index,
          expiresAt: index + 1,
        });
      }
    });

    const rows = await alice.query(api.tasks.filesLibraryV2, { eventSlug });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileId: `headshot:${eventContactId}`,
      sourceFilename: "current.png",
      filename: "current.webp",
      version: 1,
      versionCount: 1,
      uploadedByName: "Dana Keynote",
    });
  });
});

describe("files library scaling", () => {
  test("treats a SplitRequired headshot page as incomplete", () => {
    expect(
      completeHeadshotContactPage({
        page: [],
        isDone: true,
        pageStatus: "SplitRequired",
      }),
    ).toBe(false);
    expect(
      completeHeadshotContactPage({
        page: [],
        isDone: true,
        pageStatus: "SplitRecommended",
      }),
    ).toBe(true);
  });

  test("batches 110 distinct actors and blobs, then rejects current file 121 honestly", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { sessionId, eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
      "Opening keynote",
    );
    const addScaleRows = async (start: number, end: number) => {
      await t.run(async (ctx) => {
        const event = await ctx.db
          .query("events")
          .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
          .unique();
        if (event === null) throw new Error("event missing");
        const existingRequirement = (
          await ctx.db
            .query("requirements")
            .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
            .take(10)
        ).find((requirement) => requirement.title === "Scale evidence");
        const requirementId =
          existingRequirement?._id ??
          (await ctx.db.insert("requirements", {
            eventId: event._id,
            title: "Scale evidence",
            scope: "participant",
            evidence: "file",
            reviewRequired: false,
            dueAt: DUE,
            active: true,
          }));
        for (let index = start; index < end; index += 1) {
          const uploadedBy = await ctx.db.insert("users", {
            tokenIdentifier: `scale-token-${index}`,
            clerkSubject: `scale-subject-${index}`,
            email: `scale-${index}@example.com`,
            name: `Scale User ${index}`,
          });
          const storageId = await ctx.storage.store(
            new Blob([`scale fixture ${index}`], {
              type: "application/pdf",
            }),
          );
          const instanceId = await ctx.db.insert("taskInstances", {
            requirementId,
            eventId: event._id,
            sessionId,
            eventContactId,
            status: "complete",
            dueAt: DUE,
            updatedAt: index,
          });
          await ctx.db.insert("uploads", {
            eventId: event._id,
            taskInstanceId: instanceId,
            storageId,
            filename: `scale-${index}.pdf`,
            version: 1,
            uploadedBy,
          });
        }
      });
    };

    await addScaleRows(0, 110);
    const rows = await alice.query(api.tasks.filesLibraryV2, { eventSlug });
    expect(rows).toHaveLength(110);
    expect(new Set(rows.map((row) => row.fileId)).size).toBe(110);
    expect(new Set(rows.map((row) => row.uploadedByName)).size).toBe(110);
    expect(new Set(rows.map((row) => row.url)).size).toBe(110);
    expect(rows.every((row) => row.requirementTitle === "Scale evidence")).toBe(
      true,
    );
    expect(rows.every((row) => row.sessionTitle === "Opening keynote")).toBe(
      true,
    );

    await addScaleRows(110, 121);
    await expectRejectedWith(
      alice.query(api.tasks.filesLibraryV2, { eventSlug }),
      "files_export_too_large",
    );
  });

  test("executes uploads, headshots, attached history, and comments in one files query", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
      "Opening keynote",
    );
    const dana = await signIn(t, "dana", { emailVerified: true });
    await dana.mutation(api.portal.enter, { eventSlug });
    await attachPortalHeadshot(dana, eventSlug, eventContactId, "headshot.png");
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Signed release",
      scope: "participant",
      evidence: "file",
      reviewRequired: false,
      dueAt: DUE,
    });
    const instanceId = (
      await alice.query(api.tasks.listInstances, { eventSlug })
    )[0].instanceId;
    await dana.mutation(api.portal.uploadForTask, {
      eventSlug,
      instanceId,
      storageId: await storeBlob(t),
      filename: "release.pdf",
    });
    await alice.mutation(api.tasks.commentOnTask, {
      eventSlug,
      instanceId,
      body: "Verified by production.",
    });

    const rows = await alice.query(api.tasks.filesLibraryV2, { eventSlug });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.kind).sort()).toEqual(["headshot", "task"]);
    expect(rows.find((row) => row.kind === "task")?.commentCount).toBe(1);
    expect(rows.find((row) => row.kind === "headshot")).toMatchObject({
      sourceFilename: "headshot.png",
      uploadedByName: "Dana Keynote",
    });
    const taskRow = rows.find((row) => row.kind === "task");
    if (
      taskRow?.instanceId === null ||
      taskRow?.sessionId === null ||
      taskRow?.version === null ||
      taskRow?.versionCount === null ||
      taskRow?.uploadedAt === null ||
      taskRow === undefined
    ) {
      throw new Error("task row missing");
    }
    expect(await alice.query(api.tasks.filesLibrary, { eventSlug })).toEqual([
      {
        instanceId: taskRow.instanceId,
        requirementTitle: "Signed release",
        sessionId: taskRow.sessionId,
        sessionTitle: "Opening keynote",
        speakerName: "Dana Keynote",
        filename: "release.pdf",
        version: taskRow.version,
        versionCount: taskRow.versionCount,
        uploadedAt: taskRow.uploadedAt,
        url: taskRow.url,
        commentCount: 1,
      },
    ]);
    expect(
      (
        await alice.query(api.tasks.exportBundle, {
          eventSlug,
          instanceIds: [],
        })
      ).map((file) => file.filename),
    ).toEqual(["release.pdf"]);
    expect(
      (
        await alice.query(api.tasks.exportBundle, {
          eventSlug,
          instanceIds: [instanceId],
        })
      ).map((file) => file.filename),
    ).toEqual(["release.pdf"]);
    expect(
      (
        await alice.query(api.tasks.exportBundleV2, {
          eventSlug,
          fileIds: [],
        })
      )
        .map((file) => file.filename)
        .sort(),
    ).toEqual(["headshot.webp", "release.pdf"]);
  });

  test("fails closed on max-sized contact payloads and headshot 65 without returning partial rows", async () => {
    const t = setupTest();
    const { alice, orgSlug } = await eventSetup(t);
    const payloadEvent = await createEvent(
      alice,
      orgSlug,
      "Payload Budget Summit",
    );
    const countEvent = await createEvent(
      alice,
      orgSlug,
      "Headshot Count Summit",
    );
    const allowedCustomValues = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `field-${index}`,
        "€".repeat(1_000),
      ]),
    );
    expect(
      new TextEncoder().encode(JSON.stringify(allowedCustomValues)).length,
    ).toBeLessThanOrEqual(MAX_SPEAKER_CUSTOM_VALUES_BYTES);

    await t.run(async (ctx) => {
      const payload = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", payloadEvent))
        .unique();
      const count = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", countEvent))
        .unique();
      if (payload === null || count === null) throw new Error("event missing");
      const storageId = await ctx.storage.store(
        new Blob(["legacy-png"], { type: "image/png" }),
      );
      for (let index = 0; index < 64; index += 1) {
        await ctx.db.insert("eventContacts", {
          eventId: payload._id,
          orgId: payload.orgId,
          firstName: `Payload ${index}`,
          lastName: "Speaker",
          bio: "b".repeat(4_000),
          headshotId: storageId,
          customValues: allowedCustomValues,
        });
        await ctx.db.insert("eventContacts", {
          eventId: count._id,
          orgId: count.orgId,
          firstName: `Count ${index}`,
          lastName: "Speaker",
          headshotId: storageId,
        });
      }
    });

    await expectRejectedWith(
      alice.query(api.tasks.filesLibraryV2, { eventSlug: payloadEvent }),
      "files_export_too_large",
    );
    expect(
      await alice.query(api.tasks.filesLibrary, { eventSlug: payloadEvent }),
    ).toEqual([]);
    expect(
      await alice.query(api.tasks.filesLibraryV2, { eventSlug: countEvent }),
    ).toHaveLength(64);
    await t.run(async (ctx) => {
      const count = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", countEvent))
        .unique();
      if (count === null) throw new Error("event missing");
      const existing = await ctx.db
        .query("eventContacts")
        .withIndex("by_eventId_and_headshotId", (q) =>
          q.eq("eventId", count._id).gt("headshotId", undefined),
        )
        .first();
      if (existing?.headshotId === undefined)
        throw new Error("headshot missing");
      await ctx.db.insert("eventContacts", {
        eventId: count._id,
        orgId: count.orgId,
        firstName: "Count 64",
        lastName: "Speaker",
        headshotId: existing.headshotId,
      });
    });
    await expectRejectedWith(
      alice.query(api.tasks.filesLibraryV2, { eventSlug: countEvent }),
      "files_export_too_large",
    );
    expect(
      await alice.query(api.tasks.exportBundle, {
        eventSlug: countEvent,
        instanceIds: [],
      }),
    ).toEqual([]);
  });

  test("rejects task-contact 17 and session 65 at the documented relationship caps", async () => {
    const t = setupTest();
    const { alice, orgSlug } = await eventSetup(t);
    const contactEvent = await createEvent(
      alice,
      orgSlug,
      "Task Contact Cap Summit",
    );
    const sessionEvent = await createEvent(
      alice,
      orgSlug,
      "Session Cap Summit",
    );
    const aliceId = await userIdFor(t, "alice");
    await t.run(async (ctx) => {
      const contactCapEvent = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", contactEvent))
        .unique();
      const sessionCapEvent = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", sessionEvent))
        .unique();
      if (contactCapEvent === null || sessionCapEvent === null) {
        throw new Error("event missing");
      }
      const storageId = await ctx.storage.store(new Blob(["file"]));
      const contactRequirementId = await ctx.db.insert("requirements", {
        eventId: contactCapEvent._id,
        title: "Contact evidence",
        scope: "participant",
        evidence: "file",
        reviewRequired: false,
        dueAt: DUE,
        active: true,
      });
      const contactSessionId = await ctx.db.insert("sessions", {
        eventId: contactCapEvent._id,
        title: "Shared session",
        source: "direct",
        status: "planned",
      });
      for (let index = 0; index < 17; index += 1) {
        const eventContactId = await ctx.db.insert("eventContacts", {
          eventId: contactCapEvent._id,
          orgId: contactCapEvent.orgId,
          firstName: `Contact ${index}`,
          lastName: "Speaker",
        });
        const instanceId = await ctx.db.insert("taskInstances", {
          requirementId: contactRequirementId,
          eventId: contactCapEvent._id,
          sessionId: contactSessionId,
          eventContactId,
          status: "complete",
          dueAt: DUE,
          updatedAt: index,
        });
        await ctx.db.insert("uploads", {
          eventId: contactCapEvent._id,
          taskInstanceId: instanceId,
          storageId,
          filename: `contact-${index}.pdf`,
          version: 1,
          uploadedBy: aliceId,
        });
      }

      const sessionRequirementId = await ctx.db.insert("requirements", {
        eventId: sessionCapEvent._id,
        title: "Session evidence",
        scope: "session",
        evidence: "file",
        reviewRequired: false,
        dueAt: DUE,
        active: true,
      });
      for (let index = 0; index < 65; index += 1) {
        const sessionId = await ctx.db.insert("sessions", {
          eventId: sessionCapEvent._id,
          title: `Session ${index}`,
          source: "direct",
          status: "planned",
        });
        const instanceId = await ctx.db.insert("taskInstances", {
          requirementId: sessionRequirementId,
          eventId: sessionCapEvent._id,
          sessionId,
          status: "complete",
          dueAt: DUE,
          updatedAt: index,
        });
        await ctx.db.insert("uploads", {
          eventId: sessionCapEvent._id,
          taskInstanceId: instanceId,
          storageId,
          filename: `session-${index}.pdf`,
          version: 1,
          uploadedBy: aliceId,
        });
      }
    });

    await expectRejectedWith(
      alice.query(api.tasks.filesLibraryV2, { eventSlug: contactEvent }),
      "files_export_too_large",
    );
    await expectRejectedWith(
      alice.query(api.tasks.filesLibraryV2, { eventSlug: sessionEvent }),
      "files_export_too_large",
    );
  });

  test("rejects comment 301 instead of reading an unbounded comment payload", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
      "Opening keynote",
    );
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Signed release",
      scope: "participant",
      evidence: "file",
      reviewRequired: false,
      dueAt: DUE,
    });
    const dana = await signIn(t, "dana", { emailVerified: true });
    await dana.mutation(api.portal.enter, { eventSlug });
    const instanceId = (
      await alice.query(api.tasks.listInstances, { eventSlug })
    )[0].instanceId;
    await dana.mutation(api.portal.uploadForTask, {
      eventSlug,
      instanceId,
      storageId: await storeBlob(t),
      filename: "release.pdf",
    });
    const danaId = await userIdFor(t, "dana");
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("event missing");
      for (let index = 0; index < 301; index += 1) {
        await ctx.db.insert("uploadComments", {
          eventId: event._id,
          instanceId,
          authorUserId: danaId,
          body: "x".repeat(2_000),
          createdAt: index,
        });
      }
    });

    await expectRejectedWith(
      alice.query(api.tasks.filesLibraryV2, { eventSlug }),
      "files_export_too_large",
    );
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
    const dana = await signIn(t, "dana", { emailVerified: true });
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
    const dana = await signIn(t, "dana", { emailVerified: true });
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
    await expectRejectedWith(
      dana.mutation(api.portal.uploadForTask, {
        eventSlug,
        instanceId,
        storageId: await storeBlob(t),
        filename: "../release.pdf",
      }),
      "invalid_filename",
    );
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
    expect(listed.every((u) => u.uploadedAt > 0)).toBe(true);
    const portalUploads = (
      await dana.query(api.portal.myTasks, { eventSlug })
    )[0].uploads;
    expect(
      portalUploads.map(({ filename, version, uploadedAt }) => ({
        filename,
        version,
        uploadedAt,
      })),
    ).toEqual(
      listed.map(({ filename, version, uploadedAt }) => ({
        filename,
        version,
        uploadedAt,
      })),
    );
    const [libraryFile] = await alice.query(api.tasks.filesLibraryV2, {
      eventSlug,
    });
    expect(libraryFile).toMatchObject({
      fileId: `task:${instanceId}`,
      kind: "task",
      instanceId,
      sourceFilename: null,
      filename: "release-v2.pdf",
      version: 2,
      versionCount: 2,
      uploadedByName: "Dana Keynote",
      uploadedAt: listed[0].uploadedAt,
    });
    expect(
      await alice.query(api.tasks.exportBundle, {
        eventSlug,
        instanceIds: [instanceId],
      }),
    ).toEqual([
      {
        filename: "release-v2.pdf",
        url: libraryFile.url,
        sessionTitle: "Opening keynote",
        speakerName: "Dana Keynote",
        requirementTitle: "Signed release",
      },
    ]);
    // A historical task at the explicit version ceiling refuses another
    // upload instead of reusing a capped-prefix version number. Approval also
    // stamps the newest row, not one of the first 200 records.
    const newestId = await t.run(async (ctx) => {
      const source = stored[0];
      return await ctx.db.insert("uploads", {
        eventId: source.eventId,
        taskInstanceId: source.taskInstanceId,
        storageId: await ctx.storage.store(new Blob(["version 200"])),
        filename: "release-v200.pdf",
        version: 200,
        uploadedBy: source.uploadedBy,
      });
    });
    await expectRejectedWith(
      dana.mutation(api.portal.uploadForTask, {
        eventSlug,
        instanceId,
        storageId: await storeBlob(t),
        filename: "release-v201.pdf",
      }),
      "upload_version_limit",
    );
    await alice.mutation(api.tasks.approve, { eventSlug, instanceId });
    await t.run(async (ctx) => {
      expect((await ctx.db.get("uploads", newestId))?.approvedAt).toBeTypeOf(
        "number",
      );
    });
  });

  test("comments resolve person names and timestamps for both roles without exposing organizer email to the portal", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Priya",
        lastName: "Raman",
        email: "priya@example.com",
      },
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
    // Reproduce the deployed account whose Clerk profile has no name. Existing
    // comment rows retain only the user id, so completing the app-owned profile
    // later must relabel the same history without rewriting it.
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "alice@example.com"))
        .unique();
      if (user === null) throw new Error("missing organizer");
      await ctx.db.patch("users", user._id, { name: undefined });
    });
    const jordan = alice;
    const priya = await signIn(t, "priya", {
      emailVerified: true,
      name: undefined,
      givenName: undefined,
      familyName: undefined,
    });
    await priya.mutation(api.portal.enter, { eventSlug });
    const unnamedOrganizer = await signIn(t, "helper", {
      name: undefined,
      givenName: undefined,
      familyName: undefined,
    });
    await grantEventRole(t, eventSlug, "helper", "organizer");
    const instanceId = (
      await jordan.query(api.tasks.listInstances, { eventSlug })
    )[0].instanceId;

    await jordan.mutation(api.tasks.commentOnTask, {
      eventSlug,
      instanceId,
      body: "Please upload the final deck.",
    });
    const beforeOrganizer = await jordan.query(api.tasks.taskComments, {
      eventSlug,
      instanceId,
    });
    const beforePortal = await priya.query(api.portal.taskComments, {
      eventSlug,
      instanceId,
    });
    expect(beforeOrganizer[0]).toMatchObject({
      authorName: "Organizer",
      authorEmail: null,
      body: "Please upload the final deck.",
    });
    expect(beforePortal[0]).toMatchObject({
      authorName: "Organizer",
      authorEmail: null,
      body: "Please upload the final deck.",
    });

    await jordan.mutation(api.users.setDisplayName, {
      displayName: "Jordan Alvarez",
    });
    await priya.mutation(api.portal.commentOnTask, {
      eventSlug,
      instanceId,
      body: "I will send it today.",
    });
    await unnamedOrganizer.mutation(api.tasks.commentOnTask, {
      eventSlug,
      instanceId,
      body: "Thanks — the event team is watching this thread.",
    });
    await t.run(async (ctx) => {
      const helper = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "helper@example.com"))
        .unique();
      if (helper === null) throw new Error("missing helper");
      await ctx.db.delete("users", helper._id);
    });

    const organizerView = await jordan.query(api.tasks.taskComments, {
      eventSlug,
      instanceId,
    });
    const portalView = await priya.query(api.portal.taskComments, {
      eventSlug,
      instanceId,
    });
    expect(
      organizerView.map((comment) => ({
        body: comment.body,
        authorName: comment.authorName,
        authorEmail: comment.authorEmail,
        mine: comment.mine,
      })),
    ).toEqual([
      {
        body: "Please upload the final deck.",
        authorName: "Jordan Alvarez",
        authorEmail: null,
        mine: true,
      },
      {
        body: "I will send it today.",
        authorName: "Priya Raman",
        authorEmail: null,
        mine: false,
      },
      {
        body: "Thanks — the event team is watching this thread.",
        authorName: "Someone",
        authorEmail: null,
        mine: false,
      },
    ]);
    expect(
      portalView.map((comment) => ({
        body: comment.body,
        authorName: comment.authorName,
        authorEmail: comment.authorEmail,
        mine: comment.mine,
      })),
    ).toEqual([
      {
        body: "Please upload the final deck.",
        authorName: "Jordan Alvarez",
        authorEmail: null,
        mine: false,
      },
      {
        body: "I will send it today.",
        authorName: "Priya Raman",
        authorEmail: null,
        mine: true,
      },
      {
        body: "Thanks — the event team is watching this thread.",
        authorName: "Someone",
        authorEmail: null,
        mine: false,
      },
    ]);
    expect(organizerView.every((comment) => comment.createdAt > 0)).toBe(true);
    expect(portalView.map((comment) => comment.createdAt)).toEqual(
      organizerView.map((comment) => comment.createdAt),
    );
  });

  test("generateUploadUrl is rate limited per user (F4)", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);

    // 20/hour, same bucket size as imports.generateUploadUrl. The 21st mint in
    // the same hour is refused (no fake clock needed — the period never
    // elapses mid-test).
    for (let i = 0; i < 20; i++) {
      expect(
        await alice.mutation(api.tasks.generateUploadUrl, { eventSlug }),
      ).toBeTypeOf("string");
    }
    await expectRejectedWith(
      alice.mutation(api.tasks.generateUploadUrl, { eventSlug }),
      "rate_limited",
    );

    // Per-user, so a second organizer of the same event has their own bucket.
    const dave = await signIn(t, "dave");
    await grantEventRole(t, eventSlug, "dave", "organizer");
    expect(
      await dave.mutation(api.tasks.generateUploadUrl, { eventSlug }),
    ).toBeTypeOf("string");
  });
});

// ── Portal task list ─────────────────────────────────────────────────────

describe("portal.myTasks", () => {
  test("three manual tasks stay complete across reload and reduce organizer open counts", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    for (const title of ["Confirm travel", "Choose meal", "Approve intro"]) {
      await manualRequirement(alice, eventSlug, { title });
    }
    const dana = await signIn(t, "dana", { emailVerified: true });
    await dana.mutation(api.portal.enter, { eventSlug });
    const before = await dana.query(api.portal.myTasks, { eventSlug });
    expect(before).toHaveLength(3);
    expect(before.every((task) => task.status === "pending")).toBe(true);

    for (const task of before.slice(0, 2)) {
      await dana.mutation(api.portal.completeTask, {
        eventSlug,
        instanceId: task.instanceId,
      });
    }

    // A fresh query is the reload contract: persisted server state, not local
    // optimistic state.
    const afterReload = await dana.query(api.portal.myTasks, { eventSlug });
    expect(afterReload.map((task) => task.status).sort()).toEqual([
      "complete",
      "complete",
      "pending",
    ]);
    const organizerRows = await alice.query(api.tasks.listInstances, {
      eventSlug,
    });
    expect(
      organizerRows.filter((task) => task.status === "pending"),
    ).toHaveLength(1);
    const board = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: NOW,
    });
    expect(board.speakers[0].outstandingTasks).toBe(1);
  });

  test("shows the caller's own tasks and the ones they manage", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { bob } = await acceptedTwoSpeakers(t, eventSlug);
    await manualRequirement(alice, eventSlug);

    const carol = await signIn(t, "carol", { emailVerified: true });
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
    expect(managed.map((task) => task.forSpeaker?.firstName).sort()).toEqual([
      "Carol",
      "Dave",
    ]);
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
    const dana = await signIn(t, "dana", { emailVerified: true });
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
    const danaUser = await signIn(t, "dana", { emailVerified: true });
    await danaUser.mutation(api.portal.enter, { eventSlug });
    const after = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: NOW,
    });
    expect(after.speakers.find((s) => s.name === "Dana Keynote")?.claimed).toBe(
      true,
    );
  });

  test("per-session rows read only their own tasks — grouped once, not re-filtered (M6)", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    // Three sessions with one speaker each, plus a requirement, so every
    // session owns exactly one task instance. The grouping this exercises
    // replaced `instances.filter(i => i.sessionId === session._id)` per
    // session; the OUTPUT must be identical, which is what is pinned here.
    const first = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    const second = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Evan", lastName: "Newcomer", email: "evan@example.com" },
      "Closing talk",
    );
    const third = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Fran", lastName: "Panelist", email: "fran@example.com" },
      "Panel",
    );
    await manualRequirement(alice, eventSlug);

    // Settle the middle session completely: its speaker confirms and its one
    // task completes, so it must come back Ready while the others do not.
    const evanParticipant = (await participantsOf(t, second.sessionId))[0];
    await alice.mutation(api.sessions.setParticipationState, {
      eventSlug,
      participantId: evanParticipant._id,
      to: "confirmed",
    });
    const evanInstance = (await instanceRows(t)).find(
      (i) => i.sessionId === second.sessionId,
    )!;
    await alice.mutation(api.tasks.markProvided, {
      eventSlug,
      instanceId: evanInstance._id,
    });

    const board = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: NOW,
    });
    const bySession = new Map(board.sessions.map((s) => [s.sessionId, s]));
    expect(bySession.get(first.sessionId)).toEqual({
      sessionId: first.sessionId,
      title: "Opening keynote",
      readiness: {
        status: "needsAttention",
        reasons: [
          "1 speaker has not answered their invitation.",
          "1 task is outstanding.",
        ],
      },
    });
    expect(bySession.get(second.sessionId)).toEqual({
      sessionId: second.sessionId,
      title: "Closing talk",
      readiness: { status: "ready", reasons: [] },
    });
    expect(bySession.get(third.sessionId)?.readiness.reasons).toEqual([
      "1 speaker has not answered their invitation.",
      "1 task is outstanding.",
    ]);
    // Totals are the same pass: one completed task across three sessions.
    expect(board.totals.acceptedSpeakers).toBe(3);
    expect(board.totals.overdue).toBe(0);
  });

  test("a dashboard past a read cap refuses instead of reporting readiness it never verified (H5)", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    // Readiness reads the whole event graph. Overflow the cheapest of those
    // reads (agenda items, 1000) by exactly one row: at the cap the dashboard
    // still answers, past it a partial read could only report false readiness.
    const eventId = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      return event._id;
    });
    const addItems = async (count: number) => {
      await t.run(async (ctx) => {
        for (let i = 0; i < count; i += 1) {
          await ctx.db.insert("agendaItems", {
            eventId,
            title: `Coffee ${i}`,
            startsAt: NOW,
            endsAt: NOW + 60_000,
          });
        }
      });
    };
    await addItems(1000);
    expect(
      (await alice.query(api.tasks.dashboard, { eventSlug, now: NOW }))
        .sessions,
    ).toHaveLength(1);

    await addItems(1);
    await expectRejectedWith(
      alice.query(api.tasks.dashboard, { eventSlug, now: NOW }),
      "event_too_large",
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

// ── Uploader provenance (W5) ─────────────────────────────────────────────

describe("files library uploader provenance", () => {
  test("resolves a nameless account through the event's own snapshot instead of a generic label", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId, sessionId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
      "Opening keynote",
    );
    // A second organizer whose identity provider gave us no human name. The
    // event still knows exactly who they are, through their own snapshot.
    const casey = await signIn(t, "casey", {
      emailVerified: true,
      name: undefined,
    });
    await grantEventRole(t, eventSlug, "casey", "organizer");
    const caseyId = await userIdFor(t, "casey");

    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .filter((q) => q.eq(q.field("slug"), eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      await ctx.db.insert("eventContacts", {
        eventId: event._id,
        orgId: event.orgId,
        firstName: "Casey",
        lastName: "Organizer",
        email: "casey@example.com",
        userId: caseyId,
      });
      const requirementId = await ctx.db.insert("requirements", {
        eventId: event._id,
        title: "Slides",
        scope: "participant",
        evidence: "file",
        reviewRequired: false,
        dueAt: DUE,
        active: true,
      });
      const instanceId = await ctx.db.insert("taskInstances", {
        requirementId,
        eventId: event._id,
        sessionId,
        eventContactId,
        status: "complete",
        dueAt: DUE,
        updatedAt: 1,
      });
      const storageId = await ctx.storage.store(
        new Blob(["slides"], { type: "application/pdf" }),
      );
      await ctx.db.insert("uploads", {
        eventId: event._id,
        taskInstanceId: instanceId,
        storageId,
        filename: "slides.pdf",
        version: 1,
        // Uploaded by the organizer, NOT by the speaker the task belongs to —
        // this is the path that used to render "Event contributor".
        uploadedBy: caseyId,
      });
    });

    const rows = await alice.query(api.tasks.filesLibraryV2, { eventSlug });
    const slides = rows.find((row) => row.filename === "slides.pdf");
    expect(slides).toMatchObject({
      uploadedByName: "Casey Organizer",
      uploadedByNote: null,
    });
  });

  test("an account the event holds two names for is reported as not attributable", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId, sessionId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
      "Opening keynote",
    );
    const casey = await signIn(t, "casey", {
      emailVerified: true,
      name: undefined,
    });
    await grantEventRole(t, eventSlug, "casey", "organizer");
    const caseyId = await userIdFor(t, "casey");
    expect(casey).toBeDefined();

    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .filter((q) => q.eq(q.field("slug"), eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      // Two snapshots, two different names, same account: the event cannot
      // say which one is theirs, and neither can we.
      for (const [firstName, lastName] of [
        ["Casey", "Organizer"],
        ["C.", "Organiser"],
      ]) {
        await ctx.db.insert("eventContacts", {
          eventId: event._id,
          orgId: event.orgId,
          firstName: firstName!,
          lastName: lastName!,
          email: "casey@example.com",
          userId: caseyId,
        });
      }
      const requirementId = await ctx.db.insert("requirements", {
        eventId: event._id,
        title: "Slides",
        scope: "participant",
        evidence: "file",
        reviewRequired: false,
        dueAt: DUE,
        active: true,
      });
      const instanceId = await ctx.db.insert("taskInstances", {
        requirementId,
        eventId: event._id,
        sessionId,
        eventContactId,
        status: "complete",
        dueAt: DUE,
        updatedAt: 1,
      });
      const storageId = await ctx.storage.store(
        new Blob(["slides"], { type: "application/pdf" }),
      );
      await ctx.db.insert("uploads", {
        eventId: event._id,
        taskInstanceId: instanceId,
        storageId,
        filename: "slides.pdf",
        version: 1,
        uploadedBy: caseyId,
      });
    });

    const rows = await alice.query(api.tasks.filesLibraryV2, { eventSlug });
    const slides = rows.find((row) => row.filename === "slides.pdf");
    expect(slides).toMatchObject({
      uploadedByName: null,
      uploadedByNote:
        "Not attributable: the uploading account's record is missing, or this event holds more than one name for it.",
    });
  });

  test("an account with no name anywhere is named as such, not as unattributable", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId, sessionId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
      "Opening keynote",
    );
    await signIn(t, "casey", { emailVerified: true, name: undefined });
    await grantEventRole(t, eventSlug, "casey", "organizer");
    const caseyId = await userIdFor(t, "casey");

    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .filter((q) => q.eq(q.field("slug"), eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      const requirementId = await ctx.db.insert("requirements", {
        eventId: event._id,
        title: "Slides",
        scope: "participant",
        evidence: "file",
        reviewRequired: false,
        dueAt: DUE,
        active: true,
      });
      const instanceId = await ctx.db.insert("taskInstances", {
        requirementId,
        eventId: event._id,
        sessionId,
        eventContactId,
        status: "complete",
        dueAt: DUE,
        updatedAt: 1,
      });
      const storageId = await ctx.storage.store(
        new Blob(["slides"], { type: "application/pdf" }),
      );
      await ctx.db.insert("uploads", {
        eventId: event._id,
        taskInstanceId: instanceId,
        storageId,
        filename: "slides.pdf",
        version: 1,
        uploadedBy: caseyId,
      });
    });

    const rows = await alice.query(api.tasks.filesLibraryV2, { eventSlug });
    const slides = rows.find((row) => row.filename === "slides.pdf");
    expect(slides).toMatchObject({
      uploadedByName: null,
      uploadedByNote:
        "Uploaded by an account that has not set a display name.",
    });
  });

  test("a headshot with no provenance record says the uploader was not recorded", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventSetup(t);
    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
      "Opening keynote",
    );
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(
        new Blob(["legacy"], { type: "image/webp" }),
      );
      await ctx.db.patch("eventContacts", eventContactId, {
        headshotId: storageId,
      });
    });

    const [file] = await alice.query(api.tasks.filesLibraryV2, { eventSlug });
    expect(file).toMatchObject({
      kind: "headshot",
      uploadedByName: null,
      uploadedByNote: "The uploader was not recorded for this file.",
    });
  });
});
