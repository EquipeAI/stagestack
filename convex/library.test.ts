import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { parseDurationLabel } from "./model/library";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
  type TestT,
} from "./test.helpers";

const HOUR = 60 * 60 * 1000;
const EVENT_START = Date.parse("2026-09-01T09:00:00Z");
const T10 = Date.parse("2026-09-01T10:00:00Z");
const T11 = T10 + HOUR;

describe("library CRUD", () => {
  test("add/list/update/remove across all four tables, with incrementing order", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    const trackId = await alice.mutation(api.library.add, {
      eventSlug,
      table: "tracks",
      item: { name: "  Platform  ", description: "Infra talks", color: "#123" },
    });
    const track2 = await alice.mutation(api.library.add, {
      eventSlug,
      table: "tracks",
      item: { name: "Product" },
    });
    const tagId = await alice.mutation(api.library.add, {
      eventSlug,
      table: "tags",
      item: { name: "beginner", color: "#abc" },
    });
    const roomId = await alice.mutation(api.library.add, {
      eventSlug,
      table: "rooms",
      item: { name: "Main Stage", capacity: 500 },
    });
    const fieldId = await alice.mutation(api.library.add, {
      eventSlug,
      table: "customFields",
      item: {
        name: "Session length",
        kind: "select",
        options: ["25m", "45m"],
        appliesTo: "session",
      },
    });

    const lib = await alice.query(api.library.list, { eventSlug });
    expect(lib.tracks.map((x) => x.name)).toEqual(["Platform", "Product"]);
    expect(lib.tracks.map((x) => x.order)).toEqual([0, 1]);
    expect(lib.tracks[0]._id).toBe(trackId);
    expect(lib.tracks[1]._id).toBe(track2);
    expect(lib.tags).toHaveLength(1);
    expect(lib.tags[0].order).toBe(0);
    expect(lib.rooms[0]).toMatchObject({ name: "Main Stage", capacity: 500 });
    expect(lib.customFields).toHaveLength(2);
    expect(lib.customFields[0]).toMatchObject({
      name: "Travel preferences",
      kind: "text",
      appliesTo: "speaker",
      order: 0,
    });
    expect(lib.customFields[1]).toMatchObject({
      name: "Session length",
      kind: "select",
      appliesTo: "session",
      options: ["25m", "45m"],
      order: 1,
    });

    await alice.mutation(api.library.update, {
      eventSlug,
      table: "tracks",
      id: trackId,
      patch: { name: "Platform Engineering", color: "#999" },
    });
    await alice.mutation(api.library.update, {
      eventSlug,
      table: "rooms",
      id: roomId,
      patch: { capacity: 250 },
    });
    const updated = await alice.query(api.library.list, { eventSlug });
    expect(updated.tracks[0].name).toBe("Platform Engineering");
    expect(updated.tracks[0].color).toBe("#999");
    expect(updated.rooms[0].capacity).toBe(250);

    await alice.mutation(api.library.remove, {
      eventSlug,
      table: "tags",
      id: tagId,
    });
    await alice.mutation(api.library.remove, {
      eventSlug,
      table: "customFields",
      id: fieldId,
    });
    const afterRemove = await alice.query(api.library.list, { eventSlug });
    expect(afterRemove.tags).toEqual([]);
    expect(afterRemove.customFields).toEqual([
      expect.objectContaining({ name: "Travel preferences", order: 0 }),
    ]);
    expect(afterRemove.tracks).toHaveLength(2);
  });

  test("rejects an empty name", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await expectRejectedWith(
      alice.mutation(api.library.add, {
        eventSlug,
        table: "tags",
        item: { name: "   " },
      }),
      "invalid_name",
    );
  });

  test("NEGATIVE: an item from event A cannot be updated or removed via event B", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventA = await createEvent(alice, orgSlug, "Event A");
    const eventB = await createEvent(alice, orgSlug, "Event B");

    const trackId = await alice.mutation(api.library.add, {
      eventSlug: eventA,
      table: "tracks",
      item: { name: "Platform" },
    });

    await expectRejectedWith(
      alice.mutation(api.library.update, {
        eventSlug: eventB,
        table: "tracks",
        id: trackId,
        patch: { name: "Hijacked" },
      }),
      "not_found",
    );
    await expectRejectedWith(
      alice.mutation(api.library.remove, {
        eventSlug: eventB,
        table: "tracks",
        id: trackId,
      }),
      "not_found",
    );

    // Untouched in its own event.
    const lib = await alice.query(api.library.list, { eventSlug: eventA });
    expect(lib.tracks.map((x) => x.name)).toEqual(["Platform"]);
  });

  test("NEGATIVE: a reviewer can list but cannot add", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const rita = await signIn(t, "rita");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    await alice.mutation(api.library.add, {
      eventSlug,
      table: "tracks",
      item: { name: "Platform" },
    });

    const lib = await rita.query(api.library.list, { eventSlug });
    expect(lib.tracks).toHaveLength(1);

    await expectRejectedWith(
      rita.mutation(api.library.add, {
        eventSlug,
        table: "tracks",
        item: { name: "Reviewer Track" },
      }),
      "forbidden",
    );
  });
});

