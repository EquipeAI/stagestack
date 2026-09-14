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
import { starterFormDef } from "./model/cfpForms";

// Review & evaluation (M2). The privacy rules are the point of most of these
// tests: a reviewer must reach exactly their own assignments, see evaluation
// content plus professional identity, and nothing else.

const ANSWERS: Record<string, string> = {
  firstName: "Bob",
  lastName: "Speaker",
  email: "bob@example.com",
  talkTitle: "Convex in anger",
  abstract: "Everything we learned shipping a reactive backend.",
};

async function withEnv(
  name: string,
  value: string | undefined,
  body: () => Promise<void>,
): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

async function userId(t: TestT, key: string): Promise<Id<"users">> {
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

/** An open CFP with `count` submitted proposals from distinct submitters. */
async function eventWithProposals(
  t: TestT,
  count: number,
  options: {
    form?: ReturnType<typeof starterFormDef>;
    answers?: Record<string, string>;
  } = {},
) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
  if (options.form !== undefined) {
    await alice.mutation(api.cfp.updateWorkingForm, {
      eventSlug,
      def: options.form,
    });
  }
  await alice.mutation(api.cfp.publishForm, { eventSlug });
  await alice.mutation(api.events.updateSettings, {
    eventSlug,
    patch: { cfpPublished: true },
  });

  const proposalIds: Array<Id<"proposals">> = [];
  for (let i = 0; i < count; i += 1) {
    const submitter = await signIn(t, `submitter${i}`);
    const proposalId = await submitter.mutation(api.cfp.startProposal, {
      eventSlug,
    });
    await submitter.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: {
        ...ANSWERS,
        ...options.answers,
        talkTitle: `Talk ${i}`,
      },
    });
    await submitter.mutation(api.cfp.setSpeakers, {
      proposalId,
      speakers: [
        {
          firstName: `Speaker${i}`,
          lastName: "Onstage",
          email: `speaker${i}@example.com`,
          phone: "+1 555 0100",
          tagline: "CTO, Acme",
          bio: "Builds things.",
          isPrimary: true,
        },
      ],
    });
    await submitter.mutation(api.cfp.submitProposal, { proposalId });
    proposalIds.push(proposalId);
  }
  return { alice, orgSlug, eventSlug, proposalIds };
}

/** Sign a reviewer in, grant the role, return them plus their user id. */
async function reviewerFor(
  t: TestT,
  eventSlug: string,
  key: string,
): Promise<{ as: TestUserT; id: Id<"users"> }> {
  const as = await signIn(t, key);
  await grantEventRole(t, eventSlug, key, "reviewer");
  return { as, id: await userId(t, key) };
}

/** Release the first proposal as Accepted and the second as Declined. */
async function releaseOppositeDecisions(
  organizer: TestUserT,
  eventSlug: string,
  proposalIds: [Id<"proposals">, Id<"proposals">],
): Promise<void> {
  const [acceptedId, declinedId] = proposalIds;
  expect(
    await organizer.mutation(api.sessions.setStatus, {
      eventSlug,
      proposalIds: [acceptedId],
      to: "acceptQueue",
    }),
  ).toEqual([{ proposalId: acceptedId, ok: true }]);
  expect(
    await organizer.mutation(api.sessions.setStatus, {
      eventSlug,
      proposalIds: [declinedId],
      to: "declineQueue",
    }),
  ).toEqual([{ proposalId: declinedId, ok: true }]);
  expect(
    await organizer.mutation(api.sessions.release, {
      eventSlug,
      proposalIds: [acceptedId, declinedId],
    }),
  ).toEqual([
    { proposalId: acceptedId, ok: true },
    { proposalId: declinedId, ok: true },
  ]);
}

async function proposalStatuses(
  t: TestT,
  proposalIds: Array<Id<"proposals">>,
): Promise<Array<string>> {
  return await t.run(async (ctx) => {
    const statuses: Array<string> = [];
    for (const proposalId of proposalIds) {
      const proposal = await ctx.db.get("proposals", proposalId);
      if (proposal === null) throw new Error("no proposal");
      statuses.push(proposal.status);
    }
    return statuses;
  });
}

describe("reviews.assign", () => {
  test("bulk assignment skips existing pairs and audits the counts", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    const rita = await reviewerFor(t, eventSlug, "rita");

    const first = await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });
    expect(first).toEqual({ assigned: 2, skipped: 0 });

    // Re-running the same bulk action is harmless.
    const second = await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });
    expect(second).toEqual({ assigned: 0, skipped: 2 });
    expect(
      await t.run(async (ctx) => ctx.db.query("reviews").collect()),
    ).toHaveLength(2);
    expect(await auditActions(t)).toContain("review.assign");
  });

  test("assigns accepted and declined proposals into a post-decision round without changing their decisions", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    const acceptedAndDeclined: [Id<"proposals">, Id<"proposals">] = [
      proposalIds[0],
      proposalIds[1],
    ];
    await releaseOppositeDecisions(alice, eventSlug, acceptedAndDeclined);
    const sam = await reviewerFor(t, eventSlug, "sam");
    const roundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Post-decision review",
      anonymized: true,
      reviewerCap: 5,
      scorecard: [
        { id: "score", label: "Score", kind: "numeric", required: true },
      ],
    });

    const first = await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds: acceptedAndDeclined,
      reviewerUserId: sam.id,
      roundId,
    });
    expect(first).toEqual({ assigned: 2, skipped: 0 });
    const again = await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds: acceptedAndDeclined,
      reviewerUserId: sam.id,
      roundId,
    });
    expect(again).toEqual({ assigned: 0, skipped: 2 });

    const queue = await sam.as.query(api.reviews.myAssignments, { eventSlug });
    expect(queue).toHaveLength(2);
    expect(queue.map((row) => row.proposal._id).sort()).toEqual(
      [...acceptedAndDeclined].sort(),
    );
    expect(queue.every((row) => row.round.roundId === roundId)).toBe(true);
    expect(await proposalStatuses(t, acceptedAndDeclined)).toEqual([
      "accepted",
      "declined",
    ]);
  });

  test("rejects a non-member reviewer, a foreign proposal, and a draft proposal", async () => {
    const t = setupTest();
    const { alice, orgSlug, eventSlug, proposalIds } = await eventWithProposals(
      t,
      1,
    );
    const rita = await reviewerFor(t, eventSlug, "rita");

    const stranger = await signIn(t, "stranger");
    await expectRejectedWith(
      alice.mutation(api.reviews.assign, {
        eventSlug,
        proposalIds,
        reviewerUserId: await userId(t, "stranger"),
      }),
      "invalid_reviewer",
    );
    expect(stranger).toBeTruthy();

    // A proposal from another event is invisible there. (The reviewer is
    // alice herself: an org owner organizes every event, so the assignment
    // gets past the reviewer check and fails on the proposal, which is the
    // rule under test.)
    const otherEvent = await createEvent(alice, orgSlug, "Other Summit");
    await expectRejectedWith(
      alice.mutation(api.reviews.assign, {
        eventSlug: otherEvent,
        proposalIds,
        reviewerUserId: await userId(t, "alice"),
      }),
      "not_found",
    );

    // A never-submitted draft is not in review.
    const drafter = await signIn(t, "drafter");
    const draftId = await drafter.mutation(api.cfp.startProposal, {
      eventSlug,
    });
    await expectRejectedWith(
      alice.mutation(api.reviews.assign, {
        eventSlug,
        proposalIds: [draftId],
        reviewerUserId: rita.id,
      }),
      "invalid_status",
    );
  });

  test("NEGATIVE: a reviewer cannot assign, list proposals, or read organizer views", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });

    await expectRejectedWith(
      rita.as.mutation(api.reviews.assign, {
        eventSlug,
        proposalIds,
        reviewerUserId: rita.id,
      }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.as.query(api.cfp.listProposals, { eventSlug }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.as.query(api.reviews.summary, {
        eventSlug,
        proposalId: proposalIds[0],
      }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.as.query(api.reviews.progress, { eventSlug }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.as.query(api.sessions.list, { eventSlug }),
      "forbidden",
    );
  });
});

