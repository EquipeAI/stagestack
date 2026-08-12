import { describe, expect, test } from "vitest";
import {
  outcomeLines,
  planBulk,
  planLines,
  RELEASABLE_STATUSES,
  STAGEABLE_STATUSES,
  summarizeBulk,
} from "./bulkDecisions";

// W5: the bulk bar states its arithmetic before and after. These are the
// sentences it states, and the eligibility rule `convex/model/sessions.ts`
// enforces — one module, so the two can never drift.

describe("planBulk", () => {
  const selection = [
    "pending",
    "pending",
    "acceptQueue",
    "draft",
    "accepted",
    "withdrawn",
  ] as const;

  test("staging counts eligible, already-there, and every exclusion by reason", () => {
    const plan = planBulk([...selection], { kind: "stage", to: "acceptQueue" });
    expect(plan.selected).toBe(6);
    expect(plan.eligible).toBe(3);
    expect(plan.unchanged).toBe(1);
    expect(plan.willChange).toBe(2);
    expect(plan.excluded).toEqual([
      { count: 1, reason: "still a draft — never submitted" },
      {
        count: 1,
        reason: "already released — correct it individually instead",
      },
      { count: 1, reason: "withdrawn" },
    ]);
  });

  test("release is eligible only for staged decisions, split by queue", () => {
    const plan = planBulk(
      ["acceptQueue", "acceptQueue", "declineQueue", "pending"],
      { kind: "release" },
    );
    expect(plan.eligible).toBe(3);
    expect(plan.acceptQueue).toBe(2);
    expect(plan.declineQueue).toBe(1);
    expect(plan.excluded).toEqual([
      { count: 1, reason: "not staged for a decision yet" },
    ]);
  });

  test("the eligibility sets are the ones the mutations enforce", () => {
    expect([...STAGEABLE_STATUSES].sort()).toEqual([
      "acceptQueue",
      "declineQueue",
      "pending",
    ]);
    expect([...RELEASABLE_STATUSES].sort()).toEqual([
      "acceptQueue",
      "declineQueue",
    ]);
  });

  test("the before-statement names the consequence of a release, per queue", () => {
    const lines = planLines(
      planBulk(["acceptQueue", "declineQueue", "draft"], { kind: "release" }),
      { kind: "release" },
    );
    expect(lines[0]).toBe("3 proposals selected · 2 eligible.");
    expect(lines[1]).toContain("1 in the accept queue");
    expect(lines[2]).toContain("1 in the decline queue");
    expect(lines[3]).toBe("1 proposal is still a draft — never submitted — left alone.");
  });

  test("a staging statement says what moves and what is already there", () => {
    const lines = planLines(
      planBulk(["pending", "acceptQueue"], { kind: "stage", to: "acceptQueue" }),
      { kind: "stage", to: "acceptQueue" },
    );
    expect(lines).toEqual([
      "2 proposals selected · 2 eligible.",
      "1 proposal moves to the accept queue.",
      "1 already there — nothing changes for them.",
    ]);
  });
});

describe("summarizeBulk", () => {
  test("counts the mutation's own per-id results and explains each failure", () => {
    const outcome = summarizeBulk([
      { ok: true },
      { ok: true },
      { ok: false, error: "invalid_status" },
      { ok: false, error: "not_found" },
      { ok: false, error: "not_found" },
    ]);
    expect(outcome).toEqual({
      requested: 5,
      succeeded: 2,
      failed: 3,
      byError: [
        {
          count: 1,
          reason: "moved out of an eligible state before the action ran",
        },
        { count: 2, reason: "no longer exist on this event" },
      ],
    });
    expect(outcomeLines(outcome)).toEqual([
      "2 proposals changed of 5 attempted.",
      "1 proposal moved out of an eligible state before the action ran.",
      "2 proposals no longer exist on this event.",
    ]);
  });

  test("an unknown error code still reports a count rather than vanishing", () => {
    const outcome = summarizeBulk([{ ok: false, error: "who_knows" }]);
    expect(outcome.byError).toEqual([
      { count: 1, reason: "were refused by the server" },
    ]);
  });
});