// Deleting a referenced room or track would leave dangling ids in sessions and
// agenda items — and a room named in a released slot is already out in the
// speakers' .ics files.
describe("library delete guard", () => {
  async function scheduledEvent() {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit", {
      startsAt: EVENT_START,
    });
    const room = async (name: string) =>
      (await alice.mutation(api.library.add, {
        eventSlug,
        table: "rooms",
        item: { name },
      })) as Id<"rooms">;
    const track = async (name: string) =>
      (await alice.mutation(api.library.add, {
        eventSlug,
        table: "tracks",
        item: { name },
      })) as Id<"tracks">;
    return { t, alice, orgSlug, eventSlug, room, track };
  }

  test("refuses a track or room a session or agenda item still points at", async () => {
    const { alice, eventSlug, room, track } = await scheduledEvent();
    const mainStage = await room("Main Stage");
    const breakArea = await room("Break Area");
    const emptyRoom = await room("Empty Room");
    const platform = await track("Platform");
    const unusedTrack = await track("Unused");

    const { sessionId } = await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Reactive backends",
      trackId: platform,
      speaker: {
        firstName: "Bob",
        lastName: "Speaker",
        email: "bob@example.com",
      },
    });
    await alice.mutation(api.agenda.scheduleSession, {
      eventSlug,
      sessionId,
      slot: { startsAt: T10, endsAt: T11, roomId: mainStage },
    });
    await alice.mutation(api.agenda.createAgendaItem, {
      eventSlug,
      title: "Coffee",
      startsAt: T11,
      endsAt: T11 + HOUR,
      roomId: breakArea,
    });

    await expectRejectedWith(
      alice.mutation(api.library.remove, {
        eventSlug,
        table: "tracks",
        id: platform,
      }),
      "library_item_in_use",
    );
    await expectRejectedWith(
      alice.mutation(api.library.remove, {
        eventSlug,
        table: "rooms",
        id: mainStage,
      }),
      "library_item_in_use",
    );
    await expectRejectedWith(
      alice.mutation(api.library.remove, {
        eventSlug,
        table: "rooms",
        id: breakArea,
      }),
      "library_item_in_use",
    );

    // Unreferenced rows still delete.
    await alice.mutation(api.library.remove, {
      eventSlug,
      table: "tracks",
      id: unusedTrack,
    });
    await alice.mutation(api.library.remove, {
      eventSlug,
      table: "rooms",
      id: emptyRoom,
    });
    const lib = await alice.query(api.library.list, { eventSlug });
    expect(lib.tracks.map((x) => x.name)).toEqual(["Platform"]);
    expect(lib.rooms.map((x) => x.name)).toEqual(["Main Stage", "Break Area"]);
  });

  test("a room only named in a released slot is still protected", async () => {
    const { alice, eventSlug, room } = await scheduledEvent();
    const mainStage = await room("Main Stage");
    const sideRoom = await room("Side Room");

    const { sessionId } = await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Reactive backends",
      speaker: {
        firstName: "Bob",
        lastName: "Speaker",
        email: "bob@example.com",
      },
    });
    await alice.mutation(api.agenda.scheduleSession, {
      eventSlug,
      sessionId,
      slot: { startsAt: T10, endsAt: T11, roomId: mainStage },
    });
    expect(
      await alice.mutation(api.agenda.release, {
        eventSlug,
        sessionIds: [sessionId],
      }),
    ).toEqual([{ sessionId, ok: true }]);
    // The draft moves on; the speakers' .ics still names Main Stage.
    await alice.mutation(api.agenda.scheduleSession, {
      eventSlug,
      sessionId,
      slot: { startsAt: T10, endsAt: T11, roomId: sideRoom },
    });

    await expectRejectedWith(
      alice.mutation(api.library.remove, {
        eventSlug,
        table: "rooms",
        id: mainStage,
      }),
      "library_item_in_use",
    );
  });

  test("an archived event refuses library writes", async () => {
    const { alice, eventSlug, track } = await scheduledEvent();
    const platform = await track("Platform");
    await alice.mutation(api.events.setArchived, { eventSlug, archived: true });

    for (const call of [
      alice.mutation(api.library.add, {
        eventSlug,
        table: "tags",
        item: { name: "beginner" },
      }),
      alice.mutation(api.library.update, {
        eventSlug,
        table: "tracks",
        id: platform,
        patch: { name: "Renamed" },
      }),
      alice.mutation(api.library.remove, {
        eventSlug,
        table: "tracks",
        id: platform,
      }),
    ]) {
      await expectRejectedWith(call, "event_archived");
    }

    // Reads stay open so history is browsable.
    const lib = await alice.query(api.library.list, { eventSlug });
    expect(lib.tracks.map((x) => x.name)).toEqual(["Platform"]);
  });
});

