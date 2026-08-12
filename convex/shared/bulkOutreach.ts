// The arithmetic of a bulk CRM outreach, stated once.
//
// W12 promotes the proposals bulk bar into the design system as the generic
// pattern, and the second table to use it is the contact directory. The bar
// has to say — before anything is sent — how many contacts are selected, how
// many of them can actually be emailed, and why the rest cannot. That answer
// must be the same one `convex/model/contacts.ts` reaches when the mutation
// runs, so the rule lives here and both sides import it. Same shape and same
// reason as `bulkDecisions.ts`: nothing in this file touches ctx or the
// database.

/** The mutation refuses an audience outside this range: one recipient is not a
 * bulk send (use the contact's own surface), and 25 is the cap one mutation
 * can cross the email boundary for without risking the transaction. */
export const OUTREACH_MIN = 2;
export const OUTREACH_MAX = 25;

export const OUTREACH_AUDIENCE_MESSAGE = `Select between ${OUTREACH_MIN} and ${OUTREACH_MAX} contacts.`;

export type OutreachExclusion = { count: number; reason: string };

export type OutreachPlan = {
  /** Contacts the organizer ticked. */
  selected: number;
  /** Contacts this send can reach — the ones with an address on file. */
  eligible: number;
  /** The rest, grouped by the reason, in the words the organizer should read. */
  excluded: Array<OutreachExclusion>;
  /** null when the audience is sendable; otherwise the refusal, verbatim —
   * the same sentence the mutation throws, so the bar can disable itself
   * without guessing at the backend's rule. */
  blocked: string | null;
};

/** An address on file is the whole eligibility rule: `sendBulkOutreach`
 * reports every other contact as `skipped_no_email`. */
export function canReceiveOutreach<T extends { email?: string }>(
  contact: T,
): contact is T & { email: string } {
  return contact.email !== undefined && contact.email !== "";
}

export function planOutreach(
  contacts: ReadonlyArray<{ email?: string }>,
): OutreachPlan {
  const eligible = contacts.filter(canReceiveOutreach).length;
  const missing = contacts.length - eligible;
  const outOfRange =
    contacts.length < OUTREACH_MIN || contacts.length > OUTREACH_MAX;
  return {
    selected: contacts.length,
    eligible,
    excluded:
      missing === 0
        ? []
        : [
            {
              count: missing,
              reason:
                missing === 1
                  ? "has no email address on file — skipped"
                  : "have no email address on file — skipped",
            },
          ],
    blocked: outOfRange ? OUTREACH_AUDIENCE_MESSAGE : null,
  };
}

/** The BEFORE statement, for a confirmation or the bar itself. */
export function outreachLines(plan: OutreachPlan): Array<string> {
  const lines = [
    `${plan.selected} ${plan.selected === 1 ? "contact is" : "contacts are"} selected · ${plan.eligible} will be emailed.`,
  ];
  for (const item of plan.excluded) {
    lines.push(`${item.count} ${item.reason}.`);
  }
  if (plan.blocked !== null) lines.push(plan.blocked);
  return lines;
}
