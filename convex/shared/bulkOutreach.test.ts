import { describe, expect, it } from "vitest";
import {
  OUTREACH_AUDIENCE_MESSAGE,
  OUTREACH_MAX,
  OUTREACH_MIN,
  canReceiveOutreach,
  outreachLines,
  planOutreach,
} from "./bulkOutreach";

// W12: the batch bar states eligibility BEFORE the send, and
// `model/contacts.ts` enforces it when the mutation runs. These pin the two to
// the same arithmetic — a bar that promises 5 emails from a mutation that
// sends 3 is worse than a bar that promises nothing.

const with_ = (email?: string) => ({ email });

describe("planOutreach", () => {
  it("counts an address on file as the whole eligibility rule", () => {
    const plan = planOutreach([
      with_("a@example.com"),
      with_(undefined),
      with_("c@example.com"),
    ]);
    expect(plan.selected).toBe(3);
    expect(plan.eligible).toBe(2);
    expect(plan.excluded).toEqual([
      { count: 1, reason: "has no email address on file — skipped" },
    ]);
  });

  it("groups the ineligible into one reason, pluralised", () => {
    const plan = planOutreach([with_("a@example.com"), with_(), with_()]);
    expect(plan.excluded).toEqual([
      { count: 2, reason: "have no email address on file — skipped" },
    ]);
  });

  it("reports no exclusions when everyone is reachable", () => {
    const plan = planOutreach([with_("a@example.com"), with_("b@example.com")]);
    expect(plan.excluded).toEqual([]);
    expect(plan.blocked).toBeNull();
  });

  it("blocks an audience the mutation would refuse, with the mutation's words", () => {
    expect(planOutreach([with_("a@example.com")]).blocked).toBe(
      OUTREACH_AUDIENCE_MESSAGE,
    );
    const tooMany = Array.from({ length: OUTREACH_MAX + 1 }, (_, i) =>
      with_(`p${i}@example.com`),
    );
    expect(planOutreach(tooMany).blocked).toBe(OUTREACH_AUDIENCE_MESSAGE);
    const exactly = Array.from({ length: OUTREACH_MIN }, (_, i) =>
      with_(`p${i}@example.com`),
    );
    expect(planOutreach(exactly).blocked).toBeNull();
  });

  it("an empty string is not an address", () => {
    expect(canReceiveOutreach({ email: "" })).toBe(false);
    expect(canReceiveOutreach({ email: "a@example.com" })).toBe(true);
  });

  it("states the plan in lines an organizer can read", () => {
    const lines = outreachLines(
      planOutreach([with_("a@example.com"), with_("b@example.com"), with_()]),
    );
    expect(lines[0]).toBe("3 contacts are selected · 2 will be emailed.");
    expect(lines[1]).toBe("1 has no email address on file — skipped.");
  });
});
