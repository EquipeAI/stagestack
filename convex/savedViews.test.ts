/// <reference types="vite/client" />
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

// ─────────────────────────────────────────────────────────────────────────
// W2 — saved views.
//
// What is worth breaking the build over:
//   • params validation. A stored view whose params the destination route
//     would DROP opens a page that looks filtered and is not, which is worse
//     than no saved views at all. Writes are refused, and the refusal names
//     the param;
//   • ownership. A view is a private preference: another organizer of the same
//     event must not see it, read it, rename it or delete it;
//   • tenancy. Cross-event and cross-org must refuse before anything is read;
//   • the reviewer gate. Reviews is the one module a reviewer works in, so it
//     is the one module they may name a view of — and storing params for an
//     organizer-only module must fail on the WRITE, not merely be hidden on
//     the read, or a saved view becomes a way to carry organizer filters.
// ─────────────────────────────────────────────────────────────────────────

async function organizerOnEvent(name: string) {
  const t = setupTest();
  const owner = await signIn(t, name);
  const orgSlug = await createOrg(owner, `${name} org`);
  const eventSlug = await createEvent(owner, orgSlug, `${name} conf`);
  return { t, owner, orgSlug, eventSlug };
}

describe("savedViews CRUD", () => {
  test("saves, lists, renames, re-points and deletes a view", async () => {
    const { t, owner, eventSlug } = await organizerOnEvent("ada");

    const empty = await owner.query(api.savedViews.list, {
      eventSlug,
      module: "proposals",
    });
    expect(empty.views).toEqual([]);
    expect(empty.defaultViewId).toBeNull();
    expect(empty.summary).toContain("No saved views on Proposals yet");

    const created = await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "proposals",
      name: "Wave 1 shortlist",
      params: { status: "pending", sort: "title", dir: "asc" },
    });
    expect(created.message).toContain("Saved “Wave 1 shortlist” on Proposals");
    expect(created.message).toContain("3 settings");

    const listed = await owner.query(api.savedViews.list, {
      eventSlug,
      module: "proposals",
    });
    expect(listed.views).toHaveLength(1);
    expect(listed.views[0].name).toBe("Wave 1 shortlist");
    expect(listed.views[0].params).toEqual({
      status: "pending",
      sort: "title",
      dir: "asc",
    });
    expect(listed.summary).toContain("1 saved view on Proposals");
    expect(listed.summary).toContain("None of them opens by default");

    const renamed = await owner.mutation(api.savedViews.rename, {
      eventSlug,
      viewId: created.viewId,
      name: "Wave 2",
    });
    expect(renamed.message).toBe("“Wave 1 shortlist” is now called “Wave 2”.");

    const repointed = await owner.mutation(api.savedViews.updateParams, {
      eventSlug,
      viewId: created.viewId,
      params: { status: "withdrawn" },
    });
    expect(repointed.message).toContain("“Wave 2” now opens what you are looking at");

    const afterUpdate = await owner.query(api.savedViews.list, {
      eventSlug,
      module: "proposals",
    });
    expect(afterUpdate.views[0].params).toEqual({ status: "withdrawn" });

    const deleted = await owner.mutation(api.savedViews.remove, {
      eventSlug,
      viewId: created.viewId,
    });
    expect(deleted.message).toContain("Deleted “Wave 2”");
    const gone = await owner.query(api.savedViews.list, {
      eventSlug,
      module: "proposals",
    });
    expect(gone.views).toEqual([]);
  });

  test("a view with no narrowing says it opens the table in full", async () => {
    const { t, owner, eventSlug } = await organizerOnEvent("bea");
    const created = await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "sessions",
      name: "Everything",
      params: {},
    });
    expect(created.message).toContain("opens Sessions in full");
    expect(t).toBeDefined();
  });

  test("two views cannot share a name on the same module", async () => {
    const { owner, eventSlug } = await organizerOnEvent("cal");
    await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "speakers",
      name: "Chasing",
      params: { state: "awaiting" },
    });
    await expectRejectedWith(
      owner.mutation(api.savedViews.create, {
        eventSlug,
        module: "speakers",
        name: "chasing",
        params: {},
      }),
      "name_taken",
    );
    // The same name on another module is a different table's view.
    await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "sessions",
      name: "Chasing",
      params: {},
    });
  });

  test("a blank name is refused", async () => {
    const { owner, eventSlug } = await organizerOnEvent("dev");
    await expectRejectedWith(
      owner.mutation(api.savedViews.create, {
        eventSlug,
        module: "tasks",
        name: "   ",
        params: {},
      }),
      "invalid_name",
    );
  });
});

