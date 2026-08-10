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

// Agenda builder (M6). The rules worth breaking the build over:
//   1. board edits are drafts and NEVER communicate;
//   2. release is the one external step, and speaker/room collisions are
//      non-overridable there;
//   3. a date/start change resets acknowledgement, a room change does not;
//   4. a withdrawal cancels only that person's calendar entry.

const HOUR = 60 * 60 * 1000;
const EVENT_START = Date.parse("2026-09-01T09:00:00Z");
const T10 = Date.parse("2026-09-01T10:00:00Z");
const T1030 = T10 + HOUR / 2;
const T11 = T10 + HOUR;
const T12 = T10 + 2 * HOUR;

type CalendarJob = {
  kind: string;
  toEmail: string;
  subject: string;
  ics: {
    method: "REQUEST" | "CANCEL";
    uid: string;
    sequence: number;
    startMs: number;
    endMs: number;
    location?: string;
  };
  context?: { sessionId?: string; participantId?: string; mode?: string };
};

/** Calendar sends leave a mutation as SCHEDULED actions (the .ics attachment
 * needs the raw Resend API), so this is where the evidence lives. */
async function calendarJobs(t: TestT): Promise<CalendarJob[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.system.query("_scheduled_functions").collect();
    return rows
      .filter((row) => row.name === "emails:sendCalendarInvite")
      .map((row) => row.args[0] as CalendarJob);
  });
}

async function messageKinds(t: TestT): Promise<string[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("messages").collect();
    return rows.map((row) => row.kind);
  });
}

async function sessionRow(t: TestT, sessionId: Id<"sessions">) {
  return await t.run(async (ctx) => {
    const row = await ctx.db.get("sessions", sessionId);
    if (row === null) throw new Error("no session");
    return row;
  });
}

async function participantRows(t: TestT, sessionId: Id<"sessions">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("sessionParticipants")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .collect(),
  );
}

async function participantByEmail(
  t: TestT,
  sessionId: Id<"sessions">,
  email: string,
) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("sessionParticipants")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .collect();
    for (const row of rows) {
      const contact = await ctx.db.get("eventContacts", row.eventContactId);
      if (contact?.email === email) return row;
    }
    throw new Error(`no participation for ${email}`);
  });
}

/** A second speaker on the same session (the CFP path creates these; tests
 * insert the rows directly to stay about the behavior under test). */
async function addCoSpeaker(
  t: TestT,
  sessionId: Id<"sessions">,
  speaker: { firstName: string; lastName: string; email: string },
): Promise<void> {
  await t.run(async (ctx) => {
    const session = await ctx.db.get("sessions", sessionId);
    if (session === null) throw new Error("no session");
    const contactId = await ctx.db.insert("eventContacts", {
      eventId: session.eventId,
      orgId: (await ctx.db.get("events", session.eventId))!.orgId,
      ...speaker,
    });
    await ctx.db.insert("sessionParticipants", {
      sessionId,
      eventId: session.eventId,
      eventContactId: contactId,
      role: "speaker",
      state: "awaiting",
    });
  });
}

async function setup() {
  const t = setupTest();
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit", {
    startsAt: EVENT_START,
  });
  const mainStage = (await alice.mutation(api.library.add, {
    eventSlug,
    table: "rooms",
    item: { name: "Main Stage", capacity: 300 },
  })) as Id<"rooms">;
  const sideRoom = (await alice.mutation(api.library.add, {
    eventSlug,
    table: "rooms",
    item: { name: "Side Room" },
  })) as Id<"rooms">;
  const platformTrack = (await alice.mutation(api.library.add, {
    eventSlug,
    table: "tracks",
    item: { name: "Platform" },
  })) as Id<"tracks">;
  return { t, alice, orgSlug, eventSlug, mainStage, sideRoom, platformTrack };
}

/** A private planned session with one awaiting speaker (the M2 direct path). */
async function directSession(
  as: TestUserT,
  eventSlug: string,
  title: string,
  speaker: { firstName: string; lastName: string; email: string },
  trackId?: Id<"tracks">,
): Promise<Id<"sessions">> {
  const { sessionId } = await as.mutation(api.sessions.createDirect, {
    eventSlug,
    title,
    trackId,
    speaker: { ...speaker },
  });
  return sessionId;
}

function place(
  as: TestUserT,
  eventSlug: string,
  sessionId: Id<"sessions">,
  slot: { startsAt: number; endsAt: number; roomId?: Id<"rooms"> } | null,
) {
  return as.mutation(api.agenda.scheduleSession, {
    eventSlug,
    sessionId,
    slot,
  });
}

// ── Placement ────────────────────────────────────────────────────────────

