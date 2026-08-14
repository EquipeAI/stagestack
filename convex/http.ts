import { httpRouter } from "convex/server";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { resend } from "./emails";
import { makeStageStackMcpServer } from "./lib/mcpServer";
import {
  MCP_GENERIC_REFUSAL,
  MCP_REFUSAL_MESSAGES,
  MCP_REFUSAL_STATUS,
} from "./model/apiKeys";
import { programIcs } from "./model/embeds";
import {
  GENERIC_UPLOAD_FAILURE,
  HEADSHOT_FAILURE_MESSAGES,
  HTTP_SAFE_FAILURE_CODES,
  HeadshotFailure,
  MAX_HEADSHOT_SOURCE_BYTES,
  asHeadshotFailureCode,
  headshotFailure,
  validateHeadshotBytes,
} from "./model/headshotImages";

const http = httpRouter();

const HEADSHOT_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function headshotJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...HEADSHOT_CORS_HEADERS,
    },
  });
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      headshotFailure("byte_size_mismatch");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────
// The one place an upload failure becomes a public sentence.
//
// INVARIANT: text from an ARBITRARY throw never reaches the client — a `sharp`
// failure quoting a temp path, a Convex system error naming a table, a
// stack-carrying bug all land on the generic sentence, because `error.message`
// on a plain Error is never read. Two kinds of text DO pass:
//
//   ConvexError `data.message` → passes through for any code. That text is
//     app-authored at a deliberate `throw new ConvexError({...})`, never
//     runtime-generated — but it is NOT allowlisted here, so a throw site
//     choosing its words is trusting this boundary. (Pre-C4 behavior, kept.)
//   HeadshotFailure whose code is in HTTP_SAFE_FAILURE_CODES → the registered
//     sentence, looked up from the registry (not taken from the error object).
//   everything else, including unknown and non-public codes → GENERIC
//
// Publishing a new registry sentence means adding its code to
// `HTTP_SAFE_FAILURE_CODES` in `model/headshotImages.ts` — a visible, reviewed
// edit — and can never happen by accident at a throw site.
// ─────────────────────────────────────────────────────────────────────────
function actionError(error: unknown): { status: number; message: string } {
  const record =
    error !== null && typeof error === "object"
      ? (error as { data?: unknown })
      : undefined;
  const data =
    record?.data !== null && typeof record?.data === "object"
      ? (record.data as { code?: unknown; message?: unknown })
      : undefined;
  const code = typeof data?.code === "string" ? data.code : undefined;
  if (code === "not_authenticated" || code === "user_not_provisioned") {
    return { status: 401, message: "Sign in to upload a headshot." };
  }
  const message =
    error instanceof HeadshotFailure &&
    HTTP_SAFE_FAILURE_CODES.has(error.code)
      ? HEADSHOT_FAILURE_MESSAGES[error.code]
      : typeof data?.message === "string"
        ? data.message
        : GENERIC_UPLOAD_FAILURE;
  if (code === "not_found") return { status: 404, message };
  return { status: 400, message };
}

/** Re-raise a boundary refusal by CODE. An unnamed refusal (or one whose code
 * this deploy does not know) stays unnamed, so it lands on the generic
 * sentence rather than carrying whatever string the callee happened to set. */
function raiseHeadshotFailure(code: unknown): never {
  const known = asHeadshotFailureCode(code);
  if (known !== undefined) throw new HeadshotFailure(known);
  throw new Error(GENERIC_UPLOAD_FAILURE);
}

// ─────────────────────────────────────────────────────────────────────────
// Hosted MCP server (D2). One `httpAction` behind POST/GET/DELETE at /mcp,
// with `createMcpHandler` constructed PER REQUEST so the server factory closes
// over this request's ActionCtx — the stateless model the 2026-07-28 spec
// expects. The SDK runs unmodified in the Convex isolate (Convex bundles
// isolate code `platform: "browser"`, so the SDK resolves its browser shims).
//
// Order matters and is the security contract:
//   1. Host/Origin validation (the SDK's own exports) — DNS-rebinding first,
//      before this endpoint admits it has an opinion about credentials;
//   2. bearer extraction — ONE function, `mcpBearerToken`, deliberately the
//      only place an inbound request becomes a credential. OAuth 2.1 (D5)
//      goes in front of exactly this line without touching a tool;
//   3. refuse JSON-RPC batch arrays (`isBatchBody`) — the one body shape that
//      would make "once per HTTP request" mean something other than "once per
//      action";
//   4. authenticate + spend the per-key budget, once per HTTP request;
//   5. hand the request to the SDK.
// Every tool body re-resolves the key itself (convex/mcp.ts): step 3 is a
// budget gate, never an authorization one.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Hostnames this deployment answers to, FAIL-CLOSED.
 *
 * `CONVEX_SITE_URL` is set by Convex on every real deployment, so the fallback
 * is unreachable in dev, preview and production alike. If it were ever missing
 * or unparseable, deriving the allowlist from the request's own Host header
 * would be a check that agrees with whatever it is handed — worse than no
 * check, because it looks like one. Fall back to loopback only: a local
 * harness still works, and anything reachable from the internet refuses.
 */
