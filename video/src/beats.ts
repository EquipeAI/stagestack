// The whole video as data.
//
// This is a STORY, not a feature list. It follows one organizer running one
// conference — DevFlow Conf 2027 — from an inherited spreadsheet to a
// published program, in the order the work actually happens. Each act opens
// with the job to be done and what that job normally costs; the beats inside
// it are the product answering.
//
// The rule for captions: say the *consequence*, never the feature name. Not
// "Weighted scorecards, reviewer caps, dated rounds" — that is a spec sheet.
// "You set the weights once, and every score lands on the same scale" is what
// the organizer gets out of bed for.
//
// See SHOTLIST.md for the eval evidence proving each state is real.

import type { Focus } from "./components/Screen";
import type { Stage } from "./components/Rail";
import durations from "../public/voice/durations.json";

// Timing is driven by the narration, not by taste. Each segment lasts as long
// as its own recorded line plus a beat of air; the hand-written `seconds` is
// only a floor, for the few beats whose line is shorter than the thing on
// screen needs to be looked at. Guessed timings are how a narrated demo ends
// up talking over its own cut.
const AIR = 1.15;
const voice = (id: string): number =>
  (durations as Record<string, { seconds: number }>)[id]?.seconds ?? 0;
/** Segment length in seconds: the line, plus air, but never below `floor`. */
export const timed = (id: string, floor: number): number => {
  const line = voice(id);
  return line > 0 ? Math.max(floor, line + AIR) : floor;
};

// Regions of the 1920x1080 organizer layout, in 0..1 source coords.
//
// Deliberately conservative: region zooms slice headings and cards in half,
// which reads as a broken screenshot. Anything that needs to be seen close up
// is captured as its own element (`kind: "detail"`) instead of cropped.
export const F = {
  /** whole page — must sit dead centre at w = 1 */
  page: { x: 0.5, y: 0.5, w: 1 } as Focus,
  /** content column with the sidebar cleanly cropped away */
  content: { x: 0.564, y: 0.5, w: 0.872 } as Focus,
  /** the card stack in the upper content area */
  cards: { x: 0.585, y: 0.36, w: 0.66 } as Focus,
  /** public pages have no sidebar, so they stay centred */
  centre: { x: 0.5, y: 0.5, w: 0.94 } as Focus,
};

export type Beat = {
  shot: string;
  seconds: number;
  /** "screen" = full page in browser chrome; "detail" = one framed element;
   *  "clip" = a screen recording of the real UI in that same window;
   *  "split" = two recordings side by side, time-aligned */
  kind?: "screen" | "detail" | "clip" | "split";
  from?: Focus;
  to?: Focus;
  /** detail only: fraction of the safe area to fill */
  scale?: number;
  url?: string;
  eyebrow?: string;
  caption: string;
};

export type Act = {
  stage: Stage;
  /** the organizer's job, on the chapter card */
  title: string;
  /** what that job normally costs them */
  usually: string;
  /** chapter card length in seconds */
  cardSeconds: number;
  beats: Beat[];
};

const APP = "stagestack.dev/app/e/devflow-conf-2027";
const PUB = "stagestack.dev/e/devflow-conf-2027";

