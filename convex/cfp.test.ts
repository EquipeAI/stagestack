import { describe, expect, test } from "vitest";
import type { EmailId } from "@convex-dev/resend";
import { api, internal } from "./_generated/api";
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
import type { FormDef } from "./shared/formDef";

// Starter-form ids for the two organizer-authored example fields (systemKey
// fields use the systemKey itself as the id).
const FORMAT_FIELD = "session-format-s1";
const NOTES_FIELD = "anything-else-we-should-know-s2";

const FULL_ANSWERS: Record<string, string> = {
  firstName: "Bob",
  lastName: "Speaker",
  email: "bob@example.com",
  talkTitle: "Convex in anger",
  abstract: "Everything we learned shipping a reactive backend.",
};

async function messageRows(t: TestT) {
  return await t.run(async (ctx) => ctx.db.query("messages").collect());
}

async function proposalRows(t: TestT) {
  return await t.run(async (ctx) => ctx.db.query("proposals").collect());
}

/** Publish the form AND flip the event's public CFP switch (independent
 * controls by design). */
async function openCfp(as: TestUserT, eventSlug: string): Promise<void> {
  await as.mutation(api.cfp.publishForm, { eventSlug });
  await as.mutation(api.events.updateSettings, {
    eventSlug,
    patch: { cfpPublished: true },
  });
}

/** Org owner + open CFP + a signed-in submitter who is NOT a member. */
async function openEventWithSubmitter(t: TestT) {
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
  await openCfp(alice, eventSlug);
  return { alice, bob, orgSlug, eventSlug };
}

async function readyProposal(t: TestT) {
  const ctx = await openEventWithSubmitter(t);
  const proposalId = await ctx.bob.mutation(api.cfp.startProposal, {
    eventSlug: ctx.eventSlug,
  });
  await ctx.bob.mutation(api.cfp.saveAnswers, {
    proposalId,
    answers: FULL_ANSWERS,
  });
  await ctx.bob.mutation(api.cfp.setSpeakers, {
    proposalId,
    speakers: [
      {
        firstName: "Bob",
        lastName: "Speaker",
        email: "bob@example.com",
        isPrimary: true,
      },
    ],
  });
  return { ...ctx, proposalId };
}

describe("cfp starter form", () => {
  test("every new event is created with the starter form", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    const form = await alice.query(api.cfp.getForm, { eventSlug });
    expect(form.version).toBe(0);
    expect(form.published).toBeNull();
    expect(form.publishedAt).toBeNull();
    expect(form.working.sections.map((s) => s.title)).toEqual([
      "About you",
      "Your session",
    ]);

    const fields = form.working.sections.flatMap((s) => s.fields);
    expect(fields.flatMap((f) => (f.systemKey ? [f.systemKey] : [])).sort()).toEqual(
      ["abstract", "email", "firstName", "lastName", "talkTitle"],
    );
    // System fields are required and keyed by their systemKey.
    for (const f of fields.filter((f) => f.systemKey !== undefined)) {
      expect(f.required).toBe(true);
      expect(f.id).toBe(f.systemKey);
    }
    const format = fields.find((f) => f.id === FORMAT_FIELD);
    expect(format?.kind).toBe("dropdown");
    expect(format?.options).toEqual(["Talk", "Workshop", "Panel"]);
    expect(fields.find((f) => f.id === NOTES_FIELD)?.required).toBe(false);

    // Seeding the form is not a separate audited action.
    expect(await auditActions(t)).toEqual(["org.create", "event.create"]);
  });
});

