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
import { starterFormDef } from "./model/cfpForms";
import type { FormDef } from "./shared/formDef";
import type { Doc } from "./_generated/dataModel";

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

/** Submit defers its emails to a runAfter(0) job; let it land. */
async function drainScheduled(t: TestT): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function proposalRows(t: TestT) {
  return await t.run(async (ctx) => ctx.db.query("proposals").collect());
}

function speakerInput(speaker: Doc<"proposalSpeakers">) {
  return {
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
  };
}

type CalendarJob = {
  kind: string;
  toEmail: string;
  ics: { method: "REQUEST" | "CANCEL"; uid: string; sequence: number };
  context?: { sessionId?: string; participantId?: string; mode?: string };
};

async function calendarJobs(t: TestT): Promise<CalendarJob[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.system.query("_scheduled_functions").collect();
    return rows
      .filter((row) => row.name === "emails:sendCalendarInvite")
      .map((row) => row.args[0] as CalendarJob);
  });
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

async function acceptedProposal(t: TestT) {
  const ready = await readyProposal(t);
  await ready.bob.mutation(api.cfp.submitProposal, {
    proposalId: ready.proposalId,
  });
  await drainScheduled(t);
  await ready.alice.mutation(api.sessions.setStatus, {
    eventSlug: ready.eventSlug,
    proposalIds: [ready.proposalId],
    to: "acceptQueue",
  });
  await ready.alice.mutation(api.sessions.release, {
    eventSlug: ready.eventSlug,
    proposalIds: [ready.proposalId],
  });
  const view = await ready.bob.query(api.cfp.getMyProposal, {
    proposalId: ready.proposalId,
  });
  return { ...ready, view };
}

async function revisionState(t: TestT) {
  return await t.run(async (ctx) => ({
    proposals: await ctx.db.query("proposals").collect(),
    speakers: await ctx.db.query("proposalSpeakers").collect(),
    sessions: await ctx.db.query("sessions").collect(),
    participants: await ctx.db.query("sessionParticipants").collect(),
    contacts: await ctx.db.query("eventContacts").collect(),
    tasks: await ctx.db.query("taskInstances").collect(),
    reviews: await ctx.db.query("reviews").collect(),
    audits: await ctx.db.query("auditLog").collect(),
    messages: await ctx.db.query("messages").collect(),
    scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
  }));
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
    expect(
      fields.flatMap((f) => (f.systemKey ? [f.systemKey] : [])).sort(),
    ).toEqual(["abstract", "email", "firstName", "lastName", "talkTitle"]);
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

    const { version } = await alice.mutation(api.cfp.publishForm, {
      eventSlug,
    });
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

  test("rate limits proposal creation per user when maxSubmissionsPerUser is unset", async () => {
    const t = setupTest();
    const { bob, eventSlug } = await openEventWithSubmitter(t);
    // Default settings: no organizer-configured cap, so the rate limiter is
    // the only floor. 10 drafts/hour are allowed; the 11th is refused (the
    // bucket's period never elapses mid-test, so no clock control is needed).
    for (let i = 0; i < 10; i++) {
      await bob.mutation(api.cfp.startProposal, { eventSlug });
    }
    await expectRejectedWith(
      bob.mutation(api.cfp.startProposal, { eventSlug }),
      "rate_limited",
    );
    expect(await bob.query(api.cfp.myProposals, {})).toHaveLength(10);

    // Keyed per user: another submitter is unaffected.
    const carol = await signIn(t, "carol");
    await carol.mutation(api.cfp.startProposal, { eventSlug });
  });
});

