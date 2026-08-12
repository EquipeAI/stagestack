import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { DEFAULT_TEMPLATES } from "./model/templates";
import { mailFrom, mailFromAddress, resend, resendTestMode } from "./emails";
import { isBulkKind } from "./model/comms";
import {
  POST_EVENT_GRACE_DAYS,
  SWEEP_CRON,
  SWEEP_MINUTE,
  automationQuietAfter,
  nextSweepAt,
} from "./shared/reminderSchedule";
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
  // Drain scheduled sends first (submitProposal defers its emails), so a
  // pending job can't repopulate the table after the wipe.
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
  await t.run(async (ctx) => {
    for (const message of await ctx.db.query("messages").collect()) {
      await ctx.db.delete("messages", message._id);
    }
  });
}

/**
 * A fixed instant well before every task/participant reminder cadence window.
 * Backdating the last-accepted-send stamp simulates elapsed cadence so the
 * sweep under test fires without waiting for wall-clock time to pass.
 */
const LONG_AGO = NOW - 400 * DAY;

async function elapseReminders(t: TestT): Promise<void> {
  await t.run(async (ctx) => {
    for (const i of await ctx.db.query("taskInstances").collect()) {
      await ctx.db.patch("taskInstances", i._id, { lastRemindedAt: LONG_AGO });
    }
    for (const p of await ctx.db.query("sessionParticipants").collect()) {
      await ctx.db.patch("sessionParticipants", p._id, {
        lastRemindedAt: LONG_AGO,
      });
    }
  });
}

// ── Driving the sweep ────────────────────────────────────────────────────
// M8 shape: the cron entry (`reminders.sweep`) is a dispatcher that schedules
// one independent `reminders.sweepEvent` mutation per eligible event.

async function eventIdOf(t: TestT, eventSlug: string): Promise<Id<"events">> {
  return await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
      .unique();
    if (event === null) throw new Error(`no event ${eventSlug}`);
    return event._id;
  });
}

/** The full cron path: dispatch, then drain the runAfter(0) per-event jobs
 * (their real-timer setTimeouts need event-loop turns to fire). */
async function runSweep(t: TestT, now: number): Promise<{ events: number }> {
  const result = await t.mutation(internal.reminders.sweep, { now });
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
  return result;
}

/** One event's sweep called directly — exactly the mutation the dispatcher
 * schedules — so a test can assert on its counters. */
async function sweepEventNow(t: TestT, eventSlug: string, now: number) {
  return await t.mutation(internal.reminders.sweepEvent, {
    eventId: await eventIdOf(t, eventSlug),
    now,
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────

async function organizerEvent(
  t: TestT,
  extra: { startsAt?: number; endsAt?: number } = {},
) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit", extra);
  return { alice, orgSlug, eventSlug };
}

async function inviteSpeaker(
  t: TestT,
  alice: TestUserT,
  eventSlug: string,
  speaker: { firstName: string; lastName: string; email: string },
  title: string,
) {
  const result = await alice.mutation(api.sessions.createDirect, {
    eventSlug,
    title,
    speaker,
  });
  // The invitation email is deferred to runAfter(0); land it so tests see a
  // settled comms log.
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
  return result;
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
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );

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
      t,
      alice,
      eventSlug,
      { firstName: "Nomail", lastName: "Speaker", email: "gone@example.com" },
      "Lightning talk",
    );
    await clearContactEmail(t, nomail.eventContactId);
    await inviteSpeaker(
      t,
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
      t,
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await inviteSpeaker(
      t,
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
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
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
    expect(
      (await messagesOfKind(t, "manual.oneoff")).map((m) => m.toEmail),
    ).toEqual(["bob@example.com"]);
  });

  test("claiming portal access does NOT reroute task chasing off the manager", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Dave"));
    await manualRequirement(alice, eventSlug, "Sign the speaker release");

    // Carol signs in and enters the portal: the snapshot is now claimed.
    const carol = await signIn(t, "carol", {
      email: "carol@example.com",
      emailVerified: true,
    });
    await carol.mutation(api.portal.enter, { eventSlug });

    await clearMessages(t);
    await alice.mutation(api.comms.sendOneOff, {
      eventSlug,
      to: { kind: "audience", audience: "overdueTasks" },
      subject: "Nudge",
      html: "<p>Please finish this.</p>",
      now: NOW,
    });
    // Routine task chasing stays on the primary manager even after a speaker
    // claims their portal (MILESTONES M4:87 — claiming never silently reroutes).
    // Both Carol's and Dave's obligations collapse onto bob → one message.
    expect(
      (await messagesOfKind(t, "manual.oneoff")).map((m) => m.toEmail),
    ).toEqual(["bob@example.com"]);
  });
});

// ── One-off sends ────────────────────────────────────────────────────────

describe("comms.sendOneOff", () => {
  test("records the sender, the audit row and per-recipient rendering", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await clearMessages(t);

    const result = await alice.mutation(api.comms.sendOneOff, {
      eventSlug,
      to: { kind: "audience", audience: "unconfirmedSpeakers" },
      subject: "About {{event.name}}",
      html: "<p>Hi {{speaker.firstName}}, please answer.</p>",
      now: NOW,
    });
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });

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
      t,
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

  test("sends a deduped selected subset, skips missing email, and rejects cross-event ids", async () => {
    const t = setupTest();
    const { alice, orgSlug, eventSlug } = await organizerEvent(t);
    const ada = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      "Analytical engines",
    );
    const grace = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Grace", lastName: "Hopper", email: "grace@example.com" },
      "Compilers",
    );
    const nomail = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "No", lastName: "Mail", email: "nomail@example.com" },
      "Offline",
    );
    const adaAliasId = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      return await ctx.db.insert("eventContacts", {
        eventId: event._id,
        orgId: event.orgId,
        firstName: "Ada",
        lastName: "Alias",
        email: " ADA@EXAMPLE.COM ",
      });
    });
    await clearContactEmail(t, nomail.eventContactId);
    await clearMessages(t);

    const result = await alice.mutation(api.comms.sendOneOff, {
      eventSlug,
      to: {
        kind: "contacts",
        eventContactIds: [
          ada.eventContactId,
          ada.eventContactId,
          adaAliasId,
          nomail.eventContactId,
        ],
      },
      subject: "Hello {{speaker.firstName}}",
      html: "<p>Personal message.</p>",
      now: NOW,
    });
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(await messagesOfKind(t, "manual.oneoff")).toEqual([
      expect.objectContaining({
        toEmail: "ada@example.com",
        subject: "Hello Ada",
        context: expect.objectContaining({
          eventContactId: ada.eventContactId,
          renderedSubject: "Hello Ada",
        }),
      }),
    ]);
    expect(
      await alice.mutation(api.comms.sendOneOff, {
        eventSlug,
        to: { kind: "contacts", eventContactIds: [nomail.eventContactId] },
        subject: "x",
        html: "<p>x</p>",
        now: NOW,
      }),
    ).toEqual({ sent: 0, failed: 0, skipped: 1 });

    const otherSlug = await createEvent(alice, orgSlug, "Other Summit");
    await expectRejectedWith(
      alice.mutation(api.comms.sendOneOff, {
        eventSlug: otherSlug,
        to: {
          kind: "contacts",
          eventContactIds: [grace.eventContactId],
        },
        subject: "x",
        html: "<p>x</p>",
        now: NOW,
      }),
      "not_found",
    );
  });

  test("provider refusals are failed rather than reported as selected sends", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const ada = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      "Analytical engines",
    );
    await clearMessages(t);

    let result: { sent: number; failed: number; skipped: number } | undefined;
    await withEnv("RESEND_TEST_MODE", undefined, async () => {
      result = await alice.mutation(api.comms.sendOneOff, {
        eventSlug,
        to: { kind: "contacts", eventContactIds: [ada.eventContactId] },
        subject: "Hello {{speaker.firstName}}",
        html: "<p>Personal message.</p>",
        now: NOW,
      });
    });

    expect(result).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const [logged] = await messagesOfKind(t, "manual.oneoff");
    expect(logged).toMatchObject({
      toEmail: "ada@example.com",
      deliveryStatus: "failed",
    });
  });

  test("selected one-off sends enforce the 200-contact cap", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const ids = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      const created: Array<Id<"eventContacts">> = [];
      for (let i = 0; i < 201; i += 1) {
        created.push(
          await ctx.db.insert("eventContacts", {
            eventId: event._id,
            orgId: event.orgId,
            firstName: `Speaker ${i}`,
            lastName: "",
            email: `selected${i}@example.com`,
          }),
        );
      }
      return created;
    });
    await expectRejectedWith(
      alice.mutation(api.comms.sendOneOff, {
        eventSlug,
        to: { kind: "contacts", eventContactIds: ids },
        subject: "x",
        html: "<p>x</p>",
        now: NOW,
      }),
      "invalid_audience",
    );
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
      t,
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

  test("an oversized audience is refused, not silently truncated", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    // MAX_AUDIENCE is 200; 201 reachable speakers must trip the guard.
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      const sessionId = await ctx.db.insert("sessions", {
        eventId: event._id,
        title: "Big panel",
        source: "direct",
        status: "planned",
      });
      for (let i = 0; i < 201; i++) {
        const eventContactId = await ctx.db.insert("eventContacts", {
          eventId: event._id,
          orgId: event.orgId,
          firstName: `Sp${i}`,
          lastName: "Eaker",
          email: `sp${i}@example.com`,
        });
        await ctx.db.insert("sessionParticipants", {
          sessionId,
          eventId: event._id,
          eventContactId,
          role: "speaker",
          state: "confirmed",
        });
      }
    });

    // The count is honest about the cap rather than presenting 200 as exact.
    const counts = await alice.query(api.comms.listAudiences, {
      eventSlug,
      now: NOW,
    });
    expect(counts.find((c) => c.kind === "allSpeakers")).toMatchObject({
      count: 200,
      totalKnown: 201,
      truncated: true,
    });

    // And the send refuses with the real total rather than blasting 200.
    await expectRejectedWith(
      alice.mutation(api.comms.sendOneOff, {
        eventSlug,
        to: { kind: "audience", audience: "allSpeakers" },
        subject: "x",
        html: "<p>x</p>",
        now: NOW,
      }),
      "audience_too_large",
    );
  });

  test("an audience whose task read hits its cap refuses, so `truncated` can be trusted (H5)", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );

    // The overdue-task audience reads the event's requirements (cap 200). At
    // the cap it still answers; one row past it the audience could only be
    // understated — and an understated audience reports `truncated: false`,
    // which is exactly what sendOneOff trusts before it fans out.
    const eventId = await eventIdOf(t, eventSlug);
    const addRequirements = async (count: number) => {
      await t.run(async (ctx) => {
        for (let i = 0; i < count; i += 1) {
          await ctx.db.insert("requirements", {
            eventId,
            title: `Extra ${i}`,
            scope: "participant",
            evidence: "manual",
            reviewRequired: false,
            dueAt: PAST_DUE,
            active: true,
          });
        }
      });
    };
    await addRequirements(200);
    expect(
      (
        await alice.query(api.comms.listAudiences, { eventSlug, now: NOW })
      ).find((c) => c.kind === "overdueTasks"),
    ).toMatchObject({ truncated: false });

    await addRequirements(1);
    await expectRejectedWith(
      alice.query(api.comms.listAudiences, { eventSlug, now: NOW }),
      "event_too_large",
    );
    await expectRejectedWith(
      alice.mutation(api.comms.sendOneOff, {
        eventSlug,
        to: { kind: "audience", audience: "overdueTasks" },
        subject: "x",
        html: "<p>x</p>",
        now: NOW,
      }),
      "event_too_large",
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

  test("an archived event refuses one-off sends", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { eventContactId } = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await alice.mutation(api.events.setArchived, { eventSlug, archived: true });
    await clearMessages(t);
    await expectRejectedWith(
      alice.mutation(api.comms.sendOneOff, {
        eventSlug,
        to: { kind: "contact", eventContactId },
        subject: "x",
        html: "<p>x</p>",
        now: NOW,
      }),
      "event_archived",
    );
    expect(await messageRows(t)).toHaveLength(0);
  });
});