describe("savedViews params validation", () => {
  test("a param the destination route would drop is refused, and named", async () => {
    const { owner, eventSlug } = await organizerOnEvent("eve");
    let message = "";
    try {
      await owner.mutation(api.savedViews.create, {
        eventSlug,
        module: "proposals",
        name: "Bad",
        params: { status: "pending", wormholes: "yes" },
      });
    } catch (error) {
      message = String((error as { data?: { message?: string } }).data?.message);
    }
    expect(message).toContain("“wormholes”");
    expect(message).toContain("would not open the table you are looking at");
  });

  test("a known param with an unknown VALUE is refused too", async () => {
    const { owner, eventSlug } = await organizerOnEvent("fay");
    await expectRejectedWith(
      owner.mutation(api.savedViews.create, {
        eventSlug,
        module: "proposals",
        name: "Bad value",
        params: { status: "notAStatus" },
      }),
      "invalid_params",
    );
    await expectRejectedWith(
      owner.mutation(api.savedViews.create, {
        eventSlug,
        module: "sessions",
        name: "Bad value",
        params: { content: "nope" },
      }),
      "invalid_params",
    );
  });

  test("an unknown module is refused on read and on write", async () => {
    const { owner, eventSlug } = await organizerOnEvent("gus");
    await expectRejectedWith(
      owner.query(api.savedViews.list, { eventSlug, module: "wormholes" }),
      "unknown_module",
    );
    await expectRejectedWith(
      owner.mutation(api.savedViews.create, {
        eventSlug,
        module: "wormholes",
        name: "Nope",
        params: {},
      }),
      "unknown_module",
    );
  });

  test("re-pointing an existing view validates the new params", async () => {
    const { owner, eventSlug } = await organizerOnEvent("hal");
    const created = await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "tasks",
      name: "Chase list",
      params: { tab: "instances", status: "outstanding" },
    });
    await expectRejectedWith(
      owner.mutation(api.savedViews.updateParams, {
        eventSlug,
        viewId: created.viewId,
        params: { tab: "instances", status: "notAStatus" },
      }),
      "invalid_params",
    );
  });
});

describe("savedViews default", () => {
  test("one default at a time, and turning it off leaves the view saved", async () => {
    const { owner, eventSlug } = await organizerOnEvent("ivy");
    const first = await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "proposals",
      name: "Inbox first",
      params: { status: "pending" },
    });
    const second = await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "proposals",
      name: "Queues first",
      params: { status: "acceptQueue,declineQueue" },
    });

    const set = await owner.mutation(api.savedViews.setDefault, {
      eventSlug,
      viewId: first.viewId,
      isDefault: true,
    });
    expect(set.message).toContain("Proposals now opens on “Inbox first”");
    let listed = await owner.query(api.savedViews.list, {
      eventSlug,
      module: "proposals",
    });
    expect(listed.defaultViewId).toBe(first.viewId);
    expect(listed.summary).toContain("“Inbox first” opens by default");

    await owner.mutation(api.savedViews.setDefault, {
      eventSlug,
      viewId: second.viewId,
      isDefault: true,
    });
    listed = await owner.query(api.savedViews.list, {
      eventSlug,
      module: "proposals",
    });
    expect(listed.defaultViewId).toBe(second.viewId);
    expect(listed.views.filter((view) => view.isDefault)).toHaveLength(1);

    const cleared = await owner.mutation(api.savedViews.setDefault, {
      eventSlug,
      viewId: second.viewId,
      isDefault: false,
    });
    expect(cleared.message).toContain("Proposals now opens unfiltered for you");
    listed = await owner.query(api.savedViews.list, {
      eventSlug,
      module: "proposals",
    });
    expect(listed.defaultViewId).toBeNull();
    expect(listed.views).toHaveLength(2);
  });

  test("a default is per module — setting one on Proposals leaves Sessions alone", async () => {
    const { owner, eventSlug } = await organizerOnEvent("jo");
    const proposals = await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "proposals",
      name: "Inbox",
      params: { status: "pending" },
    });
    const sessions = await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "sessions",
      name: "Drafts",
      params: { content: "draft" },
    });
    await owner.mutation(api.savedViews.setDefault, {
      eventSlug,
      viewId: proposals.viewId,
      isDefault: true,
    });
    await owner.mutation(api.savedViews.setDefault, {
      eventSlug,
      viewId: sessions.viewId,
      isDefault: true,
    });
    const sessionList = await owner.query(api.savedViews.list, {
      eventSlug,
      module: "sessions",
    });
    expect(sessionList.defaultViewId).toBe(sessions.viewId);
    const proposalList = await owner.query(api.savedViews.list, {
      eventSlug,
      module: "proposals",
    });
    expect(proposalList.defaultViewId).toBe(proposals.viewId);
  });
});

