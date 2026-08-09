import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { resend } from "./emails";

const http = httpRouter();

http.route({
  path: "/resend-webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    return await resend.handleResendEventWebhook(ctx, req);
  }),
});

// Public read API (M7): a direct projection of the same published program the
// public page serves — the last explicitly published version, never the
// organizer's working state (decision log #12/#14). Read-only; CORS-open so an
// external site's embed/script can fetch it. GET /api/events/<slug>/program
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status: number, cache?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...CORS_HEADERS,
  };
  if (cache !== undefined) headers["Cache-Control"] = cache;
  return new Response(JSON.stringify(body), { status, headers });
}

http.route({
  pathPrefix: "/api/events/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/api\/events\/([^/]+)\/program\/?$/);
    if (match === null) return json({ error: "not_found" }, 404);
    const program = await ctx.runQuery(api.publish.publicProgram, {
      slug: decodeURIComponent(match[1]),
    });
    if (program === null) return json({ error: "not_published" }, 404);
    // Short cache: the projection only changes on an explicit publish.
    return json(program, 200, "public, max-age=60");
  }),
});

http.route({
  pathPrefix: "/api/events/",
  method: "OPTIONS",
  handler: httpAction(
    async () => new Response(null, { status: 204, headers: CORS_HEADERS }),
  ),
});

export default http;