describe("agenda.scheduleSession", () => {
  test("places a session, then returns it to the tray — silently", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await directSession(alice, eventSlug, "Reactive backends", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    const before = (await messageKinds(t)).length;

    await place(alice, eventSlug, sessionId, {
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
    });
    let session = await sessionRow(t, sessionId);
    expect(session.startsAt).toBe(T10);
    expect(session.endsAt).toBe(T11);
    expect(session.roomId).toBe(mainStage);
    // The board is a DRAFT: nothing is released and nothing is sent.
    expect(session.releasedSlot).toBeUndefined();
    expect(await messageKinds(t)).toHaveLength(before);
    expect(await calendarJobs(t)).toHaveLength(0);
    expect(await auditActions(t)).toContain("agenda.place");

    await place(alice, eventSlug, sessionId, null);
    session = await sessionRow(t, sessionId);
    expect(session.startsAt).toBeUndefined();
    expect(session.roomId).toBeUndefined();
    expect(await messageKinds(t)).toHaveLength(before);
    expect(await auditActions(t)).toContain("agenda.unschedule");
  });

  test("rejects an end at or before the start", async () => {
    const { alice, eventSlug, mainStage } = await setup();
    const sessionId = await directSession(alice, eventSlug, "Backwards", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    await expectRejectedWith(
      place(alice, eventSlug, sessionId, {
        startsAt: T11,
        endsAt: T10,
        roomId: mainStage,
      }),
      "invalid_slot",
    );
    await expectRejectedWith(
      place(alice, eventSlug, sessionId, { startsAt: T11, endsAt: T11 }),
      "invalid_slot",
    );
  });

  test("rejects a time far outside the event window", async () => {
    const { alice, eventSlug } = await setup();
    const sessionId = await directSession(alice, eventSlug, "Next month", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    const wayLater = EVENT_START + 30 * 24 * HOUR;
    await expectRejectedWith(
      place(alice, eventSlug, sessionId, {
        startsAt: wayLater,
        endsAt: wayLater + HOUR,
      }),
      "invalid_slot",
    );
  });

  test("rejects a room that belongs to another event", async () => {
    const { alice, eventSlug, orgSlug } = await setup();
    const otherSlug = await createEvent(alice, orgSlug, "Other Summit", {
      startsAt: EVENT_START,
    });
    const foreignRoom = (await alice.mutation(api.library.add, {
      eventSlug: otherSlug,
      table: "rooms",
      item: { name: "Not ours" },
    })) as Id<"rooms">;
    const sessionId = await directSession(alice, eventSlug, "Wrong room", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    await expectRejectedWith(
      place(alice, eventSlug, sessionId, {
        startsAt: T10,
        endsAt: T11,
        roomId: foreignRoom,
      }),
      "not_found",
    );
  });
});

// ── Conflicts ────────────────────────────────────────────────────────────

describe("agenda.board conflicts", () => {
  test("same room overlap blocks both sessions", async () => {
    const { alice, eventSlug, mainStage } = await setup();
    const a = await directSession(alice, eventSlug, "Talk A", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    const b = await directSession(alice, eventSlug, "Talk B", {
      firstName: "Carol",
      lastName: "Speaker",
      email: "carol@example.com",
    });
    await place(alice, eventSlug, a, {
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
    });
    await place(alice, eventSlug, b, {
      startsAt: T1030,
      endsAt: T12,
      roomId: mainStage,
    });

    const board = await alice.query(api.agenda.board, { eventSlug });
    for (const sessionId of [a, b]) {
      const row = board.sessions.find((s) => s.sessionId === sessionId);
      expect(row?.conflicts).toHaveLength(1);
      expect(row?.conflicts[0]).toMatchObject({
        kind: "room",
        level: "blocker",
        withType: "session",
      });
    }
  });

  test("the same speaker on two overlapping sessions is a blocker", async () => {
    const { alice, eventSlug, mainStage, sideRoom } = await setup();
    const speaker = {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    };
    // The same address resolves to the same event snapshot, so this really is
    // one person on two sessions.
    const a = await directSession(alice, eventSlug, "Talk A", speaker);
    const b = await directSession(alice, eventSlug, "Talk B", speaker);
    await place(alice, eventSlug, a, {
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
    });
    await place(alice, eventSlug, b, {
      startsAt: T1030,
      endsAt: T12,
      roomId: sideRoom,
    });

    const board = await alice.query(api.agenda.board, { eventSlug });
    const rowA = board.sessions.find((s) => s.sessionId === a);
    expect(rowA?.conflicts).toEqual([
      expect.objectContaining({ kind: "speaker", level: "blocker" }),
    ]);
  });

  test("same-track overlap is a warning, not a blocker", async () => {
    const { alice, eventSlug, mainStage, sideRoom, platformTrack } =
      await setup();
    const a = await directSession(
      alice,
      eventSlug,
      "Talk A",
      { firstName: "Bob", lastName: "Speaker", email: "bob@example.com" },
      platformTrack,
    );
    const b = await directSession(
      alice,
      eventSlug,
      "Talk B",
      { firstName: "Carol", lastName: "Speaker", email: "carol@example.com" },
      platformTrack,
    );
    await place(alice, eventSlug, a, {
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
    });
    await place(alice, eventSlug, b, {
      startsAt: T1030,
      endsAt: T12,
      roomId: sideRoom,
    });

    const board = await alice.query(api.agenda.board, { eventSlug });
    const rowA = board.sessions.find((s) => s.sessionId === a);
    expect(rowA?.conflicts).toEqual([
      expect.objectContaining({ kind: "track", level: "warning" }),
    ]);
  });

  test("back-to-back blocks in one room are clean, and agenda items collide too", async () => {
    const { alice, eventSlug, mainStage } = await setup();
    const a = await directSession(alice, eventSlug, "Talk A", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    await place(alice, eventSlug, a, {
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
    });
    // [10:00, 11:00) and [11:00, 12:00) are half-open — no overlap.
    const lunch = await alice.mutation(api.agenda.createAgendaItem, {
      eventSlug,
      title: "Lunch",
      startsAt: T11,
      endsAt: T12,
      roomId: mainStage,
    });
    let board = await alice.query(api.agenda.board, { eventSlug });
    expect(board.sessions[0].conflicts).toEqual([]);
    expect(board.agendaItems[0].conflicts).toEqual([]);

    // Drag lunch over the talk and both light up.
    await alice.mutation(api.agenda.updateAgendaItem, {
      eventSlug,
      itemId: lunch,
      patch: { startsAt: T1030 },
    });
    board = await alice.query(api.agenda.board, { eventSlug });
    expect(board.sessions[0].conflicts[0]).toMatchObject({
      kind: "room",
      level: "blocker",
      withType: "agendaItem",
    });
    expect(board.agendaItems[0].conflicts[0]).toMatchObject({
      withType: "session",
    });

    await alice.mutation(api.agenda.removeAgendaItem, {
      eventSlug,
      itemId: lunch,
    });
    board = await alice.query(api.agenda.board, { eventSlug });
    expect(board.agendaItems).toHaveLength(0);
    expect(board.sessions[0].conflicts).toEqual([]);
  });

  test("an agenda item's room can be cleared with roomId: null", async () => {
    const { alice, eventSlug, mainStage } = await setup();
    const lunch = await alice.mutation(api.agenda.createAgendaItem, {
      eventSlug,
      title: "Lunch",
      startsAt: T11,
      endsAt: T12,
      roomId: mainStage,
    });
    let board = await alice.query(api.agenda.board, { eventSlug });
    expect(board.agendaItems[0].roomId).toBe(mainStage);

    // A time-only edit leaves the room untouched (absent roomId = unchanged).
    await alice.mutation(api.agenda.updateAgendaItem, {
      eventSlug,
      itemId: lunch,
      patch: { startsAt: T1030 },
    });
    board = await alice.query(api.agenda.board, { eventSlug });
    expect(board.agendaItems[0].roomId).toBe(mainStage);

    // roomId: null is an explicit clear.
    await alice.mutation(api.agenda.updateAgendaItem, {
      eventSlug,
      itemId: lunch,
      patch: { roomId: null },
    });
    board = await alice.query(api.agenda.board, { eventSlug });
    expect(board.agendaItems[0].roomId).toBeUndefined();
  });

  test("the board is an organizer surface — reviewers are refused", async () => {
    const { t, alice, eventSlug } = await setup();
    await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    const rita = await signIn(t, "rita");
    await expectRejectedWith(
      rita.query(api.agenda.board, { eventSlug }),
      "forbidden",
    );
    // …and the tray still works for the organizer.
    const sessionId = await directSession(alice, eventSlug, "Unplaced", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    const board = await alice.query(api.agenda.board, { eventSlug });
    expect(board.sessions.map((s) => s.sessionId)).toContain(sessionId);
    expect(board.sessions[0].startsAt).toBeUndefined();
  });
});

// ── Release ──────────────────────────────────────────────────────────────

async function placedSession(
  as: TestUserT,
  eventSlug: string,
  title: string,
  email: string,
  slot: { startsAt: number; endsAt: number; roomId?: Id<"rooms"> },
): Promise<Id<"sessions">> {
  const sessionId = await directSession(as, eventSlug, title, {
    firstName: email.split("@")[0],
    lastName: "Speaker",
    email,
  });
  await place(as, eventSlug, sessionId, slot);
  return sessionId;
}

describe("agenda.release", () => {
  test("first release records the slot, awaits acknowledgement and queues invites", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await placedSession(
      alice,
      eventSlug,
      "Reactive backends",
      "bob@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );

    const results = await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    expect(results).toEqual([{ sessionId, ok: true }]);

    const session = await sessionRow(t, sessionId);
    expect(session.releasedSlot).toMatchObject({
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
      sequence: 0,
    });
    const participants = await participantRows(t, sessionId);
    expect(participants.map((p) => p.ack)).toEqual(["awaitingAck"]);

    const jobs = await calendarJobs(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe("schedule.released");
    expect(jobs[0].toEmail).toBe("bob@example.com");
    expect(jobs[0].ics.method).toBe("REQUEST");
    expect(jobs[0].ics.sequence).toBe(0);
    expect(jobs[0].ics.location).toBe("Main Stage");
    expect(jobs[0].ics.uid).toBe(
      `session-${sessionId}-${participants[0]._id}@stagestack.dev`,
    );
    expect(await auditActions(t)).toContain("agenda.release");
  });

  test("a blocker conflict fails only its own ids", async () => {
    const { t, alice, eventSlug, mainStage, sideRoom } = await setup();
    const a = await placedSession(alice, eventSlug, "A", "a@example.com", {
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
    });
    const b = await placedSession(alice, eventSlug, "B", "b@example.com", {
      startsAt: T1030,
      endsAt: T12,
      roomId: mainStage,
    });
    const c = await placedSession(alice, eventSlug, "C", "c@example.com", {
      startsAt: T10,
      endsAt: T11,
      roomId: sideRoom,
    });

    const results = await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [a, b, c],
    });
    expect(results).toEqual([
      { sessionId: a, ok: false, error: "conflict" },
      { sessionId: b, ok: false, error: "conflict" },
      { sessionId: c, ok: true },
    ]);
    expect((await sessionRow(t, a)).releasedSlot).toBeUndefined();
    expect((await sessionRow(t, c)).releasedSlot).toBeDefined();
    // Only the clean session was told anything.
    expect(await calendarJobs(t)).toHaveLength(1);
  });

  test("an unscheduled or unchanged session comes back as a per-id error", async () => {
    const { alice, eventSlug, mainStage } = await setup();
    const tray = await directSession(alice, eventSlug, "Tray", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    expect(
      await alice.mutation(api.agenda.release, {
        eventSlug,
        sessionIds: [tray],
      }),
    ).toEqual([{ sessionId: tray, ok: false, error: "not_scheduled" }]);

    const placed = await placedSession(
      alice,
      eventSlug,
      "Placed",
      "carol@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [placed],
    });
    expect(
      await alice.mutation(api.agenda.release, {
        eventSlug,
        sessionIds: [placed],
      }),
    ).toEqual([{ sessionId: placed, ok: false, error: "unchanged" }]);
  });

  test("a start-time change bumps the sequence and resets acknowledgement", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await placedSession(
      alice,
      eventSlug,
      "Reactive backends",
      "bob@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    const [participant] = await participantRows(t, sessionId);
    await alice.mutation(api.agenda.setAck, {
      eventSlug,
      participantId: participant._id,
      response: "acknowledged",
    });

    await place(alice, eventSlug, sessionId, {
      startsAt: T11,
      endsAt: T12,
      roomId: mainStage,
    });
    expect(
      await alice.mutation(api.agenda.release, {
        eventSlug,
        sessionIds: [sessionId],
      }),
    ).toEqual([{ sessionId, ok: true }]);

    const session = await sessionRow(t, sessionId);
    expect(session.releasedSlot).toMatchObject({ startsAt: T11, sequence: 1 });
    // "any change to its date or start time reset[s] acknowledgement".
    expect((await participantRows(t, sessionId))[0].ack).toBe("awaitingAck");
    const jobs = await calendarJobs(t);
    expect(jobs).toHaveLength(2);
    expect(jobs[1].kind).toBe("schedule.updated");
    expect(jobs[1].ics.sequence).toBe(1);
    expect(jobs[1].ics.method).toBe("REQUEST");
  });

  test("a room-only change updates the invite but keeps the acknowledgement", async () => {
    const { t, alice, eventSlug, mainStage, sideRoom } = await setup();
    const sessionId = await placedSession(
      alice,
      eventSlug,
      "Reactive backends",
      "bob@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    const [participant] = await participantRows(t, sessionId);
    await alice.mutation(api.agenda.setAck, {
      eventSlug,
      participantId: participant._id,
      response: "acknowledged",
    });

    await place(alice, eventSlug, sessionId, {
      startsAt: T10,
      endsAt: T11,
      roomId: sideRoom,
    });
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });

    expect((await sessionRow(t, sessionId)).releasedSlot).toMatchObject({
      roomId: sideRoom,
      sequence: 1,
    });
    // "room, track, or wording changes notify/update without resetting it".
    expect((await participantRows(t, sessionId))[0].ack).toBe("acknowledged");
    const jobs = await calendarJobs(t);
    expect(jobs).toHaveLength(2);
    expect(jobs[1].ics.location).toBe("Side Room");
  });
});

// ── Cancellation ─────────────────────────────────────────────────────────

describe("agenda.cancelRelease", () => {
  test("cancelling sends METHOD:CANCEL, clears the slot and keeps the draft", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await placedSession(
      alice,
      eventSlug,
      "Reactive backends",
      "bob@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });

    const notified = await alice.mutation(api.agenda.cancelRelease, {
      eventSlug,
      sessionId,
    });
    expect(notified).toBe(1);

    const session = await sessionRow(t, sessionId);
    expect(session.releasedSlot).toBeUndefined();
    // The board is untouched: cancelling what speakers were told is not the
    // same as clearing the placement.
    expect(session.startsAt).toBe(T10);
    expect((await participantRows(t, sessionId))[0].ack).toBeUndefined();

    const jobs = await calendarJobs(t);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]).toMatchObject({ kind: "schedule.cancelled" });
    expect(jobs[1].ics.method).toBe("CANCEL");
    expect(jobs[1].ics.sequence).toBe(1);
    expect(await auditActions(t)).toContain("agenda.cancelRelease");

    await expectRejectedWith(
      alice.mutation(api.agenda.cancelRelease, { eventSlug, sessionId }),
      "invalid_status",
    );
  });

  test("a withdrawal cancels only that speaker's calendar entry", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await directSession(alice, eventSlug, "Two speakers", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    // A real co-speaker on the SAME session (the CFP path creates these; here
    // the row is inserted directly to keep the test about cancellation).
    await t.run(async (ctx) => {
      const session = await ctx.db.get("sessions", sessionId);
      if (session === null) throw new Error("no session");
      const carol = await ctx.db.insert("eventContacts", {
        eventId: session.eventId,
        orgId: (await ctx.db.get("events", session.eventId))!.orgId,
        firstName: "Carol",
        lastName: "Speaker",
        email: "carol@example.com",
      });
      await ctx.db.insert("sessionParticipants", {
        sessionId,
        eventId: session.eventId,
        eventContactId: carol,
        role: "speaker",
        state: "awaiting",
      });
    });
    await place(alice, eventSlug, sessionId, {
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
    });
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    expect(await calendarJobs(t)).toHaveLength(2);
    const participant = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("sessionParticipants")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
        .collect();
      for (const row of rows) {
        const contact = await ctx.db.get("eventContacts", row.eventContactId);
        if (contact?.email === "bob@example.com") return row;
      }
      throw new Error("no bob participation");
    });

    // portal.enter requires a Clerk-verified address (model/portal.ts).
    const bob = await signIn(t, "bob", { emailVerified: true });
    await bob.mutation(api.portal.enter, { eventSlug });
    await bob.mutation(api.portal.withdrawParticipation, {
      eventSlug,
      participantId: participant._id,
    });

    const jobs = await calendarJobs(t);
    const cancels = jobs.filter((j) => j.ics.method === "CANCEL");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].toEmail).toBe("bob@example.com");
    expect(cancels[0].ics.uid).toContain(participant._id);
    // The session itself keeps its released slot, and the co-speaker keeps
    // their invitation and their pending acknowledgement.
    expect((await sessionRow(t, sessionId)).releasedSlot).toBeDefined();
    const after = await participantRows(t, sessionId);
    expect(after.find((r) => r._id === participant._id)?.ack).toBeUndefined();
    expect(after.find((r) => r._id !== participant._id)?.ack).toBe(
      "awaitingAck",
    );
    expect(await auditActions(t)).toContain("agenda.participantCancel");
  });
});

