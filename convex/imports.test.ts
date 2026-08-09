import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { IMPORT_LIMITS, type PlannedRecord } from "./shared/importPlan";
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

  test("NEGATIVE: a reviewer cannot read a done plan's result (speaker PII)", async () => {
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
    // A finished plan carries contact details verbatim — exactly the data
    // reviewers are never allowed to see.
    await t.run(async (ctx) =>
      ctx.db.patch("jobs", planJobId, {
        status: "done",
        result: {
          summary: "1 record",
          records: [
            {
              id: "r0",
              record: {
                kind: "proposal",
                title: "Talk A",
                speakers: [
                  {
                    firstName: "Ada",
                    lastName: "Lovelace",
                    email: "ada@example.com",
                    phone: "+1 555 0100",
                  },
                ],
              },
            },
          ],
          skippedRows: [],
        },
      }),
    );

    const bob = await signIn(t, "bob");
    await grantEventRole(t, eventSlug, "bob", "reviewer");
    await expectRejectedWith(
      bob.query(api.imports.getJob, { eventSlug, jobId: planJobId }),
      "forbidden",
    );

    // The organizer still gets the plan back.
    const job = await alice.query(api.imports.getJob, {
      eventSlug,
      jobId: planJobId,
    });
    expect(job?.status).toBe("done");
    expect(job?.result.records[0].record.speakers[0].email).toBe(
      "ada@example.com",
    );
  });

  test("start and generateUploadUrl are rate limited per user", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme");
    const eventSlug = await createEvent(alice, orgSlug, "DevConf");
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["a,b\n1,2"])),
    );

    // The plan bucket is 10/hour; the 11th queue attempt in the same hour is
    // refused (no fake clock needed — the period never elapses mid-test).
    for (let i = 0; i < 10; i++) {
      await alice.mutation(api.imports.start, {
        eventSlug,
        storageId,
        filename: `talks-${i}.csv`,
      });
    }
    await expectRejectedWith(
      alice.mutation(api.imports.start, {
        eventSlug,
        storageId,
        filename: "talks-11.csv",
      }),
      "rate_limited",
    );

    // Per-user, so a second organizer of the same event has their own bucket.
    const dave = await signIn(t, "dave");
    await grantEventRole(t, eventSlug, "dave", "organizer");
    await dave.mutation(api.imports.start, {
      eventSlug,
      storageId,
      filename: "daves.csv",
    });

    // Upload-URL minting has its own 20/hour bucket.
    for (let i = 0; i < 20; i++) {
      expect(
        await dave.mutation(api.imports.generateUploadUrl, { eventSlug }),
      ).toBeTypeOf("string");
    }
    await expectRejectedWith(
      dave.mutation(api.imports.generateUploadUrl, { eventSlug }),
      "rate_limited",
    );
  });
  // ── Payload coupling guard ─────────────────────────────────────────────
  //
  // CONSUMER: convex/worker.ts `importExecuteBatch`. It executes ONLY
  // `job.payload.records` — the approved subset stored here — sliced by
  // `batchIndex * IMPORT_LIMITS.executeBatch`. Nothing else pins that shape, so
  // moving/renaming the field in `imports.confirm` would leave execution
  // silently doing nothing (or throwing `invalid_payload`) while every other
  // test still passed. This test is that pin: keep them in step or change both.
  test("confirm stores the approved records at payload.records, in the shape the worker slices", async () => {
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

    // Three planned records; the organizer approves the first and third, so the
    // executed set must be the CONFIRMED subset, not the plan.
    const planned: PlannedRecord[] = ["Talk A", "Talk B", "Talk C"].map(
      (title, i) => ({
        id: `r${i}`,
        record: {
          kind: "proposal" as const,
          title,
          speakers: [{ firstName: "Ada", lastName: `Lovelace${i}` }],
        },
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.patch("jobs", planJobId, {
        status: "done",
        result: { summary: "3 records", records: planned, skippedRows: [] },
      }),
    );
    const approved = [planned[0], planned[2]];
    const executeJobId = await alice.mutation(api.imports.confirm, {
      eventSlug,
      planJobId,
      records: approved,
    });

    const job = await t.run(async (ctx) => ctx.db.get("jobs", executeJobId));
    expect(job?.type).toBe("import-execute");
    const payload = job?.payload as { eventId: string; records: unknown };
    // The worker reads exactly this path and requires an array.
    expect(Array.isArray(payload.records)).toBe(true);
    expect(payload.records).toEqual(approved);
    // …and `resolveJobCaller` needs the eventId alongside it.
    expect(payload.eventId).toBe(job?.eventId);

    // The worker's slice arithmetic, replayed here: batch 0 is the whole
    // approved set (2 < IMPORT_LIMITS.executeBatch) and batch 1 is empty, which
    // is what `importExecuteBatch` refuses as `invalid_batch`.
    const records = payload.records as PlannedRecord[];
    const batch = (index: number) =>
      records.slice(
        index * IMPORT_LIMITS.executeBatch,
        index * IMPORT_LIMITS.executeBatch + IMPORT_LIMITS.executeBatch,
      );
    expect(batch(0)).toEqual(approved);
    expect(batch(1)).toEqual([]);
  });
});
