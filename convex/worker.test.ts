import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { expectRejectedWith, setupTest } from "./test.helpers";

// Mirrors `test.env.WORKER_SECRET` in vitest.config.ts.
const SECRET = "test-worker-secret";

describe("worker queue", () => {
  test("enqueueTest queues a ping job that shows up in pending", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});

    const pending = await t.query(api.worker.pending, { secret: SECRET });
    expect(pending).toHaveLength(1);
    expect(pending[0]._id).toBe(jobId);
    expect(pending[0].type).toBe("ping");
    expect(typeof pending[0].payload.sentAt).toBe("number");
  });

  test("enqueueTest rejects an unknown job type", async () => {
    const t = setupTest();
    await expectRejectedWith(
      t.mutation(internal.worker.enqueueTest, { type: "not-a-job" }),
      "unknown_job_type",
    );
    expect(await t.run(async (ctx) => ctx.db.query("jobs").collect())).toEqual(
      [],
    );
  });

  test("pending/claim/finish all require the shared secret", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {
      type: "hello-agent",
    });

    await expect(
      t.query(api.worker.pending, { secret: "wrong" }),
    ).rejects.toThrow("Unauthorized worker");
    await expect(
      t.mutation(api.worker.claim, { secret: "wrong", jobId }),
    ).rejects.toThrow("Unauthorized worker");
    await expect(
      t.mutation(api.worker.finish, { secret: "wrong", jobId }),
    ).rejects.toThrow("Unauthorized worker");

    // Nothing was mutated by the rejected calls.
    const job = await t.run(async (ctx) => ctx.db.query("jobs").first());
    expect(job?.status).toBe("queued");
  });

  test("claim is compare-and-set: the second claim of a job returns false", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});

    expect(await t.mutation(api.worker.claim, { secret: SECRET, jobId })).toBe(
      true,
    );
    expect(await t.mutation(api.worker.claim, { secret: SECRET, jobId })).toBe(
      false,
    );

    const claimed = await t.run(async (ctx) => ctx.db.query("jobs").first());
    expect(claimed?.status).toBe("claimed");
    expect(typeof claimed?.claimedAt).toBe("number");
    // A claimed job is no longer pending.
    expect(await t.query(api.worker.pending, { secret: SECRET })).toEqual([]);
  });

  test("finish records success and failure", async () => {
    const t = setupTest();
    const okId = await t.mutation(internal.worker.enqueueTest, {});
    const badId = await t.mutation(internal.worker.enqueueTest, {
      type: "hello-agent",
    });
    await t.mutation(api.worker.claim, { secret: SECRET, jobId: okId });
    await t.mutation(api.worker.claim, { secret: SECRET, jobId: badId });

    await t.mutation(api.worker.finish, {
      secret: SECRET,
      jobId: okId,
      result: { pong: true },
    });
    await t.mutation(api.worker.finish, {
      secret: SECRET,
      jobId: badId,
      error: "boom",
    });

    const jobs = await t.run(async (ctx) => ctx.db.query("jobs").collect());
    const ok = jobs.find((j) => j._id === okId);
    const bad = jobs.find((j) => j._id === badId);
    expect(ok?.status).toBe("done");
    expect(ok?.result).toEqual({ pong: true });
    expect(typeof ok?.finishedAt).toBe("number");
    expect(bad?.status).toBe("failed");
    expect(bad?.error).toBe("boom");
  });
});
