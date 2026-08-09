import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
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

// Communications (M5). The rules worth breaking the build over:
//   • Audiences come from event state, never from a list someone uploaded.
//   • Routine task chasing goes to the primary manager while the speaker has
//     not claimed their portal; personal actions go to the speaker.
//   • Unconfirmed speakers get PARTICIPATION reminders, never task chasing.
//   • One consolidated email per recipient per sweep, and a second sweep inside
//     the cadence window sends nothing.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-10T09:00:00Z");
const PAST_DUE = Date.parse("2026-08-01T00:00:00Z");
const FUTURE_DUE = Date.parse("2026-12-01T00:00:00Z");

// ── Reading raw tables ───────────────────────────────────────────────────

async function messageRows(t: TestT): Promise<Array<Doc<"messages">>> {
  return await t.run(async (ctx) => ctx.db.query("messages").collect());
}

async function messagesOfKind(t: TestT, kind: string) {
  return (await messageRows(t)).filter((m) => m.kind === kind);
}

async function auditActions(t: TestT): Promise<string[]> {
  return await t.run(async (ctx) =>
    (await ctx.db.query("auditLog").collect()).map((r) => r.action),
  );
}

async function instanceRows(t: TestT): Promise<Array<Doc<"taskInstances">>> {
  return await t.run(async (ctx) => ctx.db.query("taskInstances").collect());
}

async function participantRows(
  t: TestT,
): Promise<Array<Doc<"sessionParticipants">>> {
  return await t.run(async (ctx) =>
    ctx.db.query("sessionParticipants").collect(),
  );
}

/** Wipe the comms log so a later assertion sees only new sends. */
async function clearMessages(t: TestT): Promise<void> {
  await t.run(async (ctx) => {
    for (const message of await ctx.db.query("messages").collect()) {
      await ctx.db.delete("messages", message._id);
    }
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────

async function organizerEvent(t: TestT) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
  return { alice, orgSlug, eventSlug };
}

async function inviteSpeaker(
  alice: TestUserT,
  eventSlug: string,
  speaker: { firstName: string; lastName: string; email: string },
  title: string,
) {
  return await alice.mutation(api.sessions.createDirect, {
    eventSlug,
    title,
    speaker,
  });
}

/** An invitation needs an address, but a speaker imported later may lose one —
 * strip it to model the genuinely unreachable case. */
async function clearContactEmail(
  t: TestT,
  eventContactId: Id<"eventContacts">,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.patch("eventContacts", eventContactId, { email: undefined });
  });
}

/**
 * A released CFP acceptance: `bob` is the primary manager (and not a speaker),
 * `carol` and `dave` present. Neither speaker has claimed portal access, so
 * task chasing must route to bob.
 */
