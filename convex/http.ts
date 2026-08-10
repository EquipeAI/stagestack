import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { resend } from "./emails";
import { programIcs } from "./model/embeds";

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
    const icsMatch = url.pathname.match(
      /^\/api\/events\/([^/]+)\/program\.ics\/?$/,
    );
    if (icsMatch !== null) {
      const slug = decodeURIComponent(icsMatch[1]);
      const program = await ctx.runQuery(api.publish.publicProgram, { slug });
      if (program === null) return json({ error: "not_published" }, 404);
      const body = programIcs(program, slug);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": `attachment; filename="${slug}.ics"`,
          "Cache-Control": "public, max-age=60",
          ...CORS_HEADERS,
        },
      });
    }
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

// Per-embed feeds (W3): the embed id is the public key; the payload is the
// published projection with that embed's filters applied.
// GET /api/embeds/<id> (JSON) · GET /api/embeds/<id>.ics (iCal)
http.route({
  pathPrefix: "/api/embeds/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/api\/embeds\/([^/]+?)(\.ics)?\/?$/);
    if (match === null) return json({ error: "not_found" }, 404);
    const embed = await ctx.runQuery(api.embeds.resolve, {
      embedId: decodeURIComponent(match[1]),
    });
    if (embed === null) return json({ error: "not_found" }, 404);
    if (match[2] === ".ics") {
      const body = programIcs(embed.program, embed.embedId);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": `attachment; filename="${embed.name}.ics"`,
          "Cache-Control": "public, max-age=60",
          ...CORS_HEADERS,
        },
      });
    }
    return json(embed, 200, "public, max-age=60");
  }),
});

http.route({
  pathPrefix: "/api/embeds/",
  method: "OPTIONS",
  handler: httpAction(
    async () => new Response(null, { status: 204, headers: CORS_HEADERS }),
  ),
});

http.route({
  pathPrefix: "/api/events/",
  method: "OPTIONS",
  handler: httpAction(
    async () => new Response(null, { status: 204, headers: CORS_HEADERS }),
  ),
});

export default http;