describe("reviews.myAssignments", () => {
  test("a reviewer sees only assigned proposals, with no speaker contact details", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    const rita = await reviewerFor(t, eventSlug, "rita");
    const raj = await reviewerFor(t, eventSlug, "raj");

    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds: [proposalIds[0]],
      reviewerUserId: rita.id,
    });
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds: [proposalIds[1]],
      reviewerUserId: raj.id,
    });

    const mine = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(mine).toHaveLength(1);
    expect(mine[0].proposal._id).toBe(proposalIds[0]);
    expect(mine[0].contentVersion).toBe(0);
    expect(mine[0].status).toBe("assigned");
    // Evaluation content is visible...
    expect(mine[0].proposal.answers.abstract).toBe(ANSWERS.abstract);
    // ...professional identity is visible...
    expect(mine[0].proposal.speakers[0]).toEqual({
      firstName: "Speaker0",
      lastName: "Onstage",
      tagline: "CTO, Acme",
      bio: "Builds things.",
    });
    // ...contact details are NOT (M2 privacy contract).
    const speaker = mine[0].proposal.speakers[0] as Record<string, unknown>;
    expect(speaker.email).toBeUndefined();
    expect(speaker.phone).toBeUndefined();

    const theirs = await raj.as.query(api.reviews.myAssignments, { eventSlug });
    expect(theirs.map((r) => r.proposal._id)).toEqual([proposalIds[1]]);
  });

  test("unfinished assignments sort first", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    const rita = await reviewerFor(t, eventSlug, "rita");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });

    const before = await rita.as.query(api.reviews.myAssignments, {
      eventSlug,
    });
    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      expectedContentVersion: 0,
      reviewId: before[0].reviewId,
      answers: { score: 4, recommendation: "Accept" },
    });

    const after = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(after[0].status).toBe("assigned");
    expect(after[1].status).toBe("submitted");
  });
});

