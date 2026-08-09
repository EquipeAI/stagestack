import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
} from "./test.helpers";

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
