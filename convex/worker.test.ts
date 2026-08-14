import { describe, expect, test } from "vitest";
import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  setupTest,
  signIn,
  type TestT,
} from "./test.helpers";
import {
  WORKER_HEARTBEAT_MS,
  WORKER_LEASE_TTL_MS,
  WORKER_MAX_ATTEMPTS,
} from "./worker";
import { IMPORT_LIMITS, type PlannedRecord } from "./shared/importPlan";

// Mirrors `test.env.WORKER_SECRET` in vitest.config.ts.
const SECRET = "test-worker-secret";

// A handle on the SAME shared bucket the worker endpoints consume (the
// `workerCalls` limit in convex/worker.ts — one bucket for every endpoint, so
// name and config must match here or this points at a different row). Used to
// spend the budget in one call instead of making 1200 real worker calls.
const workerBucket = new RateLimiter(components.rateLimiter, {
  workerCalls: {
    kind: "token bucket",
    rate: 600,
    period: MINUTE,
    capacity: 1200,
  },
});

const WORKER_BUCKET_CAPACITY = 1200;

/** Spend `count` of the shared worker budget in one go, instead of making that
 * many real worker calls. */
async function spendWorkerBudget(t: TestT, count: number): Promise<void> {
  await t.run(async (ctx) => {
    const spent = await workerBucket.limit(ctx, "workerCalls", { count });
    expect(spent.ok).toBe(true);
  });
}

/** Claim a job and return its fencing token, asserting the claim succeeded. */
async function claim(t: TestT, jobId: Id<"jobs">): Promise<string> {
  const token = await t.mutation(api.worker.claim, { secret: SECRET, jobId });
  expect(token).not.toBeNull();
  return token!;
}

/** Push a job's lease past the TTL by aging every sign of life on the row. */
async function expireLease(t: TestT, jobId: Id<"jobs">): Promise<void> {
  const stale = Date.now() - WORKER_LEASE_TTL_MS - 1000;
  await t.run(async (ctx) => {
    const job = await ctx.db.get("jobs", jobId);
    await ctx.db.patch("jobs", jobId, {
      claimedAt: stale,
      heartbeatAt: job?.heartbeatAt === undefined ? undefined : stale,
    });
  });
}

function proposalRecord(i: number): PlannedRecord {
  return {
    id: `r${i}`,
    record: {
      kind: "proposal",
      title: `Talk ${i}`,
      speakers: [{ firstName: "Ada", lastName: `Lovelace ${i}` }],
    },
  };
}