describe("reviews.saveDraft / submit", () => {
  test("pre-fence clients may write untouched v0 assignments through every review action", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 3);
    const rita = await reviewerFor(t, eventSlug, "rita");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });
    const assignments = await rita.as.query(api.reviews.myAssignments, {
      eventSlug,
    });
    const reviewFor = (proposalId: Id<"proposals">) => {
      const assignment = assignments.find(
        (row) => row.proposal._id === proposalId,
      );
      if (assignment === undefined) throw new Error("missing assignment");
      return assignment.reviewId;
    };

    // Deliberately omit expectedContentVersion: these calls model clients
    // deployed before the optimistic content fence existed.
    await rita.as.mutation(api.reviews.saveDraft, {
      eventSlug,
      reviewId: reviewFor(proposalIds[0]),
      answers: { comments: "Legacy v0 draft" },
    });
    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      reviewId: reviewFor(proposalIds[1]),
      answers: { score: 4, recommendation: "Accept" },
    });
    await rita.as.mutation(api.reviews.declareConflict, {
      eventSlug,
      reviewId: reviewFor(proposalIds[2]),
      note: "Legacy v0 conflict",
    });

    const after = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(
      after.map((row) => ({
        proposalId: row.proposal._id,
        status: row.status,
        contentVersion: row.contentVersion,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          proposalId: proposalIds[0],
          status: "draft",
          contentVersion: 0,
        },
        {
          proposalId: proposalIds[1],
          status: "submitted",
          contentVersion: 0,
        },
        {
          proposalId: proposalIds[2],
          status: "conflict",
          contentVersion: 0,
        },
      ]),
    );
  });

  test("a pending autosave cannot resurrect answers for revised proposal content", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });
    const opened = (
      await rita.as.query(api.reviews.myAssignments, { eventSlug })
    )[0];
    expect(opened.contentVersion).toBe(0);

    const submitter = await signIn(t, "submitter0");
    const proposal = await submitter.query(api.cfp.getMyProposal, {
      proposalId: proposalIds[0],
    });
    await submitter.mutation(api.cfp.resubmitProposal, {
      proposalId: proposalIds[0],
      expectedContentVersion: proposal.proposal.contentVersion ?? 0,
      answers: {
        ...proposal.proposal.answers,
        abstract: "Revised after the reviewer opened the assignment.",
      },
      speakers: proposal.speakers.map((speaker) => ({
        proposalSpeakerId: speaker._id,
        firstName: speaker.firstName,
        lastName: speaker.lastName,
        email: speaker.email,
        phone: speaker.phone,
        tagline: speaker.tagline,
        bio: speaker.bio,
        headshotId: speaker.headshotId,
        links: speaker.links,
        isPrimary: speaker.isPrimary,
        role: speaker.role,
      })),
    });
    const beforeLegacyAttempts = await t.run(async (ctx) => {
      const row = await ctx.db.get("reviews", opened.reviewId);
      if (row === null) throw new Error("missing review");
      return row;
    });

    // A deployed pre-fence client has no version to echo. Compatibility is
    // safe only at v0, so every old write is rejected after this revision.
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        reviewId: opened.reviewId,
        answers: { comments: "Unversioned stale draft" },
      }),
      "client_upgrade_required",
    );
    await expectRejectedWith(
      rita.as.mutation(api.reviews.submit, {
        eventSlug,
        reviewId: opened.reviewId,
        answers: { score: 5, recommendation: "Accept" },
      }),
      "client_upgrade_required",
    );
    await expectRejectedWith(
      rita.as.mutation(api.reviews.declareConflict, {
        eventSlug,
        reviewId: opened.reviewId,
      }),
      "client_upgrade_required",
    );
    expect(
      (await rita.as.query(api.reviews.myAssignments, { eventSlug }))[0],
    ).toMatchObject({
      reviewId: opened.reviewId,
      contentVersion: 1,
      status: "assigned",
      answers: {},
    });
    expect(
      await t.run(async (ctx) => await ctx.db.get("reviews", opened.reviewId)),
    ).toEqual(beforeLegacyAttempts);

    // These model the old panel's queued autosave, submit shortcut, and
    // conflict click carrying an explicitly observed but stale v0 fence.
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        reviewId: opened.reviewId,
        expectedContentVersion: opened.contentVersion,
        answers: { comments: "Old-content draft" },
      }),
      "stale_proposal_content",
    );
    await expectRejectedWith(
      rita.as.mutation(api.reviews.submit, {
        eventSlug,
        reviewId: opened.reviewId,
        expectedContentVersion: opened.contentVersion,
        answers: { score: 5, recommendation: "Accept" },
      }),
      "stale_proposal_content",
    );
    await expectRejectedWith(
      rita.as.mutation(api.reviews.declareConflict, {
        eventSlug,
        reviewId: opened.reviewId,
        expectedContentVersion: opened.contentVersion,
      }),
      "stale_proposal_content",
    );

    const refreshed = (
      await rita.as.query(api.reviews.myAssignments, { eventSlug })
    )[0];
    expect(refreshed).toMatchObject({
      reviewId: opened.reviewId,
      contentVersion: 1,
      status: "assigned",
      answers: {},
    });
    await rita.as.mutation(api.reviews.saveDraft, {
      eventSlug,
      reviewId: refreshed.reviewId,
      expectedContentVersion: refreshed.contentVersion,
      answers: { comments: "Fresh-content draft" },
    });
    expect(
      (await rita.as.query(api.reviews.myAssignments, { eventSlug }))[0],
    ).toMatchObject({
      contentVersion: 1,
      status: "draft",
      answers: { comments: "Fresh-content draft" },
    });
  });

  test("draft → submit → organizer summary aggregates the submitted reviews", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    const raj = await reviewerFor(t, eventSlug, "raj");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: raj.id,
    });

    const ritaReview = (
      await rita.as.query(api.reviews.myAssignments, { eventSlug })
    )[0].reviewId;
    const rajReview = (
      await raj.as.query(api.reviews.myAssignments, { eventSlug })
    )[0].reviewId;

    // Autosave: partial patch, status becomes draft.
    await rita.as.mutation(api.reviews.saveDraft, {
      eventSlug,
      expectedContentVersion: 0,
      reviewId: ritaReview,
      answers: { comments: "Halfway through." },
    });
    let mine = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(mine[0].status).toBe("draft");
    expect(mine[0].answers.comments).toBe("Halfway through.");
    expect(mine[0].answers.score).toBeUndefined();

    // The organizer sees an unfinished review's STATUS but not its content.
    const inProgress = await alice.query(api.reviews.summary, {
      eventSlug,
      proposalId: proposalIds[0],
    });
    expect(inProgress.aggregate).toMatchObject({
      count: 2,
      conflictCount: 0,
      submittedCount: 0,
    });
    expect(inProgress.aggregate.avgScore).toBeNull();
    const draftRow = inProgress.reviews.find((r) => r.status === "draft")!;
    expect(draftRow.comments).toBeUndefined();
    expect(draftRow.answers).toBeUndefined();
    expect(draftRow.reviewerEmail).toBe("rita@example.com");

    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      expectedContentVersion: 0,
      reviewId: ritaReview,
      answers: { score: 5, recommendation: "Accept", comments: "Strong." },
    });
    await raj.as.mutation(api.reviews.submit, {
      eventSlug,
      expectedContentVersion: 0,
      reviewId: rajReview,
      answers: { score: 2, recommendation: "Reject" },
    });

    const summary = await alice.query(api.reviews.summary, {
      eventSlug,
      proposalId: proposalIds[0],
    });
    expect(summary.aggregate).toEqual({
      count: 2,
      conflictCount: 0,
      submittedCount: 2,
      avgScore: 3.5,
      recommendations: { accept: 1, decline: 1, neutral: 0 },
    });
    expect(
      summary.reviews.find((r) => r.reviewerName === "rita"),
    ).toMatchObject({
      score: 5,
      recommendation: "accept",
      comments: "Strong.",
    });

    const progress = await alice.query(api.reviews.progress, { eventSlug });
    expect(progress[proposalIds[0]]).toEqual({
      assigned: 2,
      submitted: 2,
      conflicts: 0,
      avgScore: 3.5,
    });

    // Revising a submitted review overwrites it and keeps submittedAt.
    const submittedAt = summary.reviews.find(
      (r) => r.reviewerName === "rita",
    )!.submittedAt;
    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      expectedContentVersion: 0,
      reviewId: ritaReview,
      answers: { score: 3, recommendation: "Maybe" },
    });
    const revised = await alice.query(api.reviews.summary, {
      eventSlug,
      proposalId: proposalIds[0],
    });
    const ritaRow = revised.reviews.find((r) => r.reviewerName === "rita")!;
    expect(ritaRow).toMatchObject({ score: 3, recommendation: "neutral" });
    expect(ritaRow.submittedAt).toBe(submittedAt);
    expect(revised.aggregate.avgScore).toBe(2.5);
    expect(
      (await auditActions(t)).filter((a) => a === "review.submit"),
    ).toHaveLength(3);
  });

  test("validates the score and comment length, and refuses draft-saving a submitted review", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });
    const reviewId = (
      await rita.as.query(api.reviews.myAssignments, { eventSlug })
    )[0].reviewId;

    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        expectedContentVersion: 0,
        reviewId,
        answers: { score: 6 },
      }),
      "invalid_answers",
    );
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        expectedContentVersion: 0,
        reviewId,
        answers: { score: 3.5 },
      }),
      "invalid_answers",
    );
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        expectedContentVersion: 0,
        reviewId,
        answers: { comments: "x".repeat(5001) },
      }),
      "invalid_answers",
    );

    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      expectedContentVersion: 0,
      reviewId,
      answers: { score: 4, recommendation: "Accept" },
    });
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        expectedContentVersion: 0,
        reviewId,
        answers: { comments: "sneaky edit" },
      }),
      "invalid_status",
    );
  });

  test("NEGATIVE: reviewer A cannot save or submit reviewer B's review", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    const raj = await reviewerFor(t, eventSlug, "raj");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });
    const ritaReview = (
      await rita.as.query(api.reviews.myAssignments, { eventSlug })
    )[0].reviewId;

    // Raj has no assignments at all...
    expect(
      await raj.as.query(api.reviews.myAssignments, { eventSlug }),
    ).toEqual([]);
    // ...and Rita's review id is not probeable: not_found, never forbidden.
    await expectRejectedWith(
      raj.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        expectedContentVersion: 0,
        reviewId: ritaReview,
        answers: { comments: "not mine" },
      }),
      "not_found",
    );
    await expectRejectedWith(
      raj.as.mutation(api.reviews.submit, {
        eventSlug,
        expectedContentVersion: 0,
        reviewId: ritaReview,
        answers: { score: 1, recommendation: "Reject" },
      }),
      "not_found",
    );
    // Even the organizer cannot write someone else's review.
    await expectRejectedWith(
      alice.mutation(api.reviews.submit, {
        eventSlug,
        expectedContentVersion: 0,
        reviewId: ritaReview,
        answers: { score: 5, recommendation: "Accept" },
      }),
      "not_found",
    );
  });
});

