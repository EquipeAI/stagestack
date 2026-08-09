/// <reference types="vite/client" />
// Shared harness for the convex-test suite.
//
// NOTE ON THE FILENAME: two dots in the basename means the Convex bundler skips
// this file as an entry point (see `bundler/index.ts`: "Skipping ... that
// contains multiple dots"), so importing `convex-test`/`vitest` here never
// reaches a real deployment. It is deliberately NOT named `*.test.ts` so vitest
// doesn't try to collect it as a suite.
import { convexTest } from "convex-test";
import { expect } from "vitest";
import rateLimiterComponent from "@convex-dev/rate-limiter/test";
import resendComponent from "@convex-dev/resend/test";
import schema from "./schema";
import { api } from "./_generated/api";

// convex-test needs the whole function module map; `.*s` picks up the
// `_generated` .js files it uses to locate the modules root.
export const modules = import.meta.glob("./**/*.*s");

const ISSUER = "https://test.clerk.example.com";

/**
 * A convexTest instance with both mounted components registered under the same
 * names used in `convex/convex.config.ts` (`resend`, `rateLimiter`).
 */
export function setupTest() {
  const t = convexTest(schema, modules);
  resendComponent.register(t, "resend");
  rateLimiterComponent.register(t, "rateLimiter");
  return t;
}

export type TestT = ReturnType<typeof setupTest>;
export type TestUserT = ReturnType<TestT["withIdentity"]>;

export function identityFor(key: string, overrides: Record<string, unknown> = {}) {
  return {
    tokenIdentifier: `${ISSUER}|${key}`,
    subject: key,
    issuer: ISSUER,
    email: `${key}@example.com`,
    name: key,
    ...overrides,
  };
}

/** Authenticated accessor whose `users` row has been provisioned. */
export async function signIn(
  t: TestT,
  key: string,
  overrides: Record<string, unknown> = {},
) {
  const as = t.withIdentity(identityFor(key, overrides));
  await as.mutation(api.users.ensure, {});
  return as;
}

/**
 * Assert a rejection carrying a specific ConvexError `code`. Falls back to
 * substring matching on the message for plain `Error`s.
 */
export async function expectRejectedWith(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  let thrown: unknown;
  let didThrow = false;
  try {
    await promise;
  } catch (error) {
    didThrow = true;
    thrown = error;
  }
  expect(didThrow, `expected rejection with code "${code}"`).toBe(true);
  const data = (thrown as { data?: unknown }).data;
  if (data !== undefined && data !== null && typeof data === "object") {
    expect((data as { code?: string }).code).toBe(code);
    return;
  }
  expect(String((thrown as Error).message ?? thrown)).toContain(code);
}

/** Create an org owned by `as` and return its slug. */
export async function createOrg(as: TestUserT, name: string): Promise<string> {
  const { slug } = await as.mutation(api.orgs.create, { name });
  return slug;
}

/** Create an event in `orgSlug` and return its slug. */
export async function createEvent(
  as: TestUserT,
  orgSlug: string,
  name: string,
  extra: { startsAt?: number; endsAt?: number; timezone?: string } = {},
): Promise<string> {
  const startsAt = extra.startsAt ?? Date.parse("2026-09-01T09:00:00Z");
  const { slug } = await as.mutation(api.events.create, {
    orgSlug,
    name,
    startsAt,
    endsAt: extra.endsAt ?? startsAt + 2 * 24 * 3600 * 1000,
    timezone: extra.timezone ?? "America/Los_Angeles",
  });
  return slug;
}

/** Directly grant an event-scoped role, bypassing the invite flow. */
export async function grantEventRole(
  t: TestT,
  eventSlug: string,
  userKey: string,
  role: "organizer" | "reviewer",
): Promise<void> {
  await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
      .unique();
    if (event === null) throw new Error(`no event ${eventSlug}`);
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", `${ISSUER}|${userKey}`),
      )
      .unique();
    if (user === null) throw new Error(`no user ${userKey}`);
    await ctx.db.insert("eventMembers", {
      eventId: event._id,
      orgId: event.orgId,
      userId: user._id,
      role,
    });
  });
}

export async function auditActions(t: TestT): Promise<string[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("auditLog").collect();
    return rows.map((r) => r.action);
  });
}