// ── Per-contact comms log ────────────────────────────────────────────────

describe("comms.contactLog", () => {
  test("returns this contact's history newest first", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { eventContactId } = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await inviteSpeaker(
      t,
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
      t,
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

  test("the address half is indexed and case-insensitive, including pre-normalization rows (M4)", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const eventId = await eventIdOf(t, eventSlug);
    // A snapshot whose address kept the casing it arrived with (the import
    // path does not normalize what it stores).
    const eventContactId = await t.run(async (ctx) => {
      const orgId = (await ctx.db.get("events", eventId))!.orgId;
      const contactId = await ctx.db.insert("eventContacts", {
        eventId,
        orgId,
        firstName: "Dana",
        lastName: "Keynote",
        email: "Dana@Example.com",
      });
      // What the write path stores today: the normalized address, which is
      // what the (eventId, toEmail) index is queried with.
      await ctx.db.insert("messages", {
        orgId,
        eventId,
        toEmail: "dana@example.com",
        kind: "normalized.send",
        subject: "Recent",
        deliveryStatus: "delivered",
      });
      // A row written BEFORE normalization was enforced, carrying the address
      // exactly as typed: still visible, which is how the backfill gap is
      // handled without a migration.
      await ctx.db.insert("messages", {
        orgId,
        eventId,
        toEmail: "Dana@Example.com",
        kind: "legacy.mixedCase",
        subject: "Sent last year",
        deliveryStatus: "delivered",
      });
      // Noise the index must exclude: same event, someone else's address.
      await ctx.db.insert("messages", {
        orgId,
        eventId,
        toEmail: "other@example.com",
        kind: "someone.else",
        subject: "Not Dana's",
        deliveryStatus: "delivered",
      });
      return contactId;
    });

    // A real send through the one write path lands on the normalized address,
    // so it is found by the same indexed read.
    await alice.mutation(api.sessions.invitePortal, {
      eventSlug,
      eventContactId,
    });

    const log = await alice.query(api.comms.contactLog, {
      eventSlug,
      eventContactId,
    });
    expect(log.map((m) => m.kind).sort()).toEqual([
      "legacy.mixedCase",
      "normalized.send",
      "portal.invite",
    ]);
    expect(log.find((m) => m.kind === "portal.invite")?.toEmail).toBe(
      "dana@example.com",
    );
  });
});

// ── Scheduled reminders ──────────────────────────────────────────────────

describe("reminders.sweep", () => {
  test("manual outstanding-task reminders report exact sent/skipped and log a manual kind", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const reachable = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      "Analytical engines",
    );
    const unreachable = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "No", lastName: "Mail", email: "nomail@example.com" },
      "Offline systems",
    );
    for (const sessionId of [reachable.sessionId, unreachable.sessionId]) {
      await confirm(
        alice,
        eventSlug,
        await participantFor(
          t,
          sessionId,
          sessionId === reachable.sessionId ? "Ada" : "No",
        ),
      );
    }
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Confirm logistics",
      scope: "participant",
      evidence: "manual",
      reviewRequired: false,
      dueAt: NOW + DAY,
    });
    await clearContactEmail(t, unreachable.eventContactId);
    await clearMessages(t);

    const result = await alice.mutation(api.reminders.sendOutstandingNow, {
      eventSlug,
    });
    expect(result).toEqual({
      sent: 1,
      failed: 0,
      skipped: 1,
      includedTasks: 1,
    });
    const sends = await messagesOfKind(t, "reminder.tasks.manual");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      toEmail: "ada@example.com",
      sentByUserId: expect.any(String),
      context: { manual: true },
    });
  });

  test("manual outstanding reminders include awaiting speakers with an authorized contact email", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      "Analytical engines",
    );
    // The direct participant deliberately remains awaiting.
    await manualRequirement(
      alice,
      eventSlug,
      "Confirm speaker release",
      NOW + DAY,
    );
    await clearMessages(t);

    const result = await alice.mutation(api.reminders.sendOutstandingNow, {
      eventSlug,
    });
    expect(result).toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
      includedTasks: 1,
    });
    const [send] = await messagesOfKind(t, "reminder.tasks.manual");
    expect(send).toMatchObject({
      toEmail: "ada@example.com",
      deliveryStatus: "queued",
    });
    expect((send.context as { renderedBody: string }).renderedBody).toContain(
      "Confirm speaker release",
    );
  });

  test("a failed manual reminder is reported and does not advance task cadence", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      "Analytical engines",
    );
    await manualRequirement(alice, eventSlug, "Confirm speaker release");
    await elapseReminders(t);
    await clearMessages(t);

    let result:
      | { sent: number; failed: number; skipped: number; includedTasks: number }
      | undefined;
    await withEnv("RESEND_TEST_MODE", undefined, async () => {
      result = await alice.mutation(api.reminders.sendOutstandingNow, {
        eventSlug,
      });
    });

    expect(result).toEqual({
      sent: 0,
      failed: 1,
      skipped: 0,
      includedTasks: 1,
    });
    expect((await instanceRows(t))[0].lastRemindedAt).toBe(LONG_AGO);
    expect((await messagesOfKind(t, "reminder.tasks.manual"))[0]).toMatchObject(
      { deliveryStatus: "failed" },
    );
  });

  test("does nothing without a cadence while tasks are outside the due window", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await manualRequirement(
      alice,
      eventSlug,
      "Sign the speaker release",
      FUTURE_DUE,
    );
    await clearMessages(t);

    // No cadence and no task due within 48 hours → no per-event job.
    const result = await runSweep(t, NOW);
    expect(result).toMatchObject({ events: 0 });
    expect(await messageRows(t)).toHaveLength(0);
  });

  test("a requirement cadence is discovered without an event cadence or near due date", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Dave"));
    const requirement = await manualRequirement(
      alice,
      eventSlug,
      "Submit travel preferences",
      FUTURE_DUE,
    );
    await alice.mutation(api.tasks.updateRequirement, {
      eventSlug,
      requirementId: requirement.requirementId,
      patch: { reminderCadenceDays: 3 },
    });
    await clearMessages(t);
    await elapseReminders(t);

    // FUTURE_DUE is far outside the 48-hour safety window and the event has no
    // default. The requirement index is therefore the only discovery source.
    expect(await runSweep(t, NOW)).toEqual({ events: 1 });
    const [send] = await messagesOfKind(t, "reminder.tasks");
    expect(send.toEmail).toBe("bob@example.com");
    expect(
      (send.context as { instanceIds: string[] }).instanceIds,
    ).toHaveLength(2);

    // The explicit three-day cadence remains authoritative; due-date fallback
    // does not shorten it after the accepted send.
    await runSweep(t, NOW + DAY);
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(1);
    await runSweep(t, NOW + 3 * DAY);
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(2);
  });

  test("due-soon work triggers automatically without an event cadence or organizer send", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      "Analytical engines",
    );
    // Ada remains awaiting: assigning a dated task must still produce the
    // due-date safety reminder to her authorized event-contact address.
    await manualRequirement(
      alice,
      eventSlug,
      "Sign speaker release form",
      NOW + DAY,
    );
    await clearMessages(t);

    expect(await runSweep(t, NOW)).toEqual({ events: 1 });
    const [send] = await messagesOfKind(t, "reminder.tasks");
    expect(send).toMatchObject({
      toEmail: "ada@example.com",
      deliveryStatus: "queued",
    });
    expect(send.sentByUserId).toBeUndefined();
    const rendered = (send.context as { renderedBody: string }).renderedBody;
    expect(rendered).toContain("Sign speaker release form");
    expect(rendered).toContain("due");

    // Provider acceptance stamped the task, so the hourly evaluator does not
    // turn the due window into hourly spam.
    await runSweep(t, NOW + 60 * 60 * 1000);
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(1);
  });

  test("configured cadence sends a fresh overdue task on the next automatic sweep", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await manualRequirement(
      alice,
      eventSlug,
      "Automatic reminder clean-cycle verification",
      PAST_DUE,
    );
    await setCadence(alice, eventSlug, 1);
    await clearMessages(t);

    // No organizer send and no backdated reminder stamp: the task is already
    // overdue, so its first reminder belongs in the next automatic cycle even
    // though the event has an explicit cadence.
    expect(await runSweep(t, NOW)).toEqual({ events: 1 });
    const [first] = await messagesOfKind(t, "reminder.tasks");
    expect(first).toMatchObject({
      deliveryStatus: "queued",
    });
    expect(first.sentByUserId).toBeUndefined();
    const rendered = (first.context as { renderedBody: string }).renderedBody;
    expect(rendered).toContain("Automatic reminder clean-cycle verification");
    expect(rendered).toContain("due");

    // Provider acceptance starts the configured one-day cadence. The hourly
    // evaluator stays silent, then the task becomes eligible one day later.
    await runSweep(t, NOW + 60 * 60 * 1000);
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(1);
    await runSweep(t, NOW + DAY);
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(2);
  });

  test("paginated due discovery dedupes overlap and reaches work behind a thousand-row backlog", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Dave"));
    await manualRequirement(alice, eventSlug, "Target speaker release");
    await clearMessages(t);

    // Put 1,000 older pending rows ahead of the real event in the
    // status+dueAt index. One dispatcher transaction reads only 100; its
    // scheduled continuations must advance through the backlog and eventually
    // schedule the target event rather than starving it forever. The filler
    // event also appears in BOTH cadence sources, proving cross-source overlap
    // plus ten due pages still produces exactly one full event sweep.
    let fillerEventId: Id<"events"> | undefined;
    await t.run(async (ctx) => {
      const target = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (target === null) throw new Error("no target event");
      fillerEventId = await ctx.db.insert("events", {
        orgId: target.orgId,
        name: "Historical backlog",
        slug: "historical-reminder-backlog",
        startsAt: NOW - DAY,
        endsAt: NOW + 30 * DAY,
        timezone: "UTC",
        cfpPublished: false,
        reminderCadenceDays: 1,
      });
      const fillerSessionId = await ctx.db.insert("sessions", {
        eventId: fillerEventId,
        title: "Old session",
        source: "direct",
        status: "planned",
      });
      const fillerRequirementId = await ctx.db.insert("requirements", {
        eventId: fillerEventId,
        title: "Old unfinished item",
        scope: "session",
        evidence: "manual",
        reviewRequired: false,
        dueAt: PAST_DUE - DAY,
        active: true,
        reminderCadenceDays: 2,
      });
      for (let i = 0; i < 1000; i += 1) {
        await ctx.db.insert("taskInstances", {
          requirementId: fillerRequirementId,
          eventId: fillerEventId,
          sessionId: fillerSessionId,
          status: "pending",
          dueAt: PAST_DUE - DAY,
          updatedAt: NOW - 30 * DAY,
        });
      }
    });

    expect(await runSweep(t, NOW)).toEqual({ events: 1 });
    // `runSweep`'s normal three turns cover ordinary jobs. This fixture has
    // ten cursor continuations by design, so drain the rest before asserting
    // that discovery reached the newer target.
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await t.finishInProgressScheduledFunctions();
    }
    const targetSends = (await messagesOfKind(t, "reminder.tasks")).filter(
      (message) => message.toEmail === "bob@example.com",
    );
    expect(targetSends).toHaveLength(1);
    expect(
      (targetSends[0].context as { instanceIds: string[] }).instanceIds,
    ).toHaveLength(2);
    const states = await t.run(async (ctx) =>
      ctx.db.query("reminderDispatchStates").collect(),
    );
    const fillerState = states.find((state) => state.eventId === fillerEventId);
    expect(fillerState).toMatchObject({
      lastRunAt: NOW,
      dispatchCount: 1,
    });
    expect(states).toHaveLength(2);
    expect(states.every((state) => state.dispatchCount === 1)).toBe(true);
  });

  test("a failed automatic reminder is counted, left unstamped, and retried", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      "Analytical engines",
    );
    await manualRequirement(alice, eventSlug, "Sign speaker release form");
    await elapseReminders(t);
    await clearMessages(t);

    let failedResult:
      | {
          taskEmails: number;
          participationEmails: number;
          failedEmails: number;
          skippedRecipients: number;
          deferredRecipients: number;
        }
      | undefined;
    await withEnv("RESEND_TEST_MODE", undefined, async () => {
      failedResult = await sweepEventNow(t, eventSlug, NOW);
    });
    expect(failedResult).toMatchObject({
      taskEmails: 0,
      failedEmails: 1,
      skippedRecipients: 0,
    });
    expect((await instanceRows(t))[0].lastRemindedAt).toBe(LONG_AGO);

    const retry = await sweepEventNow(t, eventSlug, NOW + 60 * 60 * 1000);
    expect(retry).toMatchObject({ taskEmails: 1, failedEmails: 0 });
    expect((await instanceRows(t))[0].lastRemindedAt).toBe(
      NOW + 60 * 60 * 1000,
    );
  });

  test("automatic due reminders report an unreachable speaker as skipped", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const ada = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      "Analytical engines",
    );
    await manualRequirement(alice, eventSlug, "Sign speaker release form");
    await clearContactEmail(t, ada.eventContactId);
    await elapseReminders(t);
    await clearMessages(t);

    expect(await sweepEventNow(t, eventSlug, NOW)).toMatchObject({
      taskEmails: 0,
      failedEmails: 0,
      skippedRecipients: 1,
    });
    expect(await messageRows(t)).toHaveLength(0);
    expect((await instanceRows(t))[0].lastRemindedAt).toBe(LONG_AGO);
  });

  test("consolidates two outstanding tasks into ONE email per recipient", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Dave"));
    await manualRequirement(alice, eventSlug, "Sign the speaker release");
    await manualRequirement(alice, eventSlug, "Send your travel details");
    await setCadence(alice, eventSlug, 3);
    await clearMessages(t);
    await elapseReminders(t);

    const result = await sweepEventNow(t, eventSlug, NOW);
    expect(result).toEqual({
      taskEmails: 1,
      participationEmails: 0,
      failedEmails: 0,
      skippedRecipients: 0,
      deferredRecipients: 0,
    });

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
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await manualRequirement(alice, eventSlug, "Sign the speaker release");
    await setCadence(alice, eventSlug, 3);
    await clearMessages(t);
    await elapseReminders(t);

    expect(await sweepEventNow(t, eventSlug, NOW)).toMatchObject({
      taskEmails: 1,
    });
    // An hour later (the real cron interval) and a day later: still silent.
    expect(await sweepEventNow(t, eventSlug, NOW + 3600 * 1000)).toMatchObject({
      taskEmails: 0,
    });
    expect(await sweepEventNow(t, eventSlug, NOW + 2 * DAY)).toMatchObject({
      taskEmails: 0,
    });
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(1);

    // Past the cadence, it fires again — and being overdue never shortened it.
    expect(await sweepEventNow(t, eventSlug, NOW + 3 * DAY)).toMatchObject({
      taskEmails: 1,
    });
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(2);
  });

  test("an unconfirmed speaker gets participation chasing, never task chasing", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await manualRequirement(alice, eventSlug, "Sign the speaker release");
    await setCadence(alice, eventSlug, 3);
    await clearMessages(t);
    await elapseReminders(t);

    const result = await sweepEventNow(t, eventSlug, NOW);
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
    expect(
      (tasks[0].context as { instanceIds: string[] }).instanceIds,
    ).toHaveLength(1);

    // Dave's participant row is stamped so the next sweep respects the cadence.
    const dave = (await participantRows(t)).find(
      (p) => p.lastRemindedAt === NOW,
    );
    expect(dave).toBeDefined();
    expect(await sweepEventNow(t, eventSlug, NOW + DAY)).toMatchObject({
      participationEmails: 0,
    });
  });

  test("per-requirement remindersDisabled and cadence overrides are honored", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
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
    await elapseReminders(t);

    await runSweep(t, NOW);
    const [send] = await messagesOfKind(t, "reminder.tasks");
    // Only the two "Speaker release" instances (Carol + Dave) are in there.
    expect(
      (send.context as { instanceIds: string[] }).instanceIds,
    ).toHaveLength(2);

    // The silenced requirement's instances were never stamped BY THE SWEEP:
    // they still carry the backdated stamp, not `now`.
    const untouched = (await instanceRows(t)).filter(
      (i) => i.requirementId === quiet.requirementId,
    );
    expect(untouched.every((i) => i.lastRemindedAt === LONG_AGO)).toBe(true);

    // Two days later the event default would fire, but the override says 7.
    await runSweep(t, NOW + 2 * DAY);
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(1);
    await runSweep(t, NOW + 8 * DAY);
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(2);
  });

  test("completed work and archived events stop the chasing", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
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
    await elapseReminders(t);

    await runSweep(t, NOW);
    const [send] = await messagesOfKind(t, "reminder.tasks");
    expect(
      (send.context as { instanceIds: string[] }).instanceIds,
    ).toHaveLength(1);

    // Archiving stops automations entirely (MILESTONES M0): the dispatcher
    // never schedules the event, and a direct per-event run refuses too.
    await alice.mutation(api.events.setArchived, { eventSlug, archived: true });
    await clearMessages(t);
    expect(await runSweep(t, NOW + 30 * DAY)).toMatchObject({ events: 0 });
    expect(await sweepEventNow(t, eventSlug, NOW + 30 * DAY)).toEqual({
      taskEmails: 0,
      participationEmails: 0,
      failedEmails: 0,
      skippedRecipients: 0,
      deferredRecipients: 0,
    });
    expect(await messageRows(t)).toHaveLength(0);
  });

  test("a withdrawn participant and a cancelled session stop the chasing", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { bob, sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await manualRequirement(alice, eventSlug, "Speaker release");
    await setCadence(alice, eventSlug, 1);
    await clearMessages(t);
    await elapseReminders(t);

    // Baseline: Carol confirmed → her task chases bob (the manager); Dave
    // still awaiting → participation chasing to Dave himself.
    expect(await sweepEventNow(t, eventSlug, NOW)).toEqual({
      taskEmails: 1,
      participationEmails: 1,
      failedEmails: 0,
      skippedRecipients: 0,
      deferredRecipients: 0,
    });

    // Dave withdraws (his manager records it): participation chasing stops
    // for him at the very next sweep.
    await bob.mutation(api.portal.withdrawParticipation, {
      eventSlug,
      participantId: await participantFor(t, sessionId, "Dave"),
    });
    expect(await sweepEventNow(t, eventSlug, NOW + 2 * DAY)).toEqual({
      taskEmails: 1,
      participationEmails: 0,
      failedEmails: 0,
      skippedRecipients: 0,
      deferredRecipients: 0,
    });

    // A decision correction cancels the session → ALL chasing goes quiet,
    // task chasing included (the sweep only chases planned sessions).
    const proposalId = await t.run(async (ctx) => {
      const session = await ctx.db.get("sessions", sessionId);
      if (session?.proposalId === undefined) throw new Error("no proposal");
      return session.proposalId;
    });
    await alice.mutation(api.sessions.correct, {
      eventSlug,
      proposalId,
      to: "declined",
      note: "Pulled from the program.",
    });
    await clearMessages(t);
    expect(await sweepEventNow(t, eventSlug, NOW + 4 * DAY)).toEqual({
      taskEmails: 0,
      participationEmails: 0,
      failedEmails: 0,
      skippedRecipients: 0,
      deferredRecipients: 0,
    });
    expect(await messageRows(t)).toHaveLength(0);
  });

  test("a claimed speaker's task chasing still routes to their manager", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await manualRequirement(alice, eventSlug, "Speaker release");
    await setCadence(alice, eventSlug, 2);

    const carol = await signIn(t, "carol", {
      email: "carol@example.com",
      emailVerified: true,
    });
    await carol.mutation(api.portal.enter, { eventSlug });
    await clearMessages(t);
    await elapseReminders(t);

    await runSweep(t, NOW);
    // Carol claimed her portal, but routine task chasing never silently
    // reroutes off the primary manager (MILESTONES M4:87).
    expect(
      (await messagesOfKind(t, "reminder.tasks")).map((m) => m.toEmail),
    ).toEqual(["bob@example.com"]);
  });

  test("an organizer's template override drives the reminder copy", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await manualRequirement(alice, eventSlug, "Speaker release");
    await setCadence(alice, eventSlug, 2);
    await alice.mutation(api.templates.upsert, {
      eventSlug,
      key: "reminder.tasks",
      subject: "[{{event.name}}] still outstanding",
      html: "<p>{{tasks}}</p>",
    });
    await clearMessages(t);
    await elapseReminders(t);

    await runSweep(t, NOW);
    expect((await messagesOfKind(t, "reminder.tasks"))[0].subject).toBe(
      "[Acme Summit] still outstanding",
    );
  });

  test("the first reminder waits a full cadence after assignment", async () => {
    const t = setupTest();
    // This test walks the REAL clock (creation stamps), so anchor the event
    // dates to it too — a fixed date would drift out of the post-event grace.
    const { alice, eventSlug } = await organizerEvent(t, {
      startsAt: Date.now() + 30 * DAY,
      endsAt: Date.now() + 32 * DAY,
    });
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    // Confirm both speakers so the scenario is purely about task cadence.
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Dave"));
    await manualRequirement(alice, eventSlug, "Speaker release", FUTURE_DUE);
    await setCadence(alice, eventSlug, 3);
    await clearMessages(t);

    // Fresh instances reserve lastRemindedAt for accepted sends. The document
    // creation time is the initial baseline for a configured cadence.
    const created = await t.run(async (ctx) => {
      const [instance] = await ctx.db.query("taskInstances").collect();
      expect(instance.lastRemindedAt).toBeUndefined();
      return instance._creationTime;
    });
    const t0 = created;

    // Well outside the 48-hour due-date safety window and inside the 3-day
    // cadence: nothing fires, even though a plain hourly sweep runs.
    expect(await sweepEventNow(t, eventSlug, t0 + 3600 * 1000)).toMatchObject({
      taskEmails: 0,
      participationEmails: 0,
    });
    expect(
      await sweepEventNow(t, eventSlug, t0 + 3 * DAY - 1000),
    ).toMatchObject({ taskEmails: 0 });
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(0);

    // A full cadence after assignment: it finally fires.
    expect(await sweepEventNow(t, eventSlug, t0 + 3 * DAY)).toMatchObject({
      taskEmails: 1,
    });
  });

  test("a manager owed a task AND covering an awaiting speaker gets ONE email", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    // Carol confirms → her task is chased to bob. Dave stays awaiting AND has
    // no address of his own, so his participation reminder falls back to bob.
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    const daveParticipant = await participantFor(t, sessionId, "Dave");
    await t.run(async (ctx) => {
      const dave = await ctx.db.get("sessionParticipants", daveParticipant);
      if (dave === null) throw new Error("no dave");
      await ctx.db.patch("eventContacts", dave.eventContactId, {
        email: undefined,
      });
    });
    await manualRequirement(alice, eventSlug, "Speaker release");
    await setCadence(alice, eventSlug, 2);
    await clearMessages(t);
    await elapseReminders(t);

    const result = await sweepEventNow(t, eventSlug, NOW);
    // Both a task section and a participation section, but ONE message (M5:86).
    const sends = await messageRows(t);
    expect(sends).toHaveLength(1);
    expect(sends[0].toEmail).toBe("bob@example.com");
    // ...and it is COUNTED once: counters count emails, not sections, so the
    // combined send is one taskEmail and the totals sum to messages sent.
    expect(result).toMatchObject({ taskEmails: 1, participationEmails: 0 });
    // The participation section did ride along in the one email.
    expect(
      (sends[0].context as { participantIds: string[] }).participantIds,
    ).toHaveLength(1);

    // Carol's task instance and Dave's participant were both stamped, so a
    // second sweep inside the window is silent.
    expect(await sweepEventNow(t, eventSlug, NOW + 3600 * 1000)).toMatchObject({
      taskEmails: 0,
      participationEmails: 0,
    });
  });

  test("a self-managed direct speaker owns their session task; overdue audience keeps it", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    // Direct invite: Sam manages himself — there is no primary manager.
    const { sessionId } = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Sam", lastName: "Solo", email: "sam@example.com" },
      "Solo talk",
    );
    // A session-scope obligation for the whole session.
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Final slide deck",
      scope: "session",
      evidence: "manual",
      reviewRequired: false,
      dueAt: PAST_DUE,
    });

    // Sam signs in, claims his snapshot, and confirms.
    const sam = await signIn(t, "sam", {
      email: "sam@example.com",
      emailVerified: true,
    });
    await sam.mutation(api.portal.enter, { eventSlug });
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Sam"));

    // Fix 6: the session task is visible to the self-managed speaker...
    const tasks = await sam.query(api.portal.myTasks, { eventSlug });
    const sessionTask = tasks.find((task) => task.scope === "session");
    expect(sessionTask).toBeDefined();

    // ...the overdue audience includes it (routed to Sam, who has no manager)...
    const counts = await alice.query(api.comms.listAudiences, {
      eventSlug,
      now: NOW,
    });
    expect(counts.find((c) => c.kind === "overdueTasks")?.count).toBe(1);

    // ...and Sam can complete it himself.
    await sam.mutation(api.portal.completeTask, {
      eventSlug,
      instanceId: sessionTask!.instanceId,
    });
    const after = await alice.query(api.comms.listAudiences, {
      eventSlug,
      now: NOW,
    });
    expect(after.find((c) => c.kind === "overdueTasks")?.count).toBe(0);
  });

  test("one failing event's sweep does not block other events", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const okSlug = await createEvent(alice, orgSlug, "Healthy Summit");
    const brokenSlug = await createEvent(alice, orgSlug, "Broken Summit");
    await inviteSpeaker(
      t,
      alice,
      okSlug,
      { firstName: "Hana", lastName: "Fine", email: "hana@example.com" },
      "Healthy talk",
    );
    await inviteSpeaker(
      t,
      alice,
      brokenSlug,
      { firstName: "Bora", lastName: "Stuck", email: "bora@example.com" },
      "Broken talk",
    );
    await setCadence(alice, okSlug, 1);
    await setCadence(alice, brokenSlug, 1);
    // The healthy event carries an override, so it renders even after the
    // built-in default disappears below; the broken event has none.
    await alice.mutation(api.templates.upsert, {
      eventSlug: okSlug,
      key: "reminder.participation",
      subject: "Confirm for {{event.name}}",
      html: "<p>{{body}}</p>",
    });
    await clearMessages(t);
    await elapseReminders(t);

    // Simulate a per-event render failure: the participation template is
    // missing, so the broken event's sweep throws mid-flight.
    const saved = DEFAULT_TEMPLATES["reminder.participation"];
    delete DEFAULT_TEMPLATES["reminder.participation"];
    try {
      await expectRejectedWith(sweepEventNow(t, brokenSlug, NOW), "not_found");
      // The dispatcher schedules BOTH events; the broken one fails in its own
      // mutation and the healthy one still gets its reminder out.
      expect(await runSweep(t, NOW)).toMatchObject({ events: 2 });
      const sends = await messagesOfKind(t, "reminder.participation");
      expect(sends.map((m) => m.toEmail)).toEqual(["hana@example.com"]);
    } finally {
      DEFAULT_TEMPLATES["reminder.participation"] = saved;
    }
  });

  test("an event past the old 500-event scan window still gets its reminders (H5)", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await manualRequirement(alice, eventSlug, "Upload your slides");
    await setCadence(alice, eventSlug, 1);
    await clearMessages(t);
    await elapseReminders(t);

    // 600 other events, ALL created before this assertion and none of them
    // wanting reminders. The old dispatcher read `events.take(500)` in
    // creation order, so anything past the 500th row was never dispatched —
    // invisibly. The cadence index means the filler rows are not even read.
    const orgId = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      for (let i = 0; i < 600; i += 1) {
        await ctx.db.insert("events", {
          orgId: event.orgId,
          name: `Filler ${i}`,
          slug: `filler-${i}`,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          timezone: event.timezone,
          cfpPublished: false,
        });
      }
      return event.orgId;
    });

    expect(await runSweep(t, NOW)).toMatchObject({ events: 1 });
    expect(
      (await messagesOfKind(t, "reminder.tasks")).map((m) => m.toEmail),
    ).toEqual(["bob@example.com"]);

    // And one of those far-past-500 events opting in is dispatched too.
    await t.run(async (ctx) => {
      const filler = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", "filler-599"))
        .unique();
      if (filler === null) throw new Error("no filler event");
      expect(filler.orgId).toBe(orgId);
      await ctx.db.patch("events", filler._id, { reminderCadenceDays: 1 });
    });
    // This is deliberately the same logical `now` as the earlier root sweep.
    // The already-dispatched target is deduped; the newly opted-in filler is
    // the one new dispatch, proving the durable run/event gate is active.
    expect(await runSweep(t, NOW)).toMatchObject({ events: 1 });
  });

  test("the sweep stops chasing after the post-event grace window", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await manualRequirement(alice, eventSlug, "Upload your slides");
    await setCadence(alice, eventSlug, 1);
    const endsAt = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      return event.endsAt;
    });
    await clearMessages(t);
    await elapseReminders(t);

    // Inside the 7-day grace: post-event collection still gets chased.
    expect(await sweepEventNow(t, eventSlug, endsAt + 6 * DAY)).toMatchObject({
      taskEmails: 1,
    });

    // Past the grace: the dispatcher skips the event without archiving, and a
    // stale per-event job refuses on its own re-check too.
    await elapseReminders(t);
    await clearMessages(t);
    expect(await runSweep(t, endsAt + 8 * DAY)).toMatchObject({ events: 0 });
    expect(await sweepEventNow(t, eventSlug, endsAt + 8 * DAY)).toEqual({
      taskEmails: 0,
      participationEmails: 0,
      failedEmails: 0,
      skippedRecipients: 0,
      deferredRecipients: 0,
    });
    expect(await messageRows(t)).toHaveLength(0);
  });

  test("recipients past MAX_RECIPIENTS_PER_EVENT are reported, not silently dropped", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    // 201 distinct awaiting speakers: the 201st can't get a bucket this run.
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      const sessionId = await ctx.db.insert("sessions", {
        eventId: event._id,
        title: "Mega panel",
        source: "direct",
        status: "planned",
      });
      for (let i = 0; i < 201; i++) {
        const eventContactId = await ctx.db.insert("eventContacts", {
          eventId: event._id,
          orgId: event.orgId,
          firstName: `Sp${i}`,
          lastName: "Eaker",
          email: `sp${i}@example.com`,
        });
        await ctx.db.insert("sessionParticipants", {
          sessionId,
          eventId: event._id,
          eventContactId,
          role: "speaker",
          state: "awaiting",
          lastRemindedAt: LONG_AGO,
        });
      }
    });
    await setCadence(alice, eventSlug, 1);
    await clearMessages(t);

    const result = await sweepEventNow(t, eventSlug, NOW);
    expect(result).toEqual({
      taskEmails: 0,
      participationEmails: 200,
      failedEmails: 0,
      skippedRecipients: 0,
      deferredRecipients: 1,
    });
    // The deferred speaker was NOT stamped, so the next sweep picks them up.
    expect(await sweepEventNow(t, eventSlug, NOW + 3600 * 1000)).toMatchObject({
      participationEmails: 1,
      deferredRecipients: 0,
    });
  });
});

