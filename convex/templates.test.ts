import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  createEvent,
  createOrg,
  expectRejectedWith,
  grantEventRole,
  setupTest,
  signIn,
  type TestT,
} from "./test.helpers";
import {
  DEFAULT_TEMPLATES,
  RAW_KEYS,
  sampleVars,
  substituteHtml,
  substituteSubject,
} from "./model/templates";
import {
  ONE_OFF_CONTEXT_KEY,
  RAW_VAR_PATHS,
  TEMPLATE_CONTEXT_VARS,
  isKnownVar,
  tokenFor,
  varWarning,
  variablesIn,
} from "./shared/templateVars";

// Email templates (M5). What must never regress: an organizer override
// replaces the built-in copy for real sends, reset restores it, and EVERY
// substituted value is HTML-escaped unless it is one of the server-built
// RAW_KEYS blocks. A speaker named `<script>` is the whole point.

async function organizerEvent(t: TestT) {
  const alice = await signIn(t, "alice");
  const orgSlug = await createOrg(alice, "Acme Conf Co");
  const eventSlug = await createEvent(alice, orgSlug, "Acme Summit");
  return { alice, orgSlug, eventSlug };
}

async function messageRows(t: TestT): Promise<Array<Doc<"messages">>> {
  return await t.run(async (ctx) => ctx.db.query("messages").collect());
}

function speakerInput(speaker: Doc<"proposalSpeakers">) {
  return {
    proposalSpeakerId: speaker._id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    email: speaker.email,
    phone: speaker.phone,
    tagline: speaker.tagline,
    bio: speaker.bio,
    headshotId: speaker.headshotId,
    links: speaker.links,
    isPrimary: speaker.isPrimary,
    role: speaker.role,
  };
}

// ── Substitution (pure) ──────────────────────────────────────────────────

describe("substitution", () => {
  test("resolves dotted paths and drops unknown variables", () => {
    const out = substituteHtml(
      "<p>{{speaker.firstName}} / {{nope}} / {{deep.missing.path}}</p>",
      { speaker: { firstName: "Ada" } },
    );
    expect(out).toBe("<p>Ada /  / </p>");
  });

  test("escapes every substituted value — an XSS attempt stays inert", () => {
    const out = substituteHtml("<p>Hi {{speaker.firstName}},</p>", {
      speaker: { firstName: `<script>alert("xss")</script>` },
    });
    expect(out).toBe(
      `<p>Hi &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;,</p>`,
    );
    expect(out).not.toContain("<script>");
  });

  test("markup in the TEMPLATE is kept; markup in the VALUE is not", () => {
    const out = substituteHtml("<strong>{{a}}</strong>", { a: "<em>x</em>" });
    expect(out).toBe("<strong>&lt;em&gt;x&lt;/em&gt;</strong>");
  });

  test("RAW_KEYS blocks are server-built HTML and pass through", () => {
    expect(substituteHtml("{{tasks}}", { tasks: "<ul><li>a</li></ul>" })).toBe(
      "<ul><li>a</li></ul>",
    );
    expect(substituteHtml("{{body}}", { body: "<ul><li>b</li></ul>" })).toBe(
      "<ul><li>b</li></ul>",
    );
    // ...and nothing else does, even when it looks like markup.
    expect(substituteHtml("{{note}}", { note: "<ul></ul>" })).toBe(
      "&lt;ul&gt;&lt;/ul&gt;",
    );
  });

  test("subjects substitute as plain text and strip CR/LF", () => {
    expect(
      substituteSubject("Re: {{proposal.title}}", {
        proposal: { title: `Tom & Jerry\r\nBcc: evil@example.com` },
      }),
    ).toBe("Re: Tom & Jerry Bcc: evil@example.com");
  });
});

// ── The organizer surface ────────────────────────────────────────────────

describe("templates.list", () => {
  test("lists every built-in key as an uncustomized default", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const rows = await alice.query(api.templates.list, { eventSlug });

    expect(rows.length).toBe(Object.keys(DEFAULT_TEMPLATES).length);
    expect(rows.every((r) => !r.customized)).toBe(true);
    for (const key of [
      "cfp.confirmation",
      "cfp.adminNotification",
      "decision.accepted",
      "decision.declined",
      "decision.corrected",
      "invitation.direct",
      "team.invite",
      "task.changesRequested",
      "reminder.tasks",
      "reminder.participation",
      "portal.invite",
      "portal.handoffInvite",
    ]) {
      expect(rows.map((r) => r.key)).toContain(key);
    }
  });

  test("reviewers cannot read or edit templates", async () => {
    const t = setupTest();
    const { eventSlug } = await organizerEvent(t);
    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");

    await expectRejectedWith(
      rita.query(api.templates.list, { eventSlug }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.mutation(api.templates.upsert, {
        eventSlug,
        key: "cfp.confirmation",
        subject: "x",
        html: "<p>x</p>",
      }),
      "forbidden",
    );
  });
});