// ── .ics SEQUENCE monotonicity + failed-invite resend ────────────────────
// RFC 5546: SEQUENCE must never go backwards for a UID. Outlook/Exchange keep
// a cancelled UID as a tombstone and silently drop any REQUEST that doesn't
// exceed the CANCEL's number, so the persisted per-session counter
// (sessions.icsSequence) must survive every path that clears releasedSlot.

describe("ics sequence", () => {
  test("never decreases across release → cancel → re-release", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await placedSession(
      alice,
      eventSlug,
      "Reactive backends",
      "bob@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    await alice.mutation(api.agenda.cancelRelease, { eventSlug, sessionId });

    // Same slot, re-released after the cancel. Restarting at 0 would leave
    // the REQUEST at or below the CANCEL's tombstone — it must continue above.
    expect(
      await alice.mutation(api.agenda.release, {
        eventSlug,
        sessionIds: [sessionId],
      }),
    ).toEqual([{ sessionId, ok: true }]);

    const jobs = await calendarJobs(t);
    expect(jobs.map((j) => [j.ics.method, j.ics.sequence])).toEqual([
      ["REQUEST", 0],
      ["CANCEL", 1],
      ["REQUEST", 2],
    ]);
    const session = await sessionRow(t, sessionId);
    expect(session.icsSequence).toBe(2);
    expect(session.releasedSlot).toMatchObject({ sequence: 2 });
  });

  test("a per-participant cancel bumps the persisted counter", async () => {
    const { t, alice, eventSlug, mainStage, sideRoom } = await setup();
    const sessionId = await directSession(alice, eventSlug, "Two speakers", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    await addCoSpeaker(t, sessionId, {
      firstName: "Carol",
      lastName: "Speaker",
      email: "carol@example.com",
    });
    await place(alice, eventSlug, sessionId, {
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
    });
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });

    // Bob withdraws: his CANCEL goes out at 1 AND the session records it.
    const bobRow = await participantByEmail(t, sessionId, "bob@example.com");
    // portal.enter requires a Clerk-verified address (model/portal.ts).
    const bob = await signIn(t, "bob", { emailVerified: true });
    await bob.mutation(api.portal.enter, { eventSlug });
    await bob.mutation(api.portal.withdrawParticipation, {
      eventSlug,
      participantId: bobRow._id,
    });
    expect((await sessionRow(t, sessionId)).icsSequence).toBe(1);

    // The next session-wide release must EXCEED that CANCEL, not reuse it.
    await place(alice, eventSlug, sessionId, {
      startsAt: T10,
      endsAt: T11,
      roomId: sideRoom,
    });
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    const jobs = await calendarJobs(t);
    const last = jobs[jobs.length - 1];
    expect(last.toEmail).toBe("carol@example.com");
    expect(last.ics.method).toBe("REQUEST");
    expect(last.ics.sequence).toBe(2);
    expect((await sessionRow(t, sessionId)).releasedSlot).toMatchObject({
      sequence: 2,
    });
  });

  test("an unchanged release resends only to a participant whose last invite failed", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await directSession(alice, eventSlug, "Two speakers", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    await addCoSpeaker(t, sessionId, {
      firstName: "Carol",
      lastName: "Speaker",
      email: "carol@example.com",
    });
    await place(alice, eventSlug, sessionId, {
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
    });
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });

    // The scheduled send action doesn't run under convex-test, so write the
    // comms-log rows convex/emails.ts would have recorded: bob's send died
    // mid-flight, carol's went out.
    const rows = await participantRows(t, sessionId);
    const bobMessageId = await t.run(async (ctx) => {
      const session = await ctx.db.get("sessions", sessionId);
      if (session === null) throw new Error("no session");
      const orgId = (await ctx.db.get("events", session.eventId))!.orgId;
      let failedId: Id<"messages"> | undefined;
      for (const row of rows) {
        const contact = await ctx.db.get("eventContacts", row.eventContactId);
        const failed = contact?.email === "bob@example.com";
        const messageId = await ctx.db.insert("messages", {
          orgId,
          eventId: session.eventId,
          toEmail: contact?.email ?? "",
          kind: "schedule.released",
          subject: "Your slot at Acme Summit",
          deliveryStatus: failed ? "failed" : "sent",
          context: {
            sessionId,
            participantId: row._id,
            sequence: 0,
            mode: "first",
            ...(failed ? { sendError: "Resend API 500" } : {}),
          },
        });
        if (failed) failedId = messageId;
      }
      if (failedId === undefined) throw new Error("no bob message");
      return failedId;
    });

    // Bob acknowledged from the portal despite never receiving the email.
    const bobRow = await participantByEmail(t, sessionId, "bob@example.com");
    await alice.mutation(api.agenda.setAck, {
      eventSlug,
      participantId: bobRow._id,
      response: "acknowledged",
    });

    const before = (await calendarJobs(t)).length;
    expect(
      await alice.mutation(api.agenda.release, {
        eventSlug,
        sessionIds: [sessionId],
      }),
    ).toEqual([{ sessionId, ok: true }]);

    const jobs = await calendarJobs(t);
    expect(jobs).toHaveLength(before + 1);
    const resend = jobs[jobs.length - 1];
    expect(resend.toEmail).toBe("bob@example.com");
    // He gets the exact notice he missed, at a sequence above the failed one.
    expect(resend.kind).toBe("schedule.released");
    expect(resend.ics.method).toBe("REQUEST");
    expect(resend.ics.sequence).toBe(1);
    expect(resend.context?.mode).toBe("resend");

    const session = await sessionRow(t, sessionId);
    expect(session.icsSequence).toBe(1);
    // The released placement itself is untouched by a resend…
    expect(session.releasedSlot).toMatchObject({ sequence: 0 });
    // …and neither is the acknowledgement bob already gave.
    expect(
      (await participantRows(t, sessionId)).find((r) => r._id === bobRow._id)
        ?.ack,
    ).toBe("acknowledged");

    // Once nothing on record failed, the same call is "unchanged" again.
    await t.run(async (ctx) => {
      await ctx.db.patch("messages", bobMessageId, { deliveryStatus: "sent" });
    });
    expect(
      await alice.mutation(api.agenda.release, {
        eventSlug,
        sessionIds: [sessionId],
      }),
    ).toEqual([{ sessionId, ok: false, error: "unchanged" }]);
  });

  test("the calendar trail is read once per wave and stays per session (M5)", async () => {
    const { t, alice, eventSlug, mainStage, sideRoom } = await setup();
    // Two released sessions in one wave. The trail behind them is now ONE
    // indexed read for the whole call instead of a full comms-log scan per
    // session, so this pins the thing that could break: rows must still be
    // attributed to the right (session, participant) pair.
    const first = await directSession(alice, eventSlug, "First", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    const second = await directSession(alice, eventSlug, "Second", {
      firstName: "Carol",
      lastName: "Speaker",
      email: "carol@example.com",
    });
    await place(alice, eventSlug, first, {
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
    });
    await place(alice, eventSlug, second, {
      startsAt: T10,
      endsAt: T11,
      roomId: sideRoom,
    });
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [first, second],
    });

    // Log what convex/emails.ts would have written: carol's send failed, bob's
    // went out. Plus an unrelated event message of another kind, which the
    // (eventId, kind) index must not even read.
    await t.run(async (ctx) => {
      const session = (await ctx.db.get("sessions", first))!;
      const orgId = (await ctx.db.get("events", session.eventId))!.orgId;
      for (const [sessionId, email] of [
        [first, "bob@example.com"],
        [second, "carol@example.com"],
      ] as const) {
        const participant = (
          await ctx.db
            .query("sessionParticipants")
            .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
            .collect()
        )[0];
        await ctx.db.insert("messages", {
          orgId,
          eventId: session.eventId,
          toEmail: email,
          kind: "schedule.released",
          subject: "Your slot",
          deliveryStatus: email === "carol@example.com" ? "failed" : "sent",
          context: { sessionId, participantId: participant._id, sequence: 0 },
        });
      }
      await ctx.db.insert("messages", {
        orgId,
        eventId: session.eventId,
        toEmail: "bob@example.com",
        kind: "reminder.tasks",
        subject: "Your outstanding tasks",
        deliveryStatus: "failed",
        context: { sessionId: first },
      });
    });

    const before = (await calendarJobs(t)).length;
    // One wave, both ids: only the session whose invite failed is resent, and
    // the unchanged one is still refused as unchanged.
    expect(
      await alice.mutation(api.agenda.release, {
        eventSlug,
        sessionIds: [first, second],
      }),
    ).toEqual([
      { sessionId: first, ok: false, error: "unchanged" },
      { sessionId: second, ok: true },
    ]);
    const jobs = (await calendarJobs(t)).slice(before);
    expect(jobs.map((job) => job.toEmail)).toEqual(["carol@example.com"]);
    expect(jobs[0].context?.sessionId).toBe(second);
    expect(jobs[0].context?.mode).toBe("resend");
  });
});