// ── Mail identity & bulk-mail opt-out (M14/M15) ──────────────────────────
//
// Two self-host properties that only exist if they are pinned:
//   • WHO the mail claims to be from, and whether real sends are allowed, come
//     from deployment env vars — not from constants baked into the code.
//   • Bulk/nudge mail (organizer broadcasts, reminder digests) carries
//     `List-Unsubscribe`; transactional lifecycle mail does not, because an
//     opt-out on an invitation offers to break a flow the recipient needs.

/** The subset of the Resend client's send options these tests assert on. */
type SentOptions = {
  from: string;
  to: string | string[];
  subject: string;
  headers?: Array<{ name: string; value: string }>;
};

/** Spy that still performs the real send, so the comms log is written exactly
 * as in production and only the transport arguments are observed. */
function captureSends() {
  const spy = vi.spyOn(resend, "sendEmail");
  const sent: SentOptions[] = [];
  return {
    /** Snapshots the calls before restoring — `mockRestore()` also clears them. */
    restore: () => {
      sent.push(
        ...spy.mock.calls.map((call) => call[1] as unknown as SentOptions),
      );
      spy.mockRestore();
    },
    options: (): SentOptions[] => sent,
  };
}

function headerValue(
  options: SentOptions | undefined,
  name: string,
): string | undefined {
  return options?.headers?.find((h) => h.name === name)?.value;
}