describe("cfp.updateWorkingForm validation", () => {
  async function organizer(t: TestT) {
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    return { alice, eventSlug };
  }

  test("rejects a form missing a system field", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizer(t);
    const def = starterFormDef();
    def.sections[1].fields = def.sections[1].fields.filter(
      (f) => f.systemKey !== "abstract",
    );
    await expectRejectedWith(
      alice.mutation(api.cfp.updateWorkingForm, { eventSlug, def }),
      "invalid_form",
    );
  });

  test("rejects a system field that is no longer required", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizer(t);
    const def = starterFormDef();
    def.sections[1].fields[0].required = false;
    await expectRejectedWith(
      alice.mutation(api.cfp.updateWorkingForm, { eventSlug, def }),
      "invalid_form",
    );
  });

  test("rejects duplicate field ids", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizer(t);
    const def = starterFormDef();
    def.sections[1].fields.push({
      id: FORMAT_FIELD,
      kind: "text",
      label: "Copycat",
      required: false,
    });
    await expectRejectedWith(
      alice.mutation(api.cfp.updateWorkingForm, { eventSlug, def }),
      "invalid_form",
    );
  });

  test("rejects a malformed field id", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizer(t);
    const def = starterFormDef();
    def.sections[1].fields.push({
      id: "1-leading-digit",
      kind: "text",
      label: "Nope",
      required: false,
    });
    await expectRejectedWith(
      alice.mutation(api.cfp.updateWorkingForm, { eventSlug, def }),
      "invalid_form",
    );
  });

  test("rejects a choice field with no options", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizer(t);
    const def = starterFormDef();
    def.sections[1].fields.push({
      id: "empty-choice",
      kind: "dropdown",
      label: "Pick one",
      required: false,
    });
    await expectRejectedWith(
      alice.mutation(api.cfp.updateWorkingForm, { eventSlug, def }),
      "invalid_form",
    );
  });

  test("rejects visibleIf pointing at itself or at a missing field", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizer(t);

    const selfRef = starterFormDef();
    selfRef.sections[1].fields.push({
      id: "self-ref",
      kind: "text",
      label: "Self referential",
      required: false,
      visibleIf: { fieldId: "self-ref", op: "equals", value: "x" },
    });
    await expectRejectedWith(
      alice.mutation(api.cfp.updateWorkingForm, { eventSlug, def: selfRef }),
      "invalid_form",
    );

    const missingRef = starterFormDef();
    missingRef.sections[1].fields.push({
      id: "dangling",
      kind: "text",
      label: "Dangling",
      required: false,
      visibleIf: { fieldId: "no-such-field", op: "equals", value: "x" },
    });
    await expectRejectedWith(
      alice.mutation(api.cfp.updateWorkingForm, { eventSlug, def: missingRef }),
      "invalid_form",
    );
  });

  test("accepts a valid edit and publishing bumps the version", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizer(t);
    const def = starterFormDef();
    def.sections[1].fields.push({
      id: "travel-support",
      kind: "radio",
      label: "Do you need travel support?",
      required: false,
      options: ["Yes", "No"],
    });
    await alice.mutation(api.cfp.updateWorkingForm, { eventSlug, def });

    const before = await alice.query(api.cfp.getForm, { eventSlug });
    expect(before.published).toBeNull();
    expect(before.working.sections[1].fields.at(-1)?.id).toBe("travel-support");

    const { version } = await alice.mutation(api.cfp.publishForm, { eventSlug });
    expect(version).toBe(1);
    const after = await alice.query(api.cfp.getForm, { eventSlug });
    expect(after.published?.sections[1].fields.at(-1)?.id).toBe(
      "travel-support",
    );
    expect(after.publishedAt).toBeGreaterThan(0);
    expect(await auditActions(t)).toContain("cfp.publishForm");
  });
});

describe("cfpPublic.get", () => {
  test("returns nothing until the form is published AND the event opts in", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    expect(await t.query(api.cfpPublic.get, { eventSlug })).toBeNull();
    expect(await t.query(api.cfpPublic.get, { eventSlug: "nope" })).toBeNull();

    // Published form, but the event still hasn't opened its CFP publicly.
    await alice.mutation(api.cfp.publishForm, { eventSlug });
    expect(await t.query(api.cfpPublic.get, { eventSlug })).toBeNull();

    await alice.mutation(api.cfp.updateFormSettings, {
      eventSlug,
      successMessage: "  See you on stage!  ",
    });
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { cfpPublished: true, location: "Berlin" },
    });

    // Unauthenticated read works.
    const published = await t.query(api.cfpPublic.get, { eventSlug });
    expect(published).not.toBeNull();
    expect(published!.event).toMatchObject({
      name: "Acme Summit",
      slug: eventSlug,
      location: "Berlin",
    });
    expect(published!.version).toBe(1);
    expect(published!.successMessage).toBe("See you on stage!");
    expect(published!.form.sections).toHaveLength(2);
  });
});