describe("event-graph read caps (H5)", () => {
  test("a schedule past a read cap refuses instead of green-lighting what it never read", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await directSession(alice, eventSlug, "Keynote", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    await place(alice, eventSlug, sessionId, {
      startsAt: T10,
      endsAt: T11,
      roomId: mainStage,
    });

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
          // Placed nowhere near the session, so nothing here is a conflict:
          // the refusal is about the READ, not about what it found.
          await ctx.db.insert("agendaItems", {
            eventId,
            title: `Coffee ${i}`,
            startsAt: T12,
            endsAt: T12 + 60_000,
          });
        }
      });
    };

    // Exactly at the cap the board still draws and the gate still opens.
    await addItems(1000);
    expect(
      (await alice.query(api.agenda.board, { eventSlug })).agendaItems,
    ).toHaveLength(1000);

    // One row past it, a conflict-derived answer would be a guess: the board
    // AND the release gate refuse, rather than reporting an all-clear over
    // rows they never looked at.
    await addItems(1);
    await expectRejectedWith(
      alice.query(api.agenda.board, { eventSlug }),
      "event_too_large",
    );
    await expectRejectedWith(
      alice.mutation(api.agenda.release, { eventSlug, sessionIds: [sessionId] }),
      "event_too_large",
    );
  });
});