describe("NEGATIVE: savedViews authz", () => {
  test("NEGATIVE: another organizer of the same event never sees my views", async () => {
    const { t, owner, eventSlug } = await organizerOnEvent("kim");
    const mine = await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "proposals",
      name: "Mine",
      params: { status: "pending" },
    });

    const colleague = await signIn(t, "lee");
    await grantEventRole(t, eventSlug, "lee", "organizer");

    const theirs = await colleague.query(api.savedViews.list, {
      eventSlug,
      module: "proposals",
    });
    expect(theirs.views).toEqual([]);

    await expectRejectedWith(
      colleague.mutation(api.savedViews.rename, {
        eventSlug,
        viewId: mine.viewId,
        name: "Stolen",
      }),
      "not_found",
    );
    await expectRejectedWith(
      colleague.mutation(api.savedViews.remove, { eventSlug, viewId: mine.viewId }),
      "not_found",
    );
    await expectRejectedWith(
      colleague.mutation(api.savedViews.setDefault, {
        eventSlug,
        viewId: mine.viewId,
        isDefault: true,
      }),
      "not_found",
    );
    await expectRejectedWith(
      colleague.mutation(api.savedViews.updateParams, {
        eventSlug,
        viewId: mine.viewId,
        params: {},
      }),
      "not_found",
    );
  });

  test("NEGATIVE: a view cannot be reached through another event of the same org", async () => {
    const t = setupTest();
    const owner = await signIn(t, "mia");
    const orgSlug = await createOrg(owner, "mia org");
    const one = await createEvent(owner, orgSlug, "First conf");
    const two = await createEvent(owner, orgSlug, "Second conf");
    const view = await owner.mutation(api.savedViews.create, {
      eventSlug: one,
      module: "proposals",
      name: "First only",
      params: { status: "pending" },
    });
    const otherEvent = await owner.query(api.savedViews.list, {
      eventSlug: two,
      module: "proposals",
    });
    expect(otherEvent.views).toEqual([]);
    await expectRejectedWith(
      owner.mutation(api.savedViews.rename, {
        eventSlug: two,
        viewId: view.viewId,
        name: "Reached",
      }),
      "not_found",
    );
  });

  test("NEGATIVE: another organization is refused before anything is read", async () => {
    const t = setupTest();
    const owner = await signIn(t, "ned");
    const orgSlug = await createOrg(owner, "ned org");
    const eventSlug = await createEvent(owner, orgSlug, "Ned conf");
    const view = await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "proposals",
      name: "Ned's",
      params: {},
    });

    const stranger = await signIn(t, "oz");
    await createOrg(stranger, "oz org");
    await expectRejectedWith(
      stranger.query(api.savedViews.list, { eventSlug, module: "proposals" }),
      "forbidden",
    );
    await expectRejectedWith(
      stranger.mutation(api.savedViews.create, {
        eventSlug,
        module: "proposals",
        name: "Intruder",
        params: {},
      }),
      "forbidden",
    );
    await expectRejectedWith(
      stranger.mutation(api.savedViews.remove, { eventSlug, viewId: view.viewId }),
      "forbidden",
    );
  });

  test("a reviewer can save views of Reviews, the one module they work in", async () => {
    const { t, eventSlug } = await organizerOnEvent("pat");
    const reviewer = await signIn(t, "quin");
    await grantEventRole(t, eventSlug, "quin", "reviewer");

    const saved = await reviewer.mutation(api.savedViews.create, {
      eventSlug,
      module: "reviews",
      name: "My queue",
      params: {},
    });
    expect(saved.message).toContain("Saved “My queue” on Reviews");
    const listed = await reviewer.query(api.savedViews.list, {
      eventSlug,
      module: "reviews",
    });
    expect(listed.views).toHaveLength(1);
    await reviewer.mutation(api.savedViews.setDefault, {
      eventSlug,
      viewId: saved.viewId,
      isDefault: true,
    });
  });

  test("NEGATIVE: a reviewer cannot store or retrieve organizer-module params", async () => {
    const { t, owner, eventSlug } = await organizerOnEvent("rae");
    const organizerView = await owner.mutation(api.savedViews.create, {
      eventSlug,
      module: "proposals",
      name: "Organizer queue",
      params: { status: "acceptQueue,declineQueue" },
    });

    const reviewer = await signIn(t, "sam");
    await grantEventRole(t, eventSlug, "sam", "reviewer");

    // WRITE: the organizer-only vocabulary cannot be parked in a preference.
    for (const module of ["proposals", "sessions", "speakers", "tasks", "agenda"]) {
      await expectRejectedWith(
        reviewer.mutation(api.savedViews.create, {
          eventSlug,
          module,
          name: `Sneaky ${module}`,
          params: {},
        }),
        "forbidden",
      );
      // READ: and the list is refused, not merely empty.
      await expectRejectedWith(
        reviewer.query(api.savedViews.list, { eventSlug, module }),
        "forbidden",
      );
    }

    // And an organizer's own row is not reachable by id either.
    await expectRejectedWith(
      reviewer.mutation(api.savedViews.setDefault, {
        eventSlug,
        viewId: organizerView.viewId,
        isDefault: true,
      }),
      "not_found",
    );
  });
});
