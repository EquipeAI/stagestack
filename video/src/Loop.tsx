// Silent ~20s hero loop for stagestack.dev.
//
// No captions: it plays muted and unattended behind hero copy, so the product
// has to carry it. It opens and closes on the same frame of the same shot so
// the wrap reads as a match cut rather than a jump.

import React from "react";
import { AbsoluteFill } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { F } from "./beats";
import { Screen } from "./components/Screen";
import { c, s } from "./theme";

const XFADE = 10;

// Ordered as the lifecycle, not as a highlight reel — even silent and
// captionless, the sequence should read as one event moving forward.
const REEL: { shot: string; from?: typeof F.page; to?: typeof F.page }[] = [
  { shot: "02-dashboard", from: F.page },
  { shot: "03-cfp-builder", from: F.page },
  { shot: "19-reviewer-scoring", from: F.page },
  { shot: "12b-comms-log", from: F.page },
  { shot: "21-agenda-room", from: F.page },
  { shot: "28-public-event-page", from: F.centre },
  // Return to the opening frame so the loop point is invisible.
  { shot: "02-dashboard", from: F.page, to: F.page },
];

const EACH = s(3.4);

export const loopDuration = () =>
  REEL.length * EACH - XFADE * (REEL.length - 1);

const URLS: Record<string, string> = {
  "02-dashboard": "stagestack.dev/app/e/devflow-conf-2027",
  "03-cfp-builder": "stagestack.dev/app/e/devflow-conf-2027/cfp",
  "19-reviewer-scoring": "stagestack.dev/app/e/devflow-conf-2027/reviews",
  "12b-comms-log": "stagestack.dev/app/e/devflow-conf-2027/comms",
  "21-agenda-room": "stagestack.dev/app/e/devflow-conf-2027/agenda",
  "28-public-event-page": "stagestack.dev/e/devflow-conf-2027",
};

export const Loop: React.FC = () => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(120% 100% at 50% 0%, ${c.gray800} 0%, ${c.gray950} 60%)`,
    }}
  >
    <TransitionSeries>
      {REEL.flatMap((beat, i) => {
        const seq = (
          <TransitionSeries.Sequence
            key={`b${i}`}
            durationInFrames={EACH}
            name={beat.shot}
          >
            <Screen
              shot={beat.shot}
              from={beat.from}
              to={beat.to}
              url={URLS[beat.shot]}
              durationInFrames={EACH}
              marginTop={90}
            />
          </TransitionSeries.Sequence>
        );
        return i === 0
          ? [seq]
          : [
              <TransitionSeries.Transition
                key={`t${i}`}
                presentation={fade()}
                timing={linearTiming({ durationInFrames: XFADE })}
              />,
              seq,
            ];
      })}
    </TransitionSeries>
  </AbsoluteFill>
);
