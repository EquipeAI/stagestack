/**
 * Demo-content seeding (S1 — "seeded demo event").
 *
 * Builds one self-contained demo organization + event so a reviewer (or an
 * agent connected over `/mcp`) lands in a populated workspace with nothing to
 * set up: a published CFP with proposals in every status, a launched review
 * round scored by more than one reviewer, a part-scheduled agenda carrying
 * deliberate conflicts, speakers at every readiness state, tasks in every
 * review state, and a published public page.
 *
 * INTERNAL ONLY, and deliberately so: these mutations write rows the
 * capability layer would normally author, which is exactly why they are not
 * reachable from a client. Run them with `npx convex run` against a
 * deployment you mean to populate.
 *
 * Personas all use plus-variations of one real inbox, so every email the demo
 * sends is deliverable and inspectable without touching a stranger's address.
 */
import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { rebuildProgram } from "./model/publish";

const ORG_SLUG = "meridian-conferences";
const EVENT_SLUG = "meridian-dev-summit-2026";

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

/** Persona addresses. By default every persona is a plus-variation of the
 * maintainer's inbox, so a solo rehearsal receives all the mail. Set the
 * `SEED_DEMO_EMAILS` deployment env var to a JSON object mapping persona tags
 * to real addresses (e.g. `{"reviewer3":"lena@example.com"}`) to hand personas
 * to real people: any tag absent from the map keeps its default. Because
 * `persona()` finds-or-creates by email, someone who signs in with Clerk
 * BEFORE the seed runs gets the persona's assignments attached to their real
 * account; speakers can also claim their portal after the fact, since the
 * portal matches on the verified email at entry. */
const email = (tag: string): string => {
  const raw = process.env.SEED_DEMO_EMAILS;
  if (raw !== undefined && raw !== "") {
    try {
      const map = JSON.parse(raw) as Record<string, unknown>;
      const mapped = map[tag];
      if (typeof mapped === "string" && mapped.includes("@")) return mapped;
    } catch {
      // Malformed JSON falls through to the default: a seed run must not
      // half-apply a mapping, and the default is always safe.
    }
  }
  return `alvaro+${tag}@equipeai.com.br`;
};

type PersonaSpec = {
  tag: string;
  first: string;
  last: string;
  jobTitle: string;
  company: string;
};

const PERSONAS: PersonaSpec[] = [
  {
    tag: "demo-organizer",
    first: "Maya",
    last: "Okonkwo",
    jobTitle: "Program Chair",
    company: "Meridian Conferences",
  },
  {
    tag: "reviewer1",
    first: "Priya",
    last: "Raman",
    jobTitle: "Principal Engineer",
    company: "Northwind",
  },
  {
    tag: "reviewer2",
    first: "Tomas",
    last: "Ferreira",
    jobTitle: "Staff SRE",
    company: "Cavalcade",
  },
  {
    tag: "reviewer3",
    first: "Lena",
    last: "Hoffmann",
    jobTitle: "Head of Platform",
    company: "Verano",
  },
  {
    tag: "speaker1",
    first: "Ada",
    last: "Whitfield",
    jobTitle: "Distinguished Engineer",
    company: "Loom Labs",
  },
  {
    tag: "speaker2",
    first: "Kenji",
    last: "Nakamura",
    jobTitle: "Director of Infrastructure",
    company: "Tidepool",
  },
  {
    tag: "speaker3",
    first: "Rosa",
    last: "Delgado",
    jobTitle: "Developer Advocate",
    company: "Bellwether",
  },
  {
    tag: "speaker4",
    first: "Omar",
    last: "Haddad",
    jobTitle: "Founding Engineer",
    company: "Quietriver",
  },
  {
    tag: "speaker5",
    first: "Ingrid",
    last: "Solberg",
    jobTitle: "ML Systems Lead",
    company: "Fjordline",
  },
  {
    tag: "speaker6",
    first: "Marcus",
    last: "Bell",
    jobTitle: "CTO",
    company: "Ravenhill",
  },
];

/** Find-or-create the user row for a persona. Demo personas get a synthetic
 * token identifier: they never sign in, they only need to be referenceable as
 * reviewers, submitters and portal claimants. A persona who later signs in
 * with the same email is a different row — which is correct, because the
 * identity would be a real Clerk subject rather than this placeholder. */
async function persona(
  ctx: MutationCtx,
  spec: PersonaSpec,
): Promise<Id<"users">> {
  const addr = email(spec.tag);
  const existing = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", addr))
    .first();
  if (existing !== null) return existing._id;
  return await ctx.db.insert("users", {
    tokenIdentifier: `seed-demo|${spec.tag}`,
    clerkSubject: `seed-demo-${spec.tag}`,
    email: addr,
    name: `${spec.first} ${spec.last}`,
  });
}

export const wipe = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", ORG_SLUG))
      .unique();
    if (org === null) return { deleted: 0 };
    let deleted = 0;
    const events = await ctx.db
      .query("events")
      .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
      .collect();
    const eventIds = new Set<string>(events.map((e) => e._id));

    // Full-table scans, filtered in code. A demo deployment holds thousands of
    // rows, not millions, and a wipe that misses a table is worse than a wipe
    // that reads a few extra pages.
    const eventScoped = [
      "eventMembers",
      "tracks",
      "tags",
      "rooms",
      "formats",
      "customFields",
      "uploadComments",
      "embeds",
      "proposalSpeakers",
      "reviewRounds",
      "roundReviewers",
      "reviews",
      "eventContacts",
      "sessions",
      "sessionParticipants",
      "requirements",
      "taskInstances",
      "uploads",
      "agendaItems",
      "publishedPrograms",
      "publicationFlags",
      "cfpForms",
      "savedViews",
      "emailTemplates",
      "proposals",
    ] as const;
    for (const table of eventScoped) {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) {
        if (!eventIds.has(row.eventId)) continue;
        await ctx.db.delete(table, row._id);
        deleted += 1;
      }
    }
    const orgScoped = [
      "contacts",
      "contactNotes",
      "members",
      "apiKeys",
      "auditLog",
      "messages",
      "invitations",
      "savedSegments",
    ] as const;
    for (const table of orgScoped) {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) {
        if (row.orgId !== org._id) continue;
        await ctx.db.delete(table, row._id);
        deleted += 1;
      }
    }
    for (const ev of events) {
      await ctx.db.delete("events", ev._id);
      deleted += 1;
    }
    await ctx.db.delete("organizations", org._id);
    deleted += 1;
    return { deleted };
  },
});

