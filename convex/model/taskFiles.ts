import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { requireOrganizer } from "../lib/functions";
import { resolveEventUserDisplayName } from "./userDisplay";
import type { DisplayNameResolution } from "./userDisplay";

// ──────────────────────────────────────────────────────────────────────────
// The files library and bulk export (W5: CNT-13/CNT-14), moved verbatim out of
// `model/tasks.ts` — the speaker-ops header there still describes the
// requirement/instance rules these rows are a read-only projection of.
//
// The hydration ceilings below bound a hydration budget, not an event's rows,
// which is why they live here and not in `lib/readCaps`.
// ──────────────────────────────────────────────────────────────────────────

const FILE_LIBRARY_SCAN = 300;
const FILE_LIBRARY_CURRENT_LIMIT = 120;
const FILE_LIBRARY_HEADSHOT_CONTACT_LIMIT = 64;
const FILE_LIBRARY_TASK_CONTACT_LIMIT = 16;
const FILE_LIBRARY_SESSION_LIMIT = 64;
const FILE_LIBRARY_HEADSHOT_CONTACT_BYTES = 2 * 1024 * 1024;
const FILE_LIBRARY_HYDRATION_BYTES = 6 * 1024 * 1024;

export type LibraryFileRow = {
  fileId: string;
  kind: "task" | "headshot";
  instanceId: Id<"taskInstances"> | null;
  requirementTitle: string;
  sessionId: Id<"sessions"> | null;
  sessionTitle: string;
  speakerName: string | null;
  /** Original browser basename retained as provenance; null for task uploads
   * (whose stored/download filename is already the original) and legacy
   * headshots created before provenance capture. */
  sourceFilename: string | null;
  /** MIME-correct filename used for view/download and bundle export. */
  filename: string;
  version: number | null;
  versionCount: number | null;
  uploadedByName: string | null;
  /** Why `uploadedByName` is null, in the words the surface should show.
   * Null whenever a name resolved. One producer: never re-worded in TSX. */
  uploadedByNote: string | null;
  uploadedAt: number | null;
  url: string | null;
  commentCount: number;
};

/** Original files-library contract kept for clients deployed before headshots
 * became first-class rows. It is intentionally task-only and contains no
 * nullable task/session/version fields. */
export type LegacyLibraryFileRow = {
  instanceId: Id<"taskInstances">;
  requirementTitle: string;
  sessionId: Id<"sessions">;
  sessionTitle: string;
  speakerName: string | null;
  filename: string;
  version: number;
  versionCount: number;
  uploadedAt: number;
  url: string | null;
  commentCount: number;
};

export function legacyLibraryFileRows(
  rows: ReadonlyArray<LibraryFileRow>,
): LegacyLibraryFileRow[] {
  return rows.flatMap((row) => {
    if (
      row.kind !== "task" ||
      row.instanceId === null ||
      row.sessionId === null ||
      row.version === null ||
      row.versionCount === null ||
      row.uploadedAt === null
    ) {
      return [];
    }
    return [
      {
        instanceId: row.instanceId,
        requirementTitle: row.requirementTitle,
        sessionId: row.sessionId,
        sessionTitle: row.sessionTitle,
        speakerName: row.speakerName,
        filename: row.filename,
        version: row.version,
        versionCount: row.versionCount,
        uploadedAt: row.uploadedAt,
        url: row.url,
        commentCount: row.commentCount,
      },
    ];
  });
}

function headshotDownloadFilename(
  originalFilename: string | undefined,
): string {
  if (originalFilename === undefined) return "headshot.webp";
  const dot = originalFilename.lastIndexOf(".");
  const rawStem = dot <= 0 ? originalFilename : originalFilename.slice(0, dot);
  const stem = rawStem.trim().replace(/[. ]+$/g, "");
  return `${stem.length === 0 ? "headshot" : stem}.webp`;
}