describe("cfp.startProposal", () => {
  test("rejects an unpublished CFP", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    await expectRejectedWith(
      bob.mutation(api.cfp.startProposal, { eventSlug }),
      "cfp_not_published",
    );
    await expectRejectedWith(
      bob.mutation(api.cfp.startProposal, { eventSlug: "no-such-event" }),
      "not_found",
    );
  });

  test("rejects a closed submission window", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug } = await openEventWithSubmitter(t);
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { cfpCloseAt: Date.now() - 1000 },
    });
    await expectRejectedWith(
      bob.mutation(api.cfp.startProposal, { eventSlug }),
      "cfp_closed",
    );
  });

  test("enforces maxSubmissionsPerUser", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug } = await openEventWithSubmitter(t);
    await alice.mutation(api.cfp.updateFormSettings, {
      eventSlug,
      maxSubmissionsPerUser: 1,
    });

    const first = await bob.mutation(api.cfp.startProposal, { eventSlug });
    await expectRejectedWith(
      bob.mutation(api.cfp.startProposal, { eventSlug }),
      "submission_limit",
    );

    // Withdrawing frees the slot; another user has their own allowance.
    await bob.mutation(api.cfp.withdrawProposal, { proposalId: first });
    await bob.mutation(api.cfp.startProposal, { eventSlug });
    const carol = await signIn(t, "carol");
    await carol.mutation(api.cfp.startProposal, { eventSlug });
  });
});

describe("cfp.saveAnswers", () => {
  test("rejects an unknown field id and a wrong-typed value", async () => {
    const t = setupTest();
    const { bob, eventSlug } = await openEventWithSubmitter(t);
    const proposalId = await bob.mutation(api.cfp.startProposal, { eventSlug });

    await expectRejectedWith(
      bob.mutation(api.cfp.saveAnswers, {
        proposalId,
        answers: { nonsense: "hi" },
      }),
      "invalid_answer",
    );
    // A number where the form wants text.
    await expectRejectedWith(
      bob.mutation(api.cfp.saveAnswers, {
        proposalId,
        answers: { talkTitle: 42 },
      }),
      "invalid_answer",
    );
    // A list where the form wants a single value.
    await expectRejectedWith(
      bob.mutation(api.cfp.saveAnswers, {
        proposalId,
        answers: { [FORMAT_FIELD]: ["Talk"] },
      }),
      "invalid_answer",
    );
    // Over the short-text cap.
    await expectRejectedWith(
      bob.mutation(api.cfp.saveAnswers, {
        proposalId,
        answers: { talkTitle: "x".repeat(501) },
      }),
      "invalid_answer",
    );
  });

  test("full-replaces answers and denormalizes the title", async () => {
    const t = setupTest();
    const { bob, eventSlug } = await openEventWithSubmitter(t);
    const proposalId = await bob.mutation(api.cfp.startProposal, { eventSlug });

    let mine = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(mine.proposal.title).toBe("Untitled proposal");
    expect(mine.windowOpen).toBe(true);
    expect(mine.formVersion).toBe(1);

    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { ...FULL_ANSWERS, [FORMAT_FIELD]: "Workshop" },
    });
    mine = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(mine.proposal.title).toBe("Convex in anger");
    expect(mine.proposal.answers[FORMAT_FIELD]).toBe("Workshop");

    // Replace, don't merge.
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { talkTitle: "Second thoughts" },
    });
    mine = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(mine.proposal.answers).toEqual({ talkTitle: "Second thoughts" });
    expect(mine.proposal.title).toBe("Second thoughts");
  });
});

describe("cfp proposal ownership", () => {
  test("NEGATIVE: another user gets not_found (never forbidden) on read and write", async () => {
    const t = setupTest();
    const { eventSlug, bob } = await openEventWithSubmitter(t);
    const proposalId = await bob.mutation(api.cfp.startProposal, { eventSlug });
    const mallory = await signIn(t, "mallory");

    await expectRejectedWith(
      mallory.query(api.cfp.getMyProposal, { proposalId }),
      "not_found",
    );
    await expectRejectedWith(
      mallory.mutation(api.cfp.saveAnswers, {
        proposalId,
        answers: { talkTitle: "Stolen" },
      }),
      "not_found",
    );
    await expectRejectedWith(
      mallory.mutation(api.cfp.submitProposal, { proposalId }),
      "not_found",
    );
    await expectRejectedWith(
      mallory.mutation(api.cfp.withdrawProposal, { proposalId }),
      "not_found",
    );
    await expectRejectedWith(
      mallory.mutation(api.cfp.generateUploadUrl, { proposalId }),
      "not_found",
    );
    // Even the event's own organizer doesn't own the proposal.
    const alice = await signIn(t, "alice");
    await expectRejectedWith(
      alice.query(api.cfp.getMyProposal, { proposalId }),
      "not_found",
    );
  });

  test("myProposals lists only the caller's proposals, newest first", async () => {
    const t = setupTest();
    const { bob, eventSlug } = await openEventWithSubmitter(t);
    const first = await bob.mutation(api.cfp.startProposal, { eventSlug });
    const second = await bob.mutation(api.cfp.startProposal, { eventSlug });
    const mallory = await signIn(t, "mallory");
    await mallory.mutation(api.cfp.startProposal, { eventSlug });

    const mine = await bob.query(api.cfp.myProposals, {});
    expect(mine).toHaveLength(2);
    expect([...mine.map((r) => r.proposal._id)].sort()).toEqual(
      [first, second].sort(),
    );
    // Newest first.
    expect(mine[0].proposal._creationTime).toBeGreaterThanOrEqual(
      mine[1].proposal._creationTime,
    );
    expect(mine[0].eventSlug).toBe(eventSlug);
    expect(mine[0].eventName).toBe("Acme Summit");
    expect(await mallory.query(api.cfp.myProposals, {})).toHaveLength(1);
  });
});

