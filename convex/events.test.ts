import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import {
  auditActions,
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
} from "./test.helpers";

const STARTS = Date.parse("2026-09-01T09:00:00Z");

describe("events.create", () => {
  test("org owner creates an event with a slug and cfpPublished false", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit 2026");
    expect(eventSlug).toBe("acme-summit-2026");

    const { event, org, role, orgRole } = await alice.query(api.events.get, {
      eventSlug,
    });
    expect(event.cfpPublished).toBe(false);
    expect(event.name).toBe("Acme Summit 2026");
    expect(event.timezone).toBe("America/Los_Angeles");
    expect(org.slug).toBe(orgSlug);
    expect(role).toBe("organizer");
    expect(orgRole).toBe("owner");
  });

  test("NEGATIVE: a non-member of the org cannot create an event in it", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const mallory = await signIn(t, "mallory");
    const orgSlug = await createOrg(alice, "Acme Conf Co");

    await expectRejectedWith(
      mallory.mutation(api.events.create, {
        orgSlug,
        name: "Sneaky Summit",
        startsAt: STARTS,
        endsAt: STARTS + 1000,
        timezone: "UTC",
      }),
      "forbidden",
    );
  });

  test("NEGATIVE: an event-scoped organizer is not an org admin and cannot create events", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const dave = await signIn(t, "dave");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await grantEventRole(t, eventSlug, "dave", "organizer");

    await expectRejectedWith(
      dave.mutation(api.events.create, {
        orgSlug,
        name: "Dave's Own Summit",
        startsAt: STARTS,
        endsAt: STARTS + 1000,
        timezone: "UTC",
      }),
      "forbidden",
    );
  });

  test("validates dates and timezone", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");

    await expectRejectedWith(
      alice.mutation(api.events.create, {
        orgSlug,
        name: "Backwards",
        startsAt: STARTS,
        endsAt: STARTS - 1,
        timezone: "UTC",
      }),
      "invalid_dates",
    );
    await expectRejectedWith(
      alice.mutation(api.events.create, {
        orgSlug,
        name: "Bad Zone",
        startsAt: STARTS,
        endsAt: STARTS + 1,
        timezone: "Pacific Time",
      }),
      "invalid_timezone",
    );
  });
});

describe("events.get", () => {
  test("an event-scoped reviewer can read the event with role reviewer", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const rita = await signIn(t, "rita");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await grantEventRole(t, eventSlug, "rita", "reviewer");

    const result = await rita.query(api.events.get, { eventSlug });
    expect(result.role).toBe("reviewer");
    expect(result.orgRole).toBeNull();
    expect(result.event.slug).toBe(eventSlug);
  });

  test("NEGATIVE: unrelated authed user is forbidden; unauthenticated is rejected", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const mallory = await signIn(t, "mallory");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    await expectRejectedWith(
      mallory.query(api.events.get, { eventSlug }),
      "forbidden",
    );
    await expectRejectedWith(
      t.query(api.events.get, { eventSlug }),
      "not_authenticated",
    );
    await expectRejectedWith(
      alice.query(api.events.get, { eventSlug: "no-such-event" }),
      "not_found",
    );
  });
});

describe("events.updateSettings", () => {
  test("updates name and dates and writes an audit row", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    const newStart = Date.parse("2026-10-01T09:00:00Z");
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: {
        name: "Acme Summit (renamed)",
        startsAt: newStart,
        endsAt: newStart + 3600_000,
        location: "Berlin",
        cfpPublished: true,
      },
    });

    const { event } = await alice.query(api.events.get, { eventSlug });
    expect(event.name).toBe("Acme Summit (renamed)");
    expect(event.startsAt).toBe(newStart);
    expect(event.endsAt).toBe(newStart + 3600_000);
    expect(event.location).toBe("Berlin");
    expect(event.cfpPublished).toBe(true);

    // Null clears a clearable field.
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { location: null },
    });
    const after = await alice.query(api.events.get, { eventSlug });
    expect(after.event.location).toBeUndefined();

    expect(await auditActions(t)).toEqual([
      "org.create",
      "event.create",
      "event.updateSettings",
      "event.updateSettings",
    ]);
  });

  test("rejects endsAt before startsAt and a taken slug", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    const otherSlug = await createEvent(alice, orgSlug, "Acme Winter");

    await expectRejectedWith(
      alice.mutation(api.events.updateSettings, {
        eventSlug,
        patch: { endsAt: STARTS - 1 },
      }),
      "invalid_dates",
    );
    await expectRejectedWith(
      alice.mutation(api.events.updateSettings, {
        eventSlug,
        patch: { slug: otherSlug },
      }),
      "slug_taken",
    );
    await expectRejectedWith(
      alice.mutation(api.events.updateSettings, {
        eventSlug,
        patch: { slug: "Not A Slug" },
      }),
      "invalid_slug",
    );
  });

  test("website must be a full http(s) URL — it renders as a public href", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");

    // A javascript: scheme would become a clickable XSS vector on the public
    // event page (M7), and a bare host would render as a relative link.
    await expectRejectedWith(
      alice.mutation(api.events.updateSettings, {
        eventSlug,
        patch: { website: "javascript:alert(1)" },
      }),
      "invalid_link",
    );
    await expectRejectedWith(
      alice.mutation(api.events.updateSettings, {
        eventSlug,
        patch: { website: "acme.example" },
      }),
      "invalid_link",
    );

    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { website: "https://acme.example" },
    });
    let { event } = await alice.query(api.events.get, { eventSlug });
    expect(event.website).toBe("https://acme.example");

    // Blank clears, exactly like null.
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { website: "   " },
    });
    ({ event } = await alice.query(api.events.get, { eventSlug }));
    expect(event.website).toBeUndefined();
  });

  test("NEGATIVE: a reviewer cannot update settings (eventMutation requires organizer)", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const rita = await signIn(t, "rita");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
    await grantEventRole(t, eventSlug, "rita", "reviewer");

    await expectRejectedWith(
      rita.mutation(api.events.updateSettings, {
        eventSlug,
        patch: { name: "Reviewer Was Here" },
      }),
      "forbidden",
    );
  });
});