describe("reviews.unassign", () => {
  test("works before submission and is refused after", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    const rita = await reviewerFor(t, eventSlug, "rita");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });
    const mine = await rita.as.query(api.reviews.myAssignments, { eventSlug });

    await alice.mutation(api.reviews.unassign, {
      eventSlug,
      reviewId: mine[0].reviewId,
    });
    expect(
      await rita.as.query(api.reviews.myAssignments, { eventSlug }),
    ).toHaveLength(1);

    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      expectedContentVersion: 0,
      reviewId: mine[1].reviewId,
      answers: { score: 4, recommendation: "Accept" },
    });
    await expectRejectedWith(
      alice.mutation(api.reviews.unassign, {
        eventSlug,
        reviewId: mine[1].reviewId,
      }),
      "invalid_status",
    );
    expect(await auditActions(t)).toContain("review.unassign");
  });
});

describe("reviews.myAssignments file answers", () => {
  test("a malformed stored file answer degrades to a null URL instead of failing the list", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    // Add a file field and republish so it is an evaluation field.
    const def = starterFormDef();
    def.sections[1].fields.push({
      id: "slides",
      kind: "file",
      label: "Slides",
      required: false,
    });
    await alice.mutation(api.cfp.updateWorkingForm, { eventSlug, def });
    await alice.mutation(api.cfp.publishForm, { eventSlug });
    // Plant a malformed value directly — the write path refuses these now,
    // but a reviewer list must survive one that predates the gate.
    await t.run(async (ctx) => {
      const proposal = await ctx.db.get("proposals", proposalIds[0]);
      await ctx.db.patch("proposals", proposalIds[0], {
        answers: { ...proposal!.answers, slides: "not-a-storage-id" },
      });
    });
    const rita = await reviewerFor(t, eventSlug, "rita");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });

    const rows = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(rows).toHaveLength(1);
    expect(rows[0].proposal.fileUrls["not-a-storage-id"]).toBeNull();
  });
});

// ── W2: rounds, pools, scorecards, distribution, COI, progress ───────────