export const ACTS: Act[] = [
  // ---- Prologue: you inherited this from someone else ---------------------
  {
    stage: "Import",
    title: "Day one: you inherit a spreadsheet.",
    usually: "Usually: a week of copy-paste, and three mistakes you find in May.",
    cardSeconds: timed("act-Import", 3.6),
    beats: [
      {
        shot: "d-import-2-plan",
        seconds: timed("beat-d-import-2-plan", 4.4),
        url: `${APP}/import`,
        caption: "Hand it the file. An agent reads it and proposes the import.",
      },
      {
        shot: "d-import-record",
        kind: "detail",
        seconds: timed("beat-d-import-record", 4.4),
        scale: 0.95,
        caption:
          "Every row mapped and explained, every one of them yours to uncheck. Nothing is written until you approve.",
      },
    ],
  },

  // ---- Act 1: open the call -----------------------------------------------
  {
    stage: "Call",
    title: "Now open the call for speakers.",
    usually: "Usually: a form that can't ask workshops a different question.",
    cardSeconds: timed("act-Call", 3.4),
    beats: [
      {
        shot: "03-cfp-builder",
        seconds: timed("beat-03-cfp-builder", 4),
        url: `${APP}/cfp`,
        caption: "Build the form your event actually needs. No developer.",
      },
      {
        shot: "d-cfp-conditional",
        kind: "detail",
        seconds: timed("beat-d-cfp-conditional", 4.2),
        caption:
          "Workshop questions appear only for workshops. One form, not four.",
      },
      {
        shot: "06-public-cfp",
        seconds: timed("beat-06-public-cfp", 3.8),
        url: `${PUB}/submit`,
        caption:
          "Speakers get a wizard that saves drafts — so they finish instead of giving up.",
      },
    ],
  },

  // ---- Act 2: read everything, fairly -------------------------------------
  {
    stage: "Review",
    title: "Then read all of it. Fairly.",
    usually: "Usually: a shared spreadsheet, and hoping nobody peeks at names.",
    cardSeconds: timed("act-Review", 3.4),
    beats: [
      {
        shot: "19-reviewer-scoring",
        seconds: timed("beat-19-reviewer-scoring", 4.6),
        url: `${APP}/reviews`,
        caption:
          "Reviewers open a queue, not a spreadsheet. Speaker names are hidden.",
      },
      {
        shot: "d-scorecard",
        kind: "detail",
        seconds: timed("beat-d-scorecard", 4.2),
        caption:
          "You set the weights once. Every score lands on the same scale.",
      },
    ],
  },

  // ---- Act 3: decide, and tell everyone -----------------------------------
  {
    stage: "Decide",
    title: "Decide — then tell 60 people.",
    usually: "Usually: a mail merge, and the one person you forgot.",
    cardSeconds: timed("act-Decide", 3.4),
    beats: [
      {
        shot: "16-proposals-table",
        seconds: timed("beat-16-proposals-table", 3.8),
        url: `${APP}/proposals`,
        caption: "Sort by weighted score. Stage every decision, release together.",
      },
      {
        shot: "12-comms",
        seconds: timed("beat-12-comms", 3.8),
        url: `${APP}/comms`,
        caption:
          "Accepted, declined, waitlisted — 17 templates already written for you.",
      },
      {
        shot: "12b-comms-log",
        seconds: timed("beat-12b-comms-log", 4.2),
        url: `${APP}/comms`,
        caption:
          "And every message keeps its receipt: queued, accepted, delivered.",
      },
      {
        // Captured from the maintainer's own mailbox: the one claim in this
        // video that the product cannot prove about itself.
        shot: "40-gmail-invite",
        kind: "detail",
        seconds: timed("beat-40-gmail-invite", 5.5),
        scale: 0.92,
        caption: "It arrives as a calendar invite they can accept.",
      },
    ],
  },

  // ---- Act 4: build the schedule ------------------------------------------
  {
    stage: "Schedule",
    title: "Fit it into three rooms and three days.",
    usually: "Usually: a wall of sticky notes, and one speaker in two places.",
    cardSeconds: timed("act-Schedule", 3.4),
    beats: [
      // The two beats that only work as video: the drag IS the feature, and
      // a still of a conflict badge can't show that it appeared without a
      // reload. Both are real recordings — see capture/clips.mjs.
      {
        shot: "agenda-drag",
        kind: "clip",
        seconds: timed("beat-agenda-drag", 9.5),
        url: `${APP}/agenda`,
        caption: "Two sessions, one room. Both cards go red the moment it lands.",
      },
      {
        shot: "agenda-views",
        kind: "clip",
        seconds: timed("beat-agenda-views", 8.4),
        url: `${APP}/agenda`,
        caption: "List, day, week, track, room — one program, nobody re-typing it.",
      },
    ],
  },

  // ---- Act 5: stop chasing people -----------------------------------------
  {
    stage: "Prep",
    title: "Now stop chasing people for bios.",
    usually: "Usually: 200 emails, and a checklist you maintain by hand.",
    cardSeconds: timed("act-Prep", 3.4),
    beats: [
      {
        shot: "08-speaker-portal",
        seconds: timed("beat-08-speaker-portal", 4),
        url: "stagestack.dev/portal/devflow-conf-2027",
        caption:
          "Speakers get their own page — sessions, deadlines, what's still missing.",
      },
      {
        shot: "d-speaker-slot",
        kind: "detail",
        seconds: timed("beat-d-speaker-slot", 3.8),
        scale: 0.82,
        caption:
          "Their slot, in their timezone. They flag a clash instead of emailing you.",
      },
      {
        shot: "d-ops-warning",
        kind: "detail",
        seconds: timed("beat-d-ops-warning", 4),
        scale: 0.78,
        caption:
          "“1 accepted speaker is missing a bio or headshot.” Derived, not a box you tick.",
      },
      {
        shot: "26-speaker-tasks",
        seconds: timed("beat-26-speaker-tasks", 3.6),
        url: `${APP}/tasks`,
        caption: "The reminders go out on their own. You go do something else.",
      },
      {
        // Two recordings, not one: the claim is simultaneity, so cutting
        // between the screens would destroy the thing being shown.
        shot: "realtime",
        kind: "split",
        seconds: timed("beat-realtime", 8.5),
        caption: "The speaker ticks one box. Nobody pressed refresh on the right.",
      },
    ],
  },

  // ---- Act 6: ship it -----------------------------------------------------
  {
    stage: "Publish",
    title: "Then put the program in front of the world.",
    usually: "Usually: exporting to a designer, and a schedule that goes stale.",
    cardSeconds: timed("act-Publish", 3.4),
    beats: [
      {
        shot: "28-public-event-page",
        seconds: timed("beat-28-public-event-page", 3.6),
        url: PUB,
        caption: "Publish once. The public page is the program you just built.",
      },
      {
        shot: "29-embed-widget",
        seconds: timed("beat-29-embed-widget", 3.4),
        url: "stagestack.dev/embed/w/…",
        caption:
          "Drop it into your own site — five widgets, plus JSON and iCal feeds.",
      },
    ],
  },
];

/** Flat list, for the cuts that don't carry the act structure. */
export const BEATS: Beat[] = ACTS.flatMap((a) => a.beats);
