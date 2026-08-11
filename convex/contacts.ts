import { v } from "convex/values";
import { orgMutation, orgQuery } from "./lib/functions";
import { vv } from "./lib/validators";
import * as Contacts from "./model/contacts";

const vProfileInput = v.object({
  firstName: v.string(),
  lastName: v.string(),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  tagline: v.optional(v.string()),
  jobTitle: v.optional(v.string()),
  company: v.optional(v.string()),
  bio: v.optional(v.string()),
  headshotId: v.optional(v.id("_storage")),
  links: v.optional(
    v.object({
      website: v.optional(v.string()),
      twitter: v.optional(v.string()),
      linkedin: v.optional(v.string()),
      github: v.optional(v.string()),
    }),
  ),
});

const vStage = v.union(
  v.literal("sourced"),
  v.literal("contacted"),
  v.literal("shortlisted"),
  v.literal("confirmed"),
  v.literal("declined"),
);

const vSegmentFilters = v.object({
  search: v.optional(v.string()),
  tag: v.optional(v.string()),
  company: v.optional(v.string()),
});

export const list = orgQuery({
  args: { search: v.optional(v.string()) },
  returns: v.array(vv.doc("contacts")),
  handler: async (ctx, args) => {
    return await Contacts.listContacts(ctx, ctx.caller, args.search);
  },
});

export const create = orgMutation({
  args: { profile: vProfileInput },
  returns: v.id("contacts"),
  handler: async (ctx, args) => {
    return await Contacts.createContact(ctx, ctx.caller, args.profile);
  },
});

export const update = orgMutation({
  args: { contactId: v.id("contacts"), profile: vProfileInput },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Contacts.updateContact(ctx, ctx.caller, args.contactId, args.profile);
    return null;
  },
});

// ── Light CRM (W8) ───────────────────────────────────────────────────────

export const setTags = orgMutation({
  args: { contactId: v.id("contacts"), tags: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Contacts.setTags(ctx, ctx.caller, args.contactId, args.tags);
    return null;
  },
});

export const addNote = orgMutation({
  args: { contactId: v.id("contacts"), body: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Contacts.addNote(ctx, ctx.caller, args.contactId, args.body);
    return null;
  },
});

export const notes = orgQuery({
  args: { contactId: v.id("contacts") },
  returns: v.array(
    v.object({
      noteId: vv.id("contactNotes"),
      authorName: v.union(v.string(), v.null()),
      body: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    return await Contacts.listNotes(ctx, ctx.caller, args.contactId);
  },
});

export const connections = orgQuery({
  args: { contactId: v.id("contacts") },
  returns: v.array(
    v.object({
      eventId: vv.id("events"),
      eventName: v.string(),
      eventSlug: v.string(),
      startsAt: v.number(),
      sessions: v.array(v.object({ title: v.string(), state: v.string() })),
    }),
  ),
  handler: async (ctx, args) => {
    return await Contacts.connections(ctx, ctx.caller, args.contactId);
  },
});

export const addToEvent = orgMutation({
  args: { contactId: v.id("contacts"), eventId: v.id("events") },
  returns: v.object({ created: v.boolean() }),
  handler: async (ctx, args) => {
    return await Contacts.addToEvent(
      ctx,
      ctx.caller,
      args.contactId,
      args.eventId,
    );
  },
});

export const importCsvBatch = orgMutation({
  args: {
    rows: v.array(
      v.object({
        rowNumber: v.number(),
        firstName: v.string(),
        lastName: v.string(),
        email: v.string(),
        company: v.optional(v.string()),
        jobTitle: v.optional(v.string()),
        bio: v.optional(v.string()),
        tags: v.optional(v.array(v.string())),
      }),
    ),
  },
  returns: v.object({
    received: v.number(),
    imported: v.number(),
    skipped: v.number(),
    errors: v.array(v.object({ rowNumber: v.number(), message: v.string() })),
  }),
  handler: async (ctx, args) =>
    await Contacts.importContacts(ctx, ctx.caller, args.rows),
});

export const nearDuplicates = orgQuery({
  args: {},
  returns: v.object({
    pairs: v.array(
      v.object({ primary: vv.doc("contacts"), secondary: vv.doc("contacts") }),
    ),
    scanned: v.number(),
    capped: v.boolean(),
  }),
  handler: async (ctx) => await Contacts.nearDuplicates(ctx, ctx.caller),
});

export const merge = orgMutation({
  args: { primaryId: v.id("contacts"), secondaryId: v.id("contacts") },
  returns: v.object({ rewired: v.number() }),
  handler: async (ctx, args) =>
    await Contacts.mergeContacts(
      ctx,
      ctx.caller,
      args.primaryId,
      args.secondaryId,
    ),
});

export const setPipelineStage = orgMutation({
  args: {
    contactId: v.id("contacts"),
    stage: v.union(vStage, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await Contacts.setPipelineStage(
      ctx,
      ctx.caller,
      args.contactId,
      args.stage,
    );
    return null;
  },
});

export const pipelineHistory = orgQuery({
  args: { contactId: v.id("contacts") },
  returns: v.array(
    v.object({
      historyId: v.id("contactPipelineHistory"),
      fromStage: v.union(vStage, v.null()),
      toStage: v.union(vStage, v.null()),
      changedAt: v.number(),
      changedBy: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) =>
    await Contacts.pipelineHistory(ctx, ctx.caller, args.contactId),
});

export const saveSegment = orgMutation({
  args: { name: v.string(), filters: vSegmentFilters },
  returns: v.id("savedSegments"),
  handler: async (ctx, args) =>
    await Contacts.saveSegment(ctx, ctx.caller, args.name, args.filters),
});

export const segments = orgQuery({
  args: {},
  returns: v.array(vv.doc("savedSegments")),
  handler: async (ctx) => await Contacts.listSegments(ctx, ctx.caller),
});

export const overview = orgQuery({
  args: {},
  returns: v.object({
    totalContacts: v.number(),
    withEmail: v.number(),
    enrolled: v.number(),
    capped: v.boolean(),
    topCompanies: v.array(v.object({ company: v.string(), count: v.number() })),
  }),
  handler: async (ctx) => await Contacts.overview(ctx, ctx.caller),
});

export const sendBulkOutreach = orgMutation({
  args: {
    contactIds: v.array(v.id("contacts")),
    subject: v.string(),
    body: v.string(),
  },
  returns: v.object({
    selected: v.number(),
    queued: v.number(),
    failed: v.number(),
    skipped: v.number(),
    results: v.array(
      v.object({
        contactId: v.id("contacts"),
        status: v.union(
          v.literal("queued"),
          v.literal("failed"),
          v.literal("skipped_no_email"),
        ),
        messageId: v.union(v.id("messages"), v.null()),
      }),
    ),
  }),
  handler: async (ctx, args) =>
    await Contacts.sendBulkOutreach(
      ctx,
      ctx.caller,
      args.contactIds,
      args.subject,
      args.body,
    ),
});

export const outreachHistory = orgQuery({
  args: { contactId: v.id("contacts") },
  returns: v.array(
    v.object({
      messageId: v.id("messages"),
      subject: v.string(),
      toEmail: v.string(),
      deliveryStatus: v.union(
        v.literal("queued"),
        v.literal("sent"),
        v.literal("delivered"),
        v.literal("delivery_delayed"),
        v.literal("bounced"),
        v.literal("complained"),
        v.literal("failed"),
      ),
      sentAt: v.number(),
    }),
  ),
  handler: async (ctx, args) =>
    await Contacts.outreachHistory(ctx, ctx.caller, args.contactId),
});