describe("reviews.rounds", () => {
  test("two rounds persist with distinct names, dates, scorecards and pools", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");

    const round1 = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Initial Review",
      opensAt: Date.parse("2026-08-01"),
      closesAt: Date.parse("2026-10-15"),
      anonymized: true,
      scorecard: [
        {
          id: "orig",
          label: "Originality",
          kind: "numeric",
          min: 1,
          max: 5,
          weight: 2,
          required: true,
        },
        {
          id: "rel",
          label: "Relevance",
          kind: "numeric",
          min: 1,
          max: 5,
          weight: 1,
          required: true,
        },
        {
          id: "rec",
          label: "Recommendation",
          kind: "dropdown",
          options: ["Accept", "Maybe", "Reject"],
          required: true,
        },
        { id: "comments", label: "Comments", kind: "text" },
      ],
    });
    const round2 = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Final Review",
      opensAt: Date.parse("2026-10-16"),
      closesAt: Date.parse("2026-11-30"),
      anonymized: false,
      scorecard: [
        {
          id: "final",
          label: "Final Score",
          kind: "numeric",
          min: 1,
          max: 10,
          required: true,
        },
        { id: "comments", label: "Comments", kind: "text" },
      ],
    });
    await alice.mutation(api.reviews.addRoundReviewer, {
      eventSlug,
      roundId: round1,
      userId: rita.id,
    });

    const rounds = await alice.query(api.reviews.listRounds, { eventSlug });
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({
      name: "Initial Review",
      anonymized: true,
    });
    expect(rounds[0].scorecard.map((f) => f.kind)).toEqual([
      "numeric",
      "numeric",
      "dropdown",
      "text",
    ]);
    expect(rounds[0].scorecard[0].weight).toBe(2);
    expect(rounds[0].pool.map((m) => m.name)).toEqual(["rita"]);
    expect(rounds[1]).toMatchObject({
      name: "Final Review",
      anonymized: false,
    });
    expect(rounds[1].pool).toEqual([]);

    // Round 2's pool is independent of round 1's (ABS-02).
    const raj = await reviewerFor(t, eventSlug, "raj");
    await alice.mutation(api.reviews.addRoundReviewer, {
      eventSlug,
      roundId: round2,
      userId: raj.id,
    });
    const after = await alice.query(api.reviews.listRounds, { eventSlug });
    expect(after[0].pool.map((m) => m.name)).toEqual(["rita"]);
    expect(after[1].pool.map((m) => m.name)).toEqual(["raj"]);
  });

  test("a review round refuses a 201st pool member", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    const raj = await reviewerFor(t, eventSlug, "raj");
    const roundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Bounded pool",
      anonymized: false,
      scorecard: [
        { id: "score", label: "Score", kind: "numeric", required: true },
      ],
    });
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("missing event");
      for (let index = 0; index < 200; index += 1) {
        await ctx.db.insert("roundReviewers", {
          eventId: event._id,
          roundId,
          userId: rita.id,
        });
      }
    });

    await expectRejectedWith(
      alice.mutation(api.reviews.addRoundReviewer, {
        eventSlug,
        roundId,
        userId: raj.id,
      }),
      "reviewer_pool_full",
    );
  });

  test("weighted scorecard: the aggregate reflects the weights (ABS-04)", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    const roundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Initial Review",
      anonymized: false,
      scorecard: [
        {
          id: "orig",
          label: "Originality",
          kind: "numeric",
          weight: 2,
          required: true,
        },
        {
          id: "rel",
          label: "Relevance",
          kind: "numeric",
          weight: 1,
          required: true,
        },
        {
          id: "rec",
          label: "Recommendation",
          kind: "dropdown",
          options: ["Accept", "Maybe", "Reject"],
          required: true,
        },
        { id: "comments", label: "Comments", kind: "text" },
      ],
    });
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
      roundId,
    });
    const reviewId = (
      await rita.as.query(api.reviews.myAssignments, { eventSlug })
    )[0].reviewId;
    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      expectedContentVersion: 0,
      reviewId,
      answers: { orig: 4, rel: 2, rec: "Accept", comments: "Solid." },
    });

    const summary = await alice.query(api.reviews.summary, {
      eventSlug,
      proposalId: proposalIds[0],
    });
    // (4×2 + 2×1) / 3 = 3.333…
    expect(summary.aggregate.avgScore).toBeCloseTo(10 / 3, 5);
    expect(summary.aggregate.recommendations.accept).toBe(1);
    const row = summary.reviews[0];
    expect(row.answers).toMatchObject({ orig: 4, rel: 2, rec: "Accept" });
    expect(row.weightedScore).toBeCloseTo(10 / 3, 5);

    // A required criterion missing refuses the submit.
    const raj = await reviewerFor(t, eventSlug, "raj");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: raj.id,
      roundId,
    });
    const rajReview = (
      await raj.as.query(api.reviews.myAssignments, { eventSlug })
    )[0].reviewId;
    await expectRejectedWith(
      raj.as.mutation(api.reviews.submit, {
        eventSlug,
        expectedContentVersion: 0,
        reviewId: rajReview,
        answers: { orig: 5 },
      }),
      "invalid_answers",
    );
  });

  test("anonymized round hides speakers from the reviewer but not the organizer (ABS-07)", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    const roundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Blind Round",
      anonymized: true,
      scorecard: [
        { id: "score", label: "Score", kind: "numeric", required: true },
      ],
    });
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
      roundId,
    });

    const mine = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(mine[0].round.anonymized).toBe(true);
    expect(mine[0].proposal.speakers).toEqual([]);
    // Identity answer fields were already stripped pre-W2.
    expect(mine[0].proposal.answers.firstName).toBeUndefined();

    // The organizer's proposal detail still shows speakers (via cfp views).
    const detail = await alice.query(api.cfp.getProposalDetail, {
      eventSlug,
      proposalId: proposalIds[0],
    });
    expect(detail.speakers[0].firstName).toBe("Speaker0");
  });

  test("blind review excludes every answer in the identity section without hiding same-labeled proposal fields (ABS-07)", async () => {
    const t = setupTest();
    const identityBioId = "speaker-bio-profile";
    const proposalBioId = "speaker-bio-session";
    const identityBio = "Identity profile answer for a named employer.";
    const proposalBio = "Session-only context reviewers need to evaluate.";
    const def = starterFormDef();
    def.sections[0].fields.push({
      id: identityBioId,
      kind: "textarea",
      label: "Speaker bio",
      required: false,
    });
    def.sections[1].fields.push({
      id: proposalBioId,
      kind: "textarea",
      label: "Speaker bio",
      required: false,
    });
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1, {
      form: def,
      answers: {
        [identityBioId]: identityBio,
        [proposalBioId]: proposalBio,
      },
    });
    const blindReviewer = await reviewerFor(t, eventSlug, "blind-reviewer");
    const openReviewer = await reviewerFor(t, eventSlug, "open-reviewer");
    const scorecard = [
      { id: "score", label: "Score", kind: "numeric" as const, required: true },
    ];
    const blindRoundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Blind Round",
      anonymized: true,
      scorecard,
    });
    const openRoundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Open Round",
      anonymized: false,
      scorecard,
    });
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: blindReviewer.id,
      roundId: blindRoundId,
    });
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: openReviewer.id,
      roundId: openRoundId,
    });

    const blind = (
      await blindReviewer.as.query(api.reviews.myAssignments, { eventSlug })
    )[0];
    expect(blind.proposal.speakers).toEqual([]);
    expect(blind.proposal.answers[identityBioId]).toBeUndefined();
    expect(blind.proposal.fields.map((field) => field.id)).not.toContain(
      identityBioId,
    );
    expect(blind.proposal.answers[proposalBioId]).toBe(proposalBio);
    expect(blind.proposal.fields.map((field) => field.id)).toContain(
      proposalBioId,
    );
    const blindPayload = JSON.stringify(blind.proposal);
    expect(blindPayload).not.toContain(identityBio);
    expect(blindPayload).not.toContain("Speaker0");
    expect(blindPayload).not.toContain("speaker0@example.com");
    expect(blindPayload).not.toContain("CTO, Acme");
    expect(blindPayload).not.toContain("Builds things.");

    const open = (
      await openReviewer.as.query(api.reviews.myAssignments, { eventSlug })
    )[0];
    expect(open.proposal.answers[identityBioId]).toBe(identityBio);
    expect(open.proposal.answers[proposalBioId]).toBe(proposalBio);
    expect(open.proposal.fields.map((field) => field.id)).toContain(
      identityBioId,
    );
    expect(open.proposal.speakers[0].firstName).toBe("Speaker0");
  });

  test("autoDistribute spreads load, respects the cap, and never duplicates (ABS-06)", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 4);
    const rita = await reviewerFor(t, eventSlug, "rita");
    const raj = await reviewerFor(t, eventSlug, "raj");
    const roundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Initial",
      anonymized: false,
      reviewerCap: 3,
      scorecard: [
        { id: "score", label: "Score", kind: "numeric", required: true },
      ],
    });
    await alice.mutation(api.reviews.addRoundReviewer, {
      eventSlug,
      roundId,
      userId: rita.id,
    });
    await alice.mutation(api.reviews.addRoundReviewer, {
      eventSlug,
      roundId,
      userId: raj.id,
    });

    const result = await alice.mutation(api.reviews.autoDistribute, {
      eventSlug,
      roundId,
    });
    expect(result.assigned).toBe(4);
    expect(result.unplaced).toBe(0);
    const totals = result.perReviewer.map((r) => r.total).sort();
    expect(totals).toEqual([2, 2]);

    // Re-running assigns nothing new (each proposal already has a reviewer).
    const again = await alice.mutation(api.reviews.autoDistribute, {
      eventSlug,
      roundId,
    });
    expect(again.assigned).toBe(0);

    // Asking for 2 reviews per proposal hits the cap of 3 each: 8 slots
    // wanted, 4 filled already, capacity left = 2 → 2 assigned, 2 unplaced.
    const second = await alice.mutation(api.reviews.autoDistribute, {
      eventSlug,
      roundId,
      perProposal: 2,
    });
    expect(second.assigned).toBe(2);
    expect(second.unplaced).toBe(2);
  });

  test("auto-distributes exactly the selected accepted and declined proposals into a later reviewer queue", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    const acceptedAndDeclined: [Id<"proposals">, Id<"proposals">] = [
      proposalIds[0],
      proposalIds[1],
    ];
    await releaseOppositeDecisions(alice, eventSlug, acceptedAndDeclined);
    const sam = await reviewerFor(t, eventSlug, "sam");
    const roundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Initial Review",
      anonymized: true,
      reviewerCap: 5,
      scorecard: [
        { id: "score", label: "Score", kind: "numeric", required: true },
      ],
    });
    await alice.mutation(api.reviews.addRoundReviewer, {
      eventSlug,
      roundId,
      userId: sam.id,
    });

    const result = await alice.mutation(api.reviews.autoDistribute, {
      eventSlug,
      roundId,
      proposalIds: acceptedAndDeclined,
    });
    expect(result).toEqual({
      assigned: 2,
      unplaced: 0,
      perReviewer: [{ userId: sam.id, assigned: 2, total: 2 }],
    });
    const again = await alice.mutation(api.reviews.autoDistribute, {
      eventSlug,
      roundId,
      proposalIds: acceptedAndDeclined,
    });
    expect(again.assigned).toBe(0);

    const queue = await sam.as.query(api.reviews.myAssignments, { eventSlug });
    expect(queue).toHaveLength(2);
    expect(queue.map((row) => row.proposal._id).sort()).toEqual(
      [...acceptedAndDeclined].sort(),
    );
    expect(queue.every((row) => row.round.roundId === roundId)).toBe(true);
    expect(await proposalStatuses(t, acceptedAndDeclined)).toEqual([
      "accepted",
      "declined",
    ]);
  });

  test("conflict of interest removes the item from the actionable queue (ABS-12)", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });
    const reviewId = (
      await rita.as.query(api.reviews.myAssignments, { eventSlug })
    )[0].reviewId;
    await rita.as.mutation(api.reviews.declareConflict, {
      eventSlug,
      expectedContentVersion: 0,
      reviewId,
      note: "Former colleague.",
    });

    const mine = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(mine[0].status).toBe("conflict");
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        expectedContentVersion: 0,
        reviewId,
        answers: { score: 3 },
      }),
      "invalid_status",
    );

    // Organizer sees the conflict note and the progress board counts it.
    const summary = await alice.query(api.reviews.summary, {
      eventSlug,
      proposalId: proposalIds[0],
    });
    expect(summary.reviews[0]).toMatchObject({
      status: "conflict",
      conflictNote: "Former colleague.",
    });
    expect(summary.aggregate).toMatchObject({
      count: 0,
      conflictCount: 1,
      submittedCount: 0,
    });
    expect(
      (await alice.query(api.reviews.progress, { eventSlug }))[proposalIds[0]],
    ).toMatchObject({ assigned: 0, submitted: 0, conflicts: 1 });
    const board = await alice.query(api.reviews.reviewerProgress, {
      eventSlug,
    });
    const ritaRow = board.find((r) => r.name === "rita")!;
    expect(ritaRow.conflicts).toBe(1);
    expect(ritaRow.assigned).toBe(0);
  });

  test("reviewerProgress counts and remind emails the laggards (ABS-08/09)", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    const rita = await reviewerFor(t, eventSlug, "rita");
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });

    let board = await alice.query(api.reviews.reviewerProgress, { eventSlug });
    expect(board.find((r) => r.name === "rita")).toMatchObject({
      assigned: 2,
      submitted: 0,
    });

    const reminded = await alice.mutation(api.reviews.remind, {
      eventSlug,
      reviewerUserIds: [rita.id],
    });
    expect(reminded).toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
      skippedNothingOutstanding: 0,
      skippedNoAddress: 0,
    });
    const reminder = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .collect()
        .then((rows) => rows.find((m) => m.kind === "review.reminder")),
    );
    expect(reminder?.toEmail).toBe("rita@example.com");
    expect(reminder?.subject).toContain("2 reviews waiting");

    let refused: { sent: number; failed: number; skipped: number } | undefined;
    await withEnv("RESEND_TEST_MODE", undefined, async () => {
      refused = await alice.mutation(api.reviews.remind, {
        eventSlug,
        reviewerUserIds: [rita.id],
      });
    });
    expect(refused).toEqual({
      sent: 0,
      failed: 1,
      skipped: 0,
      skippedNothingOutstanding: 0,
      skippedNoAddress: 0,
    });

    const mine = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      expectedContentVersion: 0,
      reviewId: mine[0].reviewId,
      answers: { score: 4, recommendation: "Accept" },
    });
    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      expectedContentVersion: 0,
      reviewId: mine[1].reviewId,
      answers: { score: 5, recommendation: "Accept" },
    });
    board = await alice.query(api.reviews.reviewerProgress, { eventSlug });
    expect(board.find((r) => r.name === "rita")).toMatchObject({
      assigned: 2,
      submitted: 2,
    });
    // Nothing outstanding → the nudge is skipped, not sent.
    expect(
      await alice.mutation(api.reviews.remind, {
        eventSlug,
        reviewerUserIds: [rita.id],
      }),
      // W5: the skip is counted BY REASON — nothing outstanding, not a
      // missing address — so the bulk bar can say which.
    ).toEqual({
      sent: 0,
      failed: 0,
      skipped: 1,
      skippedNothingOutstanding: 1,
      skippedNoAddress: 0,
    });
  });

  test("legacy reviews read through the default round and keep their content", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    // Assignment with no rounds configured materializes the default round.
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });
    // Plant a pre-W2 row shape: legacy columns, no roundId/answers.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("reviews")
        .collect()
        .then((rows) => rows[0]);
      await ctx.db.patch("reviews", row._id, {
        roundId: undefined,
        answers: undefined,
        status: "submitted",
        score: 4,
        recommendation: "accept",
        comments: "Looks good.",
        submittedAt: Date.now(),
      });
    });

    const mine = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(mine[0].round.name).toBe("Initial Review");
    expect(mine[0].answers).toEqual({
      score: 4,
      recommendation: "Accept",
      comments: "Looks good.",
    });
    const summary = await alice.query(api.reviews.summary, {
      eventSlug,
      proposalId: proposalIds[0],
    });
    expect(summary.aggregate.avgScore).toBe(4);
  });

  test("summary fails closed instead of silently truncating over 200 reviews", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("missing event");
      for (let index = 0; index < 201; index += 1) {
        await ctx.db.insert("reviews", {
          eventId: event._id,
          proposalId: proposalIds[0],
          reviewerUserId: rita.id,
          status: "assigned",
          updatedAt: Date.now() + index,
        });
      }
    });

    await expectRejectedWith(
      alice.query(api.reviews.summary, {
        eventSlug,
        proposalId: proposalIds[0],
      }),
      "event_too_large",
    );
  });
});