// ── Formats (W2) ─────────────────────────────────────────────────────────
// The format library is what gives assisted placement, the CFP form and the
// public program ONE answer to "how long is a Lightning Talk". Its labels are
// asserted verbatim by the eval, so nothing here may normalise them.

describe("format labels", () => {
  test("parses only a trailing (N min) parenthetical", () => {
    expect(parseDurationLabel("Workshop (120 min)")).toBe(120);
    expect(parseDurationLabel("Lightning Talk (10 mins)")).toBe(10);
    expect(parseDurationLabel("Keynote (45 minutes)")).toBe(45);
    expect(parseDurationLabel("Panel (30 MIN)")).toBe(30);
    expect(parseDurationLabel("Talk (25min)")).toBe(25);
    expect(parseDurationLabel("  Talk (25 min)  ")).toBe(25);
    // Not a trailing parenthetical, not a number we trust, not our shape.
    expect(parseDurationLabel("Talk")).toBeNull();
    expect(parseDurationLabel("120 min Workshop")).toBeNull();
    expect(parseDurationLabel("Workshop (2 hours)")).toBeNull();
    expect(parseDurationLabel("Workshop (120 min) — advanced")).toBeNull();
    expect(parseDurationLabel("Marathon (2000 min)")).toBeNull();
    expect(parseDurationLabel("Nothing (0 min)")).toBeNull();
  });
});