function genericHeadshotDownloadFilename(
  contentType: string | null | undefined,
): string | null {
  switch (contentType?.split(";", 1)[0]?.trim().toLowerCase()) {
    case "image/webp":
      return "headshot.webp";
    case "image/png":
      return "headshot.png";
    case "image/jpeg":
    case "image/jpg":
      return "headshot.jpg";
    default:
      return null;
  }
}

const FILE_LIBRARY_IO_BATCH = 100;
const fileLibraryEncoder = new TextEncoder();

function encodedDocumentBytes(value: unknown): number {
  return fileLibraryEncoder.encode(JSON.stringify(value)).length;
}

export function completeHeadshotContactPage(page: {
  page: unknown[];
  isDone: boolean;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
}): boolean {
  return (
    page.isDone &&
    page.pageStatus !== "SplitRequired" &&
    page.page.length <= FILE_LIBRARY_HEADSHOT_CONTACT_LIMIT &&
    encodedDocumentBytes(page.page) <= FILE_LIBRARY_HEADSHOT_CONTACT_BYTES
  );
}

async function mapInBatches<Input, Output>(
  rows: ReadonlyArray<Input>,
  operation: (row: Input) => Promise<Output>,
): Promise<Output[]> {
  const out: Output[] = [];
  for (let offset = 0; offset < rows.length; offset += FILE_LIBRARY_IO_BATCH) {
    out.push(
      ...(await Promise.all(
        rows.slice(offset, offset + FILE_LIBRARY_IO_BATCH).map(operation),
      )),
    );
  }
  return out;
}

/** Every current uploaded deliverable on the event — latest version per task
 * plus every current headshot referenced by an event-contact snapshot.
 *
 * The contact is the source of truth for whether a headshot is current. A
 * same-event, currently-attached secure-upload ticket may enrich that row with
 * provenance, but a copied directory/other-event/legacy blob still remains a
 * downloadable current file. In that fallback case we deliberately expose no
 * source actor, filename, timestamp, or history from another context. */
