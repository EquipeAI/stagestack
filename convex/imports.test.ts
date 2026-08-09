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

describe("imports", () => {
  test("start/confirm stamp eventId and listJobs resumes them newest-first", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme");
    const eventSlug = await createEvent(alice, orgSlug, "DevConf");

    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["title,speaker\nTalk A,Ada"])),
    );
    const planJobId = await alice.mutation(api.imports.start, {
      eventSlug,
      storageId,
      filename: "talks.csv",
    });

    let jobs = await alice.query(api.imports.listJobs, { eventSlug });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]._id).toBe(planJobId);
    expect(jobs[0].type).toBe("import-plan");
    expect(jobs[0].status).toBe("queued");
    expect(jobs[0].filename).toBe("talks.csv");

    // Worker finishes the plan; the organizer confirms it.
    await t.run(async (ctx) =>
      ctx.db.patch("jobs", planJobId, {
        status: "done",
        result: { summary: "1 record", records: [], skippedRows: [] },
      }),
    );
    const executeJobId = await alice.mutation(api.imports.confirm, {
      eventSlug,
      planJobId,
      records: [
        {
          id: "r0",
          record: {
            kind: "proposal" as const,
            title: "Talk A",
            speakers: [{ firstName: "Ada", lastName: "Lovelace" }],
          },
        },
      ],
    });

    jobs = await alice.query(api.imports.listJobs, { eventSlug });
    expect(jobs).toHaveLength(2);
    // Newest first: the page resumes from jobs[0].
    expect(jobs[0]._id).toBe(executeJobId);
    expect(jobs[0].type).toBe("import-execute");
    expect(jobs[0].planJobId).toBe(planJobId);
    expect(jobs[1]._id).toBe(planJobId);
  });

  test("listJobs is organizer-only and scoped to the event", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme");
    const eventSlug = await createEvent(alice, orgSlug, "DevConf");
    const otherSlug = await createEvent(alice, orgSlug, "OtherConf");

    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["a,b\n1,2"])),
    );
    await alice.mutation(api.imports.start, {
      eventSlug,
      storageId,
      filename: "talks.csv",
    });

    // Reviewers cannot list import jobs.
    const bob = await signIn(t, "bob");
    await grantEventRole(t, eventSlug, "bob", "reviewer");
    await expectRejectedWith(
      bob.query(api.imports.listJobs, { eventSlug }),
      "forbidden",
    );

    // Another event of the same org sees nothing.
    expect(await alice.query(api.imports.listJobs, { eventSlug: otherSlug })).toEqual(
      [],
    );
  });
});