// ── Guided launch (W11) ──────────────────────────────────────────────────
//
// The flow's contract is that the organizer reads sentences about what will
// happen and then that exact thing happens: one planner, previewed and
// applied, refusing to apply a plan the world has moved out from under.

const LAUNCH_SCORECARD = [
  { id: "score", label: "Score", kind: "numeric" as const, required: true },
];

async function roundWithPool(
  t: TestT,
  alice: TestUserT,
  eventSlug: string,
  options: {
    reviewers: Array<string>;
    anonymized?: boolean;
    reviewerCap?: number;
  },
): Promise<{
  roundId: Id<"reviewRounds">;
  reviewers: Array<{ as: TestUserT; id: Id<"users"> }>;
}> {
  const roundId = await alice.mutation(api.reviews.createRound, {
    eventSlug,
    name: "Launch Round",
    anonymized: options.anonymized ?? false,
    reviewerCap: options.reviewerCap,
    scorecard: LAUNCH_SCORECARD,
  });
  const reviewers = [];
  for (const key of options.reviewers) {
    const reviewer = await reviewerFor(t, eventSlug, key);
    await alice.mutation(api.reviews.addRoundReviewer, {
      eventSlug,
      roundId,
      userId: reviewer.id,
    });
    reviewers.push(reviewer);
  }
  return { roundId, reviewers };
}