function mcpAllowedHostnames(): Array<string> {
  const configured = process.env.CONVEX_SITE_URL;
  if (configured !== undefined) {
    try {
      return [new URL(configured).hostname];
    } catch {
      // Fall through to loopback.
    }
  }
  return localhostAllowedHostnames();
}

/**
 * The only place an inbound HTTP request becomes a credential — the door D5's
 * OAuth work opens without disturbing anything behind it.
 */
function mcpBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header === null) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match === null ? null : match[1];
}

/**
 * JSON-RPC BATCHES ARE REFUSED HERE, before anything else looks at the body.
 *
 * The budget is spent once per HTTP REQUEST (step 3 below). A batched array is
 * the one shape where that stops being the same thing as once per action: the
 * SDK's legacy 2025 leg parses an array and dispatches EVERY element, so one
 * token could buy N tool calls — and with D3, N writes. Batching was removed
 * from MCP in 2025-06-18 and does not exist in 2026-07-28; the only revision
 * that ever had it is 2025-03-26, and no client we serve sends one.
 *
 * Refusing beats charging N tokens: per-element charging would fix the
 * accounting while keeping an obsolete, untested execution path alive on the
 * write surface, where "how many actions did this credential just take" is
 * exactly the question the endpoint has to be able to answer. And it beats
 * `legacy: 'reject'` on the handler, which is the only related knob the SDK
 * exposes: that removes ALL 2025 serving, including a single `initialize`,
 * breaking real 2025-era clients to close a hole that only array bodies open.
 *
 * The body is read from a CLONE, so the SDK still owns every other verdict on
 * it — 415 for the wrong media type, 406 for a bad Accept, its own parse
 * error. A body we cannot read or parse is not our business: pass it through
 * and let the SDK answer, rather than inventing a second error vocabulary.
 */
async function isBatchBody(request: Request): Promise<boolean> {
  if (request.method.toUpperCase() !== "POST") return false;
  try {
    return Array.isArray(JSON.parse(await request.clone().text()));
  } catch {
    return false;
  }
}

/** A JSON-RPC error response, which is what an MCP client can actually read.
 * `id: null` is correct for a failure that happened before the request body
 * was parsed — there is no id yet to echo. */
function mcpRpcError(code: string): Response {
  const status = MCP_REFUSAL_STATUS[code] ?? 400;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (status === 401) headers["WWW-Authenticate"] = `Bearer realm="stagestack"`;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        // -32001 is the reserved server-defined range; the meaningful part is
        // the sentence, which comes from the registry and never from a throw.
        code: status === 429 ? -32000 : -32001,
        message: MCP_REFUSAL_MESSAGES[code] ?? MCP_GENERIC_REFUSAL,
      },
    }),
    { status, headers },
  );
}

/** Map a thrown refusal to a REGISTERED code. An unrecognized throw becomes
 * the generic sentence — no `error.message` from an arbitrary failure ever
 * reaches an external agent. */
function mcpRefusalCode(error: unknown): string {
  const data =
    error !== null && typeof error === "object"
      ? (error as { data?: unknown }).data
      : undefined;
  const code =
    data !== null && typeof data === "object"
      ? (data as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && code in MCP_REFUSAL_MESSAGES
    ? code
    : "generic";
}

const mcpEndpoint = httpAction(async (ctx, request) => {
  const allowed = mcpAllowedHostnames();
  const rejected =
    hostHeaderValidationResponse(request, allowed) ??
    originValidationResponse(request, allowed);
  if (rejected !== undefined) return rejected;

  const presentedKey = mcpBearerToken(request);
  if (presentedKey === null) return mcpRpcError("api_key_missing");

  if (await isBatchBody(request)) return mcpRpcError("batch_unsupported");

  try {
    await ctx.runMutation(internal.mcp.authenticate, {
      presentedKey,
      now: Date.now(),
    });
  } catch (error) {
    return mcpRpcError(mcpRefusalCode(error));
  }

  const handler = createMcpHandler(() =>
    makeStageStackMcpServer(ctx, presentedKey),
  );
  return await handler.fetch(request);
});

for (const method of ["POST", "GET", "DELETE"] as const) {
  http.route({ path: "/mcp", method, handler: mcpEndpoint });
}

http.route({
  path: "/resend-webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    return await resend.handleResendEventWebhook(ctx, req);
  }),
});

