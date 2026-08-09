import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────
// Shared input validation. Every email regex and every "name must be N-M
// characters" check in the backend goes through here so the rules (and the
// error codes clients switch on) can never drift between call sites.
// ─────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Loose shape check — deliberately permissive; delivery is the real test. */
export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

/** Trim + lowercase, or throw `invalid_email`. Blank is invalid: callers that
 * treat an empty email as "absent" must check before calling. */
export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!isEmail(normalized)) {
    throw new ConvexError({
      code: "invalid_email",
      message: "That doesn't look like an email address.",
    });
  }
  return normalized;
}

// ─────────────────────────────────────────────────────────────────────────
// Bounded reads (H5). Every event-graph read is capped so one oversized event
// can't blow a transaction, but a cap that silently drops rows turns a read
// into a WRONG ANSWER: a missed double-booking, a speaker who stops being
// chased, a dashboard that reports readiness it never verified. So each call
// site picks one of exactly two behaviours below — never a bare `.take(cap)`.
// ─────────────────────────────────────────────────────────────────────────

/** Structural view of a Convex query builder — keeps these helpers pure, so
 * every call site still composes its own `.withIndex()`/`.order()` chain. */
type Takeable<T> = { take(count: number): Promise<Array<T>> };

/**
 * Read at most `cap` rows AND report whether more exist.
 *
 * `cap + 1` is load-bearing: it is the only way to tell "exactly full" from
 * "overflowing". Probing with `cap` and treating `rows.length === cap` as
 * truncated is an off-by-one that cries wolf on an event sitting exactly at
 * the cap — do not "simplify" it back. Both helpers share this one probe so
 * they can never disagree about what "at the cap" means.
 */
export async function takeCapped<T>(
  query: Takeable<T>,
  cap: number,
): Promise<{ rows: Array<T>; capped: boolean }> {
  const rows = await query.take(cap + 1);
  return { rows: rows.slice(0, cap), capped: rows.length > cap };
}

/**
 * Read rows that the answer DEPENDS ON: refuse rather than answer from a
 * partial read. `what` names the rows in organizer language ("sessions",
 * "speaker participations") because the message is rendered in the UI.
 *
 * One code for all call sites (`event_too_large`) so the UI has a single case
 * to handle no matter which read hit its ceiling.
 */
export async function takeAll<T>(
  query: Takeable<T>,
  cap: number,
  what: string,
): Promise<Array<T>> {
  const { rows, capped } = await takeCapped(query, cap);
  if (capped) {
    throw new ConvexError({
      code: "event_too_large",
      message: `This event has more than ${cap} ${what} — more than StageStack reads in one pass. Answering from a partial read would be wrong (missed schedule conflicts, false readiness), so this view is refused instead of guessing. Split the event, or contact support@stagestack.dev to raise the ${cap}-${what} limit.`,
    });
  }
  return rows;
}

export type AssertTextOptions = {
  /** Human label used in the error message, e.g. "Event name". */
  label: string;
  max: number;
  /** Defaults to 1; pass 0 for an optional-but-bounded field. */
  min?: number;
  /** ConvexError code; defaults to "invalid_name". */
  code?: string;
};

/** Trim and length-check a user-supplied string, returning the trimmed value. */
export function assertText(value: string, opts: AssertTextOptions): string {
  const trimmed = value.trim();
  const min = opts.min ?? 1;
  if (trimmed.length < min || trimmed.length > opts.max) {
    throw new ConvexError({
      code: opts.code ?? "invalid_name",
      message:
        min === 0
          ? `${opts.label} must be at most ${opts.max} characters.`
          : `${opts.label} must be ${min}-${opts.max} characters.`,
    });
  }
  return trimmed;
}

/**
 * Archived events stop accepting work (MILESTONES M0: archiving "removes an
 * event from active work and stops automations"). Reads stay open so history
 * remains browsable; every M2+ write calls this first.
 */
export function assertEventActive(event: Doc<"events">): void {
  if (event.archivedAt !== undefined) {
    throw new ConvexError({
      code: "event_archived",
      message: "This event is archived.",
    });
  }
}