describe("reviews.launch (W11)", () => {
  test("the preview's sentences describe exactly the assignments the launch writes", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    const { roundId, reviewers } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita"],
      anonymized: true,
      reviewerCap: 2,
    });

    const preview = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
    });
    expect(preview.newAssignments).toBe(2);
    expect(preview.sentences).toContain(
      "2 proposals will be assigned to rita.",
    );
    expect(preview.sentences).toContain(
      "Reviewer identities are hidden: speaker names and every identity answer are removed from what reviewers see.",
    );
    expect(preview.sentences).toContain("Cap: 2 proposals per reviewer.");

    const outcome = await alice.mutation(api.reviews.launchRound, {
      eventSlug,
      roundId,
      fingerprint: preview.fingerprint,
    });
    expect(outcome.assigned).toBe(2);
    expect(outcome.sentences[0]).toBe(
      "2 assignments created across 2 selected proposals.",
    );
    expect(outcome.sentences).toContain(
      "2 proposals assigned to rita — 2 in this round in total.",
    );

    // The rows agree with the sentence, and the reviewer's queue with both.
    const mine = await reviewers[0].as.query(api.reviews.myAssignments, {
      eventSlug,
    });
    expect(mine.map((row) => row.proposal._id).sort()).toEqual(
      [...proposalIds].sort(),
    );
    expect(await auditActions(t)).toContain("review.launch");
  });

  test("released decisions are named in the summary and left untouched by the launch", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    await releaseOppositeDecisions(alice, eventSlug, [
      proposalIds[0],
      proposalIds[1],
    ]);
    const { roundId } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita"],
    });

    const preview = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
    });
    expect(preview.decidedCount).toBe(2);
    expect(preview.sentences).toContain(
      "Both already have released decisions; those decisions will not change.",
    );
    expect(preview.sentences).toContain(
      "Speaker identities are visible to reviewers — this round is not blind.",
    );
    expect(preview.sentences).toContain(
      "No per-reviewer cap: reviewers take as many proposals as the split gives them.",
    );

    await alice.mutation(api.reviews.launchRound, {
      eventSlug,
      roundId,
      fingerprint: preview.fingerprint,
    });
    expect(await proposalStatuses(t, proposalIds)).toEqual([
      "accepted",
      "declined",
    ]);
  });

  test("a cap that cannot be met is stated, not silently dropped", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventWithProposals(t, 2);
    const { roundId } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita"],
      reviewerCap: 1,
    });

    const preview = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
    });
    expect(preview.newAssignments).toBe(1);
    expect(preview.unplaced).toBe(1);
    expect(preview.sentences).toContain(
      "1 review slot cannot be filled — every eligible reviewer is already at the cap.",
    );
    const outcome = await alice.mutation(api.reviews.launchRound, {
      eventSlug,
      roundId,
      fingerprint: preview.fingerprint,
    });
    expect(outcome.assigned).toBe(1);
    expect(outcome.unplaced).toBe(1);
  });

  test("a plan the world moved under is refused rather than applied", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    const { roundId, reviewers } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita"],
    });

    const preview = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
    });
    // Another organizer assigns one of the same proposals by hand.
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      roundId,
      proposalIds: [proposalIds[0]],
      reviewerUserId: reviewers[0].id,
    });

    await expectRejectedWith(
      alice.mutation(api.reviews.launchRound, {
        eventSlug,
        roundId,
        fingerprint: preview.fingerprint,
      }),
      "plan_stale",
    );
    // Nothing beyond the manual assignment was written.
    const board = await alice.query(api.reviews.reviewerProgress, {
      eventSlug,
    });
    expect(board.find((row) => row.name === "rita")?.assigned).toBe(1);

    // Re-previewing produces a plan that applies cleanly.
    const fresh = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
    });
    expect(fresh.fingerprint).not.toBe(preview.fingerprint);
    expect(
      (
        await alice.mutation(api.reviews.launchRound, {
          eventSlug,
          roundId,
          fingerprint: fresh.fingerprint,
        })
      ).assigned,
    ).toBe(1);
  });

  test("the zero case explains itself instead of printing a zero", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventWithProposals(t, 2);
    const { roundId } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita"],
    });

    const first = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
    });
    await alice.mutation(api.reviews.launchRound, {
      eventSlug,
      roundId,
      fingerprint: first.fingerprint,
    });

    const again = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
    });
    expect(again.newAssignments).toBe(0);
    expect(again.sentences[0]).toBe(
      "No new assignments: both selected proposals are already assigned.",
    );
    const outcome = await alice.mutation(api.reviews.launchRound, {
      eventSlug,
      roundId,
      fingerprint: again.fingerprint,
    });
    expect(outcome.assigned).toBe(0);
    expect(outcome.sentences).toEqual([
      "No new assignments: both selected proposals are already assigned.",
    ]);
  });

  test("an empty pool is described, and refused at the write", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventWithProposals(t, 1);
    const roundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Empty",
      anonymized: false,
      scorecard: LAUNCH_SCORECARD,
    });
    const preview = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
    });
    expect(preview.sentences[0]).toBe(
      "This round has no reviewers yet, so nothing will be assigned.",
    );
    await expectRejectedWith(
      alice.mutation(api.reviews.launchRound, {
        eventSlug,
        roundId,
        fingerprint: preview.fingerprint,
      }),
      "empty_pool",
    );
  });

  test("preview as reviewer returns the reviewer query's own projection", async () => {
    const t = setupTest();
    const identityBioId = "speaker-bio-profile";
    const proposalBioId = "speaker-bio-session";
    const def = starterFormDef();
    def.sections[0].fields.push({
      id: identityBioId,
      kind: "textarea",
      label: "Speaker bio",
      required: false,
    });
    def.sections[1].fields.push({
      id: proposalBioId,
      kind: "textarea",
      label: "Session context",
      required: false,
    });
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1, {
      form: def,
      answers: {
        [identityBioId]: "Identity profile answer for a named employer.",
        [proposalBioId]: "Session-only context reviewers need.",
      },
    });
    const { roundId, reviewers } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita"],
      anonymized: true,
    });
    const preview = await alice.query(api.reviews.reviewerPreview, {
      eventSlug,
      roundId,
    });
    if (preview === null) throw new Error("expected a sample proposal");
    expect(preview.anonymized).toBe(true);
    expect(preview.hiddenFieldLabels).toContain("Speaker bio");
    expect(preview.hiddenSpeakerCount).toBe(1);

    // The organizer's preview and the reviewer's own view are the SAME
    // projection — field for field, not merely similar.
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      roundId,
      proposalIds,
      reviewerUserId: reviewers[0].id,
    });
    const mine = await reviewers[0].as.query(api.reviews.myAssignments, {
      eventSlug,
    });
    expect(preview.proposal).toEqual(mine[0].proposal);
    const payload = JSON.stringify(preview.proposal);
    expect(payload).not.toContain("Speaker0");
    expect(payload).not.toContain("speaker0@example.com");
    expect(payload).not.toContain("Identity profile answer");
  });

  test("a reviewer cannot reach any of the launch surfaces", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventWithProposals(t, 1);
    const { roundId } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita"],
    });
    const rita = await signIn(t, "rita");

    await expectRejectedWith(
      rita.query(api.reviews.launchPreview, { eventSlug, roundId }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.query(api.reviews.eligibleProposals, { eventSlug, roundId }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.query(api.reviews.reviewerPreview, { eventSlug, roundId }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.mutation(api.reviews.launchRound, {
        eventSlug,
        roundId,
        fingerprint: "whatever",
      }),
      "forbidden",
    );
  });

  test("the eligible set carries what the choice needs", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    await releaseOppositeDecisions(alice, eventSlug, [
      proposalIds[0],
      proposalIds[1],
    ]);
    const { roundId, reviewers } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita"],
    });
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      roundId,
      proposalIds: [proposalIds[0]],
      reviewerUserId: reviewers[0].id,
    });

    const eligible = await alice.query(api.reviews.eligibleProposals, {
      eventSlug,
      roundId,
    });
    expect(eligible).toHaveLength(2);
    expect(
      eligible.find((row) => row.proposalId === proposalIds[0]),
    ).toMatchObject({ assigned: 1, decisionReleased: true });
    expect(
      eligible.find((row) => row.proposalId === proposalIds[1]),
    ).toMatchObject({ assigned: 0, decisionReleased: true });
  });

  test("a narrowed selection only plans the proposals it names", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 3);
    const { roundId } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita"],
    });
    const preview = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
      proposalIds: [proposalIds[0]],
    });
    expect(preview.candidateCount).toBe(1);
    expect(preview.sentences).toContain("1 proposal will be assigned to rita.");
    const outcome = await alice.mutation(api.reviews.launchRound, {
      eventSlug,
      roundId,
      proposalIds: [proposalIds[0]],
      fingerprint: preview.fingerprint,
    });
    expect(outcome.assigned).toBe(1);
  });
});