export const seed = internalMutation({
  args: { ownerEmail: v.string() },
  returns: v.object({
    orgSlug: v.string(),
    eventSlug: v.string(),
    orgId: v.string(),
    eventId: v.string(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const owner = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.ownerEmail))
      .first();
    if (owner === null) {
      throw new Error(
        `No user row for ${args.ownerEmail} — sign in once on this deployment first.`,
      );
    }

    const existingOrg = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", ORG_SLUG))
      .unique();
    if (existingOrg !== null) {
      throw new Error(
        `Organization "${ORG_SLUG}" already exists — run seedDemo:wipe first.`,
      );
    }

    const people: Record<string, Id<"users">> = {};
    for (const spec of PERSONAS) people[spec.tag] = await persona(ctx, spec);

    const orgId = await ctx.db.insert("organizations", {
      name: "Meridian Conferences",
      slug: ORG_SLUG,
      createdBy: owner._id,
    });
    await ctx.db.insert("members", {
      orgId,
      userId: owner._id,
      role: "owner",
    });
    await ctx.db.insert("members", {
      orgId,
      userId: people["demo-organizer"],
      role: "admin",
    });

    // ── Event ───────────────────────────────────────────────────────────
    // Two days, sixty days out: far enough that tasks are legitimately open,
    // near enough that overdue ones read as urgent rather than abandoned.
    // Aligned to 09:00 America/Los_Angeles (16:00 UTC in October, which is
    // PDT) rather than to whatever minute the seed happened to run: a demo
    // agenda whose sessions start at 10:59 reads as a bug to a reviewer.
    const startsAt = Math.floor((now + 60 * DAY) / DAY) * DAY + 16 * 60 * MIN;
    const eventId = await ctx.db.insert("events", {
      orgId,
      name: "Meridian Dev Summit 2026",
      slug: EVENT_SLUG,
      startsAt,
      endsAt: startsAt + DAY + 10 * 60 * MIN,
      timezone: "America/Los_Angeles",
      type: "Conference",
      location: "Fort Mason Center, San Francisco",
      website: "https://example.com/meridian",
      description:
        "Two days on the craft of building and running developer platforms — " +
        "the systems, the teams, and the agents now working alongside both.",
      cfpOpenAt: now - 60 * DAY,
      cfpCloseAt: now - 12 * DAY,
      cfpPublished: true,
      reminderCadenceDays: 5,
      replyTo: email("demo-organizer"),
      publicPageEnabled: true,
    });

    for (const [tag, role] of [
      ["demo-organizer", "organizer"],
      ["reviewer1", "reviewer"],
      ["reviewer2", "reviewer"],
      ["reviewer3", "reviewer"],
    ] as const) {
      await ctx.db.insert("eventMembers", {
        eventId,
        orgId,
        userId: people[tag],
        role,
      });
    }
    await ctx.db.insert("eventMembers", {
      eventId,
      orgId,
      userId: owner._id,
      role: "organizer",
    });

    // ── Library ─────────────────────────────────────────────────────────
    const rooms: Record<string, Id<"rooms">> = {};
    for (const [i, [name, capacity]] of (
      [
        ["Main Hall", 420],
        ["Studio A", 160],
        ["Workshop Room", 60],
      ] as const
    ).entries()) {
      rooms[name] = await ctx.db.insert("rooms", {
        eventId,
        name,
        capacity,
        order: i,
      });
    }
    const tracks: Record<string, Id<"tracks">> = {};
    for (const [i, [name, color]] of (
      [
        ["Platform", "#2F6FED"],
        ["AI & Agents", "#B4530A"],
        ["Craft", "#1F7A5C"],
      ] as const
    ).entries()) {
      tracks[name] = await ctx.db.insert("tracks", {
        eventId,
        name,
        order: i,
        color,
      });
    }
    const formats: Record<string, Id<"formats">> = {};
    for (const [i, [name, mins]] of (
      [
        ["Talk (30 min)", 30],
        ["Deep dive (45 min)", 45],
        ["Workshop (120 min)", 120],
      ] as const
    ).entries()) {
      formats[name] = await ctx.db.insert("formats", {
        eventId,
        name,
        defaultDurationMinutes: mins,
        order: i,
      });
    }

    // ── CFP form (published) ────────────────────────────────────────────
    const formDef = {
      sections: [
        {
          id: "sec-talk",
          title: "Your talk",
          description: "Tell us what you want to present.",
          fields: [
            {
              id: "talkTitle",
              kind: "text" as const,
              label: "Talk title",
              required: true,
              systemKey: "talkTitle" as const,
            },
            {
              id: "abstract",
              kind: "textarea" as const,
              label: "Abstract",
              help: "Around 150 words. This is what reviewers read first.",
              required: true,
              systemKey: "abstract" as const,
            },
            {
              id: "format",
              kind: "dropdown" as const,
              label: "Format",
              required: true,
              options: ["Talk (30 min)", "Deep dive (45 min)", "Workshop (120 min)"],
            },
            {
              id: "workshopNeeds",
              kind: "textarea" as const,
              label: "What do attendees need installed?",
              required: true,
              visibleIf: {
                fieldId: "format",
                op: "equals" as const,
                value: "Workshop (120 min)",
              },
            },
            {
              id: "track",
              kind: "dropdown" as const,
              label: "Best-fit track",
              required: false,
              options: ["Platform", "AI & Agents", "Craft"],
            },
            {
              id: "level",
              kind: "radio" as const,
              label: "Audience level",
              required: true,
              options: ["Introductory", "Intermediate", "Advanced"],
            },
          ],
        },
        {
          id: "sec-you",
          title: "About you",
          fields: [
            {
              id: "firstName",
              kind: "text" as const,
              label: "First name",
              required: true,
              systemKey: "firstName" as const,
            },
            {
              id: "lastName",
              kind: "text" as const,
              label: "Last name",
              required: true,
              systemKey: "lastName" as const,
            },
            {
              id: "email",
              kind: "email" as const,
              label: "Email",
              required: true,
              systemKey: "email" as const,
            },
            {
              id: "priorTalks",
              kind: "url" as const,
              label: "A recording of a previous talk",
              required: false,
            },
          ],
        },
      ],
    };
    await ctx.db.insert("cfpForms", {
      eventId,
      working: formDef,
      published: formDef,
      version: 3,
      publishedAt: now - 58 * DAY,
      maxSubmissionsPerUser: 3,
      successMessage:
        "Thanks — we'll be in touch once the review round closes.",
      updatedAt: now - 58 * DAY,
    });

    // ── Proposals, one per status ───────────────────────────────────────
    type ProposalSpec = {
      title: string;
      status:
        | "draft"
        | "pending"
        | "acceptQueue"
        | "declineQueue"
        | "accepted"
        | "declined"
        | "withdrawn";
      submitter: string;
      speakers: string[];
      format: string;
      track: string;
      level: string;
      abstract: string;
    };
    const proposalSpecs: ProposalSpec[] = [
      {
        title: "Paved roads that people actually walk on",
        status: "accepted",
        submitter: "speaker1",
        speakers: ["speaker1"],
        format: "Talk (30 min)",
        track: "Platform",
        level: "Intermediate",
        abstract:
          "Golden paths fail when they are longer than the cowpath. A field report on measuring the friction of your own platform before you widen it.",
      },
      {
        title: "Running agents against production, carefully",
        status: "accepted",
        submitter: "speaker2",
        speakers: ["speaker2", "speaker5"],
        format: "Deep dive (45 min)",
        track: "AI & Agents",
        level: "Advanced",
        abstract:
          "Scoped credentials, reversible writes, and an audit trail a human can read. What we changed before we let an agent touch a live system.",
      },
      {
        title: "The incident review that changed our on-call",
        status: "accepted",
        submitter: "speaker3",
        speakers: ["speaker3"],
        format: "Talk (30 min)",
        track: "Craft",
        level: "Introductory",
        abstract:
          "One postmortem, rewritten four times, and the organisational habit it eventually replaced.",
      },
      {
        title: "Build a deploy pipeline you can explain",
        status: "accepted",
        submitter: "speaker4",
        speakers: ["speaker4"],
        format: "Workshop (120 min)",
        track: "Platform",
        level: "Intermediate",
        abstract:
          "A hands-on session: start from a repo with no CI and end with a pipeline whose every stage you can justify out loud.",
      },
      {
        title: "Retrieval is not the hard part",
        status: "acceptQueue",
        submitter: "speaker5",
        speakers: ["speaker5"],
        format: "Talk (30 min)",
        track: "AI & Agents",
        level: "Advanced",
        abstract:
          "Everything downstream of the retriever — ranking, grounding, and knowing when to say nothing — with numbers from a year in production.",
      },
      {
        title: "Migrating a monolith nobody understands",
        status: "pending",
        submitter: "speaker6",
        speakers: ["speaker6"],
        format: "Deep dive (45 min)",
        track: "Platform",
        level: "Intermediate",
        abstract:
          "Archaeology first, refactoring second. How we mapped a fifteen-year-old system before touching a line of it.",
      },
      {
        title: "Type systems for people who dislike type systems",
        status: "pending",
        submitter: "speaker3",
        speakers: ["speaker3"],
        format: "Talk (30 min)",
        track: "Craft",
        level: "Introductory",
        abstract:
          "Where types pay for themselves, where they charge rent, and how to tell the difference on your own codebase.",
      },
      {
        title: "Ten things wrong with your Kubernetes cluster",
        status: "declineQueue",
        submitter: "speaker6",
        speakers: ["speaker6"],
        format: "Talk (30 min)",
        track: "Platform",
        level: "Intermediate",
        abstract:
          "A listicle talk, submitted honestly as one. Ten misconfigurations, ranked by how much they will cost you.",
      },
      {
        title: "Why we rewrote our frontend (again)",
        status: "declined",
        submitter: "speaker4",
        speakers: ["speaker4"],
        format: "Talk (30 min)",
        track: "Craft",
        level: "Introductory",
        abstract:
          "The third rewrite in four years, and the argument that finally made the fourth unnecessary.",
      },
      {
        title: "Serverless at the edge of reason",
        status: "withdrawn",
        submitter: "speaker2",
        speakers: ["speaker2"],
        format: "Talk (30 min)",
        track: "Platform",
        level: "Advanced",
        abstract:
          "Cold starts, regional failover, and the bill. Withdrawn by the speaker after a scheduling clash.",
      },
      {
        title: "Notes toward a talk about observability",
        status: "draft",
        submitter: "speaker1",
        speakers: ["speaker1"],
        format: "Talk (30 min)",
        track: "Craft",
        level: "Intermediate",
        abstract:
          "Still drafting — the through-line is that dashboards are a symptom, not a practice.",
      },
    ];

    const bySpec = new Map(PERSONAS.map((p) => [p.tag, p]));
    const proposalIds: Record<string, Id<"proposals">> = {};
    for (const [i, spec] of proposalSpecs.entries()) {
      const submittedAt =
        spec.status === "draft" ? undefined : now - (50 - i) * DAY;
      const answers: Record<string, string> = {
        talkTitle: spec.title,
        abstract: spec.abstract,
        format: spec.format,
        track: spec.track,
        level: spec.level,
        firstName: bySpec.get(spec.submitter)!.first,
        lastName: bySpec.get(spec.submitter)!.last,
        email: email(spec.submitter),
      };
      if (spec.format === "Workshop (120 min)") {
        answers.workshopNeeds =
          "Node 22, Docker, and a GitHub account with a repo they can break.";
      }
      const proposalId = await ctx.db.insert("proposals", {
        eventId,
        submitterUserId: people[spec.submitter],
        status: spec.status,
        title: spec.title,
        answers,
        formVersion: 3,
        contentVersion: 1,
        submittedAt,
        updatedAt: submittedAt ?? now - 20 * DAY,
        withdrawnAt: spec.status === "withdrawn" ? now - 18 * DAY : undefined,
      });
      proposalIds[spec.title] = proposalId;
      for (const [order, tag] of spec.speakers.entries()) {
        const p = bySpec.get(tag)!;
        await ctx.db.insert("proposalSpeakers", {
          proposalId,
          eventId,
          order,
          firstName: p.first,
          lastName: p.last,
          email: email(tag),
          tagline: `${p.jobTitle}, ${p.company}`,
          bio: `${p.first} ${p.last} works on ${p.company}'s platform team.`,
          isPrimary: order === 0,
          role: order === 0 ? "Speaker" : "Co-speaker",
        });
      }
    }

    // ── Review round (launched) ─────────────────────────────────────────
    const scorecard = [
      {
        id: "relevance",
        label: "Relevance to the audience",
        kind: "numeric" as const,
        required: true,
        min: 1,
        max: 5,
        weight: 2,
      },
      {
        id: "depth",
        label: "Depth and originality",
        kind: "numeric" as const,
        required: true,
        min: 1,
        max: 5,
        weight: 1,
      },
      {
        id: "recommendation",
        label: "Recommendation",
        kind: "dropdown" as const,
        required: true,
        options: ["Accept", "Maybe", "Reject"],
      },
      {
        id: "notes",
        label: "Notes for the committee",
        kind: "text" as const,
        required: false,
      },
    ];
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId,
      name: "Round 1 — full committee",
      order: 0,
      opensAt: now - 11 * DAY,
      closesAt: now + 4 * DAY,
      anonymized: false,
      reviewerCap: 8,
      scorecard,
      updatedAt: now - 11 * DAY,
    });
    for (const tag of ["reviewer1", "reviewer2", "reviewer3"]) {
      await ctx.db.insert("roundReviewers", {
        eventId,
        roundId,
        userId: people[tag],
      });
    }

    // Reviewer 1 is done, reviewer 2 is most of the way, reviewer 3 has not
    // started — so `review_progress` has a real completion board to report
    // and the round is legitimately still open.
    const reviewable = proposalSpecs.filter((s) => s.status !== "draft");
    const plan: Array<[string, number, number, string, string]> = [];
    for (const [i, spec] of reviewable.entries()) {
      const accepting =
        spec.status === "accepted" || spec.status === "acceptQueue";
      const rejecting =
        spec.status === "declined" || spec.status === "declineQueue";
      const rel = accepting ? 5 : rejecting ? 2 : 4;
      const dep = accepting ? 4 : rejecting ? 2 : 3;
      const rec = accepting ? "Accept" : rejecting ? "Reject" : "Maybe";
      plan.push(["reviewer1", rel, dep, rec, spec.title]);
      // Reviewer 2 skips two of them — their board shows 8 of 10.
      if (i % 5 !== 3) {
        plan.push([
          "reviewer2",
          Math.max(1, rel - 1),
          Math.min(5, dep + 1),
          rec,
          spec.title,
        ]);
      }
      plan.push(["reviewer3", 0, 0, "", spec.title]);
    }
    for (const [tag, rel, dep, rec, title] of plan) {
      const submitted = rec !== "";
      const weighted = submitted ? (rel * 2 + dep * 1) / 3 : undefined;
      await ctx.db.insert("reviews", {
        eventId,
        proposalId: proposalIds[title],
        reviewerUserId: people[tag],
        roundId,
        status: submitted ? "submitted" : "assigned",
        answers: submitted
          ? {
              relevance: rel,
              depth: dep,
              recommendation: rec,
              notes:
                rec === "Accept"
                  ? "Strong fit — I'd give this the main hall."
                  : rec === "Reject"
                    ? "Well-argued but we've run this topic twice."
                    : "Would take it if the schedule allows.",
            }
          : undefined,
        contentVersion: 1,
        weightedScore: weighted,
        score: submitted ? Math.round(weighted!) : undefined,
        recommendation: submitted
          ? rec === "Accept"
            ? "accept"
            : rec === "Reject"
              ? "decline"
              : "neutral"
          : undefined,
        submittedAt: submitted ? now - 6 * DAY : undefined,
        updatedAt: submitted ? now - 6 * DAY : now - 11 * DAY,
      });
    }
    // One declared conflict of interest, so the reassignment surface isn't
    // hypothetical.
    await ctx.db.insert("reviews", {
      eventId,
      proposalId: proposalIds["Retrieval is not the hard part"],
      reviewerUserId: people["reviewer2"],
      roundId,
      status: "conflict",
      conflictNote: "I manage this speaker's team.",
      contentVersion: 1,
      updatedAt: now - 9 * DAY,
    });

    // ── Speakers (event contacts) at every readiness state ──────────────
    type SpeakerState = {
      tag: string;
      bio: boolean;
      headshot: boolean;
      claimed: boolean;
    };
    const speakerStates: SpeakerState[] = [
      { tag: "speaker1", bio: true, headshot: true, claimed: true },
      { tag: "speaker2", bio: true, headshot: true, claimed: true },
      { tag: "speaker3", bio: true, headshot: false, claimed: true },
      { tag: "speaker4", bio: false, headshot: false, claimed: false },
      { tag: "speaker5", bio: true, headshot: false, claimed: false },
      { tag: "speaker6", bio: false, headshot: false, claimed: false },
    ];
    const contactIds: Record<string, Id<"contacts">> = {};
    const eventContactIds: Record<string, Id<"eventContacts">> = {};
    for (const st of speakerStates) {
      const p = bySpec.get(st.tag)!;
      const profile = {
        firstName: p.first,
        lastName: p.last,
        email: email(st.tag),
        tagline: `${p.jobTitle}, ${p.company}`,
        jobTitle: p.jobTitle,
        company: p.company,
        bio: st.bio
          ? `${p.first} ${p.last} is ${p.jobTitle} at ${p.company}, where the ` +
            `work is mostly about making the boring parts boring again. ` +
            `Previously at two companies that no longer exist.`
          : undefined,
      };
      contactIds[st.tag] = await ctx.db.insert("contacts", {
        orgId,
        ...profile,
        tags: ["speaker", "summit-2026"],
        pipelineStage: "confirmed",
      });
      eventContactIds[st.tag] = await ctx.db.insert("eventContacts", {
        eventId,
        orgId,
        contactId: contactIds[st.tag],
        ...profile,
        userId: st.claimed ? people[st.tag] : undefined,
      });
    }

    // ── Sessions ────────────────────────────────────────────────────────
    // Day 1 starts at 09:00 local; the seed works in UTC offsets from the
    // event start, which is enough for a demo grid that reads sensibly.
    const day1 = startsAt;
    const day2 = startsAt + DAY;
    const at = (base: number, hours: number): number =>
      base + hours * 60 * MIN;

    type SessionSpec = {
      title: string;
      proposal?: string;
      speakers: string[];
      track: string;
      format: string;
      duration: number;
      slot?: { start: number; room: string };
      contentDraft?: boolean;
      description?: string;
    };
    const sessionSpecs: SessionSpec[] = [
      {
        title: "Paved roads that people actually walk on",
        proposal: "Paved roads that people actually walk on",
        speakers: ["speaker1"],
        track: "Platform",
        format: "Talk (30 min)",
        duration: 30,
        slot: { start: at(day1, 1), room: "Main Hall" },
        description:
          "Golden paths fail when they are longer than the cowpath. A field report on measuring the friction of your own platform before you widen it.",
      },
      {
        title: "Running agents against production, carefully",
        proposal: "Running agents against production, carefully",
        speakers: ["speaker2", "speaker5"],
        track: "AI & Agents",
        format: "Deep dive (45 min)",
        duration: 45,
        slot: { start: at(day1, 2), room: "Main Hall" },
        description:
          "Scoped credentials, reversible writes, and an audit trail a human can read.",
      },
      {
        // DELIBERATE CONFLICT #1 — same room, overlapping with the deep dive
        // above. Blocker-level: the board and readiness both light up.
        title: "The incident review that changed our on-call",
        proposal: "The incident review that changed our on-call",
        speakers: ["speaker3"],
        track: "Craft",
        format: "Talk (30 min)",
        duration: 30,
        slot: { start: at(day1, 2) + 15 * MIN, room: "Main Hall" },
        description:
          "One postmortem, rewritten four times, and the organisational habit it eventually replaced.",
      },
      {
        // DELIBERATE CONFLICT #2 — speaker5 is on the deep dive above AND on
        // this one, in a different room at an overlapping time.
        title: "Retrieval is not the hard part",
        proposal: "Retrieval is not the hard part",
        speakers: ["speaker5"],
        track: "AI & Agents",
        format: "Talk (30 min)",
        duration: 30,
        slot: { start: at(day1, 2) + 20 * MIN, room: "Studio A" },
        description:
          "Everything downstream of the retriever, with numbers from a year in production.",
      },
      {
        title: "Build a deploy pipeline you can explain",
        proposal: "Build a deploy pipeline you can explain",
        speakers: ["speaker4"],
        track: "Platform",
        format: "Workshop (120 min)",
        duration: 120,
        slot: { start: at(day2, 1), room: "Workshop Room" },
        description:
          "Start from a repo with no CI and end with a pipeline whose every stage you can justify out loud.",
      },
      {
        title: "Opening remarks",
        speakers: ["speaker6"],
        track: "Platform",
        format: "Talk (30 min)",
        duration: 30,
        slot: { start: day1, room: "Main Hall" },
        description: "Welcome, housekeeping, and what we're trying to do here.",
      },
      // ── Unscheduled tray ──────────────────────────────────────────────
      {
        title: "Migrating a monolith nobody understands",
        speakers: ["speaker6"],
        track: "Platform",
        format: "Deep dive (45 min)",
        duration: 45,
        contentDraft: true,
        description:
          "Archaeology first, refactoring second. DRAFT — abstract still being cut down.",
      },
      {
        title: "Type systems for people who dislike type systems",
        speakers: ["speaker3"],
        track: "Craft",
        format: "Talk (30 min)",
        duration: 30,
      },
      {
        title: "Closing panel: what we got wrong this year",
        speakers: ["speaker1", "speaker2"],
        track: "Craft",
        format: "Deep dive (45 min)",
        duration: 45,
        description: "Four speakers, one moderator, no slides.",
      },
    ];

    const sessionIds: Record<string, Id<"sessions">> = {};
    const participantIds: Record<string, Id<"sessionParticipants">> = {};
    for (const spec of sessionSpecs) {
      const proposalId =
        spec.proposal !== undefined ? proposalIds[spec.proposal] : undefined;
      const sessionId = await ctx.db.insert("sessions", {
        eventId,
        title: spec.title,
        description: spec.description,
        format: spec.format,
        formatId: formats[spec.format],
        durationMinutes: spec.duration,
        trackId: tracks[spec.track],
        proposalId,
        source: proposalId === undefined ? "direct" : "cfp",
        status: "planned",
        contentStatus: spec.contentDraft === true ? "draft" : "approved",
        contentStatusSetBy: people["demo-organizer"],
        contentStatusSetAt: now - 5 * DAY,
        roomId: spec.slot !== undefined ? rooms[spec.slot.room] : undefined,
        startsAt: spec.slot?.start,
        endsAt:
          spec.slot !== undefined
            ? spec.slot.start + spec.duration * MIN
            : undefined,
        releasedSlot:
          spec.slot !== undefined
            ? {
                startsAt: spec.slot.start,
                endsAt: spec.slot.start + spec.duration * MIN,
                roomId: rooms[spec.slot.room],
                releasedAt: now - 4 * DAY,
                sequence: 1,
              }
            : undefined,
        icsSequence: spec.slot !== undefined ? 1 : undefined,
      });
      sessionIds[spec.title] = sessionId;

      for (const tag of spec.speakers) {
        // Confirmed / awaiting / declined across the roster, so `list_sessions`
        // and the readiness dashboard both have every state represented.
        const state =
          tag === "speaker4" || tag === "speaker6"
            ? "awaiting"
            : ("confirmed" as const);
        const id = await ctx.db.insert("sessionParticipants", {
          sessionId,
          eventId,
          eventContactId: eventContactIds[tag],
          role: "speaker",
          state,
          stateSetBy: people[tag],
          stateSetAt: state === "confirmed" ? now - 20 * DAY : undefined,
          managerUserId: people[tag],
          ack:
            spec.slot === undefined
              ? undefined
              : tag === "speaker3"
                ? "conflict"
                : state === "confirmed"
                  ? "acknowledged"
                  : "awaitingAck",
          ackSetAt: spec.slot === undefined ? undefined : now - 3 * DAY,
        });
        participantIds[`${spec.title}::${tag}`] = id;
      }
    }
    // One withdrawn participant, on the closing panel.
    await ctx.db.insert("sessionParticipants", {
      sessionId: sessionIds["Closing panel: what we got wrong this year"],
      eventId,
      eventContactId: eventContactIds["speaker6"],
      role: "speaker",
      state: "withdrawn",
      stateSetBy: people["speaker6"],
      stateSetAt: now - 2 * DAY,
      managerUserId: people["speaker6"],
    });

    // ── Agenda items ────────────────────────────────────────────────────
    for (const [title, base, hour, mins, room] of [
      ["Registration & coffee", day1, -1, 60, undefined],
      ["Lunch", day1, 4, 60, undefined],
      ["Hallway track", day1, 6, 90, "Studio A"],
      ["Day 2 breakfast", day2, -0.5, 45, undefined],
    ] as const) {
      await ctx.db.insert("agendaItems", {
        eventId,
        title,
        startsAt: at(base, hour),
        endsAt: at(base, hour) + mins * MIN,
        roomId: room === undefined ? undefined : rooms[room],
        description: undefined,
      });
    }

    // ── Requirements & tasks, one per review state ──────────────────────
    const reqBio = await ctx.db.insert("requirements", {
      eventId,
      title: "Speaker bio",
      description: "Two or three sentences for the public speaker card.",
      scope: "participant",
      evidence: "profileField",
      fieldKey: "bio",
      reviewRequired: false,
      dueAt: now - 3 * DAY,
      active: true,
    });
    const reqHeadshot = await ctx.db.insert("requirements", {
      eventId,
      title: "Headshot",
      description: "Square, at least 800px, no watermarks.",
      scope: "participant",
      evidence: "profileField",
      fieldKey: "headshot",
      reviewRequired: false,
      dueAt: now - 3 * DAY,
      active: true,
    });
    const reqSlides = await ctx.db.insert("requirements", {
      eventId,
      title: "Slide deck",
      description: "PDF or Keynote. We print handouts from this.",
      scope: "session",
      evidence: "file",
      reviewRequired: true,
      dueAt: now + 21 * DAY,
      active: true,
      reminderCadenceDays: 7,
    });
    const reqAgreement = await ctx.db.insert("requirements", {
      eventId,
      title: "Signed speaker agreement",
      description: "Recording and code-of-conduct consent.",
      scope: "participant",
      evidence: "manual",
      reviewRequired: true,
      dueAt: now + 7 * DAY,
      active: true,
    });

    const scheduledTitles = sessionSpecs
      .filter((s) => s.slot !== undefined)
      .map((s) => s.title);

    // Bio + headshot tasks track the profile fields we just seeded, so the
    // dashboard's "missing bio / missing headshot" counts agree with the task
    // list rather than contradicting it.
    for (const st of speakerStates) {
      const spec = sessionSpecs.find((s) => s.speakers.includes(st.tag));
      if (spec === undefined) continue;
      const sessionId = sessionIds[spec.title];
      const participantId = participantIds[`${spec.title}::${st.tag}`];
      await ctx.db.insert("taskInstances", {
        requirementId: reqBio,
        eventId,
        sessionId,
        participantId,
        eventContactId: eventContactIds[st.tag],
        status: st.bio ? "complete" : "pending",
        dueAt: now - 3 * DAY,
        completedBy: st.bio ? people[st.tag] : undefined,
        completedAt: st.bio ? now - 15 * DAY : undefined,
        updatedAt: now - 15 * DAY,
      });
      await ctx.db.insert("taskInstances", {
        requirementId: reqHeadshot,
        eventId,
        sessionId,
        participantId,
        eventContactId: eventContactIds[st.tag],
        status: st.headshot ? "complete" : "pending",
        dueAt: now - 3 * DAY,
        updatedAt: now - 15 * DAY,
      });
    }

    // Slide decks: one in each review state, so `list_task_reviews` and
    // `task_dashboard` both have something honest to say.
    const slideStates = [
      ["Paved roads that people actually walk on", "speaker1", "provided"],
      ["Running agents against production, carefully", "speaker2", "provided"],
      ["The incident review that changed our on-call", "speaker3", "approved"],
      ["Build a deploy pipeline you can explain", "speaker4", "changesRequested"],
      ["Retrieval is not the hard part", "speaker5", "pending"],
      ["Opening remarks", "speaker6", "pending"],
    ] as const;
    for (const [title, tag, status] of slideStates) {
      await ctx.db.insert("taskInstances", {
        requirementId: reqSlides,
        eventId,
        sessionId: sessionIds[title],
        participantId: participantIds[`${title}::${tag}`],
        eventContactId: eventContactIds[tag],
        status,
        dueAt: now + (status === "pending" ? 21 : 14) * DAY,
        reviewNote:
          status === "changesRequested"
            ? "The exercises assume Docker Desktop — please add a Colima path, or drop the container step."
            : undefined,
        completedBy: status === "approved" ? people["demo-organizer"] : undefined,
        completedAt: status === "approved" ? now - DAY : undefined,
        lastRemindedAt: status === "pending" ? now - 4 * DAY : undefined,
        updatedAt: now - 2 * DAY,
      });
    }

    // Agreements: two outstanding, one overdue-adjacent, the rest done.
    for (const [i, st] of speakerStates.entries()) {
      const spec = sessionSpecs.find((s) => s.speakers.includes(st.tag));
      if (spec === undefined) continue;
      await ctx.db.insert("taskInstances", {
        requirementId: reqAgreement,
        eventId,
        sessionId: sessionIds[spec.title],
        participantId: participantIds[`${spec.title}::${st.tag}`],
        eventContactId: eventContactIds[st.tag],
        status: i < 3 ? "approved" : i === 3 ? "provided" : "pending",
        dueAt: now + 7 * DAY,
        completedBy: i < 3 ? people["demo-organizer"] : undefined,
        completedAt: i < 3 ? now - 8 * DAY : undefined,
        updatedAt: now - 8 * DAY,
      });
    }

    // ── Publication ─────────────────────────────────────────────────────
    await ctx.db.insert("publicationFlags", {
      eventId,
      targetType: "agenda",
      targetId: "event",
      published: true,
      updatedAt: now - 4 * DAY,
    });
    for (const title of scheduledTitles) {
      await ctx.db.insert("publicationFlags", {
        eventId,
        targetType: "session",
        targetId: sessionIds[title],
        published: true,
        updatedAt: now - 4 * DAY,
      });
    }
    // Two of the tray sessions are flagged for the lineup even though they are
    // unscheduled — that is what gives `publish_state` a real pending diff.
    await ctx.db.insert("publicationFlags", {
      eventId,
      targetType: "session",
      targetId: sessionIds["Closing panel: what we got wrong this year"],
      published: true,
      updatedAt: now - 4 * DAY,
    });

    await ctx.db.insert("embeds", {
      eventId,
      name: "Website agenda widget",
      widget: "agenda",
      enabled: true,
      config: { brandColor: "#2F6FED" },
      createdBy: people["demo-organizer"],
      updatedAt: now - 4 * DAY,
    });

    await rebuildProgram(ctx, eventId, people["demo-organizer"]);

    // ── Comms history ───────────────────────────────────────────────────
    for (const [tag, kind, subject, status] of [
      ["speaker1", "decision.accepted", "Your talk is in — Meridian Dev Summit 2026", "delivered"],
      ["speaker2", "decision.accepted", "Your talk is in — Meridian Dev Summit 2026", "delivered"],
      ["speaker4", "decision.declined", "About your Meridian Dev Summit submission", "delivered"],
      ["speaker4", "task.assigned", "Two things we need from you", "delivered"],
      ["speaker6", "reminder.participation", "Still hoping to confirm you", "sent"],
      ["speaker5", "reminder.tasks", "Your slide deck is due in three weeks", "delivered"],
    ] as const) {
      await ctx.db.insert("messages", {
        orgId,
        eventId,
        contactId: contactIds[tag],
        toEmail: email(tag),
        kind,
        subject,
        deliveryStatus: status,
        deliveryUpdatedAt: now - 7 * DAY,
        sentByUserId: people["demo-organizer"],
      });
    }

    // ── Audit history ───────────────────────────────────────────────────
    // Real action codes only: `ACTION_CLAUSE` in model/controlCenter.ts is the
    // vocabulary the change list renders sentences from, and an invented code
    // would show a reviewer the honest-but-clumsy generic fallback.
    for (const [action, targetType] of [
      ["cfp.publishForm", "event"],
      ["review.roundCreate", "reviewRound"],
      ["review.autoDistribute", "reviewRound"],
      ["decision.stage", "proposal"],
      ["decision.release", "proposal"],
      ["agenda.release", "session"],
      ["publish.lineup", "event"],
      ["publish.agenda", "event"],
      ["task.approve", "taskInstance"],
    ] as const) {
      await ctx.db.insert("auditLog", {
        orgId,
        eventId,
        actorUserId: people["demo-organizer"],
        action,
        targetType,
        targetId: eventId,
      });
    }

    return {
      orgSlug: ORG_SLUG,
      eventSlug: EVENT_SLUG,
      orgId,
      eventId,
    };
  },
});