// Authenticated, ticket-bound headshot ingestion. Unlike a generic Convex
// upload URL, this endpoint owns the entire byte-to-storage transition: the
// browser supplies a scoped ticket and bearer token but never a storage id and
// never receives one back.
http.route({
  pathPrefix: "/api/headshots/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if ((await ctx.auth.getUserIdentity()) === null) {
      return headshotJson({ error: "Sign in to upload a headshot." }, 401);
    }
    const match = new URL(request.url).pathname.match(
      /^\/api\/headshots\/([^/]+)\/?$/,
    );
    if (match === null) return headshotJson({ error: "Not found." }, 404);

    let uploadId: Id<"headshotUploads">;
    try {
      uploadId = decodeURIComponent(match[1]) as Id<"headshotUploads">;
    } catch {
      return headshotJson({ error: "Not found." }, 404);
    }
    const contentType = request.headers.get("Content-Type") ?? "";
    let claimed = false;
    let storageAttemptStarted = false;
    let sourceStorageId: Id<"_storage"> | undefined;
    try {
      const claim = await ctx.runMutation(internal.headshotUploads.claim, {
        uploadId,
        contentType,
      });
      if (
        !claim.claimed ||
        claim.expectedContentType === undefined ||
        claim.expectedSize === undefined
      ) {
        return headshotJson(
          { error: claim.message ?? "That upload ticket was already used." },
          400,
        );
      }
      claimed = true;
      const bytes = await readBoundedBody(
        request,
        Math.min(MAX_HEADSHOT_SOURCE_BYTES, claim.expectedSize) + 1,
      );
      const detectedType = validateHeadshotBytes(
        bytes,
        contentType,
        claim.expectedContentType,
        claim.expectedSize,
      );
      const blobBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const capacity = await ctx.runMutation(
        internal.headshotUploads.beginStorageAttempt,
        { uploadId },
      );
      if (!capacity.reserved) raiseHeadshotFailure(capacity.code);
      storageAttemptStarted = true;
      // Store the raw source only as a temporary private blob. Its fresh id is
      // immediately bound to the actor/ticket before the Node runtime receives
      // two small ids; no 1–4 MiB Convex value crosses a function boundary.
      sourceStorageId = await ctx.storage.store(
        new Blob([blobBuffer], { type: detectedType }),
      );
      const registration = await ctx.runMutation(
        internal.headshotUploads.recordSource,
        {
          uploadId,
          sourceStorageId,
          contentType: detectedType,
          size: bytes.byteLength,
        },
      );
      if (!registration.recorded) raiseHeadshotFailure(registration.code);
      const processed = await ctx.runAction(internal.headshotProcessing.process, {
        uploadId,
        sourceStorageId,
      });
      if (!processed.ok) raiseHeadshotFailure(processed.code);
      return headshotJson({ ok: true }, 200);
    } catch (error) {
      if (claimed) {
        try {
          await ctx.runMutation(internal.headshotUploads.fail, {
            uploadId,
          });
        } catch {
          // The durable sweeper is the fallback for a recorded source.
        }
        if (sourceStorageId !== undefined) {
          let tracked = false;
          try {
            tracked = await ctx.runMutation(
              internal.headshotUploads.cleanupSource,
              { uploadId, sourceStorageId },
            );
          } catch {
            // A recorded source remains visible to the indexed sweeper.
          }
          if (!tracked) {
            // recordSource can fail before the id becomes durable. Delete that
            // exact HTTP-created id directly so the gap cannot orphan bytes.
            const deleted = await ctx.storage
              .delete(sourceStorageId)
              .then(() => true)
              .catch(() => false);
            if (deleted) {
              await ctx.runMutation(
                internal.headshotUploads.releaseKnownClean,
                { uploadId },
              ).catch(() => false);
            } else {
              await ctx.runMutation(
                internal.headshotUploads.retainIndeterminate,
                { uploadId },
              ).catch(() => undefined);
            }
          }
        } else if (storageAttemptStarted) {
          // storage.store began but returned no id. The physical outcome is
          // unknowable, so retain the worst-case two-blob reservation.
          await ctx.runMutation(internal.headshotUploads.retainIndeterminate, {
            uploadId,
          }).catch(() => undefined);
        }
      }
      const failure = actionError(error);
      return headshotJson({ error: failure.message }, failure.status);
    }
  }),
});

http.route({
  pathPrefix: "/api/headshots/",
  method: "OPTIONS",
  handler: httpAction(
    async () =>
      new Response(null, { status: 204, headers: HEADSHOT_CORS_HEADERS }),
  ),
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

/** Header-safe `Content-Disposition` filename. `embed.name` is bounded and
 * control-character-free at write time (model/embeds.ts `assertEmbedName`),
 * but this sink strips quotes/backslashes too so a legacy row can never break
 * the response header or weaken the quoted-string. */
function attachmentFilename(name: string): string {
  const sanitized = name.replace(/["\\\x00-\x1f\x7f]/g, "").trim();
  return sanitized === "" ? "embed" : sanitized;
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
          "Content-Disposition": `attachment; filename="${attachmentFilename(embed.name)}.ics"`,
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