export async function filesLibrary(
  ctx: QueryCtx,
  caller: EventCaller,
  options?: { includeHeadshots?: boolean },
): Promise<LibraryFileRow[]> {
  requireOrganizer(caller);
  const includeHeadshots = options?.includeHeadshots ?? true;
  const [uploads, headshotContactPage, headshotUploads, comments] =
    await Promise.all([
      ctx.db
        .query("uploads")
        .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
        .take(FILE_LIBRARY_SCAN + 1),
      includeHeadshots
        ? ctx.db
            .query("eventContacts")
            .withIndex("by_eventId_and_headshotId", (q) =>
              q.eq("eventId", caller.event._id).gt("headshotId", undefined),
            )
            // Convex permits one paginated range per function. Spend it on
            // the only source whose legacy rows may contain hundreds of KiB
            // of custom profile values. A byte split is an explicit refusal,
            // never a partial files view.
            .paginate({
              cursor: null,
              numItems: FILE_LIBRARY_HEADSHOT_CONTACT_LIMIT + 1,
              maximumRowsRead: FILE_LIBRARY_HEADSHOT_CONTACT_LIMIT + 1,
              maximumBytesRead: FILE_LIBRARY_HEADSHOT_CONTACT_BYTES,
            })
        : Promise.resolve({
            page: [] as Array<Doc<"eventContacts">>,
            isDone: true,
            pageStatus: null,
          }),
      includeHeadshots
        ? ctx.db
            .query("headshotUploads")
            .withIndex("by_eventId_and_attachedAt", (q) =>
              q.eq("eventId", caller.event._id).gt("attachedAt", undefined),
            )
            .take(FILE_LIBRARY_SCAN + 1)
        : Promise.resolve([] as Array<Doc<"headshotUploads">>),
      ctx.db
        .query("uploadComments")
        .withIndex("by_eventId", (q) => q.eq("eventId", caller.event._id))
        .take(FILE_LIBRARY_SCAN + 1),
    ]);
  const headshotContacts = headshotContactPage.page;
  if (uploads.length > FILE_LIBRARY_SCAN) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event has more than 300 uploaded file versions. The files library refuses a partial version history.",
    });
  }
  if (!completeHeadshotContactPage(headshotContactPage)) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event has more than 64 current headshots or its headshot profiles exceed the 2 MiB safe read budget. The files library refuses a partial view.",
    });
  }
  if (headshotUploads.length > FILE_LIBRARY_SCAN) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event has more than 300 attached headshot versions. The files library cannot report complete same-event history safely.",
    });
  }
  if (comments.length > FILE_LIBRARY_SCAN) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event has more than 300 file comments. The files library cannot report complete counts safely.",
    });
  }

  const byInstance = new Map<Id<"taskInstances">, Array<Doc<"uploads">>>();
  for (const upload of uploads) {
    const list = byInstance.get(upload.taskInstanceId) ?? [];
    list.push(upload);
    byInstance.set(upload.taskInstanceId, list);
  }
  const commentCount = new Map<Id<"taskInstances">, number>();
  for (const comment of comments) {
    commentCount.set(
      comment.instanceId,
      (commentCount.get(comment.instanceId) ?? 0) + 1,
    );
  }

  if (byInstance.size + headshotContacts.length > FILE_LIBRARY_CURRENT_LIMIT) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event has more than 120 current files. Select a smaller event before opening Files or building a bundle.",
    });
  }

  // Hydrate only relationships referenced by current file rows. The three
  // `.take` sources above have compact, write-bounded strings. Contacts are
  // different: legacy custom values can make one row approach the database's
  // document limit. Their indexed range has its own byte ceiling, and every
  // targeted get below is sequential and charged to this shared budget. At
  // most one max-size document can cross the soft ceiling before we refuse,
  // leaving ample room below Convex's 16 MiB transaction read limit.
  let hydrationBytes = encodedDocumentBytes(headshotContacts);
  function trackHydratedDocument<T>(document: T): T {
    if (document !== null && document !== undefined) {
      hydrationBytes += encodedDocumentBytes(document);
      if (hydrationBytes > FILE_LIBRARY_HYDRATION_BYTES) {
        throw new ConvexError({
          code: "files_export_too_large",
          message:
            "This event's file relationships exceed the 6 MiB safe read budget. The files library refuses a partial view.",
        });
      }
    }
    return document;
  }

  const instanceDocs: Array<Doc<"taskInstances"> | null> = [];
  for (const instanceId of byInstance.keys()) {
    instanceDocs.push(
      trackHydratedDocument(await ctx.db.get("taskInstances", instanceId)),
    );
  }
  const instanceById = new Map<Id<"taskInstances">, Doc<"taskInstances">>();
  for (const instance of instanceDocs) {
    if (instance !== null && instance.eventId === caller.event._id) {
      instanceById.set(instance._id, instance);
    }
  }

  const taskCandidates = [...byInstance].flatMap(([instanceId, list]) => {
    const instance = instanceById.get(instanceId);
    if (instance === undefined) return [];
    const latest = list.reduce((a, b) => (a.version >= b.version ? a : b));
    return [{ instance, latest, versionCount: list.length }];
  });
  const requirementIds = new Set(
    taskCandidates.map(({ instance }) => instance.requirementId),
  );
  const sessionIds = new Set(
    taskCandidates.map(({ instance }) => instance.sessionId),
  );
  const taskContactIds = new Set(
    taskCandidates.flatMap(({ instance }) =>
      instance.eventContactId === undefined ? [] : [instance.eventContactId],
    ),
  );
  if (sessionIds.size > FILE_LIBRARY_SESSION_LIMIT) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event's current files span more than 64 sessions. The files library refuses a partial view.",
    });
  }
  const headshotContactIds = new Set(
    headshotContacts.map((contact) => contact._id),
  );
  const additionalTaskContactIds = [...taskContactIds].filter(
    (eventContactId) => !headshotContactIds.has(eventContactId),
  );
  if (additionalTaskContactIds.length > FILE_LIBRARY_TASK_CONTACT_LIMIT) {
    throw new ConvexError({
      code: "files_export_too_large",
      message:
        "This event's task files span more than 16 additional speaker profiles. The files library refuses a partial view.",
    });
  }

  const contactById = new Map<Id<"eventContacts">, Doc<"eventContacts">>(
    headshotContacts.map((contact) => [contact._id, contact]),
  );
  for (const eventContactId of additionalTaskContactIds) {
    const contact = trackHydratedDocument(
      await ctx.db.get("eventContacts", eventContactId),
    );
    if (contact !== null && contact.eventId === caller.event._id) {
      contactById.set(contact._id, contact);
    }
  }
  const requirementById = new Map<Id<"requirements">, Doc<"requirements">>();
  for (const requirementId of requirementIds) {
    const requirement = trackHydratedDocument(
      await ctx.db.get("requirements", requirementId),
    );
    if (requirement !== null && requirement.eventId === caller.event._id) {
      requirementById.set(requirement._id, requirement);
    }
  }
  const sessionById = new Map<Id<"sessions">, Doc<"sessions">>();
  for (const sessionId of sessionIds) {
    const session = trackHydratedDocument(
      await ctx.db.get("sessions", sessionId),
    );
    if (session !== null && session.eventId === caller.event._id) {
      sessionById.set(session._id, session);
    }
  }

  const headshotVersions = new Map<
    Id<"eventContacts">,
    Array<Doc<"headshotUploads">>
  >();
  for (const upload of headshotUploads) {
    const versions = headshotVersions.get(upload.eventContactId) ?? [];
    versions.push(upload);
    headshotVersions.set(upload.eventContactId, versions);
  }
  for (const versions of headshotVersions.values()) {
    versions.sort(
      (a, b) =>
        (a.attachedAt ?? 0) - (b.attachedAt ?? 0) ||
        a._creationTime - b._creationTime,
    );
  }
  const headshotCandidates = headshotContacts.flatMap((contact) => {
    const storageId = contact.headshotId;
    if (storageId === undefined) return [];
    const versions = headshotVersions.get(contact._id) ?? [];
    // Replaced/retained/corrupt duplicate tickets must not be presented as
    // the current upload's provenance. Ambiguity falls back to an honest
    // generic row instead of choosing a potentially unrelated actor.
    const matches = versions.filter(
      (upload) =>
        upload.status === "attached" && upload.storageId === storageId,
    );
    const provenance = matches.length === 1 ? matches[0] : undefined;
    const version =
      provenance === undefined
        ? null
        : versions.findIndex((row) => row._id === provenance._id) + 1;
    return [{ contact, storageId, versions, provenance, version }];
  });

  // Only non-exact actors require user-row hydration. Reads are deduplicated,
  // sequential, and charged to the same byte budget as other relationships.
  const uploaderUserIds = new Set<Id<"users">>();
  const addUploaderIfNeeded = (
    userId: Id<"users">,
    eventContactId: Id<"eventContacts"> | undefined,
  ) => {
    if (
      eventContactId === undefined ||
      contactById.get(eventContactId)?.userId !== userId
    ) {
      uploaderUserIds.add(userId);
    }
  };
  for (const candidate of taskCandidates) {
    addUploaderIfNeeded(
      candidate.latest.uploadedBy,
      candidate.instance.eventContactId,
    );
  }
  for (const candidate of headshotCandidates) {
    if (candidate.provenance !== undefined) {
      addUploaderIfNeeded(
        candidate.provenance.uploadedByUserId,
        candidate.contact._id,
      );
    }
  }
  // W5: a file whose uploader IS recorded must name that person. The generic
  // "Event contributor" placeholder this used to emit was the worst of both
  // worlds — it read like a resolved actor while naming nobody, and it fired
  // whenever the account's own profile carried no name even though the event
  // knew exactly who they were. Resolve through the SAME chain every other
  // attribution surface uses (`eventUserDisplayName`: exact contact snapshot →
  // auth profile → the event's own unambiguous snapshot), and when that chain
  // genuinely resolves nothing, say so instead of inventing a label.
  const stableUploaders = new Map<Id<"users">, DisplayNameResolution>();
  for (const userId of uploaderUserIds) {
    const user = trackHydratedDocument(await ctx.db.get("users", userId));
    stableUploaders.set(
      userId,
      await resolveEventUserDisplayName(ctx, caller.event._id, user),
    );
  }
  const uploaderResolution = (
    userId: Id<"users">,
    eventContactId: Id<"eventContacts"> | undefined,
  ): DisplayNameResolution => {
    const exact =
      eventContactId === undefined
        ? undefined
        : contactById.get(eventContactId);
    if (exact?.userId === userId) {
      const exactName = `${exact.firstName} ${exact.lastName}`
        .trim()
        .replace(/\s+/g, " ");
      if (exactName !== "") return { name: exactName, reason: "resolved" };
    }
    return (
      stableUploaders.get(userId) ?? { name: null, reason: "no_user" as const }
    );
  };
  /**
   * Honest copy for each distinct way a name can be missing — produced here so
   * no route has to guess which kind of blank it is looking at, and so the
   * three are never collapsed into one flattering sentence:
   *   • no provenance row at all — nobody was ever recorded;
   *   • the account exists and has set no display name;
   *   • the account record is gone, or the event holds conflicting names for
   *     it, so this upload cannot be attributed to a person at all.
   */
  const uploaderNote = (
    resolution: DisplayNameResolution | null,
  ): string | null => {
    if (resolution === null) {
      return "The uploader was not recorded for this file.";
    }
    switch (resolution.reason) {
      case "resolved":
        return null;
      case "unnamed_account":
        return "Uploaded by an account that has not set a display name.";
      case "no_user":
      case "ambiguous":
        return "Not attributable: the uploading account's record is missing, or this event holds more than one name for it.";
    }
  };

  // A provenance-less headshot may predate normalization or may be copied
  // from another event. Read only target storage metadata: never source-event
  // tickets. Unsupported/unknown bytes remain listed but receive no URL or
  // misleading extension.
  const genericStorageIds = new Set<Id<"_storage">>();
  for (const candidate of headshotCandidates) {
    if (candidate.provenance === undefined) {
      genericStorageIds.add(candidate.storageId);
    }
  }
  const metadataEntries = await mapInBatches(
    [...genericStorageIds],
    async (storageId) =>
      [storageId, await ctx.db.system.get(storageId)] as const,
  );
  const metadataByStorageId = new Map(metadataEntries);
  const genericFilenameByStorageId = new Map<Id<"_storage">, string | null>();
  for (const storageId of genericStorageIds) {
    genericFilenameByStorageId.set(
      storageId,
      genericHeadshotDownloadFilename(
        metadataByStorageId.get(storageId)?.contentType,
      ),
    );
  }

  const downloadableStorageIds = new Set<Id<"_storage">>();
  for (const candidate of taskCandidates) {
    downloadableStorageIds.add(candidate.latest.storageId);
  }
  for (const candidate of headshotCandidates) {
    if (
      candidate.provenance !== undefined ||
      genericFilenameByStorageId.get(candidate.storageId) !== null
    ) {
      downloadableStorageIds.add(candidate.storageId);
    }
  }
  const urlEntries = await mapInBatches(
    [...downloadableStorageIds],
    async (storageId) =>
      [storageId, await ctx.storage.getUrl(storageId)] as const,
  );
  const urlByStorageId = new Map(urlEntries);

  const taskRows: LibraryFileRow[] = taskCandidates.map(
    ({ instance, latest, versionCount }) => {
      const requirement = requirementById.get(instance.requirementId);
      const session = sessionById.get(instance.sessionId);
      const contact =
        instance.eventContactId === undefined
          ? null
          : (contactById.get(instance.eventContactId) ?? null);
      const taskUploader = uploaderResolution(
        latest.uploadedBy,
        instance.eventContactId,
      );
      return {
        fileId: `task:${instance._id}`,
        kind: "task",
        instanceId: instance._id,
        requirementTitle: requirement?.title ?? "(deleted requirement)",
        sessionId: instance.sessionId,
        sessionTitle: session?.title ?? "(deleted session)",
        speakerName:
          contact === null
            ? null
            : `${contact.firstName} ${contact.lastName}`.trim(),
        sourceFilename: null,
        filename: latest.filename,
        version: latest.version,
        versionCount,
        uploadedByName: taskUploader.name,
        uploadedByNote: uploaderNote(taskUploader),
        uploadedAt: latest._creationTime,
        url: urlByStorageId.get(latest.storageId) ?? null,
        commentCount: commentCount.get(instance._id) ?? 0,
      };
    },
  );
  const headshotRows: LibraryFileRow[] = headshotCandidates.map(
    ({ contact, storageId, versions, provenance, version }) => {
      const genericFilename = genericFilenameByStorageId.get(storageId) ?? null;
      // No provenance row means nobody was recorded — a different fact from
      // "recorded, but we cannot name them".
      const headshotUploader =
        provenance === undefined
          ? null
          : uploaderResolution(provenance.uploadedByUserId, contact._id);
      return {
        fileId: `headshot:${contact._id}`,
        kind: "headshot",
        instanceId: null,
        requirementTitle: "Speaker headshot",
        sessionId: null,
        sessionTitle: "Speaker profile",
        speakerName: `${contact.firstName} ${contact.lastName}`.trim(),
        sourceFilename: provenance?.originalFilename ?? null,
        filename:
          provenance === undefined
            ? (genericFilename ?? "headshot")
            : headshotDownloadFilename(provenance.originalFilename),
        version: provenance === undefined || version === 0 ? null : version,
        versionCount: provenance === undefined ? null : versions.length,
        uploadedByName: headshotUploader?.name ?? null,
        uploadedByNote: uploaderNote(headshotUploader),
        uploadedAt: provenance?.attachedAt ?? null,
        url:
          provenance === undefined && genericFilename === null
            ? null
            : (urlByStorageId.get(storageId) ?? null),
        commentCount: 0,
      };
    },
  );

  const out = [...taskRows, ...headshotRows];
  return out.sort((a, b) => {
    if (a.uploadedAt === null && b.uploadedAt !== null) return 1;
    if (a.uploadedAt !== null && b.uploadedAt === null) return -1;
    if (a.uploadedAt !== null && b.uploadedAt !== null) {
      const newestFirst = b.uploadedAt - a.uploadedAt;
      if (newestFirst !== 0) return newestFirst;
    }
    return (
      (a.speakerName ?? a.sessionTitle).localeCompare(
        b.speakerName ?? b.sessionTitle,
      ) || a.fileId.localeCompare(b.fileId)
    );
  });
}

