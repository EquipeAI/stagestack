import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
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
    expect(lib.customFields[0]).toMatchObject({
      name: "Session length",
      kind: "select",
      appliesTo: "session",
      options: ["25m", "45m"],
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
    expect(afterRemove.customFields).toEqual([]);
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