/** Run `body` with one env var set (or removed), then put it back. */
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

describe("mail identity (M14)", () => {
  test("MAIL_FROM drives every envelope From, with a default", () => {
    expect(mailFrom()).toBe("StageStack <hello@stagestack.dev>");
    expect(mailFromAddress()).toBe("hello@stagestack.dev");
  });

  test("RESEND_TEST_MODE only turns OFF on an explicit false-y value", async () => {
    for (const value of ["false", "FALSE", " off ", "0", "no"]) {
      await withEnv("RESEND_TEST_MODE", value, async () =>
        expect(resendTestMode()).toBe(false),
      );
    }
    // Unset, blank, or a typo ⇒ test mode STAYS ON: guessing wrong here would
    // mail real speakers from a domain the deployment may not own.
    for (const value of [undefined, "", "true", "flase", "yes"]) {
      await withEnv("RESEND_TEST_MODE", value, async () =>
        expect(resendTestMode()).toBe(true),
      );
    }
  });

  test("a fresh clone's default REFUSES to mail a real speaker", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    // The suite pins RESEND_TEST_MODE=false (test.helpers.ts); dropping it
    // reproduces an unconfigured deployment. The flag is read per send, so no
    // module reload is needed for it to take effect.
    //
    // The invite MUTATION commits regardless (sends are deferred and the
    // send itself runs in a subtransaction), so what a fresh clone must show
    // is: the refused send lands as a visible FAILED comms-log row — real
    // mail never goes out, and nothing is silently lost either.
    await withEnv("RESEND_TEST_MODE", undefined, async () => {
      await inviteSpeaker(
        t,
        alice,
        eventSlug,
        { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
        "Opening keynote",
      );
      const rows = await t.run(async (ctx) =>
        ctx.db.query("messages").collect(),
      );
      const invitations = rows.filter((m) => m.kind === "invitation.direct");
      expect(invitations).toHaveLength(1);
      expect(invitations[0].deliveryStatus).toBe("failed");
      expect(invitations[0].resendEmailId).toBeUndefined();
    });
  });

  test("MAIL_FROM is the From on a real send", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const sends = captureSends();
    try {
      await withEnv("MAIL_FROM", "Selfhost Events <events@example.org>", () =>
        inviteSpeaker(
          t,
          alice,
          eventSlug,
          { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
          "Opening keynote",
        ).then(() => undefined),
      );
    } finally {
      sends.restore();
    }
    expect(sends.options()[0].from).toBe(
      "Selfhost Events <events@example.org>",
    );
  });
});