/**
 * Publish the two agenda items a reviewer expects to see on a public schedule
 * (registration and lunch), leaving the other two unflagged so `publish_state`
 * keeps a genuine pending diff to report. Split out from `seed` so it can be
 * re-run against an already-seeded event without touching the minted keys.
 */
export const publishAgendaItems = internalMutation({
  args: {},
  returns: v.object({ published: v.number() }),
  handler: async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", EVENT_SLUG))
      .unique();
    if (event === null) throw new Error("Seed the demo event first.");
    const items = await ctx.db
      .query("agendaItems")
      .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
      .collect();
    let published = 0;
    for (const item of items) {
      if (item.title !== "Registration & coffee" && item.title !== "Lunch")
        continue;
      await ctx.db.insert("publicationFlags", {
        eventId: event._id,
        targetType: "agendaItem",
        targetId: item._id,
        published: true,
        updatedAt: Date.now(),
      });
      published += 1;
    }
    return { published };
  },
});

/**
 * Attach illustrated avatars to the speakers whose readiness state is meant to
 * be COMPLETE. Without this every speaker is "no headshot", which makes the
 * dashboard's missing-headshot count a constant rather than a signal.
 *
 * Deliberately illustrated (DiceBear), not photographs: demo personas must not
 * look like photos of real people who never agreed to appear in our demo.
 *
 * The blobs are stored directly rather than through the `headshotUploads`
 * ticket flow. That flow exists to bound what an untrusted browser can put in
 * storage; a seed running with deployment credentials is not that. The only
 * consequence is that these blobs carry no quota accounting and no upload row —
 * and the cleanup sweeps in model/headshots.ts only ever delete storage ids
 * they find ON a headshotUploads row, so a seeded blob is never collected.
 */
