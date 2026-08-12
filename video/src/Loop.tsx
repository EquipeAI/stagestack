// Silent ~22s hero loop for stagestack.dev.
//
// No captions and no narration: it plays muted and unattended behind hero
// copy, so words inside it would race the headline for the reader's eye.
//
// It opens on a screen assembling itself and resolving into the real one, then
// spends most of its length on the two shots that MOVE. The previous version
// was six crossfading stills, which behind a headline reads as a slideshow of
// screenshots — precisely what the incumbent's site looks like. For a product
// whose predecessor's sin was being slow, aliveness is the whole silent
// argument.

import React from "react";
import { AbsoluteFill } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Screen } from "./components/Screen";
import { Clip } from "./components/Clip";
import { Split } from "./components/Split";
import { Assemble } from "./components/Assemble";
import { c, s } from "./theme";

const XFADE = 9;

type LoopBeat = {
  kind: "assemble" | "screen" | "clip" | "split";
  shot?: string;
  seconds: number;
  url?: string;
};

const APP = "stagestack.dev/app/e/devflow-conf-2027";

const REEL: LoopBeat[] = [
  // Builds itself, then becomes the real dashboard — which is also the frame
  // the loop returns to, so the wrap reads as a match cut.
  { kind: "assemble", seconds: 3.4 },
  { kind: "clip", shot: "agenda-drag", seconds: 5.4, url: `${APP}/agenda` },
  { kind: "screen", shot: "19-reviewer-scoring", seconds: 2.6, url: `${APP}/reviews` },
  { kind: "split", seconds: 5.2 },
  { kind: "screen", shot: "28-public-event-page", seconds: 2.6, url: "stagestack.dev/e/devflow-conf-2027" },
  { kind: "screen", shot: "02-dashboard", seconds: 2.6, url: APP },
];

const FRAMES = REEL.map((b) => s(b.seconds));

export const loopDuration = () =>
  FRAMES.reduce((a, b) => a + b, 0) - XFADE * (REEL.length - 1);

const Ground: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(120% 100% at 50% 0%, ${c.gray800} 0%, ${c.gray950} 60%)`,
    }}
  >
    {children}
  </AbsoluteFill>
);

const Beat: React.FC<{ beat: LoopBeat; durationInFrames: number }> = ({
  beat,
  durationInFrames,
}) => (
  <Ground>
    {beat.kind === "assemble" ? (
      <Assemble shot="02-dashboard" resolveAt={78} width={1420} />
    ) : beat.kind === "split" ? (
      <Split durationInFrames={durationInFrames} />
    ) : beat.kind === "clip" ? (
      <Clip
        clip={beat.shot as string}
        durationInFrames={durationInFrames}
        url={beat.url}
        cardWidth={1500}
        marginTop={78}
        region={{ x: 0.58, y: 0.46, w: 0.72 }}
      />
    ) : (
      <Screen
        shot={beat.shot as string}
        durationInFrames={durationInFrames}
        url={beat.url}
        cardWidth={1500}
        marginTop={78}
      />
    )}
  </Ground>
);

export const Loop: React.FC = () => (
  <AbsoluteFill style={{ background: c.gray950 }}>
    <TransitionSeries>
      {REEL.flatMap((beat, i) => {
        const seq = (
          <TransitionSeries.Sequence
            key={`b${i}`}
            durationInFrames={FRAMES[i]}
            name={beat.shot ?? beat.kind}
          >
            <Beat beat={beat} durationInFrames={FRAMES[i]} />
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