describe("bulk-mail unsubscribe (M15)", () => {
  test("classifies broadcasts and reminder digests as bulk, lifecycle mail as not", () => {
    expect(isBulkKind("manual.oneoff")).toBe(true);
    expect(isBulkKind("crm.bulkOutreach")).toBe(true);
    expect(isBulkKind("reminder.tasks")).toBe(true);
    expect(isBulkKind("reminder.participation")).toBe(true);
    expect(isBulkKind("invitation.direct")).toBe(false);
    expect(isBulkKind("cfp.confirmation")).toBe(false);
    expect(isBulkKind("schedule.released")).toBe(false);
  });

  test("a one-off broadcast carries mailto: List-Unsubscribe and no one-click POST", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { eventContactId } = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    await clearMessages(t);

    const sends = captureSends();
    try {
      await alice.mutation(api.comms.sendOneOff, {
        eventSlug,
        to: { kind: "contact", eventContactId },
        subject: "One more thing",
        html: "<p>Hi {{speaker.firstName}}.</p>",
        now: NOW,
      });
    } finally {
      sends.restore();
    }
    const [options] = sends.options();
    // No event reply-to configured, so the request lands in the deployment's
    // own monitored mailbox.
    expect(headerValue(options, "List-Unsubscribe")).toBe(
      "<mailto:hello@stagestack.dev?subject=Unsubscribe>",
    );
    // RFC 8058 one-click promises an HTTPS POST target; we have none, so the
    // header must not appear.
    expect(headerValue(options, "List-Unsubscribe-Post")).toBeUndefined();
    // The send itself is unaffected: the comms log still records it.
    expect(await messagesOfKind(t, "manual.oneoff")).toHaveLength(1);
  });

  test("a reminder digest points the opt-out at the event's reply-to", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { replyTo: "speakers@acme.example" },
    });
    await confirm(
      alice,
      eventSlug,
      await participantFor(t, sessionId, "Carol"),
    );
    await manualRequirement(alice, eventSlug, "Sign the speaker release");
    await setCadence(alice, eventSlug, 3);
    await clearMessages(t);
    await elapseReminders(t);

    const sends = captureSends();
    try {
      await sweepEventNow(t, eventSlug, NOW);
    } finally {
      sends.restore();
    }
    expect(await messagesOfKind(t, "reminder.tasks")).toHaveLength(1);
    expect(headerValue(sends.options()[0], "List-Unsubscribe")).toBe(
      "<mailto:speakers@acme.example?subject=Unsubscribe>",
    );
  });

  test("transactional lifecycle mail carries NO opt-out", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const sends = captureSends();
    try {
      // A direct invitation: the recipient needs this link to take the slot,
      // so offering to unsubscribe from it would break the flow.
      await inviteSpeaker(
        t,
        alice,
        eventSlug,
        { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
        "Opening keynote",
      );
    } finally {
      sends.restore();
    }
    const options = sends.options();
    expect(options.length).toBeGreaterThan(0);
    for (const sent of options) {
      expect(headerValue(sent, "List-Unsubscribe")).toBeUndefined();
    }
  });
});

