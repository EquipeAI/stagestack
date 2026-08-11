import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  HEADSHOT_ATTEMPT_RESERVED_BLOBS,
  HEADSHOT_ATTEMPT_RESERVED_BYTES,
  MAX_HEADSHOT_STORED_BYTES_PER_USER,
  MAX_HEADSHOT_STORED_BYTES_PER_USER_GLOBAL,
  MAX_HEADSHOT_STORED_TICKETS_PER_USER,
  MAX_HEADSHOT_STORED_TICKETS_PER_USER_GLOBAL,
} from "./model/speakers";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
  type TestT,
  type TestUserT,
} from "./test.helpers";

const IMAGE_TYPE = "image/png";

function pngBytes(_seed = 0): Uint8Array {
  const binary = atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function shallowPngBytes(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  return bytes;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A complete 1x1 PNG carrying a large text chunk. It proves multi-megabyte
 * source bytes stay in storage rather than crossing a v.bytes boundary, while
 * the sanitizer strips the metadata down to a tiny WebP. */
function largeMetadataPng(): Uint8Array {
  const base = pngBytes();
  const data = new Uint8Array(1_100_000);
  data.set(new TextEncoder().encode("Comment\0"));
  data.fill(0x61, 8);
  const chunk = new Uint8Array(data.byteLength + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(chunk.subarray(4, 8 + data.length)));
  const output = new Uint8Array(base.byteLength + chunk.byteLength);
  // Signature + IHDR is 33 bytes in the canonical fixture.
  output.set(base.subarray(0, 33));
  output.set(chunk, 33);
  output.set(base.subarray(33), 33 + chunk.byteLength);
  return output;
}

function bodyBlob(bytes: Uint8Array, type = IMAGE_TYPE): Blob {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buffer], { type });
}

async function setupSpeaker(t: TestT) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Speaker Safety Org");
  const eventSlug = await createEvent(alice, orgSlug, "Speaker Safety Event");
  const direct = await alice.mutation(api.sessions.createDirect, {
    eventSlug,
    title: "Safe uploads",
    speaker: {
      firstName: "Dana",
      lastName: "Keynote",
      email: "dana@example.com",
    },
  });
  return { alice, orgSlug, eventSlug, ...direct };
}

async function store(
  t: TestT,
  contents: BlobPart,
  contentType?: string,
): Promise<{ storageId: Id<"_storage">; size: number }> {
  const blob = new Blob(
    [contents],
    contentType === undefined ? undefined : { type: contentType },
  );
  const storageId = await t.run(async (ctx) => {
    const id = await ctx.storage.store(blob);
    // convex-test 0.0.55 omits Blob.type from its fake _storage metadata even
    // though real Convex persists it. Patch the system row in this test helper
    // so valid-MIME cases exercise production behavior; omit it deliberately
    // for the missing-MIME case.
    if (contentType !== undefined) {
      const db = ctx.db as unknown as {
        patch: (
          table: "_storage",
          storageId: Id<"_storage">,
          value: { contentType: string },
        ) => Promise<void>;
      };
      await db.patch("_storage", id, { contentType });
    }
    return id;
  });
  return { storageId, size: blob.size };
}

