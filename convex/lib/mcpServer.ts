import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  MCP_GENERIC_REFUSAL,
  MCP_REFUSAL_MESSAGES,
} from "../model/apiKeys";

// ─────────────────────────────────────────────────────────────────────────
// The tool catalogue StageStack presents to an external agent (D2 reads, D3
// writes).
//
// Curated, not generated: the Convex surface is ~150 functions and a mirror
// of it would be a worse product than a dozen tools an agent can hold in its
// head. Every tool here is a thin call into an internal query or mutation in
// `convex/mcp.ts`, which re-resolves the caller from the presented key and
// then calls the SAME `convex/model/*` capability the web UI calls.
//
// The write half is deliberately thin, and its shape is a product decision:
// reversible, non-outbound changes an organizer would be happy to find already
// made. Every description says what the tool does NOT do, because an agent
// deciding whether to act reads exactly this text and nothing else.
//
// The descriptions are product documentation. They are written for an agent
// that has never seen StageStack, because that is exactly who reads them.
// ─────────────────────────────────────────────────────────────────────────

const SERVER_INSTRUCTIONS = `StageStack runs conferences and events end to end: a call for papers
(proposals from speakers), review rounds that score them, sessions built from
accepted proposals, speaker tasks (bio, headshot, slides), an agenda board
that places sessions into rooms and time slots, and a publish step that pushes
the public program.

Every tool is scoped to the API key presented: it sees exactly the
organizations and events the person who created the key can see, and nothing
else. Most tools take an "eventSlug"; call list_events first to discover it, or
search to find a record by name.

Four tools WRITE: update_session_content, schedule_session, approve_task and
request_task_changes. They need a key minted with the "organizer" ceiling — a
read-only key is refused — and they take effect the moment they return: there
is no draft, no confirmation step and no undo call. Each is reversible by
making the opposite change: content edits keep a revision history, a placement
can be moved or cleared, a review decision can be re-made.

What NO tool here can do: send outreach email, publish or unpublish the public
programme, add or remove team members, invite anybody, or delete anything.
Those stay with a signed-in human in the web app. The single exception to
"these tools send nothing" is request_task_changes, which emails the person who
owes the work — that notification IS the action, and its own description says
so.

Typical questions these answer: what still blocks the program from being
published, which speakers have not submitted their material, how far a review
round has got, and what publishing right now would change on the public page.`;

const eventSlug = z
  .string()
  .describe(
    "The event's slug — its URL identifier, e.g. \"devflow-conf-2027\". Get it from list_events or search.",
  );

/**
 * The tool-side half of the sanitization boundary.
 *
 * The SDK turns an escaped exception into an `isError` result carrying
 * `error.message` VERBATIM — which for a Convex failure is a system sentence
 * naming tables, ids or a stack. So no tool body throws past this function:
 * a refusal whose code is in the registry becomes its registered sentence,
 * looked up FROM the registry rather than taken off the error object, and
 * everything else — every system error, every model refusal never written for
 * this audience, every bug — becomes the one generic sentence.
 *
 * Exported so it can be tested on both branches without needing a way to make
 * a live query fail in a chosen manner.
 */
