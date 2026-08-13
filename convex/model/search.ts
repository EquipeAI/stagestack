import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { EventCaller } from "../lib/functions";
import { takeCapped } from "./validation";

// ─────────────────────────────────────────────────────────────────────────
// Global search (the command palette's one backend capability).
//
// ── What it is NOT ───────────────────────────────────────────────────────
// Not a search service, not an index, not a ranking model. Matching is a
// case-insensitive substring over titles and names, run in JS over BOUNDED
// indexed reads. That is a deliberate ceiling, not an oversight: adding a
// search dependency for a palette that answers "take me to the thing I
// already know the name of" would be the expensive way to be no better.
//
// ── The two scopes, and why there are two ────────────────────────────────
// EVENTS are searched across every membership the caller has, because
// "switch to the other conference" is the one jump that crosses events. The
// RECORDS inside an event (sessions, speakers, proposals) are searched in the
// event the palette was opened from, and only there. Sweeping every event's
// tables per keystroke is exactly the unbounded read this codebase refuses to
// ship; the event hop is one keystroke away, so nothing is unreachable.
//
// ── Reviewer scope (the rule this file exists to hold) ───────────────────
// A reviewer's world is what they were ASSIGNED. So a reviewer's search:
//   · never reads `sessions` or `eventContacts` at all — those are organizer
//     surfaces (see the `requires: 'organizer'` nav entries), and a name in a
//     result row is already a contact detail;
//   · reaches proposals ONLY through their own `reviews` rows, the same door
//     `reviews.myAssignments` uses (`by_eventId_and_reviewerUserId`). There is
//     no by-id proposal read here, so an unassigned proposal cannot surface
//     however the term is spelled.
// The gate is the branch below, not a filter applied afterwards: code that
// reads first and hides later leaks the moment somebody edits the filter.
//
// Every sentence a person reads about these results is composed here and
// printed verbatim.
// ─────────────────────────────────────────────────────────────────────────

/** Below this, a query matches so much that the answer is noise. */
const MIN_TERM = 2;

/** Longest term we look at — the rest cannot change what matches. */
const MAX_TERM = 200;

/** Rows returned per group. A palette is a jump list, not a report. */
const GROUP_LIMIT = 5;

// Candidate reads. Each is `takeCapped`, so a group that could not see the
// whole table says so (`capped`) instead of quietly answering from a prefix.
const EVENT_SCAN = 200;
const SESSION_SCAN = 500;
const CONTACT_SCAN = 500;
const PROPOSAL_SCAN = 500;
const REVIEW_SCAN = 500;
const ORG_MEMBERSHIP_SCAN = 50;
const EVENT_MEMBERSHIP_SCAN = 200;

export type SearchKind =
  | "event"
  | "session"
  | "speaker"
  | "proposal"
  | "review";

/**
 * One jump target.
 *
 * `id` is a string, not a typed id, because the palette's list is
 * heterogeneous and the value is only ever spent as a route param. `query` is
 * the destination route's OWN search vocabulary (proposals' `q`), spelled as
 * that route already parses it — the same rule the control center's deep
 * links follow: the server names the filter, the client maps the path.
 */
export type SearchHit = {
  kind: SearchKind;
  id: string;
  eventSlug: string;
  title: string;
  subtitle?: string;
  query?: string;
};

export type SearchGroup = {
  kind: SearchKind;
  label: string;
  hits: Array<SearchHit>;
  /** True when more rows were read than shown, or than could be read. */
  capped: boolean;
  /** Composed here. Printed verbatim. */
  sentence: string;
};

export type SearchResults = {
  groups: Array<SearchGroup>;
  /** One line about the whole answer — the palette's live region says it. */
  summary: string;
};

// ── Matching ─────────────────────────────────────────────────────────────

export function normalizeTerm(term: string): string {
  return term.trim().slice(0, MAX_TERM).toLowerCase();
}

/**
 * Case-insensitive substring, with a prefix match ranked first.
 *
 * Returns a rank rather than a boolean so "Ada" beats "Amanda Adams" for the
 * term "ada" without a second pass over the rows.
 */