describe("cfp.submitProposal", () => {
  test("rejects a missing required field and a proposal with no speakers", async () => {
    const t = setupTest();
    const { bob, eventSlug } = await openEventWithSubmitter(t);
    const proposalId = await bob.mutation(api.cfp.startProposal, { eventSlug });

    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { ...FULL_ANSWERS, abstract: "   " },
    });
    await expectRejectedWith(
      bob.mutation(api.cfp.submitProposal, { proposalId }),
      "invalid_submission",
    );

    // Fill the abstract: now only the missing speaker blocks submission.
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: FULL_ANSWERS,
    });
    await expectRejectedWith(
      bob.mutation(api.cfp.submitProposal, { proposalId }),
      "invalid_submission",
    );

    await bob.mutation(api.cfp.setSpeakers, {
      proposalId,
      speakers: [{ firstName: "Bob", lastName: "Speaker", isPrimary: true }],
    });
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    expect(
      (await bob.query(api.cfp.getMyProposal, { proposalId })).proposal.status,
    ).toBe("pending");
  });

  test("rejects a malformed answer for an email-kind field", async () => {
    const t = setupTest();
    const { bob, proposalId } = await readyProposal(t);
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { ...FULL_ANSWERS, email: "not-an-email" },
    });
    await expectRejectedWith(
      bob.mutation(api.cfp.submitProposal, { proposalId }),
      "invalid_submission",
    );
  });

  test("a required field hidden by visibleIf is not required", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    const def: FormDef = starterFormDef();
    def.sections[1].fields.push({
      id: "workshop-length",
      kind: "text",
      label: "Workshop length",
      required: true,
      visibleIf: { fieldId: FORMAT_FIELD, op: "equals", value: "Workshop" },
    });
    await alice.mutation(api.cfp.updateWorkingForm, { eventSlug, def });
    await openCfp(alice, eventSlug);

    const proposalId = await bob.mutation(api.cfp.startProposal, { eventSlug });
    await bob.mutation(api.cfp.setSpeakers, {
      proposalId,
      speakers: [{ firstName: "Bob", lastName: "Speaker", isPrimary: true }],
    });

    // Format = Workshop → the conditional field is visible and required.
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { ...FULL_ANSWERS, [FORMAT_FIELD]: "Workshop" },
    });
    const thrown = await bob
      .mutation(api.cfp.submitProposal, { proposalId })
      .then(
        () => null,
        (e: { data?: { code?: string; message?: string } }) => e.data,
      );
    // It must be the conditional field that blocks — not some other rule.
    expect(thrown?.code).toBe("invalid_submission");
    expect(thrown?.message).toContain("Workshop length");

    // Format = Talk → hidden, therefore not required. This is the M1
    // conditional-logic contract.
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { ...FULL_ANSWERS, [FORMAT_FIELD]: "Talk" },
    });
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    expect(
      (await bob.query(api.cfp.getMyProposal, { proposalId })).proposal.status,
    ).toBe("pending");

    // Answering the condition makes it required again.
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { ...FULL_ANSWERS, [FORMAT_FIELD]: "Workshop" },
    });
    await expectRejectedWith(
      bob.mutation(api.cfp.submitProposal, { proposalId }),
      "invalid_submission",
    );
  });

  test("happy path: confirmation + admin notification are logged, resubmit keeps submittedAt", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await readyProposal(t);
    await alice.mutation(api.cfp.updateFormSettings, {
      eventSlug,
      successMessage: "We'll be in touch.",
    });

    const result = await bob.mutation(api.cfp.submitProposal, { proposalId });
    expect(result.successMessage).toBe("We'll be in touch.");

    const first = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(first.proposal.status).toBe("pending");
    expect(first.proposal.formVersion).toBe(1);
    expect(first.proposal.submittedAt).toBeGreaterThan(0);

    const sent = await messageRows(t);
    expect(sent).toHaveLength(2);
    const confirmation = sent.find((m) => m.kind === "cfp.confirmation")!;
    expect(confirmation.toEmail).toBe("bob@example.com");
    expect(confirmation.subject).toBe(
      "We received your proposal: Convex in anger",
    );
    expect(confirmation.deliveryStatus).toBe("queued");
    expect(confirmation.resendEmailId).toBeTruthy();
    const notification = sent.find((m) => m.kind === "cfp.adminNotification")!;
    // Org owner alice is the only organizer with an email.
    expect(notification.toEmail).toBe("alice@example.com");
    expect(notification.subject).toBe(
      "New proposal for Acme Summit: Convex in anger",
    );

    // Resubmit: same submittedAt, different subject wording.
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { ...FULL_ANSWERS, abstract: "Now with more detail." },
    });
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    const second = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(second.proposal.submittedAt).toBe(first.proposal.submittedAt);
    expect(second.proposal.updatedAt).toBeGreaterThanOrEqual(
      first.proposal.updatedAt,
    );

    const afterResubmit = await messageRows(t);
    expect(afterResubmit).toHaveLength(4);
    expect(afterResubmit.map((m) => m.subject)).toContain(
      "Your updated proposal: Convex in anger",
    );
    expect(afterResubmit.map((m) => m.subject)).toContain(
      "Updated proposal for Acme Summit: Convex in anger",
    );

    const actions = await auditActions(t);
    expect(actions.filter((a) => a === "cfp.submit")).toHaveLength(2);
  });

  test("the Resend webhook patches the comms log by resendEmailId", async () => {
    const t = setupTest();
    const { bob, proposalId } = await readyProposal(t);
    await bob.mutation(api.cfp.submitProposal, { proposalId });

    const [message] = await messageRows(t);
    const emailId = message.resendEmailId! as EmailId;
    await t.mutation(internal.emails.handleEmailEvent, {
      id: emailId,
      event: {
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: {
          created_at: new Date().toISOString(),
          email_id: emailId,
          from: "hello@stagestack.dev",
          to: message.toEmail,
          subject: message.subject,
        },
      },
    });

    const patched = await t.run(async (ctx) =>
      ctx.db.get("messages", message._id),
    );
    expect(patched?.deliveryStatus).toBe("delivered");
  });
});

