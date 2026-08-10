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
import { starterFormDef } from "./model/cfp";

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
      answers: { score: 4, recommendation: "Accept" },
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
    expect(inProgress.aggregate).toMatchObject({ count: 2, submittedCount: 0 });
    expect(inProgress.aggregate.avgScore).toBeNull();
    const draftRow = inProgress.reviews.find((r) => r.status === "draft")!;
    expect(draftRow.comments).toBeUndefined();
    expect(draftRow.answers).toBeUndefined();
    expect(draftRow.reviewerEmail).toBe("rita@example.com");

    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      reviewId: ritaReview,
      answers: { score: 5, recommendation: "Accept", comments: "Strong." },
    });
    await raj.as.mutation(api.reviews.submit, {
      eventSlug,
      reviewId: rajReview,
      answers: { score: 2, recommendation: "Reject" },
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
        reviewId,
        answers: { score: 6 },
      }),
      "invalid_answers",
    );
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        reviewId,
        answers: { score: 3.5 },
      }),
      "invalid_answers",
    );
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
        reviewId,
        answers: { comments: "x".repeat(5001) },
      }),
      "invalid_answers",
    );

    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      reviewId,
      answers: { score: 4, recommendation: "Accept" },
    });
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
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
        reviewId: ritaReview,
        answers: { comments: "not mine" },
      }),
      "not_found",
    );
    await expectRejectedWith(
      raj.as.mutation(api.reviews.submit, {
        eventSlug,
        reviewId: ritaReview,
        answers: { score: 1, recommendation: "Reject" },
      }),
      "not_found",
    );
    // Even the organizer cannot write someone else's review.
    await expectRejectedWith(
      alice.mutation(api.reviews.submit, {
        eventSlug,
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
        { id: "orig", label: "Originality", kind: "numeric", min: 1, max: 5, weight: 2, required: true },
        { id: "rel", label: "Relevance", kind: "numeric", min: 1, max: 5, weight: 1, required: true },
        { id: "rec", label: "Recommendation", kind: "dropdown", options: ["Accept", "Maybe", "Reject"], required: true },
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
        { id: "final", label: "Final Score", kind: "numeric", min: 1, max: 10, required: true },
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
    expect(rounds[0]).toMatchObject({ name: "Initial Review", anonymized: true });
    expect(rounds[0].scorecard.map((f) => f.kind)).toEqual([
      "numeric", "numeric", "dropdown", "text",
    ]);
    expect(rounds[0].scorecard[0].weight).toBe(2);
    expect(rounds[0].pool.map((m) => m.name)).toEqual(["rita"]);
    expect(rounds[1]).toMatchObject({ name: "Final Review", anonymized: false });
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

  test("weighted scorecard: the aggregate reflects the weights (ABS-04)", async () => {
    const t = setupTest();
    const { alice, eventSlug, proposalIds } = await eventWithProposals(t, 1);
    const rita = await reviewerFor(t, eventSlug, "rita");
    const roundId = await alice.mutation(api.reviews.createRound, {
      eventSlug,
      name: "Initial Review",
      anonymized: false,
      scorecard: [
        { id: "orig", label: "Originality", kind: "numeric", weight: 2, required: true },
        { id: "rel", label: "Relevance", kind: "numeric", weight: 1, required: true },
        { id: "rec", label: "Recommendation", kind: "dropdown", options: ["Accept", "Maybe", "Reject"], required: true },
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
      scorecard: [{ id: "score", label: "Score", kind: "numeric", required: true }],
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
      scorecard: [{ id: "score", label: "Score", kind: "numeric", required: true }],
    });
    await alice.mutation(api.reviews.addRoundReviewer, { eventSlug, roundId, userId: rita.id });
    await alice.mutation(api.reviews.addRoundReviewer, { eventSlug, roundId, userId: raj.id });

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
      reviewId,
      note: "Former colleague.",
    });

    const mine = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    expect(mine[0].status).toBe("conflict");
    await expectRejectedWith(
      rita.as.mutation(api.reviews.saveDraft, {
        eventSlug,
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
    const board = await alice.query(api.reviews.reviewerProgress, { eventSlug });
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
    expect(reminded).toEqual({ sent: 1, skipped: 0 });
    const reminder = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .collect()
        .then((rows) => rows.find((m) => m.kind === "review.reminder")),
    );
    expect(reminder?.toEmail).toBe("rita@example.com");
    expect(reminder?.subject).toContain("2 reviews waiting");

    const mine = await rita.as.query(api.reviews.myAssignments, { eventSlug });
    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
      reviewId: mine[0].reviewId,
      answers: { score: 4, recommendation: "Accept" },
    });
    await rita.as.mutation(api.reviews.submit, {
      eventSlug,
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
    ).toEqual({ sent: 0, skipped: 1 });
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
});
