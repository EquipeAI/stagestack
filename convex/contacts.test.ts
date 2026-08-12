import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
} from "./test.helpers";

const profile = (over: Record<string, unknown> = {}) => ({
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@example.com",
  tagline: "Rear Admiral, USN",
  ...over,
});

describe("contacts", () => {
  test("create, list, and search-filter the org directory", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");

    const graceId = await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile(),
    });
    await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile({
        firstName: "Alan",
        lastName: "Turing",
        email: "  ALAN@Example.com ",
        tagline: "Cryptanalyst",
      }),
    });

    const all = await alice.query(api.contacts.list, { orgSlug });
    // Sorted by "first last".
    expect(all.map((c) => c.firstName)).toEqual(["Alan", "Grace"]);
    // Emails are trimmed + lower-cased.
    expect(all[0].email).toBe("alan@example.com");

    const filtered = await alice.query(api.contacts.list, {
      orgSlug,
      search: "hopper",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]._id).toBe(graceId);

    const byTagline = await alice.query(api.contacts.list, {
      orgSlug,
      search: "cryptanalyst",
    });
    expect(byTagline.map((c) => c.lastName)).toEqual(["Turing"]);
  });

  test("rejects a duplicate email in the same org, and a malformed email", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Acme Conf Co");
    await alice.mutation(api.contacts.create, { orgSlug, profile: profile() });

    await expectRejectedWith(
      alice.mutation(api.contacts.create, {
        orgSlug,
        profile: profile({ firstName: "Other" }),
      }),
      "duplicate_email",
    );
    await expectRejectedWith(
      alice.mutation(api.contacts.create, {
        orgSlug,
        profile: profile({ email: "not-an-email" }),
      }),
      "invalid_email",
    );
  });

  test("tags reject silent truncation and oversized values", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "Tag Limits Co");
    const contactId = await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile(),
    });

    await expectRejectedWith(
      alice.mutation(api.contacts.setTags, {
        orgSlug,
        contactId,
        tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
      }),
      "too_many_tags",
    );
    await expectRejectedWith(
      alice.mutation(api.contacts.setTags, {
        orgSlug,
        contactId,
        tags: ["x".repeat(61)],
      }),
      "invalid_name",
    );
  });

  test("the same email is allowed in a different org", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob");
    const orgA = await createOrg(alice, "Acme Conf Co");
    const orgB = await createOrg(bob, "Beta Events");

    await alice.mutation(api.contacts.create, {
      orgSlug: orgA,
      profile: profile(),
    });
    const idB = await bob.mutation(api.contacts.create, {
      orgSlug: orgB,
      profile: profile(),
    });
    expect(idB).toBeTruthy();

    expect(await bob.query(api.contacts.list, { orgSlug: orgB })).toHaveLength(
      1,
    );
  });

  test("update rewrites the profile and rejects a cross-org contact id", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob");
    const orgA = await createOrg(alice, "Acme Conf Co");
    const orgB = await createOrg(bob, "Beta Events");

    const id = await alice.mutation(api.contacts.create, {
      orgSlug: orgA,
      profile: profile(),
    });
    await alice.mutation(api.contacts.update, {
      orgSlug: orgA,
      contactId: id,
      profile: profile({ tagline: "Compiler pioneer", phone: "+1 555 0100" }),
    });
    const [updated] = await alice.query(api.contacts.list, { orgSlug: orgA });
    expect(updated.tagline).toBe("Compiler pioneer");
    expect(updated.phone).toBe("+1 555 0100");

    // Bob owns orgB but the contact lives in orgA.
    await expectRejectedWith(
      bob.mutation(api.contacts.update, {
        orgSlug: orgB,
        contactId: id,
        profile: profile({ tagline: "Hijacked" }),
      }),
      "not_found",
    );
  });

  test("NEGATIVE: a user from another org cannot list or create in this org", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob");
    const orgA = await createOrg(alice, "Acme Conf Co");
    await createOrg(bob, "Beta Events");

    await expectRejectedWith(
      bob.query(api.contacts.list, { orgSlug: orgA }),
      "forbidden",
    );
    await expectRejectedWith(
      bob.mutation(api.contacts.create, { orgSlug: orgA, profile: profile() }),
      "forbidden",
    );
    await expectRejectedWith(
      t.query(api.contacts.list, { orgSlug: orgA }),
      "not_authenticated",
    );
  });

  test("CSV import is bounded, deterministic, and reports duplicate and invalid rows", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "CRM Import Co");

    const result = await alice.mutation(api.contacts.importCsvBatch, {
      orgSlug,
      rows: [
        {
          rowNumber: 2,
          firstName: " Ada ",
          lastName: "Lovelace",
          email: " ADA@example.com ",
          company: "Babbage",
          bio: "First programmer.",
        },
        {
          rowNumber: 3,
          firstName: "Duplicate",
          lastName: "Ada",
          email: "ada@example.com",
        },
        { rowNumber: 4, firstName: "Bad", lastName: "Address", email: "nope" },
      ],
    });

    expect(result).toMatchObject({ received: 3, imported: 1, skipped: 2 });
    expect(result.errors.map((row) => row.rowNumber)).toEqual([3, 4]);
    const contacts = await alice.query(api.contacts.list, { orgSlug });
    expect(contacts).toMatchObject([
      {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        company: "Babbage",
        bio: "First programmer.",
      },
    ]);

    await expectRejectedWith(
      alice.mutation(api.contacts.importCsvBatch, { orgSlug, rows: [] }),
      "invalid_batch",
    );

    const invalidTags = await alice.mutation(api.contacts.importCsvBatch, {
      orgSlug,
      rows: [
        {
          rowNumber: 5,
          firstName: "Katherine",
          lastName: "Johnson",
          email: "katherine@example.com",
          tags: ["x".repeat(61)],
        },
      ],
    });
    expect(invalidTags).toMatchObject({ imported: 0, skipped: 1 });
    expect(invalidTags.errors[0]?.rowNumber).toBe(5);
  });

  test("event-only organizers can use the directory but not org-wide CRM operations", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const dave = await signIn(t, "dave");
    const orgSlug = await createOrg(alice, "Scoped CRM Co");
    const eventSlug = await createEvent(alice, orgSlug, "Dave's Event");
    await grantEventRole(t, eventSlug, "dave", "organizer");
    const primaryId = await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile({ email: "grace.one@example.com" }),
    });
    const secondaryId = await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile({ email: "grace.two@example.com" }),
    });

    expect(await dave.query(api.contacts.list, { orgSlug })).toHaveLength(2);
    await expectRejectedWith(
      dave.query(api.contacts.nearDuplicates, { orgSlug }),
      "forbidden",
    );
    await expectRejectedWith(
      dave.mutation(api.contacts.importCsvBatch, {
        orgSlug,
        rows: [
          {
            rowNumber: 2,
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
          },
        ],
      }),
      "forbidden",
    );
    await expectRejectedWith(
      dave.mutation(api.contacts.setPipelineStage, {
        orgSlug,
        contactId: primaryId,
        stage: "contacted",
      }),
      "forbidden",
    );
    await expectRejectedWith(
      dave.mutation(api.contacts.sendBulkOutreach, {
        orgSlug,
        contactIds: [primaryId, secondaryId],
        subject: "Hello",
        body: "Body",
      }),
      "forbidden",
    );
    await expectRejectedWith(
      dave.mutation(api.contacts.merge, {
        orgSlug,
        primaryId,
        secondaryId,
      }),
      "forbidden",
    );
  });

  test("near duplicates merge fields and rewire notes, snapshots, messages, and stage history", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "CRM Merge Co");
    const primaryId = await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile({
        email: "grace.one@example.com",
        company: undefined,
        links: { website: "https://grace.example.com" },
      }),
    });
    const secondaryId = await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile({
        email: "grace.two@example.com",
        company: "Navy",
        phone: "+1 555",
        links: { linkedin: "https://linkedin.example/grace" },
      }),
    });
    await alice.mutation(api.contacts.setTags, {
      orgSlug,
      contactId: primaryId,
      tags: ["keynote"],
    });
    await alice.mutation(api.contacts.setTags, {
      orgSlug,
      contactId: secondaryId,
      tags: ["alumni"],
    });
    await alice.mutation(api.contacts.addNote, {
      orgSlug,
      contactId: secondaryId,
      body: "Met in London",
    });
    await alice.mutation(api.contacts.setPipelineStage, {
      orgSlug,
      contactId: secondaryId,
      stage: "contacted",
    });

    await t.run(async (ctx) => {
      const org = await ctx.db
        .query("organizations")
        .withIndex("by_slug", (q) => q.eq("slug", orgSlug))
        .unique();
      if (!org) throw new Error("missing org");
      const eventId = await ctx.db.insert("events", {
        orgId: org._id,
        name: "Event",
        slug: "crm-merge-event",
        startsAt: 1,
        endsAt: 2,
        timezone: "UTC",
        cfpPublished: false,
      });
      await ctx.db.insert("eventContacts", {
        orgId: org._id,
        eventId,
        contactId: secondaryId,
        firstName: "Grace",
        lastName: "Hopper",
      });
      await ctx.db.insert("messages", {
        orgId: org._id,
        contactId: secondaryId,
        toEmail: "grace.two@example.com",
        kind: "test",
        subject: "Hello",
        deliveryStatus: "failed",
      });
    });

    const duplicates = await alice.query(api.contacts.nearDuplicates, {
      orgSlug,
    });
    expect(duplicates.pairs).toHaveLength(1);
    const merged = await alice.mutation(api.contacts.merge, {
      orgSlug,
      primaryId,
      secondaryId,
    });
    expect(merged.rewired).toBe(4);
    const [contact] = await alice.query(api.contacts.list, { orgSlug });
    expect(contact).toMatchObject({
      _id: primaryId,
      company: "Navy",
      phone: "+1 555",
      tags: ["keynote", "alumni"],
      pipelineStage: "contacted",
      links: {
        website: "https://grace.example.com",
        linkedin: "https://linkedin.example/grace",
      },
    });
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("contactNotes")
          .withIndex("by_contactId", (q) => q.eq("contactId", primaryId))
          .take(10),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("eventContacts")
          .withIndex("by_contactId", (q) => q.eq("contactId", primaryId))
          .take(10),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("messages")
          .withIndex("by_contactId", (q) => q.eq("contactId", primaryId))
          .take(10),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("contactPipelineHistory")
          .withIndex("by_contactId", (q) => q.eq("contactId", primaryId))
          .take(10),
      ).toHaveLength(1);
      expect(await ctx.db.get("contacts", secondaryId)).toBeNull();
    });
  });

  test("merge refuses same-event identity collisions before deleting either contact", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "CRM Collision Co");
    const eventSlug = await createEvent(alice, orgSlug, "Shared Event");
    const primaryId = await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile({ email: "grace.one@example.com" }),
    });
    const secondaryId = await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile({ email: "grace.two@example.com" }),
    });
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (q) => q.eq("slug", eventSlug))
        .unique();
      if (event === null) throw new Error("missing event");
      for (const contactId of [primaryId, secondaryId]) {
        await ctx.db.insert("eventContacts", {
          orgId: event.orgId,
          eventId: event._id,
          contactId,
          firstName: "Grace",
          lastName: "Hopper",
        });
      }
    });

    await expectRejectedWith(
      alice.mutation(api.contacts.merge, {
        orgSlug,
        primaryId,
        secondaryId,
      }),
      "merge_event_conflict",
    );
    await t.run(async (ctx) => {
      expect(await ctx.db.get("contacts", primaryId)).not.toBeNull();
      expect(await ctx.db.get("contacts", secondaryId)).not.toBeNull();
    });
  });

  test("near-duplicate discovery reports when its 100-pair result is capped", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const orgSlug = await createOrg(alice, "CRM Pair Cap Co");
    for (let index = 0; index < 15; index += 1) {
      await alice.mutation(api.contacts.create, {
        orgSlug,
        profile: profile({ email: `grace-${index}@example.com` }),
      });
    }
    const result = await alice.query(api.contacts.nearDuplicates, { orgSlug });
    expect(result.pairs).toHaveLength(100);
    expect(result.capped).toBe(true);
  });

  test("pipeline, dynamic segments, overview, and bulk outreach persist with auth isolation", async () => {
    const t = setupTest();
    const alice = await signIn(t, "alice");
    const bob = await signIn(t, "bob");
    const orgSlug = await createOrg(alice, "CRM Ops Co");
    const bobOrg = await createOrg(bob, "Other CRM Co");
    const bobContactId = await bob.mutation(api.contacts.create, {
      orgSlug: bobOrg,
      profile: profile({ email: "bob-contact@example.com" }),
    });
    const firstId = await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile({ company: "Acme" }),
    });
    const secondId = await alice.mutation(api.contacts.create, {
      orgSlug,
      profile: profile({
        firstName: "Katherine",
        lastName: "Johnson",
        email: undefined,
        company: "Acme",
      }),
    });
    await expectRejectedWith(
      bob.mutation(api.contacts.sendBulkOutreach, {
        orgSlug: bobOrg,
        // The valid id comes first. Audience preflight must still reject the
        // later foreign id before any external send is attempted.
        contactIds: [bobContactId, firstId],
        subject: "Should not send",
        body: "Audience is invalid",
      }),
      "not_found",
    );
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("messages")
          .withIndex("by_contactId", (q) => q.eq("contactId", bobContactId))
          .take(10),
      ).toHaveLength(0);
    });
    await alice.mutation(api.contacts.setPipelineStage, {
      orgSlug,
      contactId: firstId,
      stage: "shortlisted",
    });
    const history = await alice.query(api.contacts.pipelineHistory, {
      orgSlug,
      contactId: firstId,
    });
    expect(history[0]).toMatchObject({
      fromStage: null,
      toStage: "shortlisted",
    });

    await alice.mutation(api.contacts.saveSegment, {
      orgSlug,
      name: "Acme shortlist",
      filters: { company: "Acme", search: "grace" },
    });
    expect(await alice.query(api.contacts.segments, { orgSlug })).toMatchObject(
      [
        {
          name: "Acme shortlist",
          filters: { company: "Acme", search: "grace" },
        },
      ],
    );
    expect(await alice.query(api.contacts.overview, { orgSlug })).toMatchObject(
      {
        totalContacts: 2,
        withEmail: 1,
        enrolled: 1,
        capped: false,
        topCompanies: [{ company: "Acme", count: 2 }],
      },
    );

    const sent = await alice.mutation(api.contacts.sendBulkOutreach, {
      orgSlug,
      contactIds: [firstId, secondId],
      subject: "Hello {{speaker.firstName}}",
      body: "Invitation for {{speaker.fullName}} at {{speaker.company}}",
    });
    expect(sent.selected).toBe(2);
    expect(sent.skipped).toBe(1);
    expect(sent.queued + sent.failed).toBe(1);
    await t.run(async (ctx) => {
      const [message] = await ctx.db
        .query("messages")
        .withIndex("by_contactId", (q) => q.eq("contactId", firstId))
        .take(10);
      expect(message.subject).toBe("Hello Grace");
      expect(message.eventId).toBeUndefined();
      expect(message.context).toMatchObject({
        source: "crm",
        renderedSubject: "Hello Grace",
        renderedBody: "Invitation for Grace Hopper at Acme",
      });
      for (let index = 0; index < 51; index += 1) {
        await ctx.db.insert("messages", {
          orgId: message.orgId,
          contactId: firstId,
          toEmail: "grace@example.com",
          kind: "test.nonCrm",
          subject: `Noise ${index}`,
          deliveryStatus: "failed",
        });
      }
    });
    const outreach = await alice.query(api.contacts.outreachHistory, {
      orgSlug,
      contactId: firstId,
    });
    expect(outreach).toHaveLength(1);
    expect(outreach[0]?.subject).toBe("Hello Grace");

    await expectRejectedWith(
      bob.mutation(api.contacts.merge, {
        orgSlug: bobOrg,
        primaryId: firstId,
        secondaryId: secondId,
      }),
      "not_found",
    );
    await expectRejectedWith(
      t.query(api.contacts.overview, { orgSlug }),
      "not_authenticated",
    );
  });
});
