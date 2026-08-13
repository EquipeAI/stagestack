// ─────────────────────────────────────────────────────────────────────────
// The one definition of what a {{variable}} means (W3).
//
// Two surfaces used to keep their own copy: the server renderer
// (convex/model/templates.ts) and the editor's variable list in the web app.
// They drifted — the web app offered `speaker.firstName` in every template,
// while a decision email's send site passes no speaker at all, so the organizer
// was told a name would appear where a real send renders nothing.
//
// So: one catalog of variables, and one map of which template CONTEXT resolves
// which of them. The context map is not "what the shipped copy happens to
// reference", it is "what that template's send site actually passes" — read off
// the `renderTemplate` call sites, and held there by a test that renders every
// listed token through the real renderer.
// ─────────────────────────────────────────────────────────────────────────

export type TemplateVarDef = {
  /** Human name. The palette's accessible name is "Insert <label> token". */
  label: string;
  /** What a preview substitutes when nothing real supplies it. */
  sample: string;
  /** Server-built HTML, interpolated UNESCAPED. Everything else is escaped. */
  raw?: true;
};

export const TEMPLATE_VAR_CATALOG: Record<string, TemplateVarDef> = {
  "event.name": { label: "event name", sample: "Acme Summit" },
  "event.when": {
    label: "event dates",
    sample: "2026-09-01 – 2026-09-03 (America/Los_Angeles)",
  },
  "event.location": { label: "event location", sample: "Moscone West" },
  "event.whenWhere": {
    label: "event dates and location",
    sample: "2026-09-01 – 2026-09-03 (America/Los_Angeles) — Moscone West",
  },
  "event.timezone": { label: "event timezone", sample: "America/Los_Angeles" },
  "speaker.firstName": { label: "speaker first name", sample: "Ada" },
  "speaker.lastName": { label: "speaker last name", sample: "Lovelace" },
  "speaker.fullName": { label: "speaker full name", sample: "Ada Lovelace" },
  "speaker.email": { label: "speaker email", sample: "ada@example.com" },
  "session.title": {
    label: "session title",
    sample: "Analytical engines in production",
  },
  "slot.when": {
    label: "slot time",
    sample: "Tue, Sep 1, 2:00 PM – Tue, Sep 1, 2:45 PM (America/Los_Angeles)",
  },
  "slot.room": { label: "slot room", sample: "Main Stage" },
  "proposal.title": {
    label: "proposal title",
    sample: "Analytical engines in production",
  },
  "proposal.speakers": { label: "proposal speakers", sample: "Ada Lovelace" },
  "task.title": { label: "task title", sample: "Speaker headshot" },
  "inviter.name": { label: "inviter name", sample: "Grace Hopper" },
  "scope.label": { label: "invitation scope", sample: "Acme Summit" },
  "role.label": { label: "invited role", sample: "organizer" },
  decision: { label: "corrected decision", sample: "accepted" },
  note: { label: "organizer note", sample: "Sample note from the organizer." },
  intro: { label: "opening line", sample: "Thanks for submitting to" },
  subjectLead: { label: "subject lead", sample: "We received your proposal" },
  link: { label: "link", sample: "https://stagestack.dev/portal/sample-event" },
  tasks: {
    label: "outstanding task list",
    sample: [
      `<ul>`,
      `<li><strong>Speaker headshot</strong> — Analytical engines in production (due 2026-08-20)</li>`,
      `<li><strong>Final slides</strong> — Analytical engines in production (due 2026-08-25)</li>`,
      `</ul>`,
    ].join("\n"),
    raw: true,
  },
  body: {
    label: "awaiting-participation list",
    sample: [
      `<ul>`,
      `<li><strong>Analytical engines in production</strong></li>`,
      `</ul>`,
    ].join("\n"),
    raw: true,
  },
};

export const ALL_VAR_PATHS: ReadonlyArray<string> =
  Object.keys(TEMPLATE_VAR_CATALOG);

/** Paths whose values are server-built HTML and must NOT be escaped. */
export const RAW_VAR_PATHS: ReadonlySet<string> = new Set(
  ALL_VAR_PATHS.filter((path) => TEMPLATE_VAR_CATALOG[path].raw === true),
);

export function isKnownVar(path: string): boolean {
  return path in TEMPLATE_VAR_CATALOG;
}

/** The organizer's one-off send (convex/model/comms.ts `sendOneOff`), which is
 * a composer context like any template even though nothing is stored for it. */
export const ONE_OFF_CONTEXT_KEY = "manual.oneoff";