export type BundleFile = {
  filename: string;
  url: string | null;
  sessionTitle: string;
  speakerName: string | null;
  requirementTitle: string;
};

/** The latest version of each selected deliverable, for the client-side ZIP
 * (CNT-14). `fileIds` empty means every current file, except the legacy
 * `instanceIds: []` compatibility path, which still means every task upload. */
export async function exportBundle(
  ctx: QueryCtx,
  caller: EventCaller,
  fileIds: string[],
  legacyTaskOnly = false,
): Promise<BundleFile[]> {
  requireOrganizer(caller);
  if (!legacyTaskOnly && fileIds.length > FILE_LIBRARY_CURRENT_LIMIT) {
    throw new ConvexError({
      code: "too_many",
      message: `Select at most ${FILE_LIBRARY_CURRENT_LIMIT} files at a time.`,
    });
  }
  const all = await filesLibrary(ctx, caller, {
    includeHeadshots: !legacyTaskOnly,
  });
  const eligible = legacyTaskOnly
    ? all.filter((row) => row.kind === "task")
    : all;
  const selected = new Set(fileIds);
  const wanted =
    selected.size === 0
      ? eligible
      : eligible.filter((row) => selected.has(row.fileId));
  return wanted.map((row) => ({
    filename: row.filename,
    url: row.url,
    sessionTitle: row.sessionTitle,
    speakerName: row.speakerName,
    requirementTitle: row.requirementTitle,
  }));
}