async function prepareOrganizerHeadshot(
  t: TestT,
  alice: TestUserT,
  eventSlug: string,
  eventContactId: Id<"eventContacts">,
  seed = 0,
): Promise<{
  uploadId: Id<"headshotUploads">;
  storageId: Id<"_storage">;
}> {
  const bytes = pngBytes(seed);
  const ticket = await alice.mutation(api.speakers.beginHeadshotUpload, {
    eventSlug,
    eventContactId,
    contentType: IMAGE_TYPE,
    size: bytes.byteLength,
  });
  const response = await alice.fetch(`/api/headshots/${ticket.uploadId}`, {
    method: "POST",
    headers: { "Content-Type": IMAGE_TYPE },
    body: bodyBlob(bytes),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  const upload = await t.run(async (ctx) =>
    ctx.db.get("headshotUploads", ticket.uploadId),
  );
  if (upload?.storageId === undefined) throw new Error("storage id missing");
  const storageId = upload.storageId;
  return { uploadId: ticket.uploadId, storageId };
}

async function uploadRows(t: TestT): Promise<Array<Doc<"headshotUploads">>> {
  return await t.run(async (ctx) =>
    ctx.db.query("headshotUploads").order("asc").collect(),
  );
}

async function storageExists(
  t: TestT,
  storageId: Id<"_storage">,
): Promise<boolean> {
  return await t.run(
    async (ctx) => (await ctx.db.system.get(storageId)) !== null,
  );
}

async function drainScheduled(t: TestT): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function recordTemporarySource(
  t: TestT,
  as: TestUserT,
  uploadId: Id<"headshotUploads">,
  bytes = pngBytes(),
): Promise<Id<"_storage">> {
  expect(
    await as.mutation(internal.headshotUploads.beginStorageAttempt, {
      uploadId,
    }),
  ).toEqual({ reserved: true });
  const source = await store(t, bodyBlob(bytes), IMAGE_TYPE);
  expect(
    await as.mutation(internal.headshotUploads.recordSource, {
      uploadId,
      sourceStorageId: source.storageId,
      contentType: IMAGE_TYPE,
      size: source.size,
    }),
  ).toEqual({ recorded: true });
  return source.storageId;
}

describe("bound speaker headshot uploads", () => {
  test("HTTP upload requires the ticket actor and never exposes a storage id", async () => {
    const t = setupTest();
    const { alice, orgSlug, eventSlug, eventContactId } = await setupSpeaker(t);

    const old = await store(t, "old image", IMAGE_TYPE);
    await expectRejectedWith(
      alice.mutation(api.speakers.updateProfile, {
        eventSlug,
        eventContactId,
        patch: { headshotId: old.storageId },
      }),
      "invalid_headshot",
    );

    const bytes = pngBytes(1);
    const ticket = await alice.mutation(api.speakers.beginHeadshotUpload, {
      eventSlug,
      eventContactId,
      contentType: IMAGE_TYPE,
      size: bytes.byteLength,
    });
    const preflight = await t.fetch(`/api/headshots/${ticket.uploadId}`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.test",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
    expect(
      (
        await t.fetch(`/api/headshots/${ticket.uploadId}`, {
          method: "POST",
          headers: { "Content-Type": IMAGE_TYPE },
          body: bodyBlob(bytes),
        })
      ).status,
    ).toBe(401);

    const charlie = await signIn(t, "charlie");
    await grantEventRole(t, eventSlug, "charlie", "organizer");
    expect(
      (
        await charlie.fetch(`/api/headshots/${ticket.uploadId}`, {
          method: "POST",
          headers: { "Content-Type": IMAGE_TYPE },
          body: bodyBlob(bytes),
        })
      ).status,
    ).toBe(404);
    expect(
      (await uploadRows(t)).find((row) => row._id === ticket.uploadId)?.status,
    ).toBe("pending");

    const response = await alice.fetch(`/api/headshots/${ticket.uploadId}`, {
      method: "POST",
      headers: { "Content-Type": IMAGE_TYPE },
      body: bodyBlob(bytes),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const publicBody = await response.json();
    expect(publicBody).toEqual({ ok: true });
    expect(JSON.stringify(publicBody)).not.toContain("storageId");
    expect(
      (
        await alice.fetch(`/api/headshots/${ticket.uploadId}`, {
          method: "POST",
          headers: { "Content-Type": IMAGE_TYPE },
          body: bodyBlob(bytes),
        })
      ).status,
    ).toBe(400);
    const ready = (await uploadRows(t)).find(
      (row) => row._id === ticket.uploadId,
    );
    if (ready?.storageId === undefined) throw new Error("storage id missing");

    const otherSlug = await createEvent(alice, orgSlug, "Other Event");
    const other = await alice.mutation(api.sessions.createDirect, {
      eventSlug: otherSlug,
      title: "Other session",
      speaker: {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
    });
    await expectRejectedWith(
      alice.mutation(api.speakers.attachHeadshot, {
        eventSlug: otherSlug,
        eventContactId: other.eventContactId,
        uploadId: ticket.uploadId,
      }),
      "not_found",
    );

    await expectRejectedWith(
      charlie.mutation(api.speakers.attachHeadshot, {
        eventSlug,
        eventContactId,
        uploadId: ticket.uploadId,
      }),
      "not_found",
    );

    await alice.mutation(api.speakers.attachHeadshot, {
      eventSlug,
      eventContactId,
      uploadId: ticket.uploadId,
    });
    expect(
      await t.run(
        async (ctx) =>
          (await ctx.db.get("eventContacts", eventContactId))?.headshotId,
      ),
    ).toBe(ready.storageId);
    expect(await storageExists(t, old.storageId)).toBe(true);
  });

  test("processes a source over one megabyte through storage ids only", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await setupSpeaker(t);
    const bytes = largeMetadataPng();
    expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
    const ticket = await alice.mutation(api.speakers.beginHeadshotUpload, {
      eventSlug,
      eventContactId,
      contentType: IMAGE_TYPE,
      size: bytes.byteLength,
    });
    const response = await alice.fetch(`/api/headshots/${ticket.uploadId}`, {
      method: "POST",
      headers: { "Content-Type": IMAGE_TYPE },
      body: bodyBlob(bytes),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const upload = (await uploadRows(t)).find(
      (row) => row._id === ticket.uploadId,
    );
    expect(upload).toMatchObject({
      status: "ready",
      sourceSize: bytes.byteLength,
      sourceCleanupPending: false,
      sourceDeletedAt: expect.any(Number),
      sanitizedContentType: "image/webp",
      reservedBlobCount: 1,
      quotaState: "reconciled",
    });
    if (upload?.sourceStorageId === undefined) {
      throw new Error("source storage id missing");
    }
    expect(await storageExists(t, upload.sourceStorageId)).toBe(false);
    expect(upload.sanitizedSize).toBeLessThan(1024 * 1024);
    expect(upload.reservedBytes).toBe(upload.sanitizedSize);
    const reconciledUsage = await t.run(async (ctx) => ({
      scoped: await ctx.db.query("headshotUploadUsage").unique(),
      global: await ctx.db.query("headshotUploadUserUsage").unique(),
      org: await ctx.db.query("headshotUploadOrgUsage").unique(),
    }));
    for (const usage of Object.values(reconciledUsage)) {
      expect(usage).toMatchObject({
        storedBytes: upload.sanitizedSize,
        ticketCount: 1,
      });
    }
  });

  test("rejects missing/unsupported MIME, bad magic, size mismatch, and oversize intent", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await setupSpeaker(t);

    await expectRejectedWith(
      alice.mutation(api.speakers.beginHeadshotUpload, {
        eventSlug,
        eventContactId,
        contentType: IMAGE_TYPE,
        size: 4 * 1024 * 1024 + 1,
      }),
      "invalid_headshot",
    );
    await expectRejectedWith(
      alice.mutation(api.speakers.beginHeadshotUpload, {
        eventSlug,
        eventContactId,
        contentType: "image/svg+xml",
        size: 20,
      }),
      "invalid_headshot",
    );

    const invalidCases: Array<{
      headers?: Record<string, string>;
      body: Blob;
    }> = [
      { body: bodyBlob(pngBytes(), "") },
      {
        headers: { "Content-Type": "text/plain" },
        body: bodyBlob(pngBytes(), "text/plain"),
      },
      {
        headers: { "Content-Type": IMAGE_TYPE },
        body: new Blob(["not really a png"], { type: IMAGE_TYPE }),
      },
      {
        headers: { "Content-Type": IMAGE_TYPE },
        body: bodyBlob(new Uint8Array([...pngBytes(), 1])),
      },
    ];
    for (const invalid of invalidCases) {
      const ticket = await alice.mutation(api.speakers.beginHeadshotUpload, {
        eventSlug,
        eventContactId,
        contentType: IMAGE_TYPE,
        size: pngBytes().byteLength,
      });
      const response = await alice.fetch(`/api/headshots/${ticket.uploadId}`, {
        method: "POST",
        ...(invalid.headers === undefined ? {} : { headers: invalid.headers }),
        body: invalid.body,
      });
      expect(response.status).toBe(400);
      expect(
        (await uploadRows(t)).find((row) => row._id === ticket.uploadId)
          ?.status,
      ).toBe("rejected");
    }

    // This source passes the small magic/header prefilter, is recorded for
    // crash recovery, then fails the real Node decoder and is deleted.
    const shallow = shallowPngBytes();
    const shallowTicket = await alice.mutation(
      api.speakers.beginHeadshotUpload,
      {
        eventSlug,
        eventContactId,
        contentType: IMAGE_TYPE,
        size: shallow.byteLength,
      },
    );
    const shallowResponse = await alice.fetch(
      `/api/headshots/${shallowTicket.uploadId}`,
      {
        method: "POST",
        headers: { "Content-Type": IMAGE_TYPE },
        body: bodyBlob(shallow),
      },
    );
    expect(shallowResponse.status).toBe(400);
    const shallowUpload = (await uploadRows(t)).find(
      (row) => row._id === shallowTicket.uploadId,
    );
    expect(shallowUpload).toMatchObject({
      status: "rejected",
      sourceDeletedAt: expect.any(Number),
      sourceCleanupPending: false,
    });
    expect(shallowUpload?.reservedBytes).toBeUndefined();
    expect(shallowUpload?.reservedBlobCount).toBeUndefined();
    if (shallowUpload?.sourceStorageId === undefined) {
      throw new Error("recorded source missing");
    }
    expect(await storageExists(t, shallowUpload.sourceStorageId)).toBe(false);

    // The production completion gate independently requires storage metadata;
    // magic/header validation alone is not allowed to bless a missing MIME.
    const missingMimeTicket = await alice.mutation(
      api.speakers.beginHeadshotUpload,
      {
        eventSlug,
        eventContactId,
        contentType: IMAGE_TYPE,
        size: pngBytes().byteLength,
      },
    );
    expect(
      await alice.mutation(internal.headshotUploads.claim, {
        uploadId: missingMimeTicket.uploadId,
        contentType: IMAGE_TYPE,
      }),
    ).toMatchObject({ claimed: true });
    const missingMimeSource = await recordTemporarySource(
      t,
      alice,
      missingMimeTicket.uploadId,
    );
    expect(
      await alice.mutation(internal.headshotUploads.markOutputStoreStarted, {
        uploadId: missingMimeTicket.uploadId,
      }),
    ).toBe(true);
    const missingMime = await t.run(async (ctx) =>
      ctx.storage.store(bodyBlob(pngBytes(), "")),
    );
    await expectRejectedWith(
      alice.mutation(internal.headshotUploads.complete, {
        uploadId: missingMimeTicket.uploadId,
        storageId: missingMime,
        contentType: "image/webp",
        size: pngBytes().byteLength,
        width: 1,
        height: 1,
      }),
      "invalid_headshot",
    );
    await t.run(async (ctx) => ctx.storage.delete(missingMime));
    await alice.mutation(internal.headshotUploads.markOutputKnownDeleted, {
      uploadId: missingMimeTicket.uploadId,
    });
    await alice.mutation(internal.headshotUploads.fail, {
      uploadId: missingMimeTicket.uploadId,
    });
    await alice.mutation(internal.headshotUploads.cleanupSource, {
      uploadId: missingMimeTicket.uploadId,
      sourceStorageId: missingMimeSource,
    });
    const releasedLedgers = await t.run(async (ctx) => [
      ...(await ctx.db.query("headshotUploadUsage").collect()),
      ...(await ctx.db.query("headshotUploadUserUsage").collect()),
      ...(await ctx.db.query("headshotUploadOrgUsage").collect()),
    ]);
    expect(releasedLedgers).not.toHaveLength(0);
    for (const usage of releasedLedgers) {
      expect(usage).toMatchObject({ storedBytes: 0, ticketCount: 0 });
    }
  });

  test("keeps active upload leases stable across discard and cron races", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await setupSpeaker(t);

    const completeTicket = await alice.mutation(
      api.speakers.beginHeadshotUpload,
      {
        eventSlug,
        eventContactId,
        contentType: IMAGE_TYPE,
        size: pngBytes().byteLength,
      },
    );
    expect(
      await alice.mutation(internal.headshotUploads.claim, {
        uploadId: completeTicket.uploadId,
        contentType: IMAGE_TYPE,
      }),
    ).toMatchObject({ claimed: true });
    await alice.mutation(api.speakers.discardHeadshotUpload, {
      eventSlug,
      eventContactId,
      uploadId: completeTicket.uploadId,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch("headshotUploads", completeTicket.uploadId, {
        // Force the indexed expiry query to encounter this active lease.
        expiresAt: 0,
      });
    });
    expect(
      await t.mutation(internal.headshotUploads.cleanupExpired, {}),
    ).toBe(0);
    expect(
      (await uploadRows(t)).find((row) => row._id === completeTicket.uploadId)
        ?.status,
    ).toBe("uploading");

    const completedSource = await recordTemporarySource(
      t,
      alice,
      completeTicket.uploadId,
    );
    await t.run(async (ctx) => {
      // Restore the ticket's attach window after the artificial indexed-race
      // setup above. The upload lease itself remained active throughout.
      await ctx.db.patch("headshotUploads", completeTicket.uploadId, {
        expiresAt: Date.now() + 60_000,
      });
    });
    expect(
      await alice.action(internal.headshotProcessing.process, {
        uploadId: completeTicket.uploadId,
        sourceStorageId: completedSource,
      }),
    ).toEqual({ ok: true });
    expect(
      (await uploadRows(t)).find((row) => row._id === completeTicket.uploadId)
        ?.status,
    ).toBe("ready");
    expect(await storageExists(t, completedSource)).toBe(false);

    const failedTicket = await alice.mutation(
      api.speakers.beginHeadshotUpload,
      {
        eventSlug,
        eventContactId,
        contentType: IMAGE_TYPE,
        size: pngBytes().byteLength,
      },
    );
    await alice.mutation(internal.headshotUploads.claim, {
      uploadId: failedTicket.uploadId,
      contentType: IMAGE_TYPE,
    });
    const failedSource = await recordTemporarySource(
      t,
      alice,
      failedTicket.uploadId,
    );
    await alice.mutation(api.speakers.discardHeadshotUpload, {
      eventSlug,
      eventContactId,
      uploadId: failedTicket.uploadId,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch("headshotUploads", failedTicket.uploadId, {
        expiresAt: 0,
      });
    });
    expect(
      await t.mutation(internal.headshotUploads.cleanupExpired, {}),
    ).toBe(0);
    await alice.mutation(internal.headshotUploads.fail, {
      uploadId: failedTicket.uploadId,
    });
    expect(
      await alice.mutation(internal.headshotUploads.cleanupSource, {
        uploadId: failedTicket.uploadId,
        sourceStorageId: failedSource,
      }),
    ).toBe(true);
    expect(
      (await uploadRows(t)).find((row) => row._id === failedTicket.uploadId)
        ?.status,
    ).toBe("rejected");
    await t.mutation(internal.headshotUploads.cleanupExpired, {});
    expect(await storageExists(t, failedSource)).toBe(false);

    const crashedTicket = await alice.mutation(
      api.speakers.beginHeadshotUpload,
      {
        eventSlug,
        eventContactId,
        contentType: IMAGE_TYPE,
        size: pngBytes().byteLength,
      },
    );
    await alice.mutation(internal.headshotUploads.claim, {
      uploadId: crashedTicket.uploadId,
      contentType: IMAGE_TYPE,
    });
    const crashedSource = await recordTemporarySource(
      t,
      alice,
      crashedTicket.uploadId,
    );
    await t.run(async (ctx) => {
      await ctx.db.patch("headshotUploads", crashedTicket.uploadId, {
        expiresAt: 0,
        uploadLeaseExpiresAt: 0,
      });
    });
    await t.mutation(internal.headshotUploads.cleanupExpired, {});
    expect(await storageExists(t, crashedSource)).toBe(false);
    expect(
      (await uploadRows(t)).find((row) => row._id === crashedTicket.uploadId),
    ).toMatchObject({
      status: "discarded",
      sourceDeletedAt: expect.any(Number),
      sourceCleanupPending: false,
    });
  });

  test("retains raw store-gap charges and blocks a second-org bypass", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await setupSpeaker(t);
    const orphanIds: Array<Id<"_storage">> = [];
    for (let index = 0; index < 5; index += 1) {
      const ticket = await alice.mutation(api.speakers.beginHeadshotUpload, {
        eventSlug,
        eventContactId,
        contentType: IMAGE_TYPE,
        size: pngBytes().byteLength,
      });
      await alice.mutation(internal.headshotUploads.claim, {
        uploadId: ticket.uploadId,
        contentType: IMAGE_TYPE,
      });
      expect(
        await alice.mutation(
          internal.headshotUploads.beginStorageAttempt,
          { uploadId: ticket.uploadId },
        ),
      ).toEqual({ reserved: true });
      // Simulate termination after storage.store returned to the runtime but
      // before recordSource durably captured the id.
      const orphan = await store(t, bodyBlob(pngBytes()), IMAGE_TYPE);
      orphanIds.push(orphan.storageId);
      await t.run(async (ctx) => {
        await ctx.db.patch("headshotUploads", ticket.uploadId, {
          expiresAt: 0,
          uploadLeaseExpiresAt: 0,
        });
      });
      await t.mutation(internal.headshotUploads.cleanupExpired, {});
      const retained = (await uploadRows(t)).find(
        (row) => row._id === ticket.uploadId,
      );
      expect(retained).toMatchObject({
        status: "retained",
        quotaState: "indeterminate",
        reservedBytes: HEADSHOT_ATTEMPT_RESERVED_BYTES,
        reservedBlobCount: HEADSHOT_ATTEMPT_RESERVED_BLOBS,
      });
      expect(retained?.sourceStorageId).toBeUndefined();
    }
    for (const orphanId of orphanIds) {
      expect(await storageExists(t, orphanId)).toBe(true);
    }
    const globalUsage = await t.run(async (ctx) =>
      ctx.db.query("headshotUploadUserUsage").unique(),
    );
    expect(globalUsage).toMatchObject({
      storedBytes: 5 * HEADSHOT_ATTEMPT_RESERVED_BYTES,
      ticketCount: 5 * HEADSHOT_ATTEMPT_RESERVED_BLOBS,
    });

    const secondOrgSlug = await createOrg(alice, "Crash Gap Org");
    const secondEventSlug = await createEvent(
      alice,
      secondOrgSlug,
      "Crash Gap Event",
    );
    const secondContact = await alice.mutation(api.sessions.createDirect, {
      eventSlug: secondEventSlug,
      title: "Crash gap session",
      speaker: {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
    });
    const blocked = await alice.mutation(api.speakers.beginHeadshotUpload, {
      eventSlug: secondEventSlug,
      eventContactId: secondContact.eventContactId,
      contentType: IMAGE_TYPE,
      size: pngBytes().byteLength,
    });
    await alice.mutation(internal.headshotUploads.claim, {
      uploadId: blocked.uploadId,
      contentType: IMAGE_TYPE,
    });
    expect(
      await alice.mutation(internal.headshotUploads.beginStorageAttempt, {
        uploadId: blocked.uploadId,
      }),
    ).toMatchObject({
      reserved: false,
      message: expect.stringContaining("storage quota"),
    });
  });

  test("retains output store-gap charges while deleting the known raw source", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await setupSpeaker(t);
    const ticket = await alice.mutation(api.speakers.beginHeadshotUpload, {
      eventSlug,
      eventContactId,
      contentType: IMAGE_TYPE,
      size: pngBytes().byteLength,
    });
    await alice.mutation(internal.headshotUploads.claim, {
      uploadId: ticket.uploadId,
      contentType: IMAGE_TYPE,
    });
    const sourceStorageId = await recordTemporarySource(
      t,
      alice,
      ticket.uploadId,
    );
    await alice.mutation(internal.headshotUploads.markOutputStoreStarted, {
      uploadId: ticket.uploadId,
    });
    // Simulate termination after the normalized store but before complete can
    // record its id. The output is deliberately unknown to the ticket.
    const unknownOutput = await store(t, "unknown output", "image/webp");
    await t.run(async (ctx) => {
      await ctx.db.patch("headshotUploads", ticket.uploadId, {
        expiresAt: 0,
        uploadLeaseExpiresAt: 0,
      });
    });
    await t.mutation(internal.headshotUploads.cleanupExpired, {});

    const retained = (await uploadRows(t)).find(
      (row) => row._id === ticket.uploadId,
    );
    expect(retained).toMatchObject({
      status: "retained",
      quotaState: "indeterminate",
      sourceDeletedAt: expect.any(Number),
      reservedBytes: HEADSHOT_ATTEMPT_RESERVED_BYTES,
      reservedBlobCount: HEADSHOT_ATTEMPT_RESERVED_BLOBS,
    });
    expect(retained?.storageId).toBeUndefined();
    expect(await storageExists(t, sourceStorageId)).toBe(false);
    expect(await storageExists(t, unknownOutput.storageId)).toBe(true);
    const globalUsage = await t.run(async (ctx) =>
      ctx.db.query("headshotUploadUserUsage").unique(),
    );
    expect(globalUsage).toMatchObject({
      storedBytes: HEADSHOT_ATTEMPT_RESERVED_BYTES,
      ticketCount: HEADSHOT_ATTEMPT_RESERVED_BLOBS,
    });
  });

  test("rate limits organizer upload tickets by user", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await setupSpeaker(t);
    for (let index = 0; index < 10; index += 1) {
      await alice.mutation(api.speakers.beginHeadshotUpload, {
        eventSlug,
        eventContactId,
        contentType: IMAGE_TYPE,
        size: pngBytes().byteLength,
      });
    }
    await expectRejectedWith(
      alice.mutation(api.speakers.beginHeadshotUpload, {
        eventSlug,
        eventContactId,
        contentType: IMAGE_TYPE,
        size: pngBytes().byteLength,
      }),
      "rate_limited",
    );
  });

  test("bounds durable stored headshots by org and uploader", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await setupSpeaker(t);
    const ticket = await alice.mutation(api.speakers.beginHeadshotUpload, {
      eventSlug,
      eventContactId,
      contentType: IMAGE_TYPE,
      size: pngBytes().byteLength,
    });
    await alice.mutation(internal.headshotUploads.claim, {
      uploadId: ticket.uploadId,
      contentType: IMAGE_TYPE,
    });
    await t.run(async (ctx) => {
      const upload = await ctx.db.get("headshotUploads", ticket.uploadId);
      if (upload === null) throw new Error("ticket missing");
      await ctx.db.insert("headshotUploadUsage", {
        orgId: upload.orgId,
        userId: upload.uploadedByUserId,
        storedBytes: MAX_HEADSHOT_STORED_BYTES_PER_USER,
        ticketCount: MAX_HEADSHOT_STORED_TICKETS_PER_USER,
        updatedAt: Date.now(),
      });
    });
    expect(
      await alice.mutation(internal.headshotUploads.beginStorageAttempt, {
        uploadId: ticket.uploadId,
      }),
    ).toMatchObject({
      reserved: false,
      message: expect.stringContaining("storage quota"),
    });
    expect(
      (await uploadRows(t)).find((row) => row._id === ticket.uploadId)?.status,
    ).toBe("rejected");
  });

  test("prevents a second-org quota bypass and releases every ledger", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await setupSpeaker(t);
    const first = await alice.mutation(api.speakers.beginHeadshotUpload, {
      eventSlug,
      eventContactId,
      contentType: IMAGE_TYPE,
      size: pngBytes().byteLength,
    });
    await alice.mutation(internal.headshotUploads.claim, {
      uploadId: first.uploadId,
      contentType: IMAGE_TYPE,
    });
    expect(
      await alice.mutation(internal.headshotUploads.beginStorageAttempt, {
        uploadId: first.uploadId,
      }),
    ).toEqual({ reserved: true });
    await t.run(async (ctx) => {
      const globalUsage = await ctx.db
        .query("headshotUploadUserUsage")
        .unique();
      if (globalUsage === null) throw new Error("global usage missing");
      await ctx.db.patch("headshotUploadUserUsage", globalUsage._id, {
        storedBytes: MAX_HEADSHOT_STORED_BYTES_PER_USER_GLOBAL,
        ticketCount: MAX_HEADSHOT_STORED_TICKETS_PER_USER_GLOBAL,
      });
    });

    const secondOrgSlug = await createOrg(alice, "Second Quota Org");
    const secondEventSlug = await createEvent(
      alice,
      secondOrgSlug,
      "Second Quota Event",
    );
    const secondContact = await alice.mutation(api.sessions.createDirect, {
      eventSlug: secondEventSlug,
      title: "Quota session",
      speaker: {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
    });
    const blocked = await alice.mutation(api.speakers.beginHeadshotUpload, {
      eventSlug: secondEventSlug,
      eventContactId: secondContact.eventContactId,
      contentType: IMAGE_TYPE,
      size: pngBytes().byteLength,
    });
    await alice.mutation(internal.headshotUploads.claim, {
      uploadId: blocked.uploadId,
      contentType: IMAGE_TYPE,
    });
    expect(
      await alice.mutation(internal.headshotUploads.beginStorageAttempt, {
        uploadId: blocked.uploadId,
      }),
    ).toMatchObject({ reserved: false });

    // Releasing the first org's real reservation decrements the per-org/user,
    // global-user and org-total ledgers atomically.
    await alice.mutation(internal.headshotUploads.fail, {
      uploadId: first.uploadId,
    });
    expect(
      await alice.mutation(internal.headshotUploads.releaseKnownClean, {
        uploadId: first.uploadId,
      }),
    ).toBe(true);
    const allowed = await alice.mutation(api.speakers.beginHeadshotUpload, {
      eventSlug: secondEventSlug,
      eventContactId: secondContact.eventContactId,
      contentType: IMAGE_TYPE,
      size: pngBytes().byteLength,
    });
    await alice.mutation(internal.headshotUploads.claim, {
      uploadId: allowed.uploadId,
      contentType: IMAGE_TYPE,
    });
    expect(
      await alice.mutation(internal.headshotUploads.beginStorageAttempt, {
        uploadId: allowed.uploadId,
      }),
    ).toEqual({ reserved: true });
    await alice.mutation(internal.headshotUploads.fail, {
      uploadId: allowed.uploadId,
    });
    expect(
      await alice.mutation(internal.headshotUploads.releaseKnownClean, {
        uploadId: allowed.uploadId,
      }),
    ).toBe(true);
    const globalAfterRelease = await t.run(async (ctx) =>
      ctx.db.query("headshotUploadUserUsage").unique(),
    );
    expect(globalAfterRelease).toMatchObject({
      storedBytes:
        MAX_HEADSHOT_STORED_BYTES_PER_USER_GLOBAL -
        HEADSHOT_ATTEMPT_RESERVED_BYTES,
      ticketCount:
        MAX_HEADSHOT_STORED_TICKETS_PER_USER_GLOBAL -
        HEADSHOT_ATTEMPT_RESERVED_BLOBS,
    });
    const scopedAfterRelease = await t.run(async (ctx) => ({
      perOrgUser: await ctx.db.query("headshotUploadUsage").collect(),
      orgTotals: await ctx.db.query("headshotUploadOrgUsage").collect(),
    }));
    expect(scopedAfterRelease.perOrgUser).toHaveLength(2);
    expect(scopedAfterRelease.orgTotals).toHaveLength(2);
    for (const usage of [
      ...scopedAfterRelease.perOrgUser,
      ...scopedAfterRelease.orgTotals,
    ]) {
      expect(usage).toMatchObject({ storedBytes: 0, ticketCount: 0 });
    }
  });

  test("sweeps lost responses and safely deletes or retains replacements", async () => {
    const t = setupTest();
    const { alice, orgSlug, eventSlug, eventContactId } = await setupSpeaker(t);

    const abandoned = await prepareOrganizerHeadshot(
      t,
      alice,
      eventSlug,
      eventContactId,
      2,
    );
    await t.run(async (ctx) => {
      await ctx.db.patch("headshotUploads", abandoned.uploadId, {
        expiresAt: 0,
      });
    });
    await t.mutation(internal.headshotUploads.cleanupExpired, {});
    expect(await storageExists(t, abandoned.storageId)).toBe(false);
    expect(
      (await uploadRows(t)).find((row) => row._id === abandoned.uploadId)
        ?.status,
    ).toBe("deleted");

    const referenced = await prepareOrganizerHeadshot(
      t,
      alice,
      eventSlug,
      eventContactId,
      3,
    );
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("event missing");
      await ctx.db.patch("events", event._id, { logoId: referenced.storageId });
      await ctx.db.patch("headshotUploads", referenced.uploadId, {
        expiresAt: 0,
      });
    });
    await t.mutation(internal.headshotUploads.cleanupExpired, {});
    expect(await storageExists(t, referenced.storageId)).toBe(true);
    expect(
      (await uploadRows(t)).find((row) => row._id === referenced.uploadId)
        ?.status,
    ).toBe("cleanupPending");

    const first = await prepareOrganizerHeadshot(
      t,
      alice,
      eventSlug,
      eventContactId,
      4,
    );
    await alice.mutation(api.speakers.attachHeadshot, {
      eventSlug,
      eventContactId,
      uploadId: first.uploadId,
    });
    const second = await prepareOrganizerHeadshot(
      t,
      alice,
      eventSlug,
      eventContactId,
      5,
    );
    await alice.mutation(api.speakers.attachHeadshot, {
      eventSlug,
      eventContactId,
      uploadId: second.uploadId,
    });
    await drainScheduled(t);
    expect(await storageExists(t, first.storageId)).toBe(false);
    expect(
      (await uploadRows(t)).find((r) => r._id === first.uploadId)?.status,
    ).toBe("deleted");

    // A later event copied the current directory headshot. Replacing it on the
    // first event must retain the shared blob for that independent snapshot.
    const shared = second;
    const otherSlug = await createEvent(alice, orgSlug, "Shared Photo Event");
    const other = await alice.mutation(api.sessions.createDirect, {
      eventSlug: otherSlug,
      title: "Shared photo session",
      speaker: {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
    });
    // Event snapshots are independent after creation. Simulate the legitimate
    // shared-history case (an older snapshot copied this directory photo) that
    // replacement cleanup must detect through the exact headshot index.
    await t.run(async (ctx) => {
      await ctx.db.patch("eventContacts", other.eventContactId, {
        headshotId: shared.storageId,
      });
    });
    expect(
      await t.run(
        async (ctx) =>
          (await ctx.db.get("eventContacts", other.eventContactId))?.headshotId,
      ),
    ).toBe(shared.storageId);

    const third = await prepareOrganizerHeadshot(
      t,
      alice,
      eventSlug,
      eventContactId,
      6,
    );
    await alice.mutation(api.speakers.attachHeadshot, {
      eventSlug,
      eventContactId,
      uploadId: third.uploadId,
    });
    await drainScheduled(t);
    expect(await storageExists(t, shared.storageId)).toBe(true);
    const sharedPending = (await uploadRows(t)).find(
      (row) => row._id === shared.uploadId,
    );
    expect(sharedPending?.status).toBe("cleanupPending");
    const usageBeforeRelease = await t.run(async (ctx) =>
      ctx.db.query("headshotUploadUsage").unique(),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch("eventContacts", other.eventContactId, {
        headshotId: undefined,
      });
      await ctx.db.patch("headshotUploads", shared.uploadId, {
        cleanupAfter: 0,
      });
    });
    await t.mutation(internal.headshotUploads.cleanupExpired, {});
    expect(await storageExists(t, shared.storageId)).toBe(false);
    expect(
      (await uploadRows(t)).find((row) => row._id === shared.uploadId)?.status,
    ).toBe("deleted");
    const usageAfterRelease = await t.run(async (ctx) =>
      ctx.db.query("headshotUploadUsage").unique(),
    );
    expect(usageAfterRelease?.ticketCount).toBe(
      (usageBeforeRelease?.ticketCount ?? 0) - 1,
    );
  });

  test("retries ambiguous replacement cleanup and releases quota once clear", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await setupSpeaker(t);
    const first = await prepareOrganizerHeadshot(
      t,
      alice,
      eventSlug,
      eventContactId,
      7,
    );
    await alice.mutation(api.speakers.attachHeadshot, {
      eventSlug,
      eventContactId,
      uploadId: first.uploadId,
    });
    await t.run(async (ctx) => {
      for (let index = 0; index < 1_001; index += 1) {
        await ctx.db.insert("jobs", {
          type: "reference-ambiguity-test",
          payload: { index },
          status: "done",
        });
      }
    });
    const second = await prepareOrganizerHeadshot(
      t,
      alice,
      eventSlug,
      eventContactId,
      8,
    );
    await alice.mutation(api.speakers.attachHeadshot, {
      eventSlug,
      eventContactId,
      uploadId: second.uploadId,
    });
    await drainScheduled(t);

    const pending = (await uploadRows(t)).find(
      (row) => row._id === first.uploadId,
    );
    expect(pending).toMatchObject({
      status: "cleanupPending",
      cleanupAfter: expect.any(Number),
    });
    expect(await storageExists(t, first.storageId)).toBe(true);
    const usageBefore = await t.run(async (ctx) => {
      const upload = await ctx.db.get("headshotUploads", first.uploadId);
      if (upload === null) throw new Error("ticket missing");
      return await ctx.db
        .query("headshotUploadUsage")
        .withIndex("by_orgId_and_userId", (q) =>
          q.eq("orgId", upload.orgId).eq("userId", upload.uploadedByUserId),
        )
        .unique();
    });
    expect(usageBefore?.ticketCount).toBe(2);

    await t.run(async (ctx) => {
      for (const job of await ctx.db.query("jobs").collect()) {
        await ctx.db.delete("jobs", job._id);
      }
      await ctx.db.patch("headshotUploads", first.uploadId, {
        cleanupAfter: 0,
      });
    });
    expect(
      await t.mutation(internal.headshotUploads.cleanupExpired, {}),
    ).toBe(1);
    expect(await storageExists(t, first.storageId)).toBe(false);
    expect(
      (await uploadRows(t)).find((row) => row._id === first.uploadId)?.status,
    ).toBe("deleted");
    const usageAfter = await t.run(async (ctx) =>
      ctx.db.query("headshotUploadUsage").unique(),
    );
    expect(usageAfter?.ticketCount).toBe(1);
  });
});