describe("formats library", () => {
  test("adds, orders, and derives the default length from the label", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    await alice.mutation(api.library.add, {
      eventSlug,
      table: "formats",
      item: { name: "Workshop (120 min)" },
    });
    await alice.mutation(api.library.add, {
      eventSlug,
      table: "formats",
      item: { name: "Talk", defaultDurationMinutes: 45 },
    });
    await alice.mutation(api.library.add, {
      eventSlug,
      table: "formats",
      item: { name: "Panel" },
    });

    const lib = await alice.query(api.library.list, { eventSlug });
    expect(lib.formats.map((f) => [f.name, f.defaultDurationMinutes])).toEqual([
      ["Workshop (120 min)", 120],
      ["Talk", 45],
      ["Panel", undefined],
    ]);
    expect(lib.formats.map((f) => f.order)).toEqual([0, 1, 2]);

    await alice.mutation(api.library.update, {
      eventSlug,
      table: "formats",
      id: lib.formats[2]._id,
      patch: { defaultDurationMinutes: 60 },
    });
    const updated = await alice.query(api.library.list, { eventSlug });
    expect(updated.formats[2].defaultDurationMinutes).toBe(60);

    await expectRejectedWith(
      alice.mutation(api.library.update, {
        eventSlug,
        table: "formats",
        id: lib.formats[1]._id,
        patch: { defaultDurationMinutes: 0 },
      }),
      "invalid_duration",
    );
  });

  test("refuses to delete a format a session still points at", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await alice.mutation(api.library.add, {
      eventSlug,
      table: "formats",
      item: { name: "Workshop (120 min)" },
    });
    const unused = await alice.mutation(api.library.add, {
      eventSlug,
      table: "formats",
      item: { name: "Panel" },
    });
    await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Reactive backends",
      format: "Workshop (120 min)",
      speaker: {
        firstName: "Bob",
        lastName: "Speaker",
        email: "bob@example.com",
      },
    });

    const lib = await alice.query(api.library.list, { eventSlug });
    await expectRejectedWith(
      alice.mutation(api.library.remove, {
        eventSlug,
        table: "formats",
        id: lib.formats[0]._id,
      }),
      "library_item_in_use",
    );
    // The unreferenced one still deletes.
    await alice.mutation(api.library.remove, {
      eventSlug,
      table: "formats",
      id: unused,
    });
  });

  test("NEGATIVE: a reviewer can list formats but cannot add one, and a format from event A is invisible to event B", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const rita = await signIn(t, "rita");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventA = await createEvent(alice, orgSlug, "Event A");
    const eventB = await createEvent(alice, orgSlug, "Event B");
    await grantEventRole(t, eventA, "rita", "reviewer");
    const formatId = await alice.mutation(api.library.add, {
      eventSlug: eventA,
      table: "formats",
      item: { name: "Workshop (120 min)" },
    });

    expect(
      (await rita.query(api.library.list, { eventSlug: eventA })).formats,
    ).toHaveLength(1);
    await expectRejectedWith(
      rita.mutation(api.library.add, {
        eventSlug: eventA,
        table: "formats",
        item: { name: "Reviewer Format" },
      }),
      "forbidden",
    );
    await expectRejectedWith(
      alice.mutation(api.library.update, {
        eventSlug: eventB,
        table: "formats",
        id: formatId,
        patch: { name: "Hijacked" },
      }),
      "not_found",
    );
    await expectRejectedWith(
      alice.mutation(api.library.remove, {
        eventSlug: eventB,
        table: "formats",
        id: formatId,
      }),
      "not_found",
    );
  });
});