export const headshots = internalAction({
  args: {},
  returns: v.object({ attached: v.number() }),
  handler: async (ctx) => {
    // Only the speakers seeded as headshot: true.
    const withHeadshots = ["speaker1", "speaker2"];
    let attached = 0;
    for (const tag of withHeadshots) {
      const spec = PERSONAS.find((p) => p.tag === tag)!;
      const res = await fetch(
        `https://api.dicebear.com/9.x/notionists/png?seed=${encodeURIComponent(
          `${spec.first}${spec.last}`,
        )}&size=512&backgroundColor=ede9fe`,
      );
      if (!res.ok) throw new Error(`avatar fetch failed: ${res.status}`);
      const storageId = await ctx.storage.store(await res.blob());
      await ctx.runMutation(internal.seedDemo.attachHeadshot, {
        email: email(tag),
        storageId,
      });
      attached += 1;
    }
    return { attached };
  },
});

/**
 * Give the file-evidence slide-deck tasks an actual file.
 *
 * A task sitting in `provided` with nothing attached is a lie the whole demo
 * tells: the review queue offers "approve / request changes" on a submission
 * that does not exist, and an agent reading `list_task_reviews` correctly
 * calls it out. One small PDF, uploaded as every submitted deck.
 */
export const slideUploads = internalAction({
  args: {},
  returns: v.object({ uploads: v.number() }),
  handler: async (ctx) => {
    // A minimal one-page PDF, built here rather than fetched: the demo should
    // not depend on a third party being up.
    const body =
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
      "trailer<</Root 1 0 R>>\n%%EOF\n";
    const storageId = await ctx.storage.store(
      new Blob([body], { type: "application/pdf" }),
    );
    // Annotated, not inferred: returning `runMutation`'s result straight out
    // of an action in the SAME file makes the module's type depend on itself
    // through `internal`, and TypeScript answers `any` — which then cascades
    // as implicit-any errors across every other file in the project.
    const result: { uploads: number } = await ctx.runMutation(
      internal.seedDemo.attachSlideUploads,
      { storageId },
    );
    return result;
  },
});