// ── Calendar invite sends (emails.ts) ────────────────────────────────────

describe("emails.sendCalendarInvite", () => {
  const ICS = {
    method: "REQUEST" as const,
    uid: "session-test@stagestack.dev",
    sequence: 0,
    startMs: NOW + 10 * DAY,
    endMs: NOW + 10 * DAY + 3600 * 1000,
    summary: "Convex in anger",
    organizerName: "Acme Summit",
    organizerEmail: "hello@stagestack.dev",
    attendeeName: "Carol Speaker",
    attendeeEmail: "carol@example.com",
  };

  async function inviteArgs(t: TestT, eventSlug: string) {
    return await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      return {
        orgId: event.orgId,
        eventId: event._id,
        toEmail: "carol@example.com",
        subject: "Your slot at Acme Summit",
        html: "<p>Slot details</p>",
        ics: ICS,
        kind: "schedule.released",
        context: { sequence: 0 },
      };
    });
  }

  test("a failed send leaves a failed comms-log row and still throws", async () => {
    const t = setupTest();
    const { eventSlug } = await organizerEvent(t);
    const args = await inviteArgs(t, eventSlug);
    await clearMessages(t);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
      ),
    );
    try {
      await expect(
        t.action(internal.emails.sendCalendarInvite, args),
      ).rejects.toThrow(/Resend API 500/);
    } finally {
      vi.unstubAllGlobals();
    }

    // The row was opened BEFORE the network call, so the failure has a trace:
    // status failed, the error recorded, and the recipient/kind preserved.
    const rows = await messageRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "schedule.released",
      toEmail: "carol@example.com",
      deliveryStatus: "failed",
    });
    // The resendEmailId was attached before the fetch — a webhook can never
    // race past a missing row again.
    expect(rows[0].resendEmailId).toBeDefined();
    expect((rows[0].context as { sendError: string }).sendError).toContain(
      "Resend API 500",
    );
  });

  test("a successful send patches the row and the webhook lookup still works", async () => {
    const t = setupTest();
    const { eventSlug } = await organizerEvent(t);
    const args = await inviteArgs(t, eventSlug);
    await clearMessages(t);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "re_provider_1" }), {
            status: 200,
          }),
      ),
    );
    let emailId = "";
    try {
      emailId = await t.action(internal.emails.sendCalendarInvite, args);
    } finally {
      vi.unstubAllGlobals();
    }

    const [row] = await messageRows(t);
    expect(row).toMatchObject({
      kind: "schedule.released",
      deliveryStatus: "sent",
      resendEmailId: emailId,
    });

    // Delivery webhook finds the row by resendEmailId and upgrades the status.
    await t.mutation(internal.emails.handleEmailEvent, {
      id: emailId as import("@convex-dev/resend").EmailId,
      event: {
        type: "email.delivered",
        created_at: "2026-08-10T09:00:00.000Z",
        data: {
          created_at: "2026-08-10T09:00:00.000Z",
          email_id: "re_provider_1",
          from: "StageStack <hello@stagestack.dev>",
          to: ["carol@example.com"],
          subject: args.subject,
        },
      },
    });
    expect((await messageRows(t))[0].deliveryStatus).toBe("delivered");
  });

  test("an agenda release drives the whole send: base64 .ics attachment + Idempotency-Key", async () => {
    const SLOT_START = Date.parse("2026-09-01T15:00:00Z");
    const SLOT_END = Date.parse("2026-09-01T16:00:00Z");
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Erin", lastName: "Onstage", email: "erin@example.com" },
      "Closing keynote",
    );
    const roomId = await alice.mutation(api.library.add, {
      eventSlug,
      table: "rooms",
      item: { name: "Main Stage" },
    });
    await alice.mutation(api.agenda.scheduleSession, {
      eventSlug,
      sessionId,
      slot: {
        startsAt: SLOT_START,
        endsAt: SLOT_END,
        roomId: roomId as Id<"rooms">,
      },
    });
    await clearMessages(t);

    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "re_provider_1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await alice.mutation(api.agenda.release, {
        eventSlug,
        sessionIds: [sessionId],
      });
      // Drain the runAfter(0) sendCalendarInvite action (and its followups).
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await t.finishInProgressScheduledFunctions();
      }
    } finally {
      vi.unstubAllGlobals();
    }

    // The raw Resend call is the only one carrying an attachment.
    const inviteCalls = fetchMock.mock.calls.filter((call) => {
      const init = call[1] as RequestInit | undefined;
      if (typeof init?.body !== "string") return false;
      try {
        return JSON.parse(init.body).attachments !== undefined;
      } catch {
        return false;
      }
    });
    expect(inviteCalls).toHaveLength(1);
    const [url, init] = inviteCalls[0] as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body as string) as {
      to: string[];
      attachments: Array<{
        filename: string;
        content: string;
        content_type: string;
      }>;
    };
    expect(body.to).toEqual(["erin@example.com"]);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toBe("invite.ics");
    expect(body.attachments[0].content_type).toBe(
      "text/calendar; method=REQUEST; charset=UTF-8",
    );
    const ics = atob(body.attachments[0].content);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain(`UID:session-${sessionId}-`);
    expect(ics).toContain("LOCATION:Main Stage");

    // The comms row was opened before the network call, patched to `sent`
    // after it, and the Idempotency-Key is the SAME component emailId the
    // delivery webhook will use to find the row.
    const [row] = await messagesOfKind(t, "schedule.released");
    expect(row).toMatchObject({
      toEmail: "erin@example.com",
      deliveryStatus: "sent",
    });
    expect(typeof row.resendEmailId).toBe("string");
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(row.resendEmailId);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Delivery health (CFP-08). A refused send commits the caller's write and
// leaves a `failed` row — correct, but silent. The rules worth a test:
//   • Failed rows in the recent window are counted and timestamped, so the
//     comms page can show the "emails are failing" banner.
//   • A healthy event reports zero — the banner never cries wolf.
//   • The summary is operational data: organizer-only, like the log itself.
// ─────────────────────────────────────────────────────────────────────────