// ── Acknowledgement ──────────────────────────────────────────────────────

describe("acknowledgement", () => {
  test("the speaker answers their own slot from the portal", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await placedSession(
      alice,
      eventSlug,
      "Reactive backends",
      "bob@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );
    // portal.enter requires a Clerk-verified address (model/portal.ts).
    const bob = await signIn(t, "bob", { emailVerified: true });
    await bob.mutation(api.portal.enter, { eventSlug });

    const [participant] = await participantRows(t, sessionId);
    // Nothing to acknowledge before the organizer releases the slot.
    await expectRejectedWith(
      bob.mutation(api.portal.acknowledgeSlot, {
        eventSlug,
        participantId: participant._id,
        response: "acknowledged",
      }),
      "no_released_slot",
    );

    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    let context = await bob.query(api.portal.context, { eventSlug });
    expect(context.speaking[0].ack).toBe("awaitingAck");
    expect(context.speaking[0].releasedSlot).toEqual({
      startsAt: T10,
      endsAt: T11,
      roomName: "Main Stage",
    });

    await bob.mutation(api.portal.acknowledgeSlot, {
      eventSlug,
      participantId: participant._id,
      response: "acknowledged",
    });
    context = await bob.query(api.portal.context, { eventSlug });
    expect(context.speaking[0].ack).toBe("acknowledged");
    expect(await auditActions(t)).toContain("agenda.ack");
  });

  test("a reported conflict blocks the session, alerts organizers and leaves participation alone", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await placedSession(
      alice,
      eventSlug,
      "Reactive backends",
      "bob@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );
    // portal.enter requires a Clerk-verified address (model/portal.ts).
    const bob = await signIn(t, "bob", { emailVerified: true });
    await bob.mutation(api.portal.enter, { eventSlug });
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    const [participant] = await participantRows(t, sessionId);
    await bob.mutation(api.portal.confirmParticipation, {
      eventSlug,
      participantId: participant._id,
      to: "confirmed",
    });

    await bob.mutation(api.portal.acknowledgeSlot, {
      eventSlug,
      participantId: participant._id,
      response: "conflict",
    });

    const after = (await participantRows(t, sessionId))[0];
    expect(after.ack).toBe("conflict");
    // "does not decline participation; withdrawal remains a separate action".
    expect(after.state).toBe("confirmed");

    const dashboard = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: T10,
    });
    const row = dashboard.sessions.find((s) => s.sessionId === sessionId);
    expect(row?.readiness.status).toBe("blocked");
    expect(row?.readiness.reasons.join(" ")).toContain(
      "reported a schedule conflict",
    );
    expect(await messageKinds(t)).toContain("schedule.conflictReported");
  });

  test("re-reporting the same conflict is idempotent — no repeat email or audit", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await placedSession(
      alice,
      eventSlug,
      "Reactive backends",
      "bob@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );
    // portal.enter requires a Clerk-verified address (model/portal.ts).
    const bob = await signIn(t, "bob", { emailVerified: true });
    await bob.mutation(api.portal.enter, { eventSlug });
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    const [participant] = await participantRows(t, sessionId);
    await bob.mutation(api.portal.confirmParticipation, {
      eventSlug,
      participantId: participant._id,
      to: "confirmed",
    });

    // Report the conflict, then re-assert the SAME response twice more.
    for (let i = 0; i < 3; i++) {
      await bob.mutation(api.portal.acknowledgeSlot, {
        eventSlug,
        participantId: participant._id,
        response: "conflict",
      });
    }

    // Only the transition INTO conflict notified organizers and audited (7a).
    const conflictEmails = (await messageKinds(t)).filter(
      (k) => k === "schedule.conflictReported",
    );
    expect(conflictEmails).toHaveLength(1);
    const acks = (await auditActions(t)).filter((a) => a === "agenda.ack");
    expect(acks).toHaveLength(1);
  });

  test("awaiting acknowledgement warns without blocking", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await placedSession(
      alice,
      eventSlug,
      "Reactive backends",
      "bob@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    const dashboard = await alice.query(api.tasks.dashboard, {
      eventSlug,
      now: T10,
    });
    const row = dashboard.sessions.find((s) => s.sessionId === sessionId);
    expect(row?.readiness.status).toBe("needsAttention");
    expect(row?.readiness.reasons.join(" ")).toContain(
      "not acknowledged their slot",
    );
  });

  test("an organizer may answer on the speaker's behalf; a stranger cannot", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await placedSession(
      alice,
      eventSlug,
      "Reactive backends",
      "bob@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    const [participant] = await participantRows(t, sessionId);

    const mallory = await signIn(t, "mallory");
    await expectRejectedWith(
      mallory.mutation(api.portal.acknowledgeSlot, {
        eventSlug,
        participantId: participant._id,
        response: "acknowledged",
      }),
      "not_found",
    );

    await alice.mutation(api.agenda.setAck, {
      eventSlug,
      participantId: participant._id,
      response: "acknowledged",
    });
    expect((await participantRows(t, sessionId))[0].ack).toBe("acknowledged");
    const acks = await t.run(async (ctx) => {
      const rows = await ctx.db.query("auditLog").collect();
      return rows.filter((r) => r.action === "agenda.ack");
    });
    expect(acks[0].meta).toMatchObject({ onBehalf: true });
  });
});