export const attachSlideUploads = internalMutation({
  args: { storageId: v.id("_storage") },
  returns: v.object({ uploads: v.number() }),
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (q) => q.eq("slug", EVENT_SLUG))
      .unique();
    if (event === null) throw new Error("Seed the demo event first.");
    const slides = (
      await ctx.db
        .query("requirements")
        .withIndex("by_eventId", (q) => q.eq("eventId", event._id))
        .collect()
    ).find((r) => r.title === "Slide deck");
    if (slides === undefined) throw new Error("No slide-deck requirement.");
    const instances = await ctx.db
      .query("taskInstances")
      .withIndex("by_requirementId", (q) => q.eq("requirementId", slides._id))
      .collect();
    let uploads = 0;
    for (const inst of instances) {
      // Only the states that claim a file was submitted.
      if (
        inst.status !== "provided" &&
        inst.status !== "approved" &&
        inst.status !== "changesRequested"
      )
        continue;
      // The speaker themself when they have claimed their portal; otherwise
      // the organizer, who is who uploads on an unclaimed speaker's behalf.
      const claimed = inst.eventContactId
        ? (await ctx.db.get("eventContacts", inst.eventContactId))?.userId
        : undefined;
      const org = await ctx.db.get("organizations", event.orgId);
      const uploader = claimed ?? org?.createdBy;
      if (uploader === undefined) continue;
      await ctx.db.insert("uploads", {
        eventId: event._id,
        taskInstanceId: inst._id,
        storageId: args.storageId,
        filename: "slides-draft-v2.pdf",
        version: 1,
        uploadedBy: uploader,
        approvedAt: inst.status === "approved" ? inst.completedAt : undefined,
        approvedBy: inst.status === "approved" ? inst.completedBy : undefined,
      });
      uploads += 1;
    }
    return { uploads };
  },
});

