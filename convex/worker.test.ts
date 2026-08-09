import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  setupTest,
  signIn,
} from "./test.helpers";
import { WORKER_LEASE_TTL_MS, WORKER_MAX_ATTEMPTS } from "./worker";

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

  test("finish only flips claimed jobs", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});

    // Not yet claimed: finish is a no-op.
    await t.mutation(api.worker.finish, {
      secret: SECRET,
      jobId,
      result: { pong: true },
    });
    let job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("queued");
    expect(job?.result).toBeUndefined();

    await t.mutation(api.worker.claim, { secret: SECRET, jobId });
    await t.mutation(api.worker.finish, {
      secret: SECRET,
      jobId,
      result: { pong: true },
    });
    // A stale duplicate finish (old worker after a lease handover) is ignored.
    await t.mutation(api.worker.finish, {
      secret: SECRET,
      jobId,
      error: "late duplicate",
    });
    job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("done");
    expect(job?.result).toEqual({ pong: true });
    expect(job?.error).toBeUndefined();
  });

  test("lease sweep requeues expired claims and increments attempts", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});
    await t.mutation(api.worker.claim, { secret: SECRET, jobId });

    // Fresh claim: sweep leaves it alone.
    await t.mutation(internal.worker.sweepExpiredLeases, {});
    let job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("claimed");
    expect(job?.attempts).toBeUndefined();

    // Age the claim past the TTL.
    await t.run(async (ctx) =>
      ctx.db.patch("jobs", jobId, {
        claimedAt: Date.now() - WORKER_LEASE_TTL_MS - 1000,
      }),
    );
    await t.mutation(internal.worker.sweepExpiredLeases, {});
    job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);
    expect(job?.claimedAt).toBeUndefined();

    // The requeued job is claimable again (and back in pending).
    const pending = await t.query(api.worker.pending, { secret: SECRET });
    expect(pending.map((j) => j._id)).toContain(jobId);
    expect(await t.mutation(api.worker.claim, { secret: SECRET, jobId })).toBe(
      true,
    );
  });

  test("lease sweep fails a job once attempts reach the cap", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});

    for (let i = 1; i <= WORKER_MAX_ATTEMPTS; i++) {
      await t.mutation(api.worker.claim, { secret: SECRET, jobId });
      await t.run(async (ctx) =>
        ctx.db.patch("jobs", jobId, {
          claimedAt: Date.now() - WORKER_LEASE_TTL_MS - 1000,
        }),
      );
      await t.mutation(internal.worker.sweepExpiredLeases, {});
    }
    const job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(WORKER_MAX_ATTEMPTS);
    expect(job?.error).toContain("lease");
    expect(typeof job?.finishedAt).toBe("number");
    // A failed job cannot be claimed again.
    expect(await t.mutation(api.worker.claim, { secret: SECRET, jobId })).toBe(
      false,
    );
  });

  test("importExecuteBatch is idempotent per batchIndex", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme");
    const eventSlug = await createEvent(alice, orgSlug, "DevConf");
    const { eventId, userId } = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      const user = await ctx.db.query("users").first();
      return { eventId: event!._id, userId: user!._id };
    });
    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        type: "import-execute",
        payload: { eventId },
        status: "claimed",
        claimedAt: Date.now(),
        initiatedBy: userId,
      }),
    );

    const records = [
      {
        id: "r0",
        record: {
          kind: "proposal" as const,
          title: "Talk A",
          speakers: [{ firstName: "Ada", lastName: "Lovelace" }],
        },
      },
    ];
    const first = await t.mutation(api.worker.importExecuteBatch, {
      secret: SECRET,
      jobId,
      batchIndex: 0,
      records,
    });
    expect(first).toHaveLength(1);
    expect(first[0].ok).toBe(true);

    // Replaying the same batch (committed, response lost) returns the
    // recorded results and writes nothing new.
    const replay = await t.mutation(api.worker.importExecuteBatch, {
      secret: SECRET,
      jobId,
      batchIndex: 0,
      records,
    });
    expect(replay).toEqual(first);
    expect(
      await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).length),
    ).toBe(1);

    // A new batch index executes normally.
    const second = await t.mutation(api.worker.importExecuteBatch, {
      secret: SECRET,
      jobId,
      batchIndex: 1,
      records: [
        {
          id: "r1",
          record: {
            kind: "proposal" as const,
            title: "Talk B",
            speakers: [{ firstName: "Grace", lastName: "Hopper" }],
          },
        },
      ],
    });
    expect(second[0].ok).toBe(true);
    expect(
      await t.run(async (ctx) => (await ctx.db.query("proposals").collect()).length),
    ).toBe(2);
  });
});