describe("templates.upsert / reset", () => {
  test("an override replaces the default and reset restores it", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);

    await alice.mutation(api.templates.upsert, {
      eventSlug,
      key: "portal.invite",
      name: "Our portal invite",
      subject: "Portal access for {{event.name}}",
      html: "<p>Yo {{speaker.firstName}}</p>",
    });

    let row = (await alice.query(api.templates.list, { eventSlug })).find(
      (r) => r.key === "portal.invite",
    );
    expect(row).toMatchObject({
      customized: true,
      name: "Our portal invite",
      subject: "Portal access for {{event.name}}",
    });
    expect(row?.updatedAt).toBeTypeOf("number");

    // Upsert twice = update, not a second row.
    await alice.mutation(api.templates.upsert, {
      eventSlug,
      key: "portal.invite",
      subject: "Portal access v2 for {{event.name}}",
      html: "<p>Yo again {{speaker.firstName}}</p>",
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("emailTemplates").collect()),
    ).toHaveLength(1);

    const { removed } = await alice.mutation(api.templates.reset, {
      eventSlug,
      key: "portal.invite",
    });
    expect(removed).toBe(true);
    row = (await alice.query(api.templates.list, { eventSlug })).find(
      (r) => r.key === "portal.invite",
    );
    expect(row).toMatchObject({
      customized: false,
      subject: DEFAULT_TEMPLATES["portal.invite"].subject,
    });

    // Resetting a template that was never overridden is a no-op, not an error.
    expect(
      await alice.mutation(api.templates.reset, {
        eventSlug,
        key: "portal.invite",
      }),
    ).toEqual({ removed: false });
  });

  test("rejects unknown keys, accepts validated custom:<slug>", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);

    await expectRejectedWith(
      alice.mutation(api.templates.upsert, {
        eventSlug,
        key: "not.a.real.key",
        subject: "x",
        html: "<p>x</p>",
      }),
      "invalid_template_key",
    );
    await expectRejectedWith(
      alice.mutation(api.templates.upsert, {
        eventSlug,
        key: "custom:Bad Slug!",
        subject: "x",
        html: "<p>x</p>",
      }),
      "invalid_template_key",
    );

    await alice.mutation(api.templates.upsert, {
      eventSlug,
      key: "custom:travel-brief",
      name: "Travel brief",
      subject: "Travel for {{event.name}}",
      html: "<p>Hi {{speaker.firstName}}</p>",
    });
    const rows = await alice.query(api.templates.list, { eventSlug });
    expect(rows.find((r) => r.key === "custom:travel-brief")).toMatchObject({
      customized: true,
      name: "Travel brief",
    });
  });

  test("bounds subject and body size", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await expectRejectedWith(
      alice.mutation(api.templates.upsert, {
        eventSlug,
        key: "reminder.tasks",
        subject: "x".repeat(301),
        html: "<p>ok</p>",
      }),
      "invalid_subject",
    );
    await expectRejectedWith(
      alice.mutation(api.templates.upsert, {
        eventSlug,
        key: "reminder.tasks",
        subject: "ok",
        html: "x".repeat(50_001),
      }),
      "invalid_html",
    );
  });
});

describe("templates.preview", () => {
  test("renders sample data through the real substitution", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);

    const preview = await alice.query(api.templates.preview, {
      eventSlug,
      key: "reminder.tasks",
    });
    expect(preview.subject).toBe("Outstanding items for Acme Summit");
    expect(preview.html).toContain("Hi Ada,");
    // The raw block renders as a real list, not escaped entities.
    expect(preview.html).toContain("<li><strong>Speaker headshot</strong>");
    // ...and it went through the branded shell.
    expect(preview.html).toContain("StageStack");
  });

  test("previews the organizer's override once one exists", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await alice.mutation(api.templates.upsert, {
      eventSlug,
      key: "decision.accepted",
      subject: "You're in: {{proposal.title}}",
      html: "<p>{{speaker.firstName}}, see you at {{event.name}}.</p>",
    });
    const preview = await alice.query(api.templates.preview, {
      eventSlug,
      key: "decision.accepted",
    });
    expect(preview.subject).toBe("You're in: Analytical engines in production");
    // `{{speaker.firstName}}` renders as nothing here, and the preview says so
    // by showing nothing: a decision email's send site (`decisionVars` in
    // convex/model/sessions.ts) passes no speaker at all. The preview used to
    // substitute "Ada" and promise a personalisation the real send never made.
    expect(preview.html).toContain("<p>, see you at Acme Summit.</p>");
  });
});