function rank(haystack: string, needle: string): number | null {
  const at = haystack.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  return at;
}

type Candidate = { hit: SearchHit; rank: number; tiebreak: string };

function collect(
  rows: Array<Candidate | null>,
): { hits: Array<SearchHit>; more: boolean } {
  const found = rows.filter((row): row is Candidate => row !== null);
  found.sort(
    (a, b) => a.rank - b.rank || a.tiebreak.localeCompare(b.tiebreak),
  );
  return {
    hits: found.slice(0, GROUP_LIMIT).map((row) => row.hit),
    more: found.length > GROUP_LIMIT,
  };
}

// ── Sentences ────────────────────────────────────────────────────────────

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * What a group is showing, and — when it is showing a prefix — that it is.
 *
 * A capped group never claims a total. It says the list is the top few and
 * names the surface that holds the complete answer, because "5 sessions" when
 * there are 60 is the quiet lie this codebase spends its comments avoiding.
 */
function groupSentence(
  label: string,
  shown: number,
  capped: boolean,
  where: string,
): string {
  const noun = plural(shown, "match", "matches");
  if (!capped) {
    return `${shown} ${label.toLowerCase()} ${noun}.`;
  }
  return `Showing the first ${shown} of more ${label.toLowerCase()} matches — ${where} has the full list.`;
}

function summarySentence(
  term: string,
  groups: Array<SearchGroup>,
  capped: boolean,
): string {
  const total = groups.reduce((sum, group) => sum + group.hits.length, 0);
  if (total === 0) {
    return `Nothing matches “${term}”.`;
  }
  const kinds = groups.length;
  const head = `${capped ? "At least " : ""}${total} ${plural(total, "result", "results")} in ${kinds} ${plural(kinds, "group", "groups")}.`;
  return `${head} Use the arrow keys to pick one, Enter to open it.`;
}

// ── Events, across every membership ──────────────────────────────────────

/**
 * Every event this user can open, read through their memberships and nothing
 * else — the same two doors `orgs.myHome` uses (org membership sees the whole
 * org; an event membership sees exactly that event), so search can never
 * reach an org the user was never added to.
 *
 * Budgeted rather than per-org capped: one sweep spends at most EVENT_SCAN
 * document reads no matter how many organizations the account belongs to.
 */
async function accessibleEvents(
  ctx: QueryCtx,
  user: Doc<"users">,
): Promise<{ events: Array<Doc<"events">>; capped: boolean }> {
  const [orgMemberships, eventMemberships] = await Promise.all([
    ctx.db
      .query("members")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .take(ORG_MEMBERSHIP_SCAN),
    ctx.db
      .query("eventMembers")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .take(EVENT_MEMBERSHIP_SCAN),
  ]);

  const events: Array<Doc<"events">> = [];
  const seen = new Set<string>();
  let budget = EVENT_SCAN;
  let capped = false;

  const orgIds = new Set<string>();
  for (const membership of orgMemberships) {
    if (budget <= 0) {
      capped = true;
      break;
    }
    orgIds.add(membership.orgId);
    const page = await takeCapped(
      ctx.db
        .query("events")
        .withIndex("by_orgId", (q) => q.eq("orgId", membership.orgId)),
      budget,
    );
    capped = capped || page.capped;
    for (const event of page.rows) {
      if (seen.has(event._id)) continue;
      seen.add(event._id);
      events.push(event);
      budget -= 1;
    }
  }

  for (const membership of eventMemberships) {
    // An org membership already pulled in every event of that org.
    if (orgIds.has(membership.orgId) || seen.has(membership.eventId)) continue;
    if (budget <= 0) {
      capped = true;
      break;
    }
    const event = await ctx.db.get("events", membership.eventId);
    if (event === null) continue;
    seen.add(event._id);
    events.push(event);
    budget -= 1;
  }

  return { events, capped };
}