describe("cfp.saveAnswers", () => {
  test("drops unknown field ids (removed-field drafts must not brick) and rejects wrong-typed values", async () => {
    const t = setupTest();
    const { bob, eventSlug } = await openEventWithSubmitter(t);
    const proposalId = await bob.mutation(api.cfp.startProposal, { eventSlug });

    // An answer for a field the organizer has since removed is silently
    // dropped rather than rejected — otherwise the autosaved draft could
    // never save again (codex M1 finding).
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { nonsense: "hi", talkTitle: "Kept" },
    });
    const afterDrop = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(afterDrop.proposal.answers).not.toHaveProperty("nonsense");
    expect(afterDrop.proposal.answers.talkTitle).toBe("Kept");
    // A number: no field kind is numeric. vAnswerValue no longer admits
    // numbers (a deployment rejects them at the arg validator); convex-test
    // doesn't enforce record value validators, so the handler check fires.
    await expectRejectedWith(
      bob.mutation(api.cfp.saveAnswers, {
        proposalId,
        answers: { talkTitle: 42 as unknown as string },
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
      mallory.mutation(api.cfp.resubmitProposal, {
        proposalId,
        expectedContentVersion: 0,
        answers: {},
        speakers: [],
      }),
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
    const submitted = await bob.query(api.cfp.getMyProposal, { proposalId });
    await expectRejectedWith(
      bob.mutation(api.cfp.resubmitProposal, {
        proposalId,
        expectedContentVersion: submitted.proposal.contentVersion ?? 0,
        answers: { ...FULL_ANSWERS, [FORMAT_FIELD]: "Workshop" },
        speakers: submitted.speakers.map(speakerInput),
      }),
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
    await drainScheduled(t);

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
    await bob.mutation(api.cfp.resubmitProposal, {
      proposalId,
      expectedContentVersion: first.proposal.contentVersion ?? 0,
      answers: { ...FULL_ANSWERS, abstract: "Now with more detail." },
      speakers: first.speakers.map(speakerInput),
    });
    await drainScheduled(t);
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

  test("legacy split-write clients must refresh after submission and cannot write partial revisions", async () => {
    const t = setupTest();
    const { bob, proposalId } = await readyProposal(t);
    // readyProposal used both split-write endpoints successfully while this was
    // a draft. Only their already-submitted use is an obsolete client flow.
    expect(
      (await bob.query(api.cfp.getMyProposal, { proposalId })).proposal.status,
    ).toBe("draft");
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    const submitted = await bob.query(api.cfp.getMyProposal, { proposalId });
    const before = await revisionState(t);

    const expectClientUpgrade = async (operation: Promise<unknown>) => {
      const failure = await operation.then(
        () => null,
        (error: { data?: { code?: string; message?: string } }) => error.data,
      );
      expect(failure?.code).toBe("client_upgrade_required");
      expect(failure?.message).toContain("Refresh the page");
      expect(failure?.message).toContain("Save & resubmit");
      expect(await revisionState(t)).toEqual(before);
    };

    await expectClientUpgrade(
      bob.mutation(api.cfp.saveAnswers, {
        proposalId,
        answers: {
          ...submitted.proposal.answers,
          abstract: "An unsafe partial answer update.",
        },
      }),
    );
    await expectClientUpgrade(
      bob.mutation(api.cfp.setSpeakers, {
        proposalId,
        speakers: [
          ...submitted.speakers.map(speakerInput),
          {
            firstName: "Unsafe",
            lastName: "Partial Speaker",
            isPrimary: false,
          },
        ],
      }),
    );
  });

  test("the Resend webhook patches the comms log by resendEmailId", async () => {
    const t = setupTest();
    const { bob, proposalId } = await readyProposal(t);
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    await drainScheduled(t);

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
    expect(
      (await messageRows(t)).filter((m) => m.kind === "cfp.withdrawn"),
    ).toEqual([]);
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

    const listed = await alice.query(api.cfp.listProposals, { eventSlug });
    expect(listed.rows).toHaveLength(1);
    expect(listed.capped).toBe(false);
    expect(listed.rows[0].proposal.title).toBe("Convex in anger");
    expect(listed.rows[0].speakerCount).toBe(1);

    expect(
      (await alice.query(api.cfp.listProposals, { eventSlug, status: "draft" }))
        .rows,
    ).toEqual([]);
    expect(
      (
        await alice.query(api.cfp.listProposals, {
          eventSlug,
          status: "pending",
        })
      ).rows,
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

  test("the unfiltered list is newest-first across mixed statuses", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await readyProposal(t);
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    const second = await bob.mutation(api.cfp.startProposal, { eventSlug });
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId: second,
      answers: { ...FULL_ANSWERS, talkTitle: "Second talk" },
    });
    await bob.mutation(api.cfp.setSpeakers, {
      proposalId: second,
      speakers: [{ firstName: "Bob", lastName: "Speaker", isPrimary: true }],
    });
    await bob.mutation(api.cfp.submitProposal, { proposalId: second });
    // Different statuses on purpose: the creation-ordered by-event index must
    // not group by status the way the status-first index would.
    await alice.mutation(api.sessions.setStatus, {
      eventSlug,
      proposalIds: [second],
      to: "acceptQueue",
    });

    const { rows } = await alice.query(api.cfp.listProposals, { eventSlug });
    expect(rows.map((r) => r.proposal._id)).toEqual([second, proposalId]);
  });

  test("a list past the read cap reports capped instead of pretending it is whole (H5)", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await readyProposal(t);
    await bob.mutation(api.cfp.submitProposal, { proposalId });

    // Exactly at the cap: still the whole story, so `capped` must stay false —
    // the cap+1 probe exists precisely so a full page isn't cried wolf over.
    const [eventId, submitterUserId] = await t.run(async (ctx) => {
      const proposal = (await ctx.db.get("proposals", proposalId))!;
      return [proposal.eventId, proposal.submitterUserId] as const;
    });
    const bulkInsert = async (count: number) => {
      await t.run(async (ctx) => {
        for (let i = 0; i < count; i += 1) {
          await ctx.db.insert("proposals", {
            eventId,
            submitterUserId,
            status: "pending",
            title: `Bulk ${i}`,
            answers: {},
            formVersion: 1,
            submittedAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      });
    };
    await bulkInsert(499);
    const full = await alice.query(api.cfp.listProposals, { eventSlug });
    expect(full.rows).toHaveLength(500);
    expect(full.capped).toBe(false);

    // One more proposal than a page holds: the count the UI renders must admit
    // it is partial rather than reading "500 of 500".
    await bulkInsert(1);
    const over = await alice.query(api.cfp.listProposals, { eventSlug });
    expect(over.rows).toHaveLength(500);
    expect(over.capped).toBe(true);
    // A status-filtered read is capped independently, on its own index.
    const pending = await alice.query(api.cfp.listProposals, {
      eventSlug,
      status: "pending",
    });
    expect(pending.capped).toBe(true);
    expect(
      (await alice.query(api.cfp.listProposals, { eventSlug, status: "draft" }))
        .capped,
    ).toBe(false);
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

    const reopened = await bob.query(api.cfp.getMyProposal, { proposalId });
    await expectRejectedWith(
      bob.mutation(api.cfp.saveAnswers, {
        proposalId,
        answers: { ...FULL_ANSWERS, abstract: "Late edit." },
      }),
      "client_upgrade_required",
    );
    await bob.mutation(api.cfp.resubmitProposal, {
      proposalId,
      expectedContentVersion: reopened.proposal.contentVersion ?? 0,
      answers: { ...FULL_ANSWERS, abstract: "Late edit." },
      speakers: reopened.speakers.map(speakerInput),
    });
    expect(
      (await bob.query(api.cfp.getMyProposal, { proposalId })).windowOpen,
    ).toBe(true);
    expect(await auditActions(t)).toContain("cfp.reopenProposal");
  });

  test("an accepted proposal atomically adds one stable co-author, task, and current calendar request", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId } = await readyProposal(t);
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    await drainScheduled(t);
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Confirm speaker details",
      scope: "participant",
      evidence: "manual",
      reviewRequired: false,
      dueAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    await alice.mutation(api.sessions.setStatus, {
      eventSlug,
      proposalIds: [proposalId],
      to: "acceptQueue",
    });
    await alice.mutation(api.sessions.release, {
      eventSlug,
      proposalIds: [proposalId],
    });

    const initial = await bob.query(api.cfp.getMyProposal, { proposalId });
    const originalSpeaker = initial.speakers[0];
    const original = await t.run(async (ctx) => {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId))
        .unique();
      if (session === null) throw new Error("no accepted session");
      const participant = await ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
        .unique();
      if (participant === null) throw new Error("no accepted participant");
      const task = await ctx.db
        .query("taskInstances")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
        .unique();
      if (task === null) throw new Error("no accepted task");
      const event = await ctx.db.get("events", session.eventId);
      if (event === null) throw new Error("no event");
      return { session, participant, task, event };
    });
    await alice.mutation(api.agenda.scheduleSession, {
      eventSlug,
      sessionId: original.session._id,
      slot: {
        startsAt: original.event.startsAt + 60 * 60 * 1000,
        endsAt: original.event.startsAt + 2 * 60 * 60 * 1000,
      },
    });
    expect(
      await alice.mutation(api.agenda.release, {
        eventSlug,
        sessionIds: [original.session._id],
      }),
    ).toEqual([{ sessionId: original.session._id, ok: true }]);
    await alice.mutation(api.agenda.setAck, {
      eventSlug,
      participantId: original.participant._id,
      response: "acknowledged",
    });

    const reviewer = await signIn(t, "rita");
    const reviewerUserId = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("users")
        .withIndex("by_tokenIdentifier", (q) =>
          q.eq("tokenIdentifier", "https://test.clerk.example.com|rita"),
        )
        .unique();
      if (row === null) throw new Error("no reviewer");
      await ctx.db.insert("reviews", {
        eventId: original.event._id,
        proposalId,
        reviewerUserId: row._id,
        status: "submitted",
        score: 5,
        recommendation: "accept",
        comments: "Strong proposal",
        submittedAt: Date.now(),
        updatedAt: Date.now(),
      });
      return row._id;
    });
    expect(reviewer).toBeDefined();

    const revisionSpeakers = [
      speakerInput(originalSpeaker),
      {
        firstName: "Marcus",
        lastName: "Okafor",
        isPrimary: false,
        role: "Co-author",
      },
    ];
    const revisedAnswers = {
      ...initial.proposal.answers,
      abstract: "Now includes the co-author's production findings.",
    };

    // Reopening the event-wide CFP is deliberately insufficient: a released
    // acceptance needs its own explicit, audited proposal grant.
    await expectRejectedWith(
      bob.mutation(api.cfp.resubmitProposal, {
        proposalId,
        expectedContentVersion: initial.proposal.contentVersion ?? 0,
        answers: revisedAnswers,
        speakers: revisionSpeakers,
      }),
      "not_editable",
    );
    await alice.mutation(api.cfp.reopenProposal, {
      eventSlug,
      proposalId,
      until: Date.now() + 3600_000,
    });

    // The old split writes are closed for accepted revisions.
    await expectRejectedWith(
      bob.mutation(api.cfp.setSpeakers, {
        proposalId,
        speakers: revisionSpeakers,
      }),
      "client_upgrade_required",
    );
    await bob.mutation(api.cfp.resubmitProposal, {
      proposalId,
      expectedContentVersion: initial.proposal.contentVersion ?? 0,
      answers: revisedAnswers,
      speakers: revisionSpeakers,
    });

    const accepted = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(accepted.proposal.status).toBe("accepted");
    expect(accepted.speakers[0]._id).toBe(originalSpeaker._id);
    expect(accepted.speakers[1]).toMatchObject({
      firstName: "Marcus",
      lastName: "Okafor",
      role: "Co-author",
    });
    expect(accepted.speakers[1].email).toBeUndefined();
    const marcusSpeakerId = accepted.speakers[1]._id;

    const afterRevision = await t.run(async (ctx) => {
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId))
        .collect();
      const participants = await ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) =>
          q.eq("sessionId", original.session._id),
        )
        .collect();
      const tasks = await ctx.db
        .query("taskInstances")
        .withIndex("by_sessionId", (q) =>
          q.eq("sessionId", original.session._id),
        )
        .collect();
      const contacts = await Promise.all(
        participants.map((participant) =>
          ctx.db.get("eventContacts", participant.eventContactId),
        ),
      );
      const reviews = await ctx.db
        .query("reviews")
        .withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId))
        .collect();
      return { sessions, participants, tasks, contacts, reviews };
    });
    expect(afterRevision.sessions.map((session) => session._id)).toEqual([
      original.session._id,
    ]);
    expect(afterRevision.participants).toHaveLength(2);
    expect(afterRevision.tasks).toHaveLength(2);
    expect(afterRevision.tasks.map((task) => task._id)).toContain(
      original.task._id,
    );
    const originalParticipant = afterRevision.participants.find(
      (participant) => participant._id === original.participant._id,
    );
    const addedParticipant = afterRevision.participants.find(
      (participant) => participant._id !== original.participant._id,
    );
    expect(originalParticipant?.ack).toBe("acknowledged");
    expect(originalParticipant?.role).toBe("speaker");
    expect(addedParticipant?.ack).toBe("awaitingAck");
    expect(addedParticipant?.role).toBe("Co-author");
    const marcusContact = afterRevision.contacts.find(
      (contact) => contact?.proposalSpeakerId === marcusSpeakerId,
    );
    expect(marcusContact).toMatchObject({
      firstName: "Marcus",
      lastName: "Okafor",
    });
    expect(marcusContact?.email).toBeUndefined();
    expect(afterRevision.reviews).toHaveLength(1);
    expect(afterRevision.reviews[0]).toMatchObject({
      reviewerUserId,
      status: "assigned",
      contentVersion: 1,
    });
    expect(afterRevision.reviews[0].score).toBeUndefined();
    expect(afterRevision.reviews[0].recommendation).toBeUndefined();
    expect(afterRevision.reviews[0].comments).toBeUndefined();
    expect(afterRevision.reviews[0].submittedAt).toBeUndefined();
    expect(accepted.proposal.contentVersion).toBe(1);

    // `sessions.list` is the organizer read model consumed by the session
    // portal dialog, so the proposal role must survive all the way there.
    const organizerSession = (
      await alice.query(api.sessions.list, { eventSlug })
    ).find((row) => row.session._id === original.session._id);
    expect(
      organizerSession?.participants.find(
        (participant) => participant.participantId === addedParticipant?._id,
      )?.role,
    ).toBe("Co-author");

    const jobsAfterRevision = await calendarJobs(t);
    expect(jobsAfterRevision).toHaveLength(2);
    const addedInvite = jobsAfterRevision.find(
      (job) => job.context?.participantId === addedParticipant?._id,
    );
    expect(addedInvite).toMatchObject({
      kind: "schedule.released",
      toEmail: "bob@example.com",
      ics: { method: "REQUEST", sequence: 1 },
      context: { mode: "participant_added" },
    });

    // A second browser tab still holds revision 0. Its whole payload is stale
    // now (including a speaker list that predates Marcus), so the version fence
    // must win before speaker reconciliation or any proposal/session side
    // effect. Every affected table and scheduled calendar request stays exact.
    const beforeStaleTab = await revisionState(t);
    const calendarBeforeStaleTab = await calendarJobs(t);
    await expectRejectedWith(
      bob.mutation(api.cfp.resubmitProposal, {
        proposalId,
        expectedContentVersion: initial.proposal.contentVersion ?? 0,
        answers: {
          ...initial.proposal.answers,
          abstract: "A stale tab must not overwrite the accepted revision.",
        },
        speakers: initial.speakers.map(speakerInput),
      }),
      "stale_proposal_content",
    );
    expect(await revisionState(t)).toEqual(beforeStaleTab);
    expect(await calendarJobs(t)).toEqual(calendarBeforeStaleTab);

    const stableIds = {
      speakers: accepted.speakers.map((speaker) => speaker._id),
      participants: afterRevision.participants.map(
        (participant) => participant._id,
      ),
      participantRoles: afterRevision.participants.map(
        (participant) => participant.role,
      ),
      contacts: afterRevision.contacts.map((contact) => contact?._id),
      tasks: afterRevision.tasks.map((task) => task._id),
    };
    await bob.mutation(api.cfp.resubmitProposal, {
      proposalId,
      expectedContentVersion: accepted.proposal.contentVersion ?? 0,
      answers: accepted.proposal.answers,
      speakers: accepted.speakers.map(speakerInput),
    });
    const repeated = await bob.query(api.cfp.getMyProposal, { proposalId });
    const repeatedMaterialization = await t.run(async (ctx) => {
      const participants = await ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) =>
          q.eq("sessionId", original.session._id),
        )
        .collect();
      const contacts = await Promise.all(
        participants.map((participant) =>
          ctx.db.get("eventContacts", participant.eventContactId),
        ),
      );
      const tasks = await ctx.db
        .query("taskInstances")
        .withIndex("by_sessionId", (q) =>
          q.eq("sessionId", original.session._id),
        )
        .collect();
      return { participants, contacts, tasks };
    });
    expect({
      speakers: repeated.speakers.map((speaker) => speaker._id),
      participants: repeatedMaterialization.participants.map(
        (participant) => participant._id,
      ),
      participantRoles: repeatedMaterialization.participants.map(
        (participant) => participant.role,
      ),
      contacts: repeatedMaterialization.contacts.map((contact) => contact?._id),
      tasks: repeatedMaterialization.tasks.map((task) => task._id),
    }).toEqual(stableIds);
    expect(await calendarJobs(t)).toHaveLength(2);

    const actions = await auditActions(t);
    expect(
      actions.filter((action) => action === "decision.release"),
    ).toHaveLength(1);
    expect(
      actions.filter(
        (action) => action === "review.invalidateForProposalRevision",
      ),
    ).toHaveLength(1);
    expect(
      actions.filter(
        (action) => action === "agenda.participantAddedToReleasedSlot",
      ),
    ).toHaveLength(1);
    expect(
      actions.filter((action) => action === "decision.correct"),
    ).toHaveLength(0);

    // The ordinary correction invariant is unchanged after the revision.
    await alice.mutation(api.sessions.correct, {
      eventSlug,
      proposalId,
      to: "declined",
      note: "The program changed after acceptance.",
    });
    expect(
      (await bob.query(api.cfp.getMyProposal, { proposalId })).proposal.status,
    ).toBe("declined");
    expect(
      await t.run(
        async (ctx) =>
          (await ctx.db.get("sessions", original.session._id))?.status,
      ),
    ).toBe("cancelled");
    await expectRejectedWith(
      alice.mutation(api.cfp.reopenProposal, {
        eventSlug,
        proposalId,
        until: Date.now() + 3600_000,
      }),
      "invalid_status",
    );
  });

  test("accepted revision rejects removal, duplicate/foreign ids, and expiry without partial writes", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId, view } =
      await acceptedProposal(t);
    await alice.mutation(api.cfp.reopenProposal, {
      eventSlug,
      proposalId,
      until: Date.now() + 3600_000,
    });
    const otherProposalId = await bob.mutation(api.cfp.startProposal, {
      eventSlug,
    });
    await bob.mutation(api.cfp.setSpeakers, {
      proposalId: otherProposalId,
      speakers: [
        { firstName: "Foreign", lastName: "Speaker", isPrimary: true },
      ],
    });
    const foreign = (
      await bob.query(api.cfp.getMyProposal, { proposalId: otherProposalId })
    ).speakers[0];
    const primary = speakerInput(view.speakers[0]);
    const answers = {
      ...view.proposal.answers,
      abstract: "A revision that must stay atomic.",
    };
    const expectUnchangedFailure = async (
      mutation: () => Promise<unknown>,
      code: string,
    ) => {
      const before = await revisionState(t);
      await expectRejectedWith(mutation(), code);
      expect(await revisionState(t)).toEqual(before);
    };

    await expectUnchangedFailure(
      () =>
        bob.mutation(api.cfp.resubmitProposal, {
          proposalId,
          expectedContentVersion: view.proposal.contentVersion ?? 0,
          answers,
          speakers: [
            primary,
            {
              ...speakerInput(foreign),
              firstName: "Injected",
            },
          ],
        }),
      "invalid_speaker_id",
    );
    await expectUnchangedFailure(
      () =>
        bob.mutation(api.cfp.resubmitProposal, {
          proposalId,
          expectedContentVersion: view.proposal.contentVersion ?? 0,
          answers,
          speakers: [primary, { ...primary, isPrimary: false }],
        }),
      "duplicate_speaker_id",
    );
    await expectUnchangedFailure(
      () =>
        bob.mutation(api.cfp.resubmitProposal, {
          proposalId,
          expectedContentVersion: view.proposal.contentVersion ?? 0,
          answers,
          speakers: [
            {
              firstName: "Replacement",
              lastName: "Speaker",
              isPrimary: true,
            },
          ],
        }),
      "accepted_speaker_removal",
    );

    await t.run(async (ctx) => {
      await ctx.db.patch("proposals", proposalId, {
        reopenedUntil: Date.now() - 1,
      });
    });
    await expectUnchangedFailure(
      () =>
        bob.mutation(api.cfp.resubmitProposal, {
          proposalId,
          expectedContentVersion: view.proposal.contentVersion ?? 0,
          answers,
          speakers: [
            primary,
            {
              firstName: "Marcus",
              lastName: "Okafor",
              isPrimary: false,
            },
          ],
        }),
      "not_editable",
    );
  });

  test("201 active requirements refuse accepted co-author fan-out with no partial revision state", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId, view } =
      await acceptedProposal(t);
    await alice.mutation(api.cfp.reopenProposal, {
      eventSlug,
      proposalId,
      until: Date.now() + 3600_000,
    });
    await t.run(async (ctx) => {
      for (let order = 0; order <= 200; order += 1) {
        await ctx.db.insert("requirements", {
          eventId: view.proposal.eventId,
          title: `Requirement ${order}`,
          scope: "participant",
          evidence: "manual",
          reviewRequired: false,
          dueAt: Date.now() + 86_400_000,
          active: true,
        });
      }
    });
    const before = await revisionState(t);
    await expectRejectedWith(
      bob.mutation(api.cfp.resubmitProposal, {
        proposalId,
        expectedContentVersion: view.proposal.contentVersion ?? 0,
        answers: {
          ...view.proposal.answers,
          abstract: "This write must roll back with the downstream failure.",
        },
        speakers: [
          speakerInput(view.speakers[0]),
          {
            firstName: "Marcus",
            lastName: "Okafor",
            isPrimary: false,
            role: "Co-author",
          },
        ],
      }),
      "event_too_large",
    );
    expect(await revisionState(t)).toEqual(before);
  });

  test("archived events refuse reopen, editable writes, atomic resubmit, and accepted sync", async () => {
    const t = setupTest();
    const { alice, bob, eventSlug, proposalId, view } =
      await acceptedProposal(t);
    await alice.mutation(api.cfp.reopenProposal, {
      eventSlug,
      proposalId,
      until: Date.now() + 3600_000,
    });
    await alice.mutation(api.events.setArchived, {
      eventSlug,
      archived: true,
    });
    const archivedView = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(archivedView.event.archivedAt).toBeGreaterThan(0);
    const before = await revisionState(t);

    await expectRejectedWith(
      alice.mutation(api.cfp.reopenProposal, {
        eventSlug,
        proposalId,
        until: Date.now() + 7200_000,
      }),
      "event_archived",
    );
    await expectRejectedWith(
      bob.mutation(api.cfp.saveAnswers, {
        proposalId,
        answers: view.proposal.answers,
      }),
      "event_archived",
    );
    await expectRejectedWith(
      bob.mutation(api.cfp.resubmitProposal, {
        proposalId,
        expectedContentVersion: view.proposal.contentVersion ?? 0,
        answers: view.proposal.answers,
        speakers: view.speakers.map(speakerInput),
      }),
      "event_archived",
    );
    expect(await revisionState(t)).toEqual(before);
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
    const originalSpeakerId = (
      await bob.query(api.cfp.getMyProposal, { proposalId })
    ).speakers[0]._id;

    const payload = [
      { firstName: "Bob", lastName: "Speaker", isPrimary: true },
      {
        firstName: "Carol",
        lastName: "Cospeaker",
        email: "  Carol@Example.COM ",
        isPrimary: false,
      },
    ];
    await bob.mutation(api.cfp.setSpeakers, {
      proposalId,
      speakers: payload,
    });
    const { speakers } = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(speakers[0]._id).toBe(originalSpeakerId);
    expect(speakers.map((s) => s.order)).toEqual([0, 1]);
    expect(speakers.map((s) => s.firstName)).toEqual(["Bob", "Carol"]);
    expect(speakers[1].email).toBe("carol@example.com");
    await bob.mutation(api.cfp.setSpeakers, { proposalId, speakers: payload });
    expect(
      (await bob.query(api.cfp.getMyProposal, { proposalId })).speakers.map(
        (speaker) => speaker._id,
      ),
    ).toEqual(speakers.map((speaker) => speaker._id));

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

  test("speaker links must be http(s) — javascript: never reaches storage", async () => {
    const t = setupTest();
    const { bob, proposalId } = await readyProposal(t);

    await expectRejectedWith(
      bob.mutation(api.cfp.setSpeakers, {
        proposalId,
        speakers: [
          {
            firstName: "Bob",
            lastName: "Speaker",
            isPrimary: true,
            links: { website: "javascript:alert(1)" },
          },
        ],
      }),
      "invalid_link",
    );

    // Valid links pass; blank fields collapse to absent instead of storing "".
    await bob.mutation(api.cfp.setSpeakers, {
      proposalId,
      speakers: [
        {
          firstName: "Bob",
          lastName: "Speaker",
          isPrimary: true,
          links: { website: "https://example.com/bob", twitter: "   " },
        },
      ],
    });
    const { speakers } = await bob.query(api.cfp.getMyProposal, { proposalId });
    expect(speakers[0].links).toEqual({ website: "https://example.com/bob" });
  });
});