describe("cfp.withdrawProposal", () => {
  test("a pending proposal becomes withdrawn and organizers are notified", async () => {
    const t = setupTest();
    const { bob, proposalId } = await readyProposal(t);
    await bob.mutation(api.cfp.submitProposal, { proposalId });

    await bob.mutation(api.cfp.withdrawProposal, { proposalId });
    const proposals = await proposalRows(t);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe("withdrawn");
    expect(proposals[0].withdrawnAt).toBeGreaterThan(0);

    const withdrawnMails = (await messageRows(t)).filter(
      (m) => m.kind === "cfp.withdrawn",
    );
    expect(withdrawnMails).toHaveLength(1);
    expect(withdrawnMails[0].toEmail).toBe("alice@example.com");

    // Withdrawing twice is rejected.
    await expectRejectedWith(
      bob.mutation(api.cfp.withdrawProposal, { proposalId }),
      "invalid_status",
    );
    expect(await auditActions(t)).toContain("cfp.withdraw");
  });

  test("a never-submitted draft is deleted outright, speakers and all", async () => {
    const t = setupTest();
    const { bob, proposalId } = await readyProposal(t);

    await bob.mutation(api.cfp.withdrawProposal, { proposalId });
    expect(await proposalRows(t)).toEqual([]);
    expect(
      await t.run(async (ctx) => ctx.db.query("proposalSpeakers").collect()),
    ).toEqual([]);
    // No organizer email for something nobody ever saw.
    expect((await messageRows(t)).filter((m) => m.kind === "cfp.withdrawn"))
      .toEqual([]);
    await expectRejectedWith(
      bob.query(api.cfp.getMyProposal, { proposalId }),
      "not_found",
    );
  });

  test("a released decision cannot be withdrawn by the submitter", async () => {
    const t = setupTest();
    const { bob, proposalId } = await readyProposal(t);
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    await t.run(async (ctx) => {
      await ctx.db.patch("proposals", proposalId, { status: "accepted" });
    });
    await expectRejectedWith(
      bob.mutation(api.cfp.withdrawProposal, { proposalId }),
      "decision_released",
    );
  });
});

