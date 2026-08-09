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