describe("cfp file answers", () => {
  test("file answers must be storage ids; malformed stored values degrade to null URLs", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    const def: FormDef = starterFormDef();
    def.sections[1].fields.push({
      id: "slides",
      kind: "file",
      label: "Slides",
      required: false,
    });
    await alice.mutation(api.cfp.updateWorkingForm, { eventSlug, def });
    await openCfp(alice, eventSlug);
    const proposalId = await bob.mutation(api.cfp.startProposal, { eventSlug });

    // Anything that isn't a storage id is refused at write time.
    await expectRejectedWith(
      bob.mutation(api.cfp.saveAnswers, {
        proposalId,
        answers: { ...FULL_ANSWERS, slides: "https://evil.example/x" },
      }),
      "invalid_answer",
    );

    // A real storage id is accepted and resolves for the organizer views.
    const storageId = await t.run(
      async (ctx) => await ctx.storage.store(new Blob(["deck"])),
    );
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: { ...FULL_ANSWERS, slides: storageId },
    });
    const detail = await alice.query(api.cfp.getProposalDetail, {
      eventSlug,
      proposalId,
    });
    expect(detail.fileUrls[storageId]).toBeTruthy();

    // A malformed value that predates the write-time gate (planted directly)
    // must not take the organizer reads down — it degrades to a null URL.
    await t.run(async (ctx) => {
      const proposal = await ctx.db.get("proposals", proposalId);
      await ctx.db.patch("proposals", proposalId, {
        answers: { ...proposal!.answers, slides: "not-a-storage-id" },
      });
    });
    const degraded = await alice.query(api.cfp.getProposalDetail, {
      eventSlug,
      proposalId,
    });
    expect(degraded.fileUrls["not-a-storage-id"]).toBeNull();
    const bundle = await alice.query(api.cfp.listFileAnswers, { eventSlug });
    expect(bundle).toHaveLength(1);
    expect(bundle[0].url).toBeNull();
  });
});