describe("library.backfillFormats", () => {
  async function eventIdOf(t: TestT, slug: string): Promise<Id<"events">> {
    return await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      if (event === null) throw new Error(`no event ${slug}`);
      return event._id;
    });
  }

  test("distinct free-text formats become rows with VERBATIM names, and re-running changes nothing", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    const speaker = (n: number) => ({
      firstName: "Bob",
      lastName: `Speaker${n}`,
      email: `bob${n}@example.com`,
    });

    // No formats library yet, so every one of these lands as free text.
    const labels = [
      "Workshop (120 min)",
      "Lightning Talk (10 min)",
      "Workshop (120 min)",
      "Fireside chat",
      // Longer than the library's 80-character name limit, and a label that
      // only differs by whitespace. Neither can be written through the API any
      // more (normalizeFormatLabel trims and refuses), so they are patched in
      // directly — which is exactly the shape a pre-migration row has.
      "X".repeat(81),
      "  Fireside chat  ",
    ];
    const sessionIds: Array<Id<"sessions">> = [];
    for (const [index, format] of labels.entries()) {
      const { sessionId } = await alice.mutation(api.sessions.createDirect, {
        eventSlug,
        title: `Session ${index}`,
        speaker: speaker(index),
      });
      await t.run(async (ctx) => {
        await ctx.db.patch("sessions", sessionId, { format });
      });
      sessionIds.push(sessionId);
    }
    // One session with no format at all must not produce a row.
    await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Formatless",
      speaker: speaker(99),
    });

    const eventId = await eventIdOf(t, eventSlug);
    const first = await t.mutation(internal.library.backfillFormats, {
      eventId,
    });
    // "  Fireside chat  " normalizes onto the row "Fireside chat" already
    // made, so it links without creating a second, near-identical format.
    expect(first).toEqual({
      formatsCreated: 3,
      sessionsLinked: 5,
      unmatched: 1,
    });

    const lib = await alice.query(api.library.list, { eventSlug });
    expect(lib.formats.map((f) => f.name)).toEqual([
      "Workshop (120 min)",
      "Lightning Talk (10 min)",
      "Fireside chat",
    ]);
    // The parenthetical is parsed into the number AND kept in the name.
    expect(lib.formats.map((f) => f.defaultDurationMinutes)).toEqual([
      120,
      10,
      undefined,
    ]);

    const rows = await t.run(async (ctx) =>
      Promise.all(sessionIds.map((id) => ctx.db.get("sessions", id))),
    );
    // The two "Workshop (120 min)" sessions share one row; the over-long
    // label kept its free text and no link.
    expect(rows[0]?.formatId).toBe(lib.formats[0]._id);
    expect(rows[2]?.formatId).toBe(lib.formats[0]._id);
    expect(rows[1]?.formatId).toBe(lib.formats[1]._id);
    expect(rows[4]?.formatId).toBeUndefined();
    expect(rows[4]?.format).toBe("X".repeat(81));
    // Free text is never dropped — it stays as the display fallback, raw
    // whitespace and all; the trim lives in the matcher and the row's name.
    expect(rows[0]?.format).toBe("Workshop (120 min)");
    expect(rows[5]?.formatId).toBe(lib.formats[2]._id);
    expect(rows[5]?.format).toBe("  Fireside chat  ");

    const second = await t.mutation(internal.library.backfillFormats, {
      eventId,
    });
    expect(second).toEqual({
      formatsCreated: 0,
      sessionsLinked: 0,
      unmatched: 1,
    });
    const after = await alice.query(api.library.list, { eventSlug });
    expect(after.formats.map((f) => f._id)).toEqual(
      lib.formats.map((f) => f._id),
    );
  });

  test("an existing row is reused rather than duplicated, and its order continues", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await alice.mutation(api.library.add, {
      eventSlug,
      table: "formats",
      item: { name: "Talk", defaultDurationMinutes: 25 },
    });
    // Written straight to the row so it bypasses the create-time resolution
    // and looks exactly like a pre-migration session.
    const { sessionId } = await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Legacy",
      speaker: {
        firstName: "Bob",
        lastName: "Speaker",
        email: "bob@example.com",
      },
    });
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionId, { format: "Talk" });
    });

    const eventId = await eventIdOf(t, eventSlug);
    expect(
      await t.mutation(internal.library.backfillFormats, { eventId }),
    ).toEqual({ formatsCreated: 0, sessionsLinked: 1, unmatched: 0 });
    const lib = await alice.query(api.library.list, { eventSlug });
    expect(lib.formats).toHaveLength(1);
    // The hand-set default survives the backfill.
    expect(lib.formats[0].defaultDurationMinutes).toBe(25);
  });
});

// ── Rename keeps the denormalized copy honest (codex #2) ─────────────────