/** An organizer-confirmed import-execute job, already claimed by a worker. */
async function executeJob(
  t: TestT,
  records: PlannedRecord[],
): Promise<{ jobId: Id<"jobs">; claimToken: string }> {
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
      // `records` is what imports.confirm stores: the organizer's approved
      // subset. importExecuteBatch slices THIS, never the worker's arguments.
      payload: { eventId, records },
      status: "queued",
      initiatedBy: userId,
    }),
  );
  return { jobId, claimToken: await claim(t, jobId) };
}

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
      t.mutation(api.worker.finish, {
        secret: "wrong",
        jobId,
        claimToken: "whatever",
      }),
    ).rejects.toThrow("Unauthorized worker");
    await expect(
      t.mutation(api.worker.touch, {
        secret: "wrong",
        jobId,
        claimToken: "whatever",
      }),
    ).rejects.toThrow("Unauthorized worker");

    // Nothing was mutated by the rejected calls.
    const job = await t.run(async (ctx) => ctx.db.query("jobs").first());
    expect(job?.status).toBe("queued");
  });

  test("claim is compare-and-set and mints a fencing token", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});

    const token = await claim(t, jobId);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    // Second claim of the same job loses the race.
    expect(
      await t.mutation(api.worker.claim, { secret: SECRET, jobId }),
    ).toBeNull();

    const claimed = await t.run(async (ctx) => ctx.db.query("jobs").first());
    expect(claimed?.status).toBe("claimed");
    expect(typeof claimed?.claimedAt).toBe("number");
    expect(claimed?.claimToken).toBe(token);
    // A claimed job is no longer pending.
    expect(await t.query(api.worker.pending, { secret: SECRET })).toEqual([]);
  });

  test("finish records success and failure", async () => {
    const t = setupTest();
    const okId = await t.mutation(internal.worker.enqueueTest, {});
    const badId = await t.mutation(internal.worker.enqueueTest, {
      type: "hello-agent",
    });
    const okToken = await claim(t, okId);
    const badToken = await claim(t, badId);

    expect(
      await t.mutation(api.worker.finish, {
        secret: SECRET,
        jobId: okId,
        claimToken: okToken,
        result: { pong: true },
      }),
    ).toBe(true);
    expect(
      await t.mutation(api.worker.finish, {
        secret: SECRET,
        jobId: badId,
        claimToken: badToken,
        error: "boom",
      }),
    ).toBe(true);

    const jobs = await t.run(async (ctx) => ctx.db.query("jobs").collect());
    const ok = jobs.find((j) => j._id === okId);
    const bad = jobs.find((j) => j._id === badId);
    expect(ok?.status).toBe("done");
    expect(ok?.result).toEqual({ pong: true });
    expect(typeof ok?.finishedAt).toBe("number");
    expect(bad?.status).toBe("failed");
    expect(bad?.error).toBe("boom");
  });

  test("finish only flips a job the caller still holds the claim on", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});

    // Not yet claimed: finish is a refused no-op.
    expect(
      await t.mutation(api.worker.finish, {
        secret: SECRET,
        jobId,
        claimToken: "no-such-token",
        result: { pong: true },
      }),
    ).toBe(false);
    let job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("queued");
    expect(job?.result).toBeUndefined();

    const token = await claim(t, jobId);
    // Claimed, but a token from nowhere is still refused.
    expect(
      await t.mutation(api.worker.finish, {
        secret: SECRET,
        jobId,
        claimToken: "no-such-token",
        result: { hijacked: true },
      }),
    ).toBe(false);
    job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("claimed");
    expect(job?.result).toBeUndefined();

    await t.mutation(api.worker.finish, {
      secret: SECRET,
      jobId,
      claimToken: token,
      result: { pong: true },
    });
    // A stale duplicate finish (same worker, job already closed) is ignored.
    expect(
      await t.mutation(api.worker.finish, {
        secret: SECRET,
        jobId,
        claimToken: token,
        error: "late duplicate",
      }),
    ).toBe(false);
    job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("done");
    expect(job?.result).toEqual({ pong: true });
    expect(job?.error).toBeUndefined();
  });

  test("a stale worker cannot finish a job that was re-claimed", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});
    const staleToken = await claim(t, jobId);

    // Worker A hangs: its lease expires and the sweep requeues the job.
    await expireLease(t, jobId);
    await t.mutation(internal.worker.sweepExpiredLeases, {});
    // Worker B picks it up and is now the owner.
    const freshToken = await claim(t, jobId);
    expect(freshToken).not.toBe(staleToken);

    // Worker A wakes up and reports. The row is `claimed` again, so status
    // alone would have let this through; the fencing token refuses it.
    expect(
      await t.mutation(api.worker.finish, {
        secret: SECRET,
        jobId,
        claimToken: staleToken,
        result: { from: "stale worker A" },
      }),
    ).toBe(false);
    let job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("claimed");
    expect(job?.result).toBeUndefined();
    expect(job?.finishedAt).toBeUndefined();

    // Worker B's own finish lands.
    expect(
      await t.mutation(api.worker.finish, {
        secret: SECRET,
        jobId,
        claimToken: freshToken,
        result: { from: "worker B" },
      }),
    ).toBe(true);
    job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("done");
    expect(job?.result).toEqual({ from: "worker B" });
  });

  test("a heartbeat keeps a long-running job from being swept", async () => {
    // The renewal interval has to leave room for a couple of missed beats.
    expect(WORKER_HEARTBEAT_MS).toBeLessThan(WORKER_LEASE_TTL_MS / 2);
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});
    const token = await claim(t, jobId);

    // The job has been running longer than the TTL, but the worker is alive
    // and renewing — this is the import-plan case (~10 LLM exchanges).
    await t.run(async (ctx) =>
      ctx.db.patch("jobs", jobId, {
        claimedAt: Date.now() - WORKER_LEASE_TTL_MS - 1000,
      }),
    );
    expect(
      await t.mutation(api.worker.touch, {
        secret: SECRET,
        jobId,
        claimToken: token,
      }),
    ).toBe(true);
    await t.mutation(internal.worker.sweepExpiredLeases, {});
    let job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("claimed");
    expect(job?.attempts).toBeUndefined();
    expect(typeof job?.heartbeatAt).toBe("number");

    // Renewals stop (worker died): the lease expires from the last heartbeat.
    await expireLease(t, jobId);
    await t.mutation(internal.worker.sweepExpiredLeases, {});
    job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);
    expect(job?.claimToken).toBeUndefined();
    expect(job?.heartbeatAt).toBeUndefined();
  });

  test("touch is fenced: it cannot renew a lost lease or revive a failed job", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});
    const staleToken = await claim(t, jobId);
    await expireLease(t, jobId);
    await t.mutation(internal.worker.sweepExpiredLeases, {});
    const freshToken = await claim(t, jobId);

    // The evicted worker's renewal is refused and writes nothing.
    expect(
      await t.mutation(api.worker.touch, {
        secret: SECRET,
        jobId,
        claimToken: staleToken,
      }),
    ).toBe(false);
    let job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.heartbeatAt).toBeUndefined();

    // Once the job is finished, even the rightful holder cannot reopen it.
    await t.mutation(api.worker.finish, {
      secret: SECRET,
      jobId,
      claimToken: freshToken,
      error: "boom",
    });
    expect(
      await t.mutation(api.worker.touch, {
        secret: SECRET,
        jobId,
        claimToken: freshToken,
      }),
    ).toBe(false);
    job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("failed");
    expect(job?.heartbeatAt).toBeUndefined();
  });

  test("lease sweep requeues expired claims and increments attempts", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});
    await claim(t, jobId);

    // Fresh claim: sweep leaves it alone.
    await t.mutation(internal.worker.sweepExpiredLeases, {});
    let job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("claimed");
    expect(job?.attempts).toBeUndefined();

    // Age the claim past the TTL.
    await expireLease(t, jobId);
    await t.mutation(internal.worker.sweepExpiredLeases, {});
    job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);
    expect(job?.claimedAt).toBeUndefined();

    // The requeued job is claimable again (and back in pending).
    const pending = await t.query(api.worker.pending, { secret: SECRET });
    expect(pending.map((j) => j._id)).toContain(jobId);
    await claim(t, jobId);
  });

  test("lease sweep fails a job once attempts reach the cap", async () => {
    const t = setupTest();
    const jobId = await t.mutation(internal.worker.enqueueTest, {});

    for (let i = 1; i <= WORKER_MAX_ATTEMPTS; i++) {
      await claim(t, jobId);
      await expireLease(t, jobId);
      await t.mutation(internal.worker.sweepExpiredLeases, {});
    }
    const job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(WORKER_MAX_ATTEMPTS);
    expect(job?.error).toContain("lease");
    expect(typeof job?.finishedAt).toBe("number");
    // A failed job cannot be claimed again.
    expect(
      await t.mutation(api.worker.claim, { secret: SECRET, jobId }),
    ).toBeNull();
  });

  test("a malformed plan result fails the import-plan job", async () => {
    const t = setupTest();
    const badId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        type: "import-plan",
        payload: { filename: "sheet.csv" },
        status: "queued",
      }),
    );
    const badToken = await claim(t, badId);
    // `records` is not an array — assertPlanShape rejects it before any
    // organizer sees the plan.
    expect(
      await t.mutation(api.worker.finish, {
        secret: SECRET,
        jobId: badId,
        claimToken: badToken,
        result: { summary: "ok", records: "not-an-array", skippedRows: [] },
      }),
    ).toBe(true);
    const bad = await t.run(async (ctx) => ctx.db.get("jobs", badId));
    expect(bad?.status).toBe("failed");
    expect(bad?.error).toContain("unusable plan");
    expect(bad?.result).toBeUndefined();

    // A well-formed plan still finishes normally.
    const okId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        type: "import-plan",
        payload: { filename: "sheet.csv" },
        status: "queued",
      }),
    );
    const okToken = await claim(t, okId);
    const plan = { summary: "Planned 1 record.", records: [], skippedRows: [] };
    await t.mutation(api.worker.finish, {
      secret: SECRET,
      jobId: okId,
      claimToken: okToken,
      result: plan,
    });
    const ok = await t.run(async (ctx) => ctx.db.get("jobs", okId));
    expect(ok?.status).toBe("done");
    expect(ok?.result).toEqual(plan);
  });

  test("a plan whose RECORDS are malformed fails the job", async () => {
    // The regression this guards: `imports.confirm` used to take
    // `records: v.array(vPlannedRecord)`, so Convex validated every record on
    // the way in. Confirm now sends ids and re-derives the records from the
    // stored plan, which makes THIS the only per-record check on the path to
    // `executeRecord`. A top-level-only shape check would let a compromised
    // worker post arbitrary objects and have them executed with the
    // initiating organizer's authority.
    const bad = [
      { summary: "ok", records: [{ id: "r0" }], skippedRows: [] },
      {
        summary: "ok",
        records: [{ id: "r0", record: { kind: "contact", firstName: 7 } }],
        skippedRows: [],
      },
      {
        summary: "ok",
        records: [{ id: "r0", record: { kind: "wire-transfer", to: "x" } }],
        skippedRows: [],
      },
      {
        summary: "ok",
        records: [
          {
            id: "r0",
            record: { kind: "track", name: "AI" },
            // Unknown fields are rejected too: `imports.getJob` serves this
            // blob under `vImportPlan`, which would throw on the way out.
            escalate: true,
          },
        ],
        skippedRows: [],
      },
      {
        summary: "ok",
        // Duplicate ids would make one approved row stand for another in
        // `imports.confirm`, which selects by id.
        records: [
          { id: "r0", record: { kind: "tag", name: "a" } },
          { id: "r0", record: { kind: "tag", name: "b" } },
        ],
        skippedRows: [],
      },
    ];
    for (const result of bad) {
      const t = setupTest();
      const jobId = await t.run(async (ctx) =>
        ctx.db.insert("jobs", {
          type: "import-plan",
          payload: { filename: "sheet.csv" },
          status: "queued",
        }),
      );
      const claimToken = await claim(t, jobId);
      expect(
        await t.mutation(api.worker.finish, {
          secret: SECRET,
          jobId,
          claimToken,
          result,
        }),
      ).toBe(true);
      const job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
      expect(job?.status).toBe("failed");
      expect(job?.result).toBeUndefined();
    }
  });

  test("importExecuteBatch executes the approved payload, not caller records", async () => {
    const t = setupTest();
    const { jobId, claimToken } = await executeJob(t, [proposalRecord(0)]);

    // The worker cannot even name records any more: the argument is gone, so
    // a smuggled record is refused by argument validation.
    await expect(
      t.mutation(api.worker.importExecuteBatch, {
        secret: SECRET,
        jobId,
        claimToken,
        batchIndex: 0,
        records: [proposalRecord(99)],
      } as never),
    ).rejects.toThrow();

    const results = await t.mutation(api.worker.importExecuteBatch, {
      secret: SECRET,
      jobId,
      claimToken,
      batchIndex: 0,
    });
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    const titles = await t.run(async (ctx) =>
      (await ctx.db.query("proposals").collect()).map((p) => p.title),
    );
    expect(titles).toEqual(["Talk 0"]);
  });

  test("importExecuteBatch requires the current claim token", async () => {
    const t = setupTest();
    const { jobId, claimToken } = await executeJob(t, [proposalRecord(0)]);

    await expectRejectedWith(
      t.mutation(api.worker.importExecuteBatch, {
        secret: SECRET,
        jobId,
        claimToken: "not-the-token",
        batchIndex: 0,
      }),
      "invalid_status",
    );
    // A stale worker whose lease was swept and re-claimed is refused too.
    await expireLease(t, jobId);
    await t.mutation(internal.worker.sweepExpiredLeases, {});
    await claim(t, jobId);
    await expectRejectedWith(
      t.mutation(api.worker.importExecuteBatch, {
        secret: SECRET,
        jobId,
        claimToken,
        batchIndex: 0,
      }),
      "invalid_status",
    );
    // Neither refusal executed anything or recorded a batch.
    const job = await t.run(async (ctx) => ctx.db.get("jobs", jobId));
    expect(job?.completedBatches).toBeUndefined();
    expect(
      await t.run(
        async (ctx) => (await ctx.db.query("proposals").collect()).length,
      ),
    ).toBe(0);
  });

  test("importExecuteBatch slices the approved plan server-side by batchIndex", async () => {
    const t = setupTest();
    const size = IMPORT_LIMITS.executeBatch;
    const records = Array.from({ length: size + 2 }, (_, i) =>
      proposalRecord(i),
    );
    const { jobId, claimToken } = await executeJob(t, records);

    const first = await t.mutation(api.worker.importExecuteBatch, {
      secret: SECRET,
      jobId,
      claimToken,
      batchIndex: 0,
    });
    expect(first).toHaveLength(size);
    expect(first[0].id).toBe("r0");
    expect(first[size - 1].id).toBe(`r${size - 1}`);

    const second = await t.mutation(api.worker.importExecuteBatch, {
      secret: SECRET,
      jobId,
      claimToken,
      batchIndex: 1,
    });
    expect(second.map((r) => r.id)).toEqual([`r${size}`, `r${size + 1}`]);
    expect(
      await t.run(
        async (ctx) => (await ctx.db.query("proposals").collect()).length,
      ),
    ).toBe(size + 2);

    // Past the end of the approved plan there is nothing to execute.
    await expectRejectedWith(
      t.mutation(api.worker.importExecuteBatch, {
        secret: SECRET,
        jobId,
        claimToken,
        batchIndex: 2,
      }),
      "invalid_batch",
    );
  });

  test("importExecuteBatch is idempotent per batchIndex", async () => {
    const t = setupTest();
    const { jobId, claimToken } = await executeJob(t, [
      proposalRecord(0),
      proposalRecord(1),
    ]);

    const first = await t.mutation(api.worker.importExecuteBatch, {
      secret: SECRET,
      jobId,
      claimToken,
      batchIndex: 0,
    });
    expect(first).toHaveLength(2);
    expect(first.every((r) => r.ok)).toBe(true);

    // Replaying the same batch (committed, response lost) returns the
    // recorded results and writes nothing new.
    const replay = await t.mutation(api.worker.importExecuteBatch, {
      secret: SECRET,
      jobId,
      claimToken,
      batchIndex: 0,
    });
    expect(replay).toEqual(first);
    expect(
      await t.run(
        async (ctx) => (await ctx.db.query("proposals").collect()).length,
      ),
    ).toBe(2);
  });

  test("importContext reports truncation instead of a silent cap (F8)", async () => {
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
    const jobId = await t.run(async (ctx) => {
      const job = await ctx.db.get("jobs", planJobId);
      // The planner's done state is what makes importContext serve a context.
      return job!._id;
    });

    const context = (await t.mutation(api.worker.importContext, {
      secret: SECRET,
      jobId,
    })) as { truncated: { contacts: boolean; proposals: boolean } };
    // Small fixture: nothing is over any cap.
    expect(context.truncated).toEqual({
      contacts: false,
      proposals: false,
    });
  });

  test("importContext CONSUMES the shared worker budget, it doesn't just observe it (F3)", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme");
    const eventSlug = await createEvent(alice, orgSlug, "DevConf");
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["title,speaker\nTalk A,Ada"])),
    );
    const jobId = await alice.mutation(api.imports.start, {
      eventSlug,
      storageId,
      filename: "talks.csv",
    });

    // Normal use is unaffected: with budget left, the context is served — and
    // that call spends one token of the shared bucket.
    expect(
      await t.mutation(api.worker.importContext, { secret: SECRET, jobId }),
    ).toMatchObject({ filename: "talks.csv" });

    // Leave exactly one token. If `importContext` only CHECKED the bucket (the
    // F3 bug — a query can't consume), the two calls below would BOTH succeed:
    // no other worker call happens in between, so nothing else would ever move
    // the bucket. Draining the rest by hand keeps the test to a handful of
    // real calls instead of 1200.
    await spendWorkerBudget(t, WORKER_BUCKET_CAPACITY - 2);

    // The last token buys one more context...
    expect(
      await t.mutation(api.worker.importContext, { secret: SECRET, jobId }),
    ).toMatchObject({ filename: "talks.csv" });
    // ...and the next call is refused, which can only be true if the calls
    // above consumed. Same refusal shape as the sibling endpoints
    // (`rateLimited()`).
    await expectRejectedWith(
      t.mutation(api.worker.importContext, { secret: SECRET, jobId }),
      "rate_limited",
    );
    // One shared bucket: importContext's own spend refuses its siblings too.
    await expectRejectedWith(
      t.query(api.worker.pending, { secret: SECRET }),
      "rate_limited",
    );
  });
});