// ── Draft rounds (W11 review) ────────────────────────────────────────────
//
// The launch flow materializes a round before the organizer has decided
// anything. Until it launches, that round is a PLAN: it must not reach a
// reviewer, must not accept assignments, and must not stand in as the round
// legacy review rows and readiness counts read through. Absence of the marker
// means launched, so every row written before the field existed is unchanged.

describe("reviews draft rounds", () => {
  test("a draft round reaches no reviewer and accepts no assignment until launch", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 2);
    const rita = await reviewerFor(t, eventSlug, "rita");
    const roundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Being built",
      anonymized: true,
      draft: true,
      scorecard: LAUNCH_SCORECARD,
    });
    await alice.mutation(api.reviews.addRoundReviewer, {
      eventSlug,
      roundId,
      userId: rita.id,
    });

    // Visible to the organizer's plan list, AS a draft.
    const listed = await alice.query(api.reviews.listRounds, { eventSlug });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "Being built", draft: true });

    // …and to nothing else.
    expect(
      await alice.query(api.reviews.reviewerProgress, { eventSlug }),
    ).toEqual([]);
    expect(
      await rita.as.query(api.reviews.myAssignments, { eventSlug }),
    ).toEqual([]);
    await expectRejectedWith(
      alice.mutation(api.reviews.autoDistribute, { eventSlug, roundId }),
      "invalid_status",
    );
    await expectRejectedWith(
      alice.mutation(api.reviews.assign, {
        eventSlug,
        roundId,
        proposalIds,
        reviewerUserId: rita.id,
      }),
      "invalid_status",
    );

    // Launching is what flips all of it.
    const preview = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
    });
    await alice.mutation(api.reviews.launchRound, {
      eventSlug,
      roundId,
      fingerprint: preview.fingerprint,
    });
    const afterLaunch = await alice.query(api.reviews.listRounds, {
      eventSlug,
    });
    expect(afterLaunch[0].draft).toBe(false);
    expect(
      (await rita.as.query(api.reviews.myAssignments, { eventSlug })).length,
    ).toBe(2);
    expect(
      (await alice.query(api.reviews.reviewerProgress, { eventSlug })).find(
        (row) => row.name === "rita",
      )?.assigned,
    ).toBe(2);
  });

  test("a draft round never stands in as the default round, in assignment or in readiness", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    // A draft round is created FIRST, and its window already closed.
    const draftRoundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Being built",
      anonymized: false,
      draft: true,
      closesAt: Date.parse("2026-01-01"),
      scorecard: LAUNCH_SCORECARD,
    });
    // An assignment naming no round must materialize/choose a LIVE round.
    await alice.mutation(api.reviews.assign, {
      eventSlug,
      proposalIds,
      reviewerUserId: rita.id,
    });
    const mine = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(mine[0].round.roundId).not.toBe(draftRoundId);
    expect(mine[0].round.name).toBe("Initial Review");

    // …and the draft's closed window must not make anyone overdue.
    const panel = await alice.query(api.readiness.attentionPanel, {
      eventSlug,
      now: Date.parse("2026-08-01"),
    });
    const reviews = panel.rows.find((row) => row.id === "reviews");
    expect(reviews?.count).toBe(1);
    expect(reviews?.sentence).toBe(
      "1 assigned review has not been submitted.",
    );
  });

  test("reviews per proposal is refused, not clamped, when it is not a whole number of at least 1", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventWithProposals(t, 1);
    const { roundId } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita"],
    });
    for (const perProposal of [0, 1.5, Number.NaN]) {
      await expectRejectedWith(
        alice.mutation(api.reviews.autoDistribute, {
          eventSlug,
          roundId,
          perProposal,
        }),
        "invalid_cap",
      );
      await expectRejectedWith(
        alice.query(api.reviews.launchPreview, {
          eventSlug,
          roundId,
          perProposal,
        }),
        "invalid_cap",
      );
    }
  });

  test("the same selection in a different order is the same plan and the same fingerprint", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 3);
    const { roundId } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita", "raj"],
    });
    const forward = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
      proposalIds,
    });
    const reversed = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
      proposalIds: [...proposalIds].reverse(),
    });
    expect(reversed.fingerprint).toBe(forward.fingerprint);
    expect(reversed.sentences).toEqual(forward.sentences);
    expect(reversed.perReviewer).toEqual(forward.perReviewer);
  });

  test("an edit that only changes the SUMMARY still refuses the stale plan", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await eventWithProposals(t, 2);
    const { roundId } = await roundWithPool(t, alice, eventSlug, {
      reviewers: ["rita"],
    });
    const preview = await alice.query(api.reviews.launchPreview, {
      eventSlug,
      roundId,
    });
    // The scorecard shapes no assignment — but it does shape what the
    // organizer was told this round asks reviewers.
    await alice.mutation(api.reviews.updateRound, {
      eventSlug,
      roundId,
      name: "Launch Round",
      anonymized: false,
      scorecard: [
        ...LAUNCH_SCORECARD,
        { id: "comments", label: "Comments", kind: "text" as const },
      ],
    });
    await expectRejectedWith(
      alice.mutation(api.reviews.launchRound, {
        eventSlug,
        roundId,
        fingerprint: preview.fingerprint,
      }),
      "plan_stale",
    );
  });
});