export const attachHeadshot = internalMutation({
  args: { email: v.string(), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", ORG_SLUG))
      .unique();
    if (org === null) throw new Error("Seed the demo org first.");
    const contact = await ctx.db
      .query("contacts")
      .withIndex("by_orgId_and_email", (q) =>
        q.eq("orgId", org._id).eq("email", args.email),
      )
      .unique();
    if (contact === null) throw new Error(`No demo contact for ${args.email}.`);
    await ctx.db.patch("contacts", contact._id, {
      headshotId: args.storageId,
    });
    const eventContacts = await ctx.db
      .query("eventContacts")
      .withIndex("by_contactId", (q) => q.eq("contactId", contact._id))
      .collect();
    for (const ec of eventContacts) {
      await ctx.db.patch("eventContacts", ec._id, {
        headshotId: args.storageId,
      });
    }
    return null;
  },
});

/** A revoked "example" key so the org-settings keys tab is never empty for a
 * reviewer who has not minted one. It is revoked at birth on purpose: the row
 * demonstrates the list, the prefix and the revocation state without any
 * usable credential ever existing. */
export const exampleKey = internalMutation({
  args: {},
  returns: v.object({ prefix: v.string() }),
  handler: async (ctx) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", ORG_SLUG))
      .unique();
    if (org === null) throw new Error("Seed the demo org first.");
    const owner = await ctx.db.get("users", org.createdBy);
    if (owner === null) throw new Error("Owner user missing.");
    const now = Date.now();
    const prefix = "ssk_…d0c5";
    await ctx.db.insert("apiKeys", {
      orgId: org._id,
      // A hash of nothing anyone holds: no plaintext for this row was ever
      // generated, so the credential does not exist to be presented.
      keyHash: `seed-example-no-plaintext-${now}`,
      prefix,
      name: "Example — Claude Code (revoked)",
      createdByUserId: owner._id,
      ceiling: "read",
      revokedAt: now,
    });
    return { prefix };
  },
});