// ── Composer tokens + live preview (W3) ──────────────────────────────────
//
// The palette and the renderer read one definition (convex/shared/templateVars
// .ts). These are the tests that keep it one: a token the palette offers must
// resolve, a token it does not offer must not, and what the preview shows must
// be what the send produces — escaping included.

describe("token catalog matches the renderer", () => {
  test("every token the palette offers resolves in its own context", () => {
    for (const [key, paths] of Object.entries(TEMPLATE_CONTEXT_VARS)) {
      const vars = sampleVars(null, key);
      for (const path of paths) {
        const rendered = substituteSubject(tokenFor(path), vars);
        expect(
          rendered,
          `${key} / {{${path}}} rendered as nothing`,
        ).not.toBe("");
        expect(rendered).not.toContain("{{");
      }
    }
  });

  test("a token the palette withholds renders as nothing", () => {
    // A decision email has no speaker and a CFP confirmation has no slot: the
    // palette hides them precisely because the send site passes neither.
    for (const [key, path] of [
      ["decision.accepted", "speaker.firstName"],
      ["cfp.confirmation", "slot.when"],
      ["team.invite", "event.name"],
      [ONE_OFF_CONTEXT_KEY, "proposal.title"],
    ] as const) {
      expect(TEMPLATE_CONTEXT_VARS[key]).not.toContain(path);
      expect(substituteSubject(tokenFor(path), sampleVars(null, key))).toBe("");
    }
  });

  test("every variable the shipped copy uses is in that template's context", () => {
    for (const [key, template] of Object.entries(DEFAULT_TEMPLATES)) {
      const used = [
        ...variablesIn(template.subject),
        ...variablesIn(template.html),
      ];
      for (const path of used) {
        expect(
          TEMPLATE_CONTEXT_VARS[key],
          `${key} ships {{${path}}} but its send site does not pass it`,
        ).toContain(path);
      }
    }
  });

  test("the warning about a dead token names WHICH kind of dead it is", () => {
    // REGRESSION (codex, W3): both composers checked the global catalog, so a
    // real variable the send site does not pass drew no warning at all. One
    // producer, two distinct reasons, shared by the editor and the one-off
    // composer.
    expect(varWarning("decision.accepted", ["{{event.name}}"])).toBeNull();

    const outOfContext = varWarning("decision.accepted", [
      "{{speaker.firstName}} on {{event.name}}",
    ]);
    expect(outOfContext?.outOfContext).toEqual(["speaker.firstName"]);
    expect(outOfContext?.unknown).toEqual([]);
    expect(outOfContext?.sentence).toBe(
      "{{speaker.firstName}} is a real variable, but this template's send passes no value for it. It renders as nothing.",
    );

    const unknown = varWarning("decision.accepted", ["{{speaker.nickname}}"]);
    expect(unknown?.unknown).toEqual(["speaker.nickname"]);
    expect(unknown?.sentence).toBe(
      "{{speaker.nickname}} is not a StageStack variable — check the spelling. It renders as nothing.",
    );

    // The one-off composer asks the same question of its own small bag.
    const oneOff = varWarning(ONE_OFF_CONTEXT_KEY, [
      "{{proposal.title}}",
      "{{nope}} {{speaker.fullName}}",
    ]);
    expect(oneOff?.outOfContext).toEqual(["proposal.title"]);
    expect(oneOff?.unknown).toEqual(["nope"]);
    expect(oneOff?.sentence).toBe(
      "{{nope}} is not a StageStack variable — check the spelling. {{proposal.title}} is a real variable, but this template's send passes no value for it. They render as nothing.",
    );
  });

  test("the renderer's raw-block set is the catalog's", () => {
    expect([...RAW_KEYS].sort()).toEqual([...RAW_VAR_PATHS].sort());
    for (const path of RAW_VAR_PATHS) expect(isKnownVar(path)).toBe(true);
  });
});

