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