// ── Virtual links ────────────────────────────────────────────────────────

describe("agenda.setVirtualLinks", () => {
  test("stores the three audiences and refuses a non-http link", async () => {
    const { t, alice, eventSlug } = await setup();
    const sessionId = await directSession(alice, eventSlug, "Hybrid talk", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    await expectRejectedWith(
      alice.mutation(api.agenda.setVirtualLinks, {
        eventSlug,
        sessionId,
        links: { attendee: "javascript:alert(1)" },
      }),
      "invalid_url",
    );

    await alice.mutation(api.agenda.setVirtualLinks, {
      eventSlug,
      sessionId,
      links: {
        attendee: "https://stream.example.com/live",
        backstage: "https://meet.example.com/backstage",
        host: "https://meet.example.com/host",
      },
    });
    const board = await alice.query(api.agenda.board, { eventSlug });
    expect(board.sessions[0].virtualLinks).toEqual({
      attendee: "https://stream.example.com/live",
      backstage: "https://meet.example.com/backstage",
      host: "https://meet.example.com/host",
    });
    // The URLs never reach the audit log.
    const entry = await t.run(async (ctx) => {
      const rows = await ctx.db.query("auditLog").collect();
      return rows.find((r) => r.action === "agenda.setVirtualLinks");
    });
    expect(entry?.meta).toEqual({
      attendee: true,
      backstage: true,
      host: true,
    });
  });

  test("only a confirmed speaker sees the backstage link in the portal", async () => {
    const { t, alice, eventSlug } = await setup();
    const sessionId = await directSession(alice, eventSlug, "Hybrid talk", {
      firstName: "Bob",
      lastName: "Speaker",
      email: "bob@example.com",
    });
    await alice.mutation(api.agenda.setVirtualLinks, {
      eventSlug,
      sessionId,
      links: {
        backstage: "https://meet.example.com/backstage",
        host: "https://meet.example.com/host",
      },
    });
    // portal.enter requires a Clerk-verified address (model/portal.ts).
    const bob = await signIn(t, "bob", { emailVerified: true });
    await bob.mutation(api.portal.enter, { eventSlug });

    let context = await bob.query(api.portal.context, { eventSlug });
    expect(context.speaking[0].backstageUrl).toBeUndefined();

    const [participant] = await participantRows(t, sessionId);
    await bob.mutation(api.portal.confirmParticipation, {
      eventSlug,
      participantId: participant._id,
      to: "confirmed",
    });
    context = await bob.query(api.portal.context, { eventSlug });
    expect(context.speaking[0].backstageUrl).toBe(
      "https://meet.example.com/backstage",
    );
    // The host link is organizer-only and never appears in the portal shape.
    expect(JSON.stringify(context)).not.toContain("meet.example.com/host");
  });
});

// ── Archived events ──────────────────────────────────────────────────────

describe("archived events", () => {
  test("every agenda write is refused once the event is archived", async () => {
    const { t, alice, eventSlug, mainStage } = await setup();
    const sessionId = await placedSession(
      alice,
      eventSlug,
      "Frozen talk",
      "bob@example.com",
      { startsAt: T10, endsAt: T11, roomId: mainStage },
    );
    await alice.mutation(api.agenda.release, {
      eventSlug,
      sessionIds: [sessionId],
    });
    const [participant] = await participantRows(t, sessionId);

    await alice.mutation(api.events.setArchived, { eventSlug, archived: true });

    // Board edits, item CRUD, release, cancel and acks are all M6 writes.
    for (const call of [
      place(alice, eventSlug, sessionId, {
        startsAt: T11,
        endsAt: T12,
        roomId: mainStage,
      }),
      alice.mutation(api.agenda.createAgendaItem, {
        eventSlug,
        title: "Lunch",
        startsAt: T11,
        endsAt: T12,
      }),
      alice.mutation(api.agenda.release, { eventSlug, sessionIds: [sessionId] }),
      alice.mutation(api.agenda.cancelRelease, { eventSlug, sessionId }),
      alice.mutation(api.agenda.setAck, {
        eventSlug,
        participantId: participant._id,
        response: "acknowledged",
      }),
    ]) {
      await expectRejectedWith(call, "event_archived");
    }

    // The board stays readable, and nothing above sent a cancellation.
    const board = await alice.query(api.agenda.board, { eventSlug });
    expect(board.sessions).toHaveLength(1);
    expect(
      (await calendarJobs(t)).filter((j) => j.ics.method === "CANCEL"),
    ).toHaveLength(0);
  });
});

// ── Auto-place (W7: AIA-08) ──────────────────────────────────────────────

describe("agenda.autoPlace", () => {
  test("places every unscheduled session into conflict-free slots in one action", async () => {
    const { t, alice, eventSlug } = await setup();
    // Two sessions sharing a speaker: they must not land in overlapping
    // slots; a third with its own speaker can share a time in another room.
    const shared = {
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
    };
    const a = await directSession(alice, eventSlug, "Talk A", shared);
    const b = await directSession(alice, eventSlug, "Talk B", shared);
    const c = await directSession(alice, eventSlug, "Talk C", {
      firstName: "Alan",
      lastName: "Turing",
      email: "alan@example.com",
    });

    const result = await alice.mutation(api.agenda.autoPlace, { eventSlug });
    expect(result.placed.map((p) => p.title).sort()).toEqual([
      "Talk A",
      "Talk B",
      "Talk C",
    ]);
    expect(result.unplaced).toEqual([]);

    // The board must show zero blockers after auto-placement.
    const board = await alice.query(api.agenda.board, { eventSlug });
    const blocked = board.sessions.filter((s) =>
      s.conflicts.some((conflict) => conflict.level === "blocker"),
    );
    expect(blocked).toEqual([]);
    for (const id of [a, b, c]) {
      const row = await sessionRow(t, id);
      expect(row?.startsAt).toBeGreaterThan(0);
      expect(row?.endsAt).toBe((row?.startsAt ?? 0) + 60 * 60 * 1000);
    }
    // Re-running places nothing new (idempotent over a full board).
    const again = await alice.mutation(api.agenda.autoPlace, { eventSlug });
    expect(again.placed).toEqual([]);
  });
});