async function acceptedWithManager(t: TestT, eventSlug: string) {
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob", { email: "bob@example.com" });
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

async function participantFor(
  t: TestT,
  sessionId: Id<"sessions">,
  firstName: string,
): Promise<Id<"sessionParticipants">> {
  return await t.run(async (ctx) => {
    const participants = await ctx.db
      .query("sessionParticipants")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .collect();
    for (const participant of participants) {
      const contact = await ctx.db.get(
        "eventContacts",
        participant.eventContactId,
      );
      if (contact?.firstName === firstName) return participant._id;
    }
    throw new Error(`no participant ${firstName}`);
  });
}

async function confirm(
  alice: TestUserT,
  eventSlug: string,
  participantId: Id<"sessionParticipants">,
): Promise<void> {
  await alice.mutation(api.sessions.setParticipationState, {
    eventSlug,
    participantId,
    to: "confirmed",
  });
}

async function setCadence(
  alice: TestUserT,
  eventSlug: string,
  days: number,
): Promise<void> {
  await alice.mutation(api.events.updateSettings, {
    eventSlug,
    patch: { reminderCadenceDays: days },
  });
}

async function manualRequirement(
  alice: TestUserT,
  eventSlug: string,
  title: string,
  dueAt = PAST_DUE,
) {
  return await alice.mutation(api.tasks.createRequirement, {
    eventSlug,
    title,
    scope: "participant",
    evidence: "manual",
    reviewRequired: false,
    dueAt,
  });
}

// ── Audiences ────────────────────────────────────────────────────────────

describe("comms.listAudiences", () => {
  test("splits confirmed from unconfirmed speakers", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));

    const counts = await alice.query(api.comms.listAudiences, {
      eventSlug,
      now: NOW,
    });
    const by = (kind: string) => counts.find((c) => c.kind === kind);
    expect(by("allSpeakers")?.count).toBe(2);
    expect(by("confirmedSpeakers")?.count).toBe(1);
    expect(by("unconfirmedSpeakers")?.count).toBe(1);
  });

  test("counts assigned reviewers and skips unreachable speakers", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    // A speaker with no email at all: unreachable, and counted as skipped.
    const nomail = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Nomail", lastName: "Speaker", email: "gone@example.com" },
      "Lightning talk",
    );
    await clearContactEmail(t, nomail.eventContactId);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );

    const counts = await alice.query(api.comms.listAudiences, {
      eventSlug,
      now: NOW,
    });
    const all = counts.find((c) => c.kind === "allSpeakers");
    expect(all).toMatchObject({ count: 1, skipped: 1 });
    expect(counts.find((c) => c.kind === "assignedReviewers")?.count).toBe(0);
  });

  test("dedupes one person who speaks in two sessions", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Closing panel",
    );
    expect(await participantRows(t)).toHaveLength(2);

    const counts = await alice.query(api.comms.listAudiences, {
      eventSlug,
      now: NOW,
    });
    expect(counts.find((c) => c.kind === "allSpeakers")?.count).toBe(1);
  });

  test("overdue-task chasing routes to the manager while unclaimed", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Dave"));
    await manualRequirement(alice, eventSlug, "Sign the speaker release");

    // Carol and Dave both owe an overdue task, but neither has claimed portal
    // access — so both obligations collapse onto bob, the primary manager.
    await clearMessages(t);
    const { sent } = await alice.mutation(api.comms.sendOneOff, {
      eventSlug,
      to: { kind: "audience", audience: "overdueTasks" },
      subject: "Quick nudge about {{event.name}}",
      html: "<p>Please chase these.</p>",
      now: NOW,
    });
    expect(sent).toBe(1);
    expect((await messagesOfKind(t, "manual.oneoff")).map((m) => m.toEmail)).toEqual(
      ["bob@example.com"],
    );
  });

  test("claiming portal access moves that speaker's chasing to them", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Dave"));
    await manualRequirement(alice, eventSlug, "Sign the speaker release");

    // Carol signs in and enters the portal: the snapshot is now claimed.
    const carol = await signIn(t, "carol", { email: "carol@example.com" });
    await carol.mutation(api.portal.enter, { eventSlug });

    await clearMessages(t);
    await alice.mutation(api.comms.sendOneOff, {
      eventSlug,
      to: { kind: "audience", audience: "overdueTasks" },
      subject: "Nudge",
      html: "<p>Please finish this.</p>",
      now: NOW,
    });
    // Carol hears about her own work; Dave is still represented by bob.
    expect(
      (await messagesOfKind(t, "manual.oneoff")).map((m) => m.toEmail).sort(),
    ).toEqual(["bob@example.com", "carol@example.com"]);
  });
});

// ── One-off sends ────────────────────────────────────────────────────────