describe("speaker CSV merge side effects", () => {
  test("syncs the directory, evidence, and already-published projection", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId, sessionId } =
      await setupSpeaker(t);
    await alice.mutation(api.tasks.createRequirement, {
      eventSlug,
      title: "Speaker bio",
      scope: "participant",
      evidence: "profileField",
      fieldKey: "bio",
      reviewRequired: false,
      dueAt: Date.parse("2026-08-20T00:00:00Z"),
    });
    const participantId = (
      await alice.query(api.sessions.list, { eventSlug })
    )[0].participants[0].participantId;
    await alice.mutation(api.sessions.setParticipationState, {
      eventSlug,
      participantId,
      to: "confirmed",
    });
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId,
      published: true,
    });
    await drainScheduled(t);

    expect(
      await alice.mutation(api.speakers.importRows, {
        eventSlug,
        rows: [
          {
            firstName: "Dana",
            lastName: "Keynote",
            email: "DANA@example.com",
            company: "Acme",
            bio: "Dana builds safe event systems.",
          },
        ],
      }),
    ).toEqual({ created: 0, merged: 1, skipped: [] });

    const snapshot = await t.run(async (ctx) =>
      ctx.db.get("eventContacts", eventContactId),
    );
    const directory = await t.run(async (ctx) =>
      snapshot?.contactId === undefined
        ? null
        : ctx.db.get("contacts", snapshot.contactId),
    );
    expect(snapshot).toMatchObject({
      company: "Acme",
      bio: "Dana builds safe event systems.",
    });
    expect(directory).toMatchObject({
      company: "Acme",
      bio: "Dana builds safe event systems.",
    });
    expect(await alice.query(api.tasks.listInstances, { eventSlug })).toEqual([
      expect.objectContaining({ status: "complete" }),
    ]);
    const program = await t.query(api.publish.publicProgram, {
      slug: eventSlug,
    });
    expect(program?.lineup[0].speakers[0]).toMatchObject({
      company: "Acme",
      bio: "Dana builds safe event systems.",
    });
  });

  test("fills a blank event snapshot without overwriting newer directory fields", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId } = await setupSpeaker(t);
    const contactId = await t.run(async (ctx) => {
      const snapshot = await ctx.db.get("eventContacts", eventContactId);
      if (snapshot?.contactId === undefined) {
        throw new Error("linked directory contact missing");
      }
      await ctx.db.patch("eventContacts", snapshot._id, {
        tagline: "Current event tagline",
        company: undefined,
        bio: undefined,
      });
      await ctx.db.patch("contacts", snapshot.contactId, {
        tagline: undefined,
        company: "New directory company",
        bio: "New directory bio",
      });
      return snapshot.contactId;
    });

    expect(
      await alice.mutation(api.speakers.importRows, {
        eventSlug,
        rows: [
          {
            firstName: "Dana",
            lastName: "Keynote",
            email: "dana@example.com",
            tagline: "Stale CSV tagline",
            company: "CSV company",
            bio: "CSV bio",
          },
        ],
      }),
    ).toEqual({ created: 0, merged: 1, skipped: [] });

    expect(
      await t.run(async (ctx) => ctx.db.get("eventContacts", eventContactId)),
    ).toMatchObject({
      tagline: "Current event tagline",
      company: "CSV company",
      bio: "CSV bio",
    });
    expect(
      await t.run(async (ctx) => ctx.db.get("contacts", contactId)),
    ).toMatchObject({
      tagline: "Current event tagline",
      company: "New directory company",
      bio: "New directory bio",
    });
  });

  test("dedupes by the exact email index beyond the old 2,000-row scan", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Large Roster Org");
    const eventSlug = await createEvent(alice, orgSlug, "Large Roster Event");
    const targetId = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("event missing");
      let last: Id<"eventContacts"> | undefined;
      for (let i = 0; i < 2_001; i += 1) {
        last = await ctx.db.insert("eventContacts", {
          eventId: event._id,
          orgId: event.orgId,
          firstName: `Speaker ${i}`,
          lastName: "",
          email: i === 2_000 ? "late@example.com" : `speaker${i}@example.com`,
        });
      }
      if (last === undefined) throw new Error("target missing");
      return last;
    });

    expect(
      await alice.mutation(api.speakers.importRows, {
        eventSlug,
        rows: [
          {
            firstName: "Late",
            lastName: "Speaker",
            email: "late@example.com",
            bio: "Found by the exact index.",
          },
        ],
      }),
    ).toEqual({ created: 0, merged: 1, skipped: [] });
    expect(
      await t.run(
        async (ctx) => (await ctx.db.get("eventContacts", targetId))?.bio,
      ),
    ).toBe("Found by the exact index.");
  });

  test("rolls back a profile edit that would overflow the forced public rebuild", async () => {
    const t = setupTest();
    const { alice, eventSlug, eventContactId, sessionId } =
      await setupSpeaker(t);
    const participantId = (
      await alice.query(api.sessions.list, { eventSlug })
    )[0].participants[0].participantId;
    await alice.mutation(api.sessions.setParticipationState, {
      eventSlug,
      participantId,
      to: "confirmed",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch("sessions", sessionId, {
        // Just below the projection guard until the 4KB profile is added.
        description: "x".repeat(919_000),
      });
    });
    await alice.mutation(api.publish.setSession, {
      eventSlug,
      sessionId,
      published: true,
    });
    await alice.mutation(api.publish.setLineup, { eventSlug, enabled: true });
    await drainScheduled(t);
    expect((await alice.query(api.publish.state, { eventSlug })).stale).toBe(
      false,
    );

    await expectRejectedWith(
      alice.mutation(api.speakers.updateProfile, {
        eventSlug,
        eventContactId,
        patch: { bio: "b".repeat(4_000) },
      }),
      "program_too_large",
    );
    expect(
      await t.run(
        async (ctx) => (await ctx.db.get("eventContacts", eventContactId))?.bio,
      ),
    ).toBeNull();
    // The live write rolled back, so the last good public blob is still fully
    // current rather than an unreported stale projection.
    expect((await alice.query(api.publish.state, { eventSlug })).stale).toBe(
      false,
    );
  });
});
