import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { resend } from "./emails";
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
