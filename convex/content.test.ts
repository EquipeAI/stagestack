/// <reference types="vite/client" />
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
  type TestT,
} from "./test.helpers";

// W5: session content editing with revision history + restore (CNT-09/11).

async function seedSession(t: TestT) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
  const sessionId = await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
      .unique();
    if (event === null) throw new Error("no event");
    return await ctx.db.insert("sessions", {
      eventId: event._id,
      title: "Original title",
      description: "Original abstract.",
      source: "direct",
      status: "planned",
    });
  });
  return { alice, eventSlug, sessionId };
}

describe("sessions content history (W5)", () => {
  test("edits record attributed revisions and restore brings the older content back", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedSession(t);
    await t.run(async (ctx) => {
      const organizer = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "alice@example.com"))
        .unique();
      if (organizer === null) throw new Error("missing organizer");
      await ctx.db.patch("users", organizer._id, { name: undefined });
    });

    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      title: "UPDATED: Original title",
      description: "Original abstract. Now with a live demo.",
    });
    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      description: "Original abstract. Now with a live demo. Bring a laptop.",
    });

    const beforeProfile = await alice.query(api.sessions.listRevisions, {
      eventSlug,
      sessionId,
    });
    expect(beforeProfile[0].editorName).toBe("Event team member");

    // Revisions retain the stable editor user id, so completing a profile
    // relabels existing history without rewriting any revision snapshots.
    await alice.mutation(api.users.setDisplayName, {
      displayName: "Jordan Alvarez",
    });
    const revisions = await alice.query(api.sessions.listRevisions, {
      eventSlug,
      sessionId,
    });
    expect(revisions).toHaveLength(2);
    expect(revisions[0].editorName).toBe("Jordan Alvarez");
    expect(revisions[0].editorEmail).toBe("alice@example.com");
    expect(revisions[0].editedAt).toBeGreaterThan(0);
    // Newest first: the top row's `before` is the state after edit #1.
    expect(revisions[0].before.description).toBe(
      "Original abstract. Now with a live demo.",
    );

    // Restoring the newest revision's `before` drops the laptop sentence but
    // keeps the live-demo one (the exact CNT-S3 step 9 check).
    await alice.mutation(api.sessions.restoreRevision, {
      eventSlug,
      revisionId: revisions[0].revisionId,
    });
    const session = await t.run(async (ctx) =>
      ctx.db.get("sessions", sessionId as Id<"sessions">),
    );
    expect(session?.title).toBe("UPDATED: Original title");
    expect(session?.description).toBe(
      "Original abstract. Now with a live demo.",
    );
    // The restore itself is a third revision — history is never destroyed.
    expect(
      await alice.query(api.sessions.listRevisions, { eventSlug, sessionId }),
    ).toHaveLength(3);
  });

  test("NEGATIVE: a non-member cannot edit content or read history", async () => {
    const t = setupTest();
    const { eventSlug, sessionId } = await seedSession(t);
    const mallory = await signIn(t, "mallory");
    await expectRejectedWith(
      mallory.mutation(api.sessions.updateContent, {
        eventSlug,
        sessionId,
        title: "hijacked",
      }),
      "forbidden",
    );
    await expectRejectedWith(
      mallory.query(api.sessions.listRevisions, { eventSlug, sessionId }),
      "forbidden",
    );
  });
});

// ── W3: snapshots, not inverse edits ─────────────────────────────────────