describe("comms.sendOneOff", () => {
  test("records the sender, the audit row and per-recipient rendering", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await clearMessages(t);

    const result = await alice.mutation(api.comms.sendOneOff, {
      eventSlug,
      to: { kind: "audience", audience: "unconfirmedSpeakers" },
      subject: "About {{event.name}}",
      html: "<p>Hi {{speaker.firstName}}, please answer.</p>",
      now: NOW,
    });
    expect(result).toEqual({ sent: 1, skipped: 0 });

    // Unconfirmed participation is a PERSONAL action: it goes to Dave himself,
    // not to bob the manager.
    const sends = await messagesOfKind(t, "manual.oneoff");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      toEmail: "dave@example.com",
      subject: "About Acme Summit",
      deliveryStatus: "queued",
    });
    expect(sends[0].sentByUserId).toBeDefined();
    expect(sends[0].context).toMatchObject({ audience: "unconfirmedSpeakers" });
    expect(await auditActions(t)).toContain("comms.sendOneOff");
  });

  test("sends to one named contact and links the org contact", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await clearMessages(t);

    await alice.mutation(api.comms.sendOneOff, {
      eventSlug,
      to: { kind: "contact", eventContactId },
      subject: "Hello {{speaker.fullName}}",
      html: "<p>Hi {{speaker.firstName}}.</p>",
      now: NOW,
    });
    const [send] = await messagesOfKind(t, "manual.oneoff");
    expect(send).toMatchObject({
      toEmail: "dana@example.com",
      subject: "Hello Dana Keynote",
    });
    expect(send.contactId).toBeDefined();
  });

  test("refuses an empty audience and a contact with no address", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await expectRejectedWith(
      alice.mutation(api.comms.sendOneOff, {
        eventSlug,
        to: { kind: "audience", audience: "confirmedSpeakers" },
        subject: "x",
        html: "<p>x</p>",
        now: NOW,
      }),
      "empty_audience",
    );

    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Nomail", lastName: "Speaker", email: "gone@example.com" },
      "Lightning talk",
    );
    await clearContactEmail(t, eventContactId);
    await expectRejectedWith(
      alice.mutation(api.comms.sendOneOff, {
        eventSlug,
        to: { kind: "contact", eventContactId },
        subject: "x",
        html: "<p>x</p>",
        now: NOW,
      }),
      "invalid_email",
    );
  });

  test("reviewers cannot send", async () => {
    const t = setupTest();
    const { eventSlug } = await organizerEvent(t);
    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    await expectRejectedWith(
      rita.mutation(api.comms.sendOneOff, {
        eventSlug,
        to: { kind: "audience", audience: "allSpeakers" },
        subject: "x",
        html: "<p>x</p>",
        now: NOW,
      }),
      "forbidden",
    );
  });
});

// ── Per-contact comms log ────────────────────────────────────────────────

describe("comms.contactLog", () => {
  test("returns this contact's history newest first", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Other", lastName: "Person", email: "other@example.com" },
      "Closing talk",
    );
    await alice.mutation(api.sessions.invitePortal, {
      eventSlug,
      eventContactId,
    });

    const log = await alice.query(api.comms.contactLog, {
      eventSlug,
      eventContactId,
    });
    expect(log.map((m) => m.kind)).toEqual([
      "portal.invite",
      "invitation.direct",
    ]);
    expect(log.every((m) => m.toEmail === "dana@example.com")).toBe(true);
    expect(log[0].deliveryStatus).toBe("queued");
    expect(log[0].sentAt).toBeTypeOf("number");
  });

  test("picks up sends that were only ever addressed by email", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { eventContactId } = await inviteSpeaker(
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    // invitation.direct stores no contactId — the address match is what makes
    // it show up in Dana's history.
    const log = await alice.query(api.comms.contactLog, {
      eventSlug,
      eventContactId,
    });
    expect(log.map((m) => m.kind)).toEqual(["invitation.direct"]);
  });
});

// ── Scheduled reminders ──────────────────────────────────────────────────