/** convex/model/agenda.ts — the three .ics-bearing schedule mails share a bag. */
const SCHEDULE_VARS: ReadonlyArray<string> = [
  "event.name",
  "event.timezone",
  "speaker.firstName",
  "speaker.lastName",
  "speaker.fullName",
  "session.title",
  "slot.when",
  "slot.room",
  "link",
];

/**
 * What each context's send site actually passes to `renderTemplate`. A path
 * missing here renders as the empty string in that template, so the palette
 * must not offer it.
 */
export const TEMPLATE_CONTEXT_VARS: Record<string, ReadonlyArray<string>> = {
  // convex/model/cfp.ts
  "cfp.confirmation": [
    "event.name",
    "proposal.title",
    "subjectLead",
    "intro",
    "link",
  ],
  "cfp.adminNotification": [
    "event.name",
    "proposal.title",
    "proposal.speakers",
    "subjectLead",
    "intro",
    "link",
  ],
  "cfp.withdrawn": ["event.name", "proposal.title", "link"],
  // convex/model/sessions.ts — `decisionVars` passes no speaker.
  "decision.accepted": ["event.name", "proposal.title", "link"],
  "decision.declined": ["event.name", "proposal.title", "link"],
  "decision.corrected": [
    "event.name",
    "proposal.title",
    "decision",
    "note",
    "link",
  ],
  "invitation.direct": [
    "event.name",
    "event.when",
    "event.location",
    "event.whenWhere",
    "speaker.firstName",
    "speaker.lastName",
    "session.title",
    "link",
  ],
  // convex/model/team.ts — an org-wide invite knows nothing about an event.
  "team.invite": ["inviter.name", "scope.label", "role.label", "link"],
  // convex/model/portal.ts
  "portal.invite": [
    "event.name",
    "speaker.firstName",
    "speaker.lastName",
    "link",
  ],
  "portal.handoffInvite": ["event.name", "session.title", "link"],
  // convex/model/tasks.ts
  "task.changesRequested": ["event.name", "task.title", "note", "link"],
  "schedule.released": SCHEDULE_VARS,
  "schedule.updated": SCHEDULE_VARS,
  "schedule.cancelled": SCHEDULE_VARS,
  // convex/reminders.ts
  "reminder.tasks": [
    "event.name",
    "speaker.firstName",
    "speaker.lastName",
    "link",
    "tasks",
  ],
  "reminder.participation": [
    "event.name",
    "speaker.firstName",
    "speaker.lastName",
    "link",
    "body",
  ],
  // convex/model/comms.ts — `sendOneOff` builds its own small bag.
  [ONE_OFF_CONTEXT_KEY]: [
    "event.name",
    "speaker.firstName",
    "speaker.lastName",
    "speaker.fullName",
    "speaker.email",
    "link",
  ],
};

/**
 * The variables `key` resolves. A `custom:<slug>` template has no send site of
 * its own — an organizer sends it by hand — so it gets the one-off bag, which
 * is what a manual send actually substitutes.
 */
export function varsForContext(key: string): ReadonlyArray<string> {
  return (
    TEMPLATE_CONTEXT_VARS[key] ?? TEMPLATE_CONTEXT_VARS[ONE_OFF_CONTEXT_KEY]
  );
}

/** Matches `{{ speaker.firstName }}` — the renderer's own pattern. Stateful
 * (`g`), so callers must not share one instance across loops. */
export const VAR_PATTERN = "\\{\\{\\s*([A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*)\\s*\\}\\}";

export function varRegExp(): RegExp {
  return new RegExp(VAR_PATTERN, "g");
}

/** Every distinct variable a draft references, in first-appearance order. */
export function variablesIn(text: string): Array<string> {
  const found: Array<string> = [];
  for (const match of text.matchAll(varRegExp())) {
    const path = match[1];
    if (!found.includes(path)) found.push(path);
  }
  return found;
}

/** The literal an organizer inserts from the palette. */
export function tokenFor(path: string): string {
  return `{{${path}}}`;
}

/**
 * A believable variable bag for `key`, shaped exactly like a real send's:
 * ONLY the paths that context resolves are present, so a preview shows an
 * out-of-context token as the nothing it really renders as. `overrides` carries
 * whatever is real — the event's name, a chosen recipient, this deployment's
 * own links.
 */
export function sampleVarBag(
  key: string,
  overrides: Record<string, string> = {},
): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  for (const path of varsForContext(key)) {
    const value = overrides[path] ?? TEMPLATE_VAR_CATALOG[path].sample;
    const segments = path.split(".");
    let node = bag;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      if (typeof next !== "object" || next === null) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    }
    node[segments[segments.length - 1]] = value;
  }
  return bag;
}
