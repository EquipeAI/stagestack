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
async function eventWithProposals(t: TestT, count: number) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
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
      answers: { ...ANSWERS, talkTitle: `Talk ${i}` },
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

  test("rejects a non-member reviewer, a foreign proposal, and a draft proposal", async () => {
    const t = setupTest();
    const { alice, orgSlug, eventSlug, proposalIds } =
      await eventWithProposals(t, 1);
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
    const draftId = await drafter.mutation(api.cfp.startProposal, { eventSlug });
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

    const before = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      reviewId: before[0].reviewId,
      score: 4,
      recommendation: "accept",
    });

    const after = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(after[0].status).toBe("assigned");
    expect(after[1].status).toBe("submitted");
  });
});

describe("reviews.saveDraft / submit", () => {
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
      reviewId: ritaReview,
      comments: "Halfway through.",
    });
    let mine = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(mine[0].status).toBe("draft");
    expect(mine[0].comments).toBe("Halfway through.");
    expect(mine[0].score).toBeUndefined();

    // The organizer sees an unfinished review's STATUS but not its content.
    const inProgress = await alice.query(api.reviews.summary, {
      eventSlug,
      proposalId: proposalIds[0],
    });
    expect(inProgress.aggregate).toMatchObject({ count: 2, submittedCount: 0 });
    expect(inProgress.aggregate.avgScore).toBeNull();
    const draftRow = inProgress.reviews.find((r) => r.status === "draft")!;
    expect(draftRow.comments).toBeUndefined();
    expect(draftRow.reviewerEmail).toBe("rita@example.com");

    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      reviewId: ritaReview,
      score: 5,
      recommendation: "accept",
      comments: "Strong.",
    });
    await raj.as.mutation(api.reviews.submit, {
      eventSlug,
      reviewId: rajReview,
      score: 2,
      recommendation: "decline",
    });

    const summary = await alice.query(api.reviews.summary, {
      eventSlug,
      proposalId: proposalIds[0],
    });
    expect(summary.aggregate).toEqual({
      count: 2,
      submittedCount: 2,
      avgScore: 3.5,
      recommendations: { accept: 1, decline: 1, neutral: 0 },
    });
    expect(
      summary.reviews.find((r) => r.reviewerName === "rita"),
    ).toMatchObject({ score: 5, recommendation: "accept", comments: "Strong." });

    const progress = await alice.query(api.reviews.progress, { eventSlug });
    expect(progress[proposalIds[0]]).toEqual({
      assigned: 2,
      submitted: 2,
      avgScore: 3.5,
    });

    // Revising a submitted review overwrites it and keeps submittedAt.
    const submittedAt = summary.reviews.find(
      (r) => r.reviewerName === "rita",
    )!.submittedAt;
    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      reviewId: ritaReview,
      score: 3,
      recommendation: "neutral",
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
        reviewId,
        score: 6,
      }),
      "invalid_score",
    );
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        reviewId,
        score: 3.5,
      }),
      "invalid_score",
    );
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        reviewId,
        comments: "x".repeat(5001),
      }),
      "invalid_comments",
    );

    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      reviewId,
      score: 4,
      recommendation: "accept",
    });
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        reviewId,
        comments: "sneaky edit",
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
        reviewId: ritaReview,
        comments: "not mine",
      }),
      "not_found",
    );
    await expectRejectedWith(
      raj.as.mutation(api.reviews.submit, {
        eventSlug,
        reviewId: ritaReview,
        score: 1,
        recommendation: "decline",
      }),
      "not_found",
    );
    // Even the organizer cannot write someone else's review.
    await expectRejectedWith(
      alice.mutation(api.reviews.submit, {
        eventSlug,
        reviewId: ritaReview,
        score: 5,
        recommendation: "accept",
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
      reviewId: mine[1].reviewId,
      score: 4,
      recommendation: "accept",
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