describe("reminders.sweep", () => {
  test("does nothing for an event with no configured cadence", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await manualRequirement(alice, eventSlug, "Sign the speaker release");
    await clearMessages(t);

    const result = await t.mutation(internal.reminders.sweep, { now: NOW });
    expect(result).toMatchObject({ events: 0, taskEmails: 0 });
    expect(await messageRows(t)).toHaveLength(0);
  });

  test("consolidates two outstanding tasks into ONE email per recipient", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Dave"));
    await manualRequirement(alice, eventSlug, "Sign the speaker release");
    await manualRequirement(alice, eventSlug, "Send your travel details");
    await setCadence(alice, eventSlug, 3);
    await clearMessages(t);

    const result = await t.mutation(internal.reminders.sweep, { now: NOW });
    expect(result).toMatchObject({ taskEmails: 1, participationEmails: 0 });

    // Both speakers are represented by bob, so all four obligations arrive in
    // one message — never one email per task.
    const sends = await messagesOfKind(t, "reminder.tasks");
    expect(sends).toHaveLength(1);
    expect(sends[0].toEmail).toBe("bob@example.com");
    expect(sends[0].subject).toBe("Outstanding items for Acme Summit");
    // System send: no organizer pressed a button.
    expect(sends[0].sentByUserId).toBeUndefined();
    expect(
      (sends[0].context as { instanceIds: string[] }).instanceIds,
    ).toHaveLength(4);

    // Every included instance is stamped, so the cadence clock starts now.
    const stamped = (await instanceRows(t)).filter(
      (i) => i.lastRemindedAt === NOW,
    );
    expect(stamped).toHaveLength(4);
  });

  test("a second sweep inside the cadence window sends nothing", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await manualRequirement(alice, eventSlug, "Sign the speaker release");
    await setCadence(alice, eventSlug, 3);
    await clearMessages(t);

    expect(
      await t.mutation(internal.reminders.sweep, { now: NOW }),
    ).toMatchObject({ taskEmails: 1 });
    // An hour later (the real cron interval) and a day later: still silent.
    expect(
      await t.mutation(internal.reminders.sweep, { now: NOW + 3600 * 1000 }),
    ).toMatchObject({ taskEmails: 0 });
    expect(
      await t.mutation(internal.reminders.sweep, { now: NOW + 2 * DAY }),
    ).toMatchObject({ taskEmails: 0 });
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(1);

    // Past the cadence, it fires again — and being overdue never shortened it.
    expect(
      await t.mutation(internal.reminders.sweep, { now: NOW + 3 * DAY }),
    ).toMatchObject({ taskEmails: 1 });
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(2);
  });

  test("an unconfirmed speaker gets participation chasing, never task chasing", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await manualRequirement(alice, eventSlug, "Sign the speaker release");
    await setCadence(alice, eventSlug, 3);
    await clearMessages(t);

    const result = await t.mutation(internal.reminders.sweep, { now: NOW });
    expect(result).toMatchObject({ taskEmails: 1, participationEmails: 1 });

    // Dave has not confirmed: he is asked to confirm, personally.
    const participation = await messagesOfKind(t, "reminder.participation");
    expect(participation.map((m) => m.toEmail)).toEqual(["dave@example.com"]);
    expect(participation[0].subject).toBe(
      "Please confirm your participation in Acme Summit",
    );
    // ...and the task reminder that went to bob covers only Carol's task.
    const tasks = await messagesOfKind(t, "reminder.tasks");
    expect(tasks[0].toEmail).toBe("bob@example.com");
    expect((tasks[0].context as { instanceIds: string[] }).instanceIds).toHaveLength(
      1,
    );

    // Dave's participant row is stamped so the next sweep respects the cadence.
    const dave = (await participantRows(t)).find(
      (p) => p.lastRemindedAt === NOW,
    );
    expect(dave).toBeDefined();
    expect(
      await t.mutation(internal.reminders.sweep, { now: NOW + DAY }),
    ).toMatchObject({ participationEmails: 0 });
  });

  test("per-requirement remindersDisabled and cadence overrides are honored", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Dave"));
    const quiet = await manualRequirement(alice, eventSlug, "Optional survey");
    const loud = await manualRequirement(alice, eventSlug, "Speaker release");
    await alice.mutation(api.tasks.updateRequirement, {
      eventSlug,
      requirementId: quiet.requirementId,
      patch: { remindersDisabled: true },
    });
    // A slower per-requirement cadence than the event default (1 day).
    await alice.mutation(api.tasks.updateRequirement, {
      eventSlug,
      requirementId: loud.requirementId,
      patch: { reminderCadenceDays: 7 },
    });
    await setCadence(alice, eventSlug, 1);
    await clearMessages(t);

    await t.mutation(internal.reminders.sweep, { now: NOW });
    const [send] = await messagesOfKind(t, "reminder.tasks");
    // Only the two "Speaker release" instances (Carol + Dave) are in there.
    expect(
      (send.context as { instanceIds: string[] }).instanceIds,
    ).toHaveLength(2);

    // The silenced requirement's instances were never stamped.
    const untouched = (await instanceRows(t)).filter(
      (i) => i.requirementId === quiet.requirementId,
    );
    expect(untouched.every((i) => i.lastRemindedAt === undefined)).toBe(true);

    // Two days later the event default would fire, but the override says 7.
    await t.mutation(internal.reminders.sweep, { now: NOW + 2 * DAY });
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(1);
    await t.mutation(internal.reminders.sweep, { now: NOW + 8 * DAY });
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(2);
  });

  test("completed work and archived events stop the chasing", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Dave"));
    await manualRequirement(alice, eventSlug, "Speaker release", FUTURE_DUE);
    await setCadence(alice, eventSlug, 1);

    // Carol's obligation is done; only Dave's should be chased.
    const carolInstance = await t.run(async (ctx) => {
      const rows = await ctx.db.query("taskInstances").collect();
      for (const row of rows) {
        if (row.eventContactId === undefined) continue;
        const contact = await ctx.db.get("eventContacts", row.eventContactId);
        if (contact?.firstName === "Carol") return row._id;
      }
      throw new Error("no instance for Carol");
    });
    await alice.mutation(api.tasks.markProvided, {
      eventSlug,
      instanceId: carolInstance,
    });
    await clearMessages(t);

    await t.mutation(internal.reminders.sweep, { now: NOW });
    const [send] = await messagesOfKind(t, "reminder.tasks");
    expect(
      (send.context as { instanceIds: string[] }).instanceIds,
    ).toHaveLength(1);

    // Archiving stops automations entirely (MILESTONES M0).
    await alice.mutation(api.events.setArchived, { eventSlug, archived: true });
    await clearMessages(t);
    expect(
      await t.mutation(internal.reminders.sweep, { now: NOW + 30 * DAY }),
    ).toMatchObject({ events: 0, taskEmails: 0, participationEmails: 0 });
    expect(await messageRows(t)).toHaveLength(0);
  });

  test("a claimed speaker is chased directly instead of their manager", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await manualRequirement(alice, eventSlug, "Speaker release");
    await setCadence(alice, eventSlug, 2);

    const carol = await signIn(t, "carol", { email: "carol@example.com" });
    await carol.mutation(api.portal.enter, { eventSlug });
    await clearMessages(t);

    await t.mutation(internal.reminders.sweep, { now: NOW });
    expect(
      (await messagesOfKind(t, "reminder.tasks")).map((m) => m.toEmail),
    ).toEqual(["carol@example.com"]);
  });

  test("an organizer's template override drives the reminder copy", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await manualRequirement(alice, eventSlug, "Speaker release");
    await setCadence(alice, eventSlug, 2);
    await alice.mutation(api.templates.upsert, {
      eventSlug,
      key: "reminder.tasks",
      subject: "[{{event.name}}] still outstanding",
      html: "<p>{{tasks}}</p>",
    });
    await clearMessages(t);

    await t.mutation(internal.reminders.sweep, { now: NOW });
    expect((await messagesOfKind(t, "reminder.tasks"))[0].subject).toBe(
      "[Acme Summit] still outstanding",
    );
  });
});