function eventGroup(
  events: Array<Doc<"events">>,
  readCapped: boolean,
  term: string,
): SearchGroup | null {
  const { hits, more } = collect(
    events.map((event) => {
      const at = rank(event.name, term);
      if (at === null) return null;
      return {
        rank: at,
        tiebreak: event.name,
        hit: {
          kind: "event" as const,
          id: event._id,
          eventSlug: event.slug,
          title: event.name,
          subtitle:
            event.archivedAt === undefined ? undefined : "Archived event",
        },
      };
    }),
  );
  if (hits.length === 0) return null;
  const capped = more || readCapped;
  return {
    kind: "event",
    label: "Events",
    hits,
    capped,
    sentence: groupSentence("Event", hits.length, capped, "My StageStack"),
  };
}

// ── Records inside one event ─────────────────────────────────────────────

async function sessionGroup(
  ctx: QueryCtx,
  eventCaller: EventCaller,
  term: string,
): Promise<SearchGroup | null> {
  const read = await takeCapped(
    ctx.db
      .query("sessions")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventCaller.event._id)),
    SESSION_SCAN,
  );
  const { hits, more } = collect(
    read.rows.map((session) => {
      const at = rank(session.title, term);
      if (at === null) return null;
      return {
        rank: at,
        tiebreak: session.title,
        hit: {
          kind: "session" as const,
          id: session._id,
          eventSlug: eventCaller.event.slug,
          title: session.title,
          subtitle:
            session.status === "cancelled" ? "Cancelled" : session.format,
        },
      };
    }),
  );
  if (hits.length === 0) return null;
  const capped = more || read.capped;
  return {
    kind: "session",
    label: "Sessions",
    hits,
    capped,
    sentence: groupSentence("Session", hits.length, capped, "Sessions"),
  };
}

function contactName(contact: Doc<"eventContacts">): string {
  return `${contact.firstName} ${contact.lastName}`.trim();
}

async function speakerGroup(
  ctx: QueryCtx,
  eventCaller: EventCaller,
  term: string,
): Promise<SearchGroup | null> {
  const read = await takeCapped(
    ctx.db
      .query("eventContacts")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventCaller.event._id)),
    CONTACT_SCAN,
  );
  const { hits, more } = collect(
    read.rows.map((contact) => {
      const name = contactName(contact);
      const at = rank(name, term);
      if (at === null) return null;
      return {
        rank: at,
        tiebreak: name,
        hit: {
          kind: "speaker" as const,
          id: contact._id,
          eventSlug: eventCaller.event.slug,
          title: name,
          // Professional identity only. No email, no phone: a palette row is
          // the last place a contact detail should be readable over someone's
          // shoulder, and the workspace behind the row already has them.
          subtitle: contact.tagline ?? contact.jobTitle ?? contact.company,
        },
      };
    }),
  );
  if (hits.length === 0) return null;
  const capped = more || read.capped;
  return {
    kind: "speaker",
    label: "Speakers",
    hits,
    capped,
    sentence: groupSentence("Speaker", hits.length, capped, "Speakers"),
  };
}

/** The organizer's own words for a proposal's state (the abstracts table's
 * vocabulary, so a palette row and the table cannot disagree). */
const PROPOSAL_STATUS_LABEL: Record<Doc<"proposals">["status"], string> = {
  draft: "Draft",
  pending: "Submitted",
  acceptQueue: "Accept queue",
  declineQueue: "Decline queue",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

/** Organizer-side proposals: the whole event's, by title. */
async function proposalGroup(
  ctx: QueryCtx,
  eventCaller: EventCaller,
  term: string,
): Promise<SearchGroup | null> {
  const read = await takeCapped(
    ctx.db
      .query("proposals")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventCaller.event._id)),
    PROPOSAL_SCAN,
  );
  const { hits, more } = collect(
    read.rows.map((proposal) => {
      const at = rank(proposal.title, term);
      if (at === null) return null;
      return {
        rank: at,
        tiebreak: proposal.title,
        hit: {
          kind: "proposal" as const,
          id: proposal._id,
          eventSlug: eventCaller.event.slug,
          title: proposal.title,
          subtitle: PROPOSAL_STATUS_LABEL[proposal.status],
          // The proposals table filters itself by title from the URL, so the
          // row lands on the proposal instead of on an unfiltered inbox.
          query: proposal.title,
        },
      };
    }),
  );
  if (hits.length === 0) return null;
  const capped = more || read.capped;
  return {
    kind: "proposal",
    label: "Proposals",
    hits,
    capped,
    sentence: groupSentence("Proposal", hits.length, capped, "Proposals"),
  };
}

