/**
 * Per-event read ceilings, declared once.
 *
 * Every bounded read in `convex/model/*` takes a ceiling. Before C4 the same
 * ceiling was re-declared in up to nine files, which is how one of them drifts
 * without anyone noticing. These are the ceilings for a FULL read of one
 * event's rows — the reads that answer "what is true about this event", and
 * that therefore either see everything or refuse (`takeAll` → `event_too_large`,
 * H5). A truncated full read is not a smaller answer, it is a wrong one.
 *
 * NOT here, deliberately: the smaller ceilings used by summary reads that
 * TRUNCATE and report `capped` instead of refusing — `COUNT_*` in
 * `model/readiness.ts`, `PANEL_*` in `model/controlCenter.ts`, and the
 * per-group ceilings in `model/analytics.ts` and `model/search.ts`. Those are
 * lower on purpose (a subscribed shell query must not take navigation down
 * with it), and folding them in here would erase the distinction that makes
 * them correct. Same for genuinely differently-scoped reads, e.g. portal's
 * per-person `PERSON_CONTACT_SCAN`.
 */

/** Sessions in one event. */
export const SESSION_SCAN = 1000;

/** `sessionParticipants` rows in one event — one per speaker per session. */
export const PARTICIPANT_SCAN = 5000;

/** `eventContacts` snapshots in one event. */
export const CONTACT_SCAN = 2000;

/** `taskInstances` in one event: requirements × the people they land on. */
export const INSTANCE_SCAN = 8000;

/** Task requirements defined on one event. */
export const REQUIREMENT_SCAN = 200;

/** Agenda items in one event. */
export const ITEM_SCAN = 1000;

/** Comms-log rows read for one event. */
export const MESSAGE_SCAN = 2000;

/** Reviews across one event's proposals. */
export const REVIEW_SCAN = 5000;