describe("delivery health (CFP-08)", () => {
  test("counts recent refused sends and reports the newest one", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);

    // Reproduce the unconfigured deployment: RESEND_TEST_MODE unset refuses
    // the real-recipient send, and the invite mutation commits regardless.
    await withEnv("RESEND_TEST_MODE", undefined, async () => {
      await inviteSpeaker(
        t,
        alice,
        eventSlug,
        { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
        "Opening keynote",
      );
    });

    const health = await alice.query(api.comms.deliveryHealth, { eventSlug });
    expect(health.failed).toBeGreaterThanOrEqual(1);
    expect(health.scanned).toBeGreaterThanOrEqual(health.failed);
    const rows = await messageRows(t);
    const newestFailed = rows
      .filter((m) => m.deliveryStatus === "failed")
      .sort((a, b) => b._creationTime - a._creationTime)[0];
    expect(health.lastFailedAt).toBe(newestFailed._creationTime);
  });

  test("a healthy event reports zero failures", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Erin", lastName: "Ok", email: "erin@example.com" },
      "All is well",
    );
    const health = await alice.query(api.comms.deliveryHealth, { eventSlug });
    expect(health.failed).toBe(0);
    expect(health.lastFailedAt).toBeNull();
    expect(health.scanned).toBeGreaterThan(0);
  });

  test("reviewers cannot read the summary", async () => {
    const t = setupTest();
    const { eventSlug } = await organizerEvent(t);
    const mallory = await signIn(t, "mallory");
    await grantEventRole(t, eventSlug, "mallory", "reviewer");
    await expectRejectedWith(
      mallory.query(api.comms.deliveryHealth, { eventSlug }),
      "forbidden",
    );
  });
});

// ── Reminder schedule & facts (W1) ───────────────────────────────────────
// The product used to predict the top of the clock hour while `crons.interval`
// fired at whatever minute the cron was first deployed at. The schedule now has
// ONE definition, and both the cron and the prediction read it.

async function eventEndsAt(t: TestT, eventSlug: string): Promise<number> {
  return await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
      .unique();
    if (event === null) throw new Error("no event");
    return event.endsAt;
  });
}

describe("reminder schedule & facts (W1)", () => {
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;
  const HOUR_START = Date.parse("2026-08-10T09:00:00Z");

  test("the cron expression and the prediction come from one constant", () => {
    expect(SWEEP_CRON).toBe(`${SWEEP_MINUTE} * * * *`);
  });

  test("nextSweepAt predicts the sweep minute, never a clean clock hour", () => {
    // Before the sweep minute: this hour's occurrence.
    expect(nextSweepAt(HOUR_START + 5 * MINUTE)).toBe(
      HOUR_START + SWEEP_MINUTE * MINUTE,
    );
    // Exactly at it: the run happening now is not a FUTURE evaluation.
    expect(nextSweepAt(HOUR_START + SWEEP_MINUTE * MINUTE)).toBe(
      HOUR_START + HOUR + SWEEP_MINUTE * MINUTE,
    );
    // Past it: the next hour's occurrence.
    expect(nextSweepAt(HOUR_START + (SWEEP_MINUTE + 21) * MINUTE)).toBe(
      HOUR_START + HOUR + SWEEP_MINUTE * MINUTE,
    );
    // The old bug, asserted away: it is never the top of an hour.
    expect(nextSweepAt(HOUR_START) % HOUR).not.toBe(0);
  });

  test("automationStatus derives its prediction from the schedule", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const now = HOUR_START + 5 * MINUTE;
    const status = await alice.query(api.reminders.automationStatus, {
      eventSlug,
      now,
    });
    expect(status).toEqual({
      enabled: true,
      cadenceDays: null,
      nextEvaluationAt: nextSweepAt(now),
      evaluationIntervalHours: 1,
      sweepMinuteUtc: SWEEP_MINUTE,
      safetyCadenceDays: 1,
      disabledReason: null,
      quietAfter: automationQuietAfter(await eventEndsAt(t, eventSlug)),
    });

    // Past the sweep minute the prediction rolls to the next hour, not to the
    // next clean hour boundary.
    const later = await alice.query(api.reminders.automationStatus, {
      eventSlug,
      now: HOUR_START + (SWEEP_MINUTE + 1) * MINUTE,
    });
    expect(later.nextEvaluationAt).toBe(
      HOUR_START + HOUR + SWEEP_MINUTE * MINUTE,
    );
  });

  test("an archived event predicts nothing at all", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await alice.mutation(api.events.setArchived, { eventSlug, archived: true });
    expect(
      await alice.query(api.reminders.automationStatus, {
        eventSlug,
        now: HOUR_START,
      }),
    ).toMatchObject({ enabled: false, nextEvaluationAt: null });
    expect(
      await alice.query(api.reminders.reminderFacts, { eventSlug }),
    ).toMatchObject({ enabled: false, nextEligibleAt: null });
  });

  test("with no cadence, the next eligible instant is the due-soon window", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await manualRequirement(alice, eventSlug, "Upload your slides");

    const facts = await alice.query(api.reminders.reminderFacts, { eventSlug });
    expect(facts.cadenceDays).toBeNull();
    expect(facts.safetyCadenceDays).toBe(1);
    expect(facts.evaluationIntervalHours).toBe(1);
    expect(facts.trackedTasks).toBeGreaterThanOrEqual(1);
    // No cadence anywhere: only the 48-hour safety window makes it eligible.
    expect(facts.nextEligibleAt).toBe(PAST_DUE - 2 * DAY);
  });

  test("a configured cadence moves the next eligible instant onto the clock", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await setCadence(alice, eventSlug, 3);
    await manualRequirement(alice, eventSlug, "Upload your slides");

    const instances = await instanceRows(t);
    const earliest = Math.min(...instances.map((i) => i._creationTime));
    const facts = await alice.query(api.reminders.reminderFacts, { eventSlug });
    expect(facts.cadenceDays).toBe(3);
    expect(facts.nextEligibleAt).toBe(earliest + 3 * DAY);
  });

  test("the facts panel reports the last automatic sweep and the last manual send", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await setCadence(alice, eventSlug, 1);
    await manualRequirement(alice, eventSlug, "Upload your slides");

    const before = await alice.query(api.reminders.reminderFacts, {
      eventSlug,
    });
    expect(before.lastAutomaticAt).toBeNull();
    expect(before.lastManualAt).toBeNull();
    expect(before.manualLookupTruncated).toBe(false);

    await runSweep(t, NOW);
    await alice.mutation(api.reminders.sendOutstandingNow, { eventSlug });

    const after = await alice.query(api.reminders.reminderFacts, { eventSlug });
    expect(after.lastAutomaticAt).toBe(NOW);
    expect(after.lastManualAt).not.toBeNull();
  });

  test("reviewers cannot read automation status or the reminder facts", async () => {
    const t = setupTest();
    const { eventSlug } = await organizerEvent(t);
    const mallory = await signIn(t, "mallory");
    await grantEventRole(t, eventSlug, "mallory", "reviewer");
    await expectRejectedWith(
      mallory.query(api.reminders.automationStatus, {
        eventSlug,
        now: HOUR_START,
      }),
      "forbidden",
    );
    await expectRejectedWith(
      mallory.query(api.reminders.reminderFacts, { eventSlug }),
      "forbidden",
    );
  });
});