describe("session content snapshots (W3)", () => {
  test("a history past the cap reports truncated instead of posing as complete", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedSession(t);
    // 201 edits -> 201 revisions, one past the 200-row projection cap.
    for (let i = 0; i < 201; i += 1) {
      await alice.mutation(api.sessions.updateContent, {
        eventSlug,
        sessionId,
        title: `Title ${i}`,
      });
    }
    const result = await alice.query(api.sessions.listSnapshots, {
      eventSlug,
      sessionId,
    });
    expect(result.truncated).toBe(true);
    // Current + the newest 200 revisions, newest first.
    expect(result.entries).toHaveLength(201);
    expect(result.entries[0].label).toBe("Current");
    expect(result.entries[1].content.title).toBe("Title 199");

  });

  test("the projection is Current first, then one labelled snapshot per edit, newest first", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedSession(t);
    await alice.mutation(api.users.setDisplayName, {
      displayName: "Jordan Alvarez",
    });
    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      title: "Second title",
    });
    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      title: "Third title",
    });

    const snapshots = (await alice.query(api.sessions.listSnapshots, {
      eventSlug,
      sessionId,
    })).entries;
    expect(snapshots).toHaveLength(3);

    const [current, newer, older] = snapshots;
    expect(current.label).toBe("Current");
    expect(current.origin).toBe("current");
    expect(current.revisionId).toBeNull();
    expect(current.editedAt).toBeNull();
    // The Current entry is the LIVE content, not a revision snapshot.
    expect(current.content.title).toBe("Third title");
    // Nothing on the Current row can be restored onto itself.
    expect(current.editorName).toBeNull();

    // Newest revision first, and its snapshot is the state that edit replaced.
    expect(newer.content.title).toBe("Second title");
    expect(older.content.title).toBe("Original title");
    expect(newer.editedAt).not.toBeNull();
    expect(older.editedAt).not.toBeNull();
    expect(newer.editedAt ?? 0).toBeGreaterThanOrEqual(older.editedAt ?? 0);

    // The label is composed server-side, in EVENT time (America/Los_Angeles in
    // the harness), so no route has to re-word or re-zone it.
    expect(newer.label).toMatch(/^Before edit on \d{1,2} \w{3} at \d{2}:\d{2}/);
    expect(newer.origin).toBe("edit");
    expect(newer.originLabel).toBeNull();
    expect(newer.editorName).toBe("Jordan Alvarez");
    expect(newer.editorEmail).toBe("alice@example.com");

    // Content fields ONLY — a snapshot must never imply schedule/track/tags
    // are versioned.
    // (an unset optional field is simply absent over the wire)
    for (const snapshot of snapshots) {
      expect(
        Object.keys(snapshot.content).every((key) =>
          ["title", "description", "format"].includes(key),
        ),
      ).toBe(true);
    }
    expect(newer.content.title).toBeDefined();
  });

  test("a restore is marked as one grouped event, not as an anonymous edit", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedSession(t);
    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      title: "Second title",
    });
    const [, target] = (await alice.query(api.sessions.listSnapshots, {
      eventSlug,
      sessionId,
    })).entries;
    if (target.revisionId === null) throw new Error("expected a revision");

    const result = await alice.mutation(api.sessions.restoreRevision, {
      eventSlug,
      revisionId: target.revisionId,
    });
    expect(result.message).toContain("Restored the snapshot from");
    expect(result.undoRevisionId).not.toBeNull();

    const after = (await alice.query(api.sessions.listSnapshots, {
      eventSlug,
      sessionId,
    })).entries;
    const restoreEntry = after[1];
    expect(restoreEntry.origin).toBe("restore");
    expect(restoreEntry.label).toMatch(/^Before the restore on /);
    // The grouping sentence names the snapshot that was restored, in event
    // time — the same moment the target entry is labelled with.
    expect(restoreEntry.originLabel).toBe(
      `Restored the snapshot from ${target.label.replace("Before edit on ", "")}`,
    );
    // The older edit is still an ordinary edit; only the restore is grouped.
    expect(after[2].origin).toBe("edit");
    expect(after[2].originLabel).toBeNull();
  });

  test("restore → undo round-trips the content, and undo-of-undo is just another restore", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedSession(t);
    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      title: "Second title",
      description: "Second abstract.",
    });
    const snapshots = (await alice.query(api.sessions.listSnapshots, {
      eventSlug,
      sessionId,
    })).entries;
    const target = snapshots[1];
    if (target.revisionId === null) throw new Error("expected a revision");

    const restore = await alice.mutation(api.sessions.restoreRevision, {
      eventSlug,
      revisionId: target.revisionId,
    });
    const restored = await t.run(async (ctx) =>
      ctx.db.get("sessions", sessionId as Id<"sessions">),
    );
    expect(restored?.title).toBe("Original title");
    expect(restored?.description).toBe("Original abstract.");

    // Undo = restoring the revision the restore itself recorded.
    if (restore.undoRevisionId === null) throw new Error("expected an undo id");
    const undo = await alice.mutation(api.sessions.restoreRevision, {
      eventSlug,
      revisionId: restore.undoRevisionId,
    });
    const undone = await t.run(async (ctx) =>
      ctx.db.get("sessions", sessionId as Id<"sessions">),
    );
    expect(undone?.title).toBe("Second title");
    expect(undone?.description).toBe("Second abstract.");

    // Undo-of-undo needs no special state: it is one more restore.
    if (undo.undoRevisionId === null) throw new Error("expected an undo id");
    await alice.mutation(api.sessions.restoreRevision, {
      eventSlug,
      revisionId: undo.undoRevisionId,
    });
    const redone = await t.run(async (ctx) =>
      ctx.db.get("sessions", sessionId as Id<"sessions">),
    );
    expect(redone?.title).toBe("Original title");
    // Nothing was ever destroyed: three restores, three more revisions.
    const history = (await alice.query(api.sessions.listSnapshots, {
      eventSlug,
      sessionId,
    })).entries;
    expect(history.filter((s) => s.origin === "restore")).toHaveLength(3);
  });

  test("restoring a format label re-links it to the library, or clears the link when no row matches", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedSession(t);
    const formatId = await alice.mutation(api.library.add, {
      eventSlug,
      table: "formats",
      item: { name: "Lightning Talk (10 min)", defaultDurationMinutes: 10 },
    });
    // Edit 1: a linked library format.
    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      format: "Lightning Talk (10 min)",
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get("sessions", sessionId)))?.formatId,
    ).toBe(formatId);
    // Edit 2: free text that matches no library row.
    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      format: "Fireside chat",
    });
    const afterFreeText = await t.run(async (ctx) =>
      ctx.db.get("sessions", sessionId),
    );
    expect(afterFreeText?.format).toBe("Fireside chat");
    expect(afterFreeText?.formatId).toBeUndefined();

    // Restoring the snapshot that carried the library label re-resolves it
    // through updateContent → resolveFormatId, so the link comes back.
    const snapshots = (await alice.query(api.sessions.listSnapshots, {
      eventSlug,
      sessionId,
    })).entries;
    const linked = snapshots.find(
      (s) => s.content.format === "Lightning Talk (10 min)",
    );
    if (linked?.revisionId == null) throw new Error("expected linked snapshot");
    await alice.mutation(api.sessions.restoreRevision, {
      eventSlug,
      revisionId: linked.revisionId,
    });
    const relinked = await t.run(async (ctx) =>
      ctx.db.get("sessions", sessionId),
    );
    expect(relinked?.format).toBe("Lightning Talk (10 min)");
    expect(relinked?.formatId).toBe(formatId);

    // And restoring the ORIGINAL snapshot — which had no format at all —
    // clears both the label and the link, the sharp edge the diff preview
    // states out loud before the write.
    const withOriginal = (await alice.query(api.sessions.listSnapshots, {
      eventSlug,
      sessionId,
    })).entries;
    const empty = withOriginal.find((s) => s.content.format === undefined);
    if (empty?.revisionId == null) throw new Error("expected empty snapshot");
    await alice.mutation(api.sessions.restoreRevision, {
      eventSlug,
      revisionId: empty.revisionId,
    });
    const cleared = await t.run(async (ctx) =>
      ctx.db.get("sessions", sessionId),
    );
    expect(cleared?.format).toBeUndefined();
    expect(cleared?.formatId).toBeUndefined();
  });

  test("NEGATIVE: a non-member cannot read the snapshot list or restore a snapshot", async () => {
    const t = setupTest();
    const { alice, eventSlug, sessionId } = await seedSession(t);
    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      title: "Second title",
    });
    const snapshots = (await alice.query(api.sessions.listSnapshots, {
      eventSlug,
      sessionId,
    })).entries;
    const revisionId = snapshots[1].revisionId;
    if (revisionId === null) throw new Error("expected a revision");

    const mallory = await signIn(t, "mallory");
    await expectRejectedWith(
      mallory.query(api.sessions.listSnapshots, { eventSlug, sessionId }),
      "forbidden",
    );
    await expectRejectedWith(
      mallory.mutation(api.sessions.restoreRevision, { eventSlug, revisionId }),
      "forbidden",
    );
    // A reviewer is a member and still must not see or rewrite session content.
    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");
    await expectRejectedWith(
      rita.query(api.sessions.listSnapshots, { eventSlug, sessionId }),
      "forbidden",
    );
  });
});
