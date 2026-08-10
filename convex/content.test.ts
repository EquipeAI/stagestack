/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
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

    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      title: "UPDATED: Original title",
      description: "Original abstract. Now with a live demo.",
    });
    await alice.mutation(api.sessions.updateContent, {
      eventSlug,
      sessionId,
      description:
        "Original abstract. Now with a live demo. Bring a laptop.",
    });

    const revisions = await alice.query(api.sessions.listRevisions, {
      eventSlug,
      sessionId,
    });
    expect(revisions).toHaveLength(2);
    expect(revisions[0].editorName).toBe("alice");
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