// ── Delivery timestamps, quiet events and manual-send truth (W1 review) ──

describe("delivery lifecycle evidence (W1)", () => {
  test("the webhook records the PROVIDER's own timestamp, not ours", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Dana", lastName: "Keynote", email: "dana@example.com" },
      "Opening keynote",
    );
    const [message] = await messageRows(t);
    expect(message.deliveryUpdatedAt).toBeUndefined();

    const providerAt = "2026-08-11T14:32:05.000Z";
    await t.mutation(internal.emails.handleEmailEvent, {
      id: message.resendEmailId as import("@convex-dev/resend").EmailId,
      event: {
        type: "email.delivered",
        created_at: providerAt,
        data: {
          created_at: providerAt,
          email_id: message.resendEmailId ?? "",
          from: "StageStack <hello@stagestack.dev>",
          to: [message.toEmail],
          subject: message.subject,
        },
      },
    });

    const patched = await t.run(async (ctx) =>
      ctx.db.get("messages", message._id),
    );
    expect(patched?.deliveryStatus).toBe("delivered");
    expect(patched?.deliveryUpdatedAt).toBe(Date.parse(providerAt));

    // …and it reaches the per-contact log the UI renders.
    const contacts = await alice.query(api.speakers.roster, { eventSlug });
    const logged = await alice.query(api.comms.contactLog, {
      eventSlug,
      eventContactId: contacts[0].eventContactId,
    });
    expect(
      logged.find((row) => row.messageId === message._id)?.deliveryUpdatedAt,
    ).toBe(Date.parse(providerAt));
  });

  test("an unparseable provider timestamp falls back instead of writing NaN", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await inviteSpeaker(
      t,
      alice,
      eventSlug,
      { firstName: "Eve", lastName: "Speaker", email: "eve@example.com" },
      "Second keynote",
    );
    const [message] = await messageRows(t);
    await t.mutation(internal.emails.handleEmailEvent, {
      id: message.resendEmailId as import("@convex-dev/resend").EmailId,
      event: {
        type: "email.bounced",
        created_at: "not a date",
        data: {
          created_at: "not a date",
          email_id: message.resendEmailId ?? "",
          from: "StageStack <hello@stagestack.dev>",
          to: [message.toEmail],
          subject: message.subject,
          bounce: {
            type: "Permanent",
            subType: "General",
            message: "mailbox unavailable",
          },
        },
      },
    });
    const patched = await t.run(async (ctx) =>
      ctx.db.get("messages", message._id),
    );
    expect(patched?.deliveryStatus).toBe("bounced");
    expect(Number.isNaN(patched?.deliveryUpdatedAt ?? NaN)).toBe(false);
    expect(patched?.deliveryUpdatedAt).toBeGreaterThan(0);
  });
});

describe("automation quiet state and manual-send truth (W1)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  test("past the post-event grace window the product stops predicting runs", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const endsAt = await eventEndsAt(t, eventSlug);

    // Inside the window: still running, still predicting.
    const inside = await alice.query(api.reminders.automationStatus, {
      eventSlug,
      now: endsAt + (POST_EVENT_GRACE_DAYS - 1) * DAY_MS,
    });
    expect(inside).toMatchObject({ enabled: true, disabledReason: null });
    expect(inside.nextEvaluationAt).not.toBeNull();
    expect(inside.quietAfter).toBe(automationQuietAfter(endsAt));

    // Past it: `sweepEligible` refuses the event, so the UI must say so.
    const outside = await alice.query(api.reminders.automationStatus, {
      eventSlug,
      now: endsAt + (POST_EVENT_GRACE_DAYS + 1) * DAY_MS,
    });
    expect(outside).toMatchObject({
      enabled: false,
      disabledReason: "postEvent",
      nextEvaluationAt: null,
    });

    // Archiving is the other off-switch, and it is named separately.
    await alice.mutation(api.events.setArchived, { eventSlug, archived: true });
    expect(
      await alice.query(api.reminders.automationStatus, {
        eventSlug,
        now: endsAt,
      }),
    ).toMatchObject({ enabled: false, disabledReason: "archived" });
    expect(
      await alice.query(api.reminders.reminderFacts, { eventSlug }),
    ).toMatchObject({ quietAfter: null });
  });

  test("a manual run that sends nothing is an attempt, not a send", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    // No requirements, so nobody qualifies: the audit row records sent 0.
    expect(
      await alice.mutation(api.reminders.sendOutstandingNow, { eventSlug }),
    ).toMatchObject({ sent: 0 });

    const empty = await alice.query(api.reminders.reminderFacts, { eventSlug });
    expect(empty.lastManualAt).toBeNull();
    expect(empty.lastManualAttemptAt).not.toBeNull();

    // A run that actually accepts a message is the send.
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await manualRequirement(alice, eventSlug, "Upload your slides");
    expect(
      (await alice.mutation(api.reminders.sendOutstandingNow, { eventSlug }))
        .sent,
    ).toBeGreaterThan(0);

    const sent = await alice.query(api.reminders.reminderFacts, { eventSlug });
    expect(sent.lastManualAt).not.toBeNull();
    expect(sent.lastManualAttemptAt).toBe(sent.lastManualAt);
  });
});

describe("reminders.outstandingReminderPreview (W1)", () => {
  test("it counts the same audience the manual send will reach", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    await confirm(alice, eventSlug, await participantFor(t, sessionId, "Carol"));
    await manualRequirement(alice, eventSlug, "Upload your slides");

    const preview = await alice.query(
      api.reminders.outstandingReminderPreview,
      { eventSlug },
    );
    expect(preview.overCap).toBe(false);
    expect(preview.blocked).toBeNull();
    expect(preview.recipients).toBeGreaterThan(0);
    expect(preview.tasks).toBeGreaterThan(0);

    const result = await alice.mutation(api.reminders.sendOutstandingNow, {
      eventSlug,
    });
    // The preview promised exactly this many attempts and included tasks.
    expect(result.sent + result.failed).toBe(preview.recipients);
    expect(result.includedTasks).toBe(preview.tasks);
    expect(result.skipped).toBe(preview.unreachableSpeakers);
  });

  test("an unreachable speaker is reported as excluded, not as a recipient", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { sessionId } = await acceptedWithManager(t, eventSlug);
    const carol = await participantFor(t, sessionId, "Carol");
    await confirm(alice, eventSlug, carol);
    await manualRequirement(alice, eventSlug, "Upload your slides");
    // Strip every address this participant could be reached at.
    await t.run(async (ctx) => {
      const participant = await ctx.db.get("sessionParticipants", carol);
      if (participant === null) throw new Error("no participant");
      await ctx.db.patch("eventContacts", participant.eventContactId, {
        email: undefined,
      });
      await ctx.db.patch("sessionParticipants", carol, {
        managerUserId: undefined,
      });
    });

    const preview = await alice.query(
      api.reminders.outstandingReminderPreview,
      { eventSlug },
    );
    expect(preview.unreachableSpeakers).toBeGreaterThanOrEqual(1);
  });

  test("an archived event reports the send as blocked", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await alice.mutation(api.events.setArchived, { eventSlug, archived: true });
    expect(
      await alice.query(api.reminders.outstandingReminderPreview, {
        eventSlug,
      }),
    ).toMatchObject({ blocked: "archived", recipients: 0 });
  });

  test("reviewers cannot preview the audience", async () => {
    const t = setupTest();
    const { eventSlug } = await organizerEvent(t);
    const mallory = await signIn(t, "mallory");
    await grantEventRole(t, eventSlug, "mallory", "reviewer");
    await expectRejectedWith(
      mallory.query(api.reminders.outstandingReminderPreview, { eventSlug }),
      "forbidden",
    );
  });
});