describe("cfp.listProposals", () => {
  test("organizers see the event's proposals; reviewers are refused (M2 defines their view)", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await readyProposal(t);
    await bob.mutation(api.cfp.submitProposal, { proposalId });

    const rows = await alice.query(api.cfp.listProposals, { eventSlug });
    expect(rows).toHaveLength(1);
    expect(rows[0].proposal.title).toBe("Convex in anger");
    expect(rows[0].speakerCount).toBe(1);

    expect(
      await alice.query(api.cfp.listProposals, { eventSlug, status: "draft" }),
    ).toEqual([]);
    expect(
      await alice.query(api.cfp.listProposals, { eventSlug, status: "pending" }),
    ).toHaveLength(1);

    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    await expectRejectedWith(
      rita.query(api.cfp.listProposals, { eventSlug }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.query(api.cfp.getForm, { eventSlug }),
      "forbidden",
    );
  });
});

describe("cfp.reopenProposal", () => {
  test("an organizer grants one submitter an edit window past the close date", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await readyProposal(t);
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { cfpCloseAt: Date.now() - 1000 },
    });

    await expectRejectedWith(
      bob.mutation(api.cfp.saveAnswers, {
        proposalId,
        answers: { ...FULL_ANSWERS, abstract: "Late edit." },
      }),
      "cfp_closed",
    );
    expect(
      (await bob.query(api.cfp.getMyProposal, { proposalId })).windowOpen,
    ).toBe(false);

    await expectRejectedWith(
      alice.mutation(api.cfp.reopenProposal, {
        eventSlug,
        proposalId,
        until: Date.now() - 1,
      }),
      "invalid_until",
    );
    await alice.mutation(api.cfp.reopenProposal, {
      eventSlug,
      proposalId,
      until: Date.now() + 3600_000,
    });

    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { ...FULL_ANSWERS, abstract: "Late edit." },
    });
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    expect(
      (await bob.query(api.cfp.getMyProposal, { proposalId })).windowOpen,
    ).toBe(true);
    expect(await auditActions(t)).toContain("cfp.reopenProposal");
  });

  test("NEGATIVE: an organizer of another event cannot reopen this proposal", async () => {
    const t = setupTest();
    const { alice, orgSlug, proposalId } = await readyProposal(t);
    const otherEvent = await createEvent(alice, orgSlug, "Other Summit");
    await expectRejectedWith(
      alice.mutation(api.cfp.reopenProposal, {
        eventSlug: otherEvent,
        proposalId,
        until: Date.now() + 3600_000,
      }),
      "not_found",
    );
  });
});

describe("cfp.setSpeakers", () => {
  test("replaces the speaker list and validates names and emails", async () => {
    const t = setupTest();
    const { bob, proposalId } = await readyProposal(t);

    await bob.mutation(api.cfp.setSpeakers, {
      proposalId,
      speakers: [
        { firstName: "Bob", lastName: "Speaker", isPrimary: true },
        {
          firstName: "Carol",
          lastName: "Cospeaker",
          email: "  Carol@Example.COM ",
          isPrimary: false,
        },
      ],
    });
    const { speakers } = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(speakers.map((s) => s.order)).toEqual([0, 1]);
    expect(speakers.map((s) => s.firstName)).toEqual(["Bob", "Carol"]);
    expect(speakers[1].email).toBe("carol@example.com");

    await expectRejectedWith(
      bob.mutation(api.cfp.setSpeakers, {
        proposalId,
        speakers: [{ firstName: "  ", lastName: "Nameless", isPrimary: true }],
      }),
      "invalid_name",
    );
    await expectRejectedWith(
      bob.mutation(api.cfp.setSpeakers, {
        proposalId,
        speakers: [
          {
            firstName: "Bad",
            lastName: "Email",
            email: "nope",
            isPrimary: true,
          },
        ],
      }),
      "invalid_email",
    );
    await expectRejectedWith(
      bob.mutation(api.cfp.setSpeakers, {
        proposalId,
        speakers: Array.from({ length: 11 }, (_, i) => ({
          firstName: `Speaker${i}`,
          lastName: "Many",
          isPrimary: i === 0,
        })),
      }),
      "too_many_speakers",
    );
    // A failed write leaves the previous list intact.
    expect(
      (await bob.query(api.cfp.getMyProposal, { proposalId })).speakers,
    ).toHaveLength(2);
  });
});