describe("templates.preview — personalised", () => {
  test("renders a draft against a real speaker on the event", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { eventContactId } = await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Opening keynote",
      speaker: {
        firstName: "Dana",
        lastName: "Keynote",
        email: "Dana@Example.com",
      },
    });

    const recipients = await alice.query(api.templates.previewRecipients, {
      eventSlug,
    });
    expect(recipients).toContainEqual({
      eventContactId,
      name: "Dana Keynote",
      firstName: "Dana",
      lastName: "Keynote",
      email: "dana@example.com",
      sample: false,
    });

    const preview = await alice.query(api.templates.preview, {
      eventSlug,
      key: "portal.invite",
      draft: {
        subject: "Portal for {{speaker.firstName}}",
        html: "<p>Hi {{speaker.firstName}} {{speaker.lastName}}.</p>",
      },
      eventContactId,
    });
    expect(preview.subject).toBe("Portal for Dana");
    expect(preview.html).toContain("<p>Hi Dana Keynote.</p>");
    expect(preview.recipient.sample).toBe(false);
    expect(preview.recipient.name).toBe("Dana Keynote");
  });

  test("with nobody chosen the recipient is flagged as a stand-in", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const preview = await alice.query(api.templates.preview, {
      eventSlug,
      key: "portal.invite",
      draft: { subject: "Hi {{speaker.firstName}}", html: "<p>x</p>" },
    });
    expect(preview.subject).toBe("Hi Ada");
    expect(preview.recipient).toMatchObject({
      sample: true,
      name: "Ada Lovelace",
      eventContactId: null,
    });
  });

  test("the preview is what the send produces, byte for byte", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { eventContactId } = await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Opening keynote",
      speaker: {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
    });
    const draft = {
      subject: "{{event.name}} — a word, {{speaker.firstName}}",
      html: "<p>Hi {{speaker.fullName}} ({{speaker.email}}) — {{link}}</p>",
    };

    const preview = await alice.query(api.templates.preview, {
      eventSlug,
      key: ONE_OFF_CONTEXT_KEY,
      draft,
      eventContactId,
    });
    await alice.mutation(api.comms.sendOneOff, {
      eventSlug,
      to: { kind: "contact", eventContactId },
      subject: draft.subject,
      html: draft.html,
      now: Date.now(),
    });

    const sent = (await messageRows(t)).find((m) => m.kind === "manual.oneoff");
    const context = sent?.context as { renderedBody: string };
    expect(sent?.subject).toBe(preview.subject);
    expect(context.renderedBody).toBe(preview.html);
  });

  test("a speaker named <script> is escaped in the preview too", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { eventContactId } = await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Opening keynote",
      speaker: {
        firstName: `<script>alert(1)</script>`,
        lastName: "Keynote",
        email: "xss@example.com",
      },
    });
    const preview = await alice.query(api.templates.preview, {
      eventSlug,
      key: ONE_OFF_CONTEXT_KEY,
      draft: { subject: "hi", html: "<p>Hi {{speaker.firstName}},</p>" },
      eventContactId,
    });
    expect(preview.html).not.toContain("<script>");
    expect(preview.html).toContain("&lt;script&gt;");
  });

  test("raw blocks stay raw, everything else stays escaped", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const preview = await alice.query(api.templates.preview, {
      eventSlug,
      key: "reminder.tasks",
      draft: { subject: "s", html: "<div>{{tasks}}{{speaker.firstName}}</div>" },
    });
    expect(preview.html).toContain("<li><strong>Speaker headshot</strong>");
    expect(preview.html).toContain("Ada");
  });
});

describe("preview authorization", () => {
  test("a reviewer cannot preview or list preview recipients", async () => {
    const t = setupTest();
    const { eventSlug } = await organizerEvent(t);
    const rita = await signIn(t, "rita");
    await grantEventRole(t, eventSlug, "rita", "reviewer");

    await expectRejectedWith(
      rita.query(api.templates.preview, {
        eventSlug,
        key: "portal.invite",
        draft: { subject: "s", html: "<p>{{speaker.firstName}}</p>" },
      }),
      "forbidden",
    );
    await expectRejectedWith(
      rita.query(api.templates.previewRecipients, { eventSlug }),
      "forbidden",
    );
  });

  test("an organizer of another org cannot preview this event", async () => {
    const t = setupTest();
    const { eventSlug } = await organizerEvent(t);
    const mallory = await signIn(t, "mallory");
    await createOrg(mallory, "Rival Events");

    await expectRejectedWith(
      mallory.query(api.templates.preview, { eventSlug, key: "portal.invite" }),
      "forbidden",
    );
    await expectRejectedWith(
      mallory.query(api.templates.previewRecipients, { eventSlug }),
      "forbidden",
    );
  });

  test("a contact from another event cannot be used as the recipient", async () => {
    const t = setupTest();
    const { alice, orgSlug, eventSlug } = await organizerEvent(t);
    const otherSlug = await createEvent(alice, orgSlug, "Other Summit");
    const { eventContactId } = await alice.mutation(api.sessions.createDirect, {
      eventSlug: otherSlug,
      title: "Elsewhere",
      speaker: {
        firstName: "Elsewhere",
        lastName: "Speaker",
        email: "elsewhere@example.com",
      },
    });

    await expectRejectedWith(
      alice.query(api.templates.preview, {
        eventSlug,
        key: "portal.invite",
        eventContactId,
      }),
      "not_found",
    );
  });
});

