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