describe("formats rename", () => {
  test("renaming a format rewrites every linked session's label, records no revision, and keeps the link through a later edit", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    const formatId = await alice.mutation(api.library.add, {
      eventSlug,
      table: "formats",
      item: { name: "Workshop (120 min)" },
    });
    const { sessionId } = await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Reactive backends",
      format: "Workshop (120 min)",
      speaker: {
        firstName: "Bob",
        lastName: "Speaker",
        email: "bob@example.com",
      },
    });
    // An untouched session must not be dragged into the rename.
    const { sessionId: other } = await alice.mutation(
      api.sessions.createDirect,
      {
        eventSlug,
        title: "Hallway track",
        format: "Unstructured chat",
        speaker: {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
        },
      },
    );
    const revisionsBefore = await alice.query(api.sessions.listRevisions, {
      eventSlug,
      sessionId,
    });

    await alice.mutation(api.library.update, {
      eventSlug,
      table: "formats",
      id: formatId,
      patch: { name: "Deep-dive workshop (120 min)" },
    });

    const renamed = await t.run(async (ctx) => ({
      linked: await ctx.db.get("sessions", sessionId),
      untouched: await ctx.db.get("sessions", other),
    }));
    // The denormalized copy follows the row — it is what resolveFormatId
    // re-keys off on the next save.
    expect(renamed.linked?.format).toBe("Deep-dive workshop (120 min)");
    expect(renamed.linked?.formatId).toBe(formatId);
    expect(renamed.untouched?.format).toBe("Unstructured chat");
    expect(renamed.untouched?.formatId).toBeUndefined();

    // A library rename is not an editorial change to anyone's session.
    const revisionsAfter = await alice.query(api.sessions.listRevisions, {
      eventSlug,
      sessionId,
    });
    expect(revisionsAfter).toHaveLength(revisionsBefore.length);

    // The bug this guards: a later title-only edit re-resolving off a stale
    // label, finding nothing, and silently dropping the link.
    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      title: "Reactive backends, revisited",
    });
    const afterEdit = await t.run(async (ctx) =>
      ctx.db.get("sessions", sessionId),
    );
    expect(afterEdit?.formatId).toBe(formatId);
    expect(afterEdit?.format).toBe("Deep-dive workshop (120 min)");
  });

  test("a label differing only by whitespace resolves to the same row, from the portal too", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    const { sessionId } = await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Reactive backends",
      speaker: {
        firstName: "Bob",
        lastName: "Speaker",
        email: "bob@example.com",
      },
    });
    // Pre-migration free text, then the migration that names the row.
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionId, { format: "Fireside chat" });
    });
    const eventId = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      return event._id;
    });
    await t.mutation(internal.library.backfillFormats, { eventId });
    const lib = await alice.query(api.library.list, { eventSlug });
    expect(lib.formats.map((f) => f.name)).toEqual(["Fireside chat"]);

    // The organizer retypes it with a trailing space: shared normalization
    // means it links to the row it matches rather than falling back to text.
    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      format: "Fireside chat ",
    });
    const row = await t.run(async (ctx) => ctx.db.get("sessions", sessionId));
    expect(row?.formatId).toBe(lib.formats[0]._id);
    expect(row?.format).toBe("Fireside chat");

    // And an over-long label is refused, never truncated into another row.
    await expectRejectedWith(
      alice.mutation(api.sessions.updateContent, {
        eventSlug,
        sessionId,
        format: "Y".repeat(81),
      }),
      "invalid_format",
    );
  });
});

describe("library.backfillFormats — read ceiling", () => {
  test("refuses an oversized event instead of reporting a partial migration", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    const eventId = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("no event");
      // One past the 1000-session ceiling the backfill reads with.
      for (let i = 0; i < 1001; i += 1) {
        await ctx.db.insert("sessions", {
          eventId: event._id,
          title: `Session ${i}`,
          format: "Talk",
          source: "direct",
          status: "planned",
        });
      }
      return event._id;
    });

    await expectRejectedWith(
      t.mutation(internal.library.backfillFormats, { eventId }),
      "event_too_large",
    );
    // Nothing was written: a refused migration must not leave half a library.
    expect(
      (await alice.query(api.library.list, { eventSlug })).formats,
    ).toEqual([]);
  });
});
