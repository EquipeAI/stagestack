/// <reference types="vite/client" />
// Suite-wide network guard.
//
// NOTE ON THE FILENAME: two dots in the basename means the Convex bundler skips
// this file as an entry point (same trick as test.helpers.ts), and it does not
// match the runner's `convex/**/*.test.ts` include, so it is setup only.
//
// Why this exists: `emails.sendWithIcs` posts the calendar invite to the raw
// Resend API with `fetch` (the component can't carry an attachment). Tests that
// drain scheduled functions therefore used to make a REAL request to
// api.resend.com, which 401s on the fake key — and the round trip is what made
// `publish.test.ts`'s production-path test flake at the 5s timeout (~1 run in 8
// locally, and it would fail every time in a sandboxed CI with no egress).
// A test suite must not depend on the internet, so global `fetch` answers the
// Resend endpoint locally and refuses everything else by name.
//
// Assigned directly rather than through `vi.stubGlobal` on purpose: a test that
// installs its own fetch spy (see comms.test.ts's calendar-attachment test)
// then restores THIS stub via `vi.unstubAllGlobals()` instead of the real
// `fetch`, so the guard survives its own tests.
import { beforeEach } from "vitest";

const RESEND_API = "https://api.resend.com/";

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(RESEND_API)) {
      // Shape the raw send path reads: `{ id }` on 2xx.
      return new Response(JSON.stringify({ id: "re_test_stub" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(
      `Blocked an outbound request from the test suite: ${url}. ` +
        `Stub it in the test (vi.stubGlobal("fetch", …)) rather than reaching the network.`,
    );
  }) as typeof fetch;
});