export function sanitizeToolError(error: unknown): string {
  const data =
    error !== null && typeof error === "object"
      ? (error as { data?: unknown }).data
      : undefined;
  const code =
    data !== null && typeof data === "object"
      ? (data as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && code in MCP_REFUSAL_MESSAGES
    ? MCP_REFUSAL_MESSAGES[code]
    : MCP_GENERIC_REFUSAL;
}

/**
 * Build a per-request server. The factory closes over this request's
 * `ActionCtx` and the key the caller presented, which is the stateless model
 * the 2026-07-28 spec expects — nothing is shared between requests.
 */
export function makeStageStackMcpServer(
  ctx: ActionCtx,
  presentedKey: string,
): McpServer {
  const server = new McpServer(
    { name: "stagestack", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const answer = async (run: () => Promise<unknown>) => {
    try {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(await run(), null, 2) },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: sanitizeToolError(error) }],
      };
    }
  };

  /** Every tool call carries the credential and one clock read; queries are
   * not re-run because time advanced, so "now" comes from the action. */
  const now = () => Date.now();

  server.registerTool(
    "search",
    {
      title: "Search StageStack",
      description:
        "Search everything the API key can reach — by default events by name; pass an eventSlug to also search that event's sessions, speakers and proposals. Use this first when you have a name but not an id or slug. Results come back grouped by kind; a group flagged `capped: true` was truncated, so treat it as a sample rather than the whole answer.",
      inputSchema: z.object({
        term: z
          .string()
          .describe("Free text, at least 2 characters. Matched against titles, names and slugs."),
        eventSlug: z
          .string()
          .optional()
          .describe(
            "Also search inside this event (sessions, speakers, proposals). Without it, only event names are searched.",
          ),
      }),
    },
    async ({ term, eventSlug: inEvent }) =>
      answer(async () =>
        ctx.runQuery(internal.mcp.search, {
          presentedKey,
          now: now(),
          term,
          eventSlug: inEvent,
        }),
      ),
  );

  server.registerTool(
    "list_events",
    {
      title: "List events",
      description:
        "List every event this API key can reach, with its slug, dates, timezone and archived state. An event-scoped key returns exactly one event. Start here to find the `eventSlug` the other tools need.",
      inputSchema: z.object({}),
    },
    async () =>
      answer(async () =>
        ctx.runQuery(internal.mcp.listEvents, {
          presentedKey,
          now: now(),
        }),
      ),
  );

  server.registerTool(
    "get_event",
    {
      title: "Get event",
      description:
        "Full settings for one event: name, dates, timezone, location, description, the call-for-papers window, and the role the API key holds on it. Use it to establish context before answering anything time-sensitive — every other tool's dates are in this event's timezone.",
      inputSchema: z.object({ eventSlug }),
    },
    async (args) =>
      answer(async () =>
        ctx.runQuery(internal.mcp.getEvent, {
          presentedKey,
          now: now(),
          eventSlug: args.eventSlug,
        }),
      ),
  );

  server.registerTool(
    "list_proposals",
    {
      title: "List proposals",
      description:
        "Every talk proposal submitted to an event's call for papers, with its status and speaker count. Statuses run: draft (speaker still writing) → pending (submitted, awaiting decision) → acceptQueue / declineQueue (decided but not yet told) → accepted / declined (speaker notified) → withdrawn. Filter by one status to answer questions like \"what is still waiting on a decision\". `capped: true` means the event has more proposals than one read returns.",
      inputSchema: z.object({
        eventSlug,
        status: z
          .enum([
            "draft",
            "pending",
            "acceptQueue",
            "declineQueue",
            "accepted",
            "declined",
            "withdrawn",
          ])
          .optional()
          .describe("Return only proposals in this status."),
      }),
    },
    async (args) =>
      answer(async () =>
        ctx.runQuery(internal.mcp.listProposals, {
          presentedKey,
          now: now(),
          eventSlug: args.eventSlug,
          status: args.status,
        }),
      ),
  );

  server.registerTool(
    "get_proposal",
    {
      title: "Get proposal",
      description:
        "One proposal in full: its answers to the call-for-papers form, its speakers, who submitted it, and links to any uploaded files. Get the `proposalId` from list_proposals or search.",
      inputSchema: z.object({
        eventSlug,
        proposalId: z
          .string()
          .describe("The proposal's id, as returned by list_proposals or search."),
      }),
    },
    async (args) =>
      answer(async () =>
        ctx.runQuery(internal.mcp.getProposal, {
          presentedKey,
          now: now(),
          eventSlug: args.eventSlug,
          proposalId: args.proposalId,
        }),
      ),
  );

  server.registerTool(
    "review_progress",
    {
      title: "Review progress",
      description:
        "How far the review of an event's proposals has got. For an organizer key: per-proposal counts (assigned, submitted, conflicts, average score) plus a per-reviewer completion board — the way to answer \"who has not finished reviewing\". For a reviewer-only key: that reviewer's own assignments and nothing else.",
      inputSchema: z.object({ eventSlug }),
    },
    async (args) =>
      answer(async () =>
        ctx.runQuery(internal.mcp.reviewProgress, {
          presentedKey,
          now: now(),
          eventSlug: args.eventSlug,
        }),
      ),
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List sessions",
      description:
        "Every session on the event's programme, with its participants and each speaker's participation state (awaiting / confirmed / declined / withdrawn). Sessions are what the public programme is made of — a proposal becomes a session when it is accepted and released. Use this to answer \"who is speaking\" and \"who has not confirmed\".",
      inputSchema: z.object({ eventSlug }),
    },
    async (args) =>
      answer(async () =>
        ctx.runQuery(internal.mcp.listSessions, {
          presentedKey,
          now: now(),
          eventSlug: args.eventSlug,
        }),
      ),
  );

  server.registerTool(
    "task_dashboard",
    {
      title: "Speaker readiness dashboard",
      description:
        "What is outstanding from speakers, and what is blocking the programme. Returns per-speaker readiness (missing bio, missing headshot, outstanding and overdue tasks), per-session readiness, headline totals, and the current blockers (draft content, unscheduled sessions, schedule conflicts). This is the \"morning sweep\" tool: ask it before chasing anybody.",
      inputSchema: z.object({ eventSlug }),
    },
    async (args) =>
      answer(async () =>
        ctx.runQuery(internal.mcp.taskDashboard, {
          presentedKey,
          now: now(),
          eventSlug: args.eventSlug,
        }),
      ),
  );

  server.registerTool(
    "agenda_board",
    {
      title: "Agenda board",
      description:
        "The schedule grid: rooms, tracks, the sessions placed into time slots, the tray of sessions still unscheduled, and any derived conflicts (a speaker double-booked, a room clash). Use it to answer \"is the schedule finished\" and \"what still has no slot\".",
      inputSchema: z.object({ eventSlug }),
    },
    async (args) =>
      answer(async () =>
        ctx.runQuery(internal.mcp.agendaBoard, {
          presentedKey,
          now: now(),
          eventSlug: args.eventSlug,
        }),
      ),
  );

  server.registerTool(
    "publish_state",
    {
      title: "Publish state and diff",
      description:
        "What the public page currently serves versus what it would serve if published now. `state` gives the published-lineup and published-agenda flags, the served version, and whether it is stale; `diff` lists exactly what publishing would add, change and remove per channel. Use it to answer \"is the public programme up to date\" and \"what would publishing change\".",
      inputSchema: z.object({ eventSlug }),
    },
    async (args) =>
      answer(async () =>
        ctx.runQuery(internal.mcp.publishState, {
          presentedKey,
          now: now(),
          eventSlug: args.eventSlug,
        }),
      ),
  );

  server.registerTool(
    "list_task_reviews",
    {
      title: "List tasks by review state",
      description:
        "Speaker tasks in one review state, each with the `taskId` that approve_task and request_task_changes need — no other tool emits one. Defaults to `provided`: work a speaker has submitted that is waiting for an organizer's decision, i.e. the review queue. Pass a status to look elsewhere — `approved` to find something to send back, `pending` for work not submitted yet, `changesRequested` for what is already back with the speaker. Ordered by due date, soonest first, so the most urgent tasks are the ones you get. Read-only; `capped: true` means more tasks are in this state than one read returns, and the ones you did not get are the ones due latest.",
      inputSchema: z.object({
        eventSlug,
        status: z
          .enum([
            "pending",
            "provided",
            "changesRequested",
            "approved",
            "complete",
            "notApplicable",
          ])
          .optional()
          .describe("Review state to list. Defaults to \"provided\"."),
      }),
    },
    async (args) =>
      answer(async () =>
        ctx.runQuery(internal.mcp.listTaskReviews, {
          presentedKey,
          now: now(),
          eventSlug: args.eventSlug,
          status: args.status,
        }),
      ),
  );

  // ── Write tools ────────────────────────────────────────────────────────
  //
  // These carry no `now`: a mutation reads the clock server-side, and a write
  // must never let the caller choose the instant its credential's expiry is
  // measured against.

  server.registerTool(
    "update_session_content",
    {
      title: "Edit session content",
      description:
        "Edit one session's title, description, format label or length. The change is LIVE IMMEDIATELY — there is no draft state and no undo call — but it is reversible: every content edit is recorded in the session's revision history, so an organizer can restore an earlier version from the web app, and you can put the previous text back through this tool. Only the fields you pass are touched; omit a field to leave it as it is. This does NOT email anyone and does NOT publish anything. One caveat, stated plainly: if this event's public programme has ALREADY been published, editing a session that appears in it updates the public page text at once — exactly as the same edit in the web app does. It never publishes an event that was not already published. Needs an organizer-ceiling API key.",
      inputSchema: z.object({
        eventSlug,
        sessionId: z
          .string()
          .describe("The session's id, as returned by list_sessions, agenda_board or search."),
        title: z.string().optional().describe("New title. Omit to leave unchanged."),
        description: z
          .string()
          .optional()
          .describe(
            "New abstract/description. Pass an empty string to clear it. Omit to leave unchanged.",
          ),
        format: z
          .string()
          .optional()
          .describe(
            "New format label, e.g. \"Workshop (120 min)\". Must match one of the event's formats verbatim to stay linked to it.",
          ),
        durationMinutes: z
          .number()
          .nullable()
          .optional()
          .describe(
            "Per-session length override in minutes. null clears the override and falls back to the format's default. Omit to leave unchanged.",
          ),
      }),
    },
    async (args) =>
      answer(async () =>
        ctx.runMutation(internal.mcp.updateSessionContent, {
          presentedKey,
          eventSlug: args.eventSlug,
          sessionId: args.sessionId,
          title: args.title,
          description: args.description,
          format: args.format,
          durationMinutes: args.durationMinutes,
        }),
      ),
  );

  server.registerTool(
    "schedule_session",
    {
      title: "Place a session on the schedule",
      description:
        "Put a session in a time slot and room on the agenda board, or pass `slot: null` to send it back to the unscheduled tray. Times are epoch milliseconds; the event's own timezone comes from get_event. The room is given BY NAME, exactly as agenda_board reports it. A placement is an internal DRAFT: it changes the board and nothing else — it does NOT email speakers, does NOT publish the schedule, and does NOT re-issue anyone's calendar invitation. Telling speakers about a slot is a separate, deliberate act by an organizer in the web app. Live immediately and fully reversible: move it again, or clear it. This tool does not check for clashes — call agenda_board afterwards to see any conflicts your placement created. Needs an organizer-ceiling API key.",
      inputSchema: z.object({
        eventSlug,
        sessionId: z
          .string()
          .describe("The session's id, as returned by list_sessions, agenda_board or search."),
        slot: z
          .object({
            startsAt: z.number().describe("Start, epoch milliseconds."),
            endsAt: z.number().describe("End, epoch milliseconds. Must be after startsAt."),
            room: z
              .string()
              .optional()
              .describe(
                "Room name, exactly as agenda_board reports it. Omit to place the session with no room.",
              ),
          })
          .nullable()
          .describe("The slot to place it in, or null to unschedule it."),
      }),
    },
    async (args) =>
      answer(async () =>
        ctx.runMutation(internal.mcp.scheduleSession, {
          presentedKey,
          eventSlug: args.eventSlug,
          sessionId: args.sessionId,
          slot: args.slot,
        }),
      ),
  );

  server.registerTool(
    "approve_task",
    {
      title: "Approve submitted speaker work",
      description:
        "Accept a speaker's submitted work on one task — the same review decision an organizer makes in the tasks table. Get the `taskId` from list_task_reviews. Only work that has been submitted and is awaiting review can be approved; anything else is refused. Live immediately, and reversible: request_task_changes sends the same task back afterwards. This sends no email and publishes nothing. Needs an organizer-ceiling API key.",
      inputSchema: z.object({
        eventSlug,
        taskId: z
          .string()
          .describe("The task's id, as returned by list_task_reviews."),
      }),
    },
    async (args) =>
      answer(async () =>
        ctx.runMutation(internal.mcp.approveTask, {
          presentedKey,
          eventSlug: args.eventSlug,
          taskId: args.taskId,
        }),
      ),
  );

  server.registerTool(
    "request_task_changes",
    {
      title: "Send speaker work back for changes",
      description:
        "Send a speaker's submitted work back with an explanatory note. THIS TOOL NOTIFIES: StageStack emails the person who owes the work — or their manager, or the event's organizers if neither has an address — with your note included, because a change request nobody is told about would not be one. Write the note as a message to the speaker; it is stored on the task and shown to them. Live immediately. The task can be resubmitted and approved afterwards, but the email cannot be recalled once sent, so be sure before you call this. It publishes nothing. Needs an organizer-ceiling API key.",
      inputSchema: z.object({
        eventSlug,
        taskId: z
          .string()
          .describe("The task's id, as returned by list_task_reviews."),
        note: z
          .string()
          .describe(
            "What needs to change, addressed to the speaker. Required — leading and trailing whitespace is stripped and the rest is sent to them as written, up to 2000 characters; a longer note is refused rather than cut short.",
          ),
      }),
    },
    async (args) =>
      answer(async () =>
        ctx.runMutation(internal.mcp.requestTaskChanges, {
          presentedKey,
          eventSlug: args.eventSlug,
          taskId: args.taskId,
          note: args.note,
        }),
      ),
  );

  return server;
}