/**
 * A reviewer's proposals: their own assignments, and only those.
 *
 * Reached through `reviews` by (event, reviewer) — the same index
 * `myAssignments` reads — so the set is bounded by what this person was given
 * and cannot be widened by the term. Titles only: the reviewer's row carries
 * no speaker name even in a non-blind round, because the palette has no round
 * context to decide blinding with, and a title is enough to jump.
 */
async function assignedProposalGroup(
  ctx: QueryCtx,
  eventCaller: EventCaller,
  term: string,
): Promise<SearchGroup | null> {
  const read = await takeCapped(
    ctx.db
      .query("reviews")
      .withIndex("by_eventId_and_reviewerUserId", (q) =>
        q
          .eq("eventId", eventCaller.event._id)
          .eq("reviewerUserId", eventCaller.user._id),
      ),
    REVIEW_SCAN,
  );
  const proposals = await Promise.all(
    read.rows.map((review) => ctx.db.get("proposals", review.proposalId)),
  );
  const { hits, more } = collect(
    proposals.map((proposal) => {
      // A withdrawn proposal leaves every active queue (MILESTONES M1), so it
      // must not be jumpable from here either.
      if (proposal === null || proposal.status === "withdrawn") return null;
      if (proposal.eventId !== eventCaller.event._id) return null;
      const at = rank(proposal.title, term);
      if (at === null) return null;
      return {
        rank: at,
        tiebreak: proposal.title,
        hit: {
          kind: "review" as const,
          id: proposal._id,
          eventSlug: eventCaller.event.slug,
          title: proposal.title,
          subtitle: "Assigned to you",
        },
      };
    }),
  );
  if (hits.length === 0) return null;
  const capped = more || read.capped;
  return {
    kind: "review",
    label: "Your reviews",
    hits,
    capped,
    sentence: groupSentence(
      "Assigned proposal",
      hits.length,
      capped,
      "Reviews",
    ),
  };
}

// ── The capability ───────────────────────────────────────────────────────

/**
 * Search the caller's world.
 *
 * `eventCaller` is the event the palette was opened from, already resolved
 * (and therefore already authorized) by the public wrapper; null when the
 * palette is open outside an event, in which case only events are searched.
 */
export async function search(
  ctx: QueryCtx,
  user: Doc<"users">,
  eventCaller: EventCaller | null,
  rawTerm: string,
): Promise<SearchResults> {
  const term = normalizeTerm(rawTerm);
  if (term.length < MIN_TERM) {
    return {
      groups: [],
      summary: `Type at least ${MIN_TERM} characters to search.`,
    };
  }

  const reachable = await accessibleEvents(ctx, user);
  const groups: Array<SearchGroup> = [];
  const events = eventGroup(reachable.events, reachable.capped, term);
  if (events !== null) groups.push(events);

  if (eventCaller !== null) {
    const inEvent =
      eventCaller.role === "organizer"
        ? await Promise.all([
            sessionGroup(ctx, eventCaller, term),
            speakerGroup(ctx, eventCaller, term),
            proposalGroup(ctx, eventCaller, term),
          ])
        : // Reviewer: assignments only. Nothing above this line reads a
          // session, a contact or an unassigned proposal for them.
          [await assignedProposalGroup(ctx, eventCaller, term)];
    for (const group of inEvent) {
      if (group !== null) groups.push(group);
    }
  }

  const capped = groups.some((group) => group.capped);
  return { groups, summary: summarySentence(rawTerm.trim(), groups, capped) };
}
