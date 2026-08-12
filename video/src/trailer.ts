// The trailer, as data.
//
// Not a shortened version of the long cut — a different film. It opens on the
// villain, leads with the two shots that PROVE something in under three
// seconds (the drag and the split-screen), and closes on the price.
//
// Pacing is inverted from the long cut. There, every beat is its narration
// line plus 1.15s of air, because a documentary must never talk over its own
// cut. Here that would spend eleven of forty seconds on silence, so the air
// drops to 0.35s, the crossfades go to zero, and the voice starts fractionally
// before its picture — a J-cut, the cheapest trick there is for making a
// sequence feel like a trailer instead of a slideshow.

import durations from "../public/voice/durations.json";

/** Trailer air: just enough that the voice never clips. */
const AIR = 0.35;
/** Frames the voice leads its picture by. */
export const JCUT = 6;

const voice = (id: string): number =>
  (durations as Record<string, { seconds: number }>)[id]?.seconds ?? 0;

/** Beat length: the line plus a breath, but never shorter than the floor —
 *  the two clips need enough frames for their motion to finish. */
const timed = (id: string, floor: number) =>
  Math.max(floor, voice(id) + AIR);

export type SocialBeat = {
  id: string;
  kind: "hook" | "screen" | "detail" | "clip" | "split" | "close";
  shot?: string;
  seconds: number;
  caption?: string;
  lines?: string[];
};

export const SOCIAL: SocialBeat[] = [
  {
    id: "social-1-hook",
    kind: "hook",
    seconds: timed("social-1-hook", 2.4),
    lines: ["$40,000 a year.", "He called it “slow.”", "Twice."],
  },
  {
    id: "social-2-import",
    kind: "screen",
    shot: "d-import-2-plan",
    seconds: timed("social-2-import", 3.2),
    caption: "Drop in the spreadsheet. An agent maps it.",
  },
  {
    id: "social-3-drag",
    kind: "clip",
    shot: "agenda-drag",
    seconds: timed("social-3-drag", 4.6),
    caption: "Wrong room? It goes red. Instantly.",
  },
  {
    id: "social-4-cfp",
    kind: "detail",
    shot: "d-cfp-conditional",
    seconds: timed("social-4-cfp", 3),
    caption: "One form. It asks workshops different questions.",
  },
  {
    id: "social-5-comms",
    kind: "screen",
    shot: "12b-comms-log",
    seconds: timed("social-5-comms", 3.2),
    caption: "Every email has a receipt.",
  },
  {
    id: "social-6-gmail",
    kind: "detail",
    shot: "40-gmail-invite",
    seconds: timed("social-6-gmail", 3.4),
    caption: "A real invite, in a real inbox.",
  },
  {
    id: "social-7-warning",
    kind: "detail",
    shot: "d-ops-warning",
    seconds: timed("social-7-warning", 3),
    caption: "It notices what's missing. Before you do.",
  },
  {
    id: "social-8-realtime",
    kind: "split",
    seconds: timed("social-8-realtime", 5),
    caption: "She ticks a box. His screen updates. No refresh.",
  },
  {
    id: "social-9-publish",
    kind: "screen",
    shot: "28-public-event-page",
    seconds: timed("social-9-publish", 3),
    caption: "Publish. That's it.",
  },
  {
    id: "social-10-close",
    kind: "close",
    seconds: timed("social-10-close", 4.5),
    lines: ["Open source.", "$0 per event."],
  },
];