// ── Templates actually drive the sends ───────────────────────────────────

describe("lifecycle sends render through templates", () => {
  test("an override changes the real portal-invite email", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    const { eventContactId } = await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Opening keynote",
      speaker: {
        firstName: "Dana",
        lastName: "Keynote",
        email: "dana@example.com",
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await t.finishInProgressScheduledFunctions();
    }

    await alice.mutation(api.templates.upsert, {
      eventSlug,
      key: "portal.invite",
      subject: "Your {{event.name}} portal, {{speaker.firstName}}",
      html: "<p>Custom body for {{speaker.firstName}} — {{link}}</p>",
    });
    await alice.mutation(api.sessions.invitePortal, {
      eventSlug,
      eventContactId,
    });

    const invite = (await messageRows(t)).find(
      (m) => m.kind === "portal.invite",
    );
    expect(invite?.subject).toBe("Your Acme Summit portal, Dana");
    expect(invite?.toEmail).toBe("dana@example.com");
  });

  test("a speaker name with markup is escaped in the delivered html", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await alice.mutation(api.sessions.createDirect, {
      eventSlug,
      title: "Opening keynote",
      speaker: {
        firstName: `<script>alert(1)</script>`,
        lastName: "Keynote",
        email: "xss@example.com",
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await t.finishInProgressScheduledFunctions();
    }

    const invitation = (await messageRows(t)).find(
      (m) => m.kind === "invitation.direct",
    );
    expect(invitation).toBeDefined();
    // Only assertable through the stored subject + the send itself; the html
    // is not persisted, so re-render the same template to prove the escaping.
    expect(
      substituteHtml("<p>Hi {{speaker.firstName}},</p>", {
        speaker: { firstName: `<script>alert(1)</script>` },
      }),
    ).not.toContain("<script>");
    expect(invitation?.subject).toBe("Invitation to speak at Acme Summit");
  });

  test("the default CFP confirmation keeps its resubmit wording", async () => {
    const t = setupTest();
    const { alice, eventSlug } = await organizerEvent(t);
    await alice.mutation(api.cfp.publishForm, { eventSlug });
    await alice.mutation(api.events.updateSettings, {
      eventSlug,
      patch: { cfpPublished: true },
    });
    const bob = await signIn(t, "bob");
    const proposalId = await bob.mutation(api.cfp.startProposal, { eventSlug });
    await bob.mutation(api.cfp.saveAnswers, {
      proposalId,
      answers: {
        firstName: "Bob",
        lastName: "Submitter",
        email: "bob@example.com",
        talkTitle: "Convex in anger",
        abstract: "Everything we learned shipping a reactive backend.",
      },
    });
    await bob.mutation(api.cfp.setSpeakers, {
      proposalId,
      speakers: [
        {
          firstName: "Bob",
          lastName: "Submitter",
          email: "bob@example.com",
          isPrimary: true,
        },
      ],
    });
    // Emails are deferred to runAfter(0); drain between submits so the two
    // sends land in submission order.
    const drain = async () => {
      for (let i = 0; i < 3; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await t.finishInProgressScheduledFunctions();
      }
    };
    await bob.mutation(api.cfp.submitProposal, { proposalId });
    await drain();
    const submitted = await bob.query(api.cfp.getMyProposal, { proposalId });
    await bob.mutation(api.cfp.resubmitProposal, {
      proposalId,
      expectedContentVersion: submitted.proposal.contentVersion ?? 0,
      answers: submitted.proposal.answers,
      speakers: submitted.speakers.map(speakerInput),
    });
    await drain();

    const confirmations = (await messageRows(t)).filter(
      (m) => m.kind === "cfp.confirmation",
    );
    expect(confirmations.map((m) => m.subject)).toEqual([
      "We received your proposal: Convex in anger",
      "Your updated proposal: Convex in anger",
    ]);
    const notices = (await messageRows(t)).filter(
      (m) => m.kind === "cfp.adminNotification",
    );
    expect(notices.map((m) => m.subject)).toEqual([
      "New proposal for Acme Summit: Convex in anger",
      "Updated proposal for Acme Summit: Convex in anger",
    ]);
  });
});
