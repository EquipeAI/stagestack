// The full submission cut.
//
// Structured as a story: a cold open that states the job, then one act per
// stage of running an event, each opening on a chapter card and playing under
// a lifecycle rail that shows how far through the job we are. The rail is the
// argument — by the last act the viewer has watched one product carry a
// conference end to end, without ever being handed a feature list.

import React from "react";
import { AbsoluteFill, staticFile, Img } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Audio } from "@remotion/media";
import { staticFile as sf, interpolate } from "remotion";
import { ACTS, timed } from "./beats";
import { Screen } from "./components/Screen";
import { Detail } from "./components/Detail";
import { Clip } from "./components/Clip";
import { Split } from "./components/Split";
import { Caption, Statement } from "./components/Caption";
import { ActCard } from "./components/ActCard";
import { Rail, STAGES } from "./components/Rail";
import { c, font, s } from "./theme";

const XFADE = 8; // frames of crossfade between beats

export const OPEN = s(timed("open", 6.5));
export const CLOSE = s(timed("close", 6));

/** Every sequence length in order, so the total accounts for overlap. */
const SEGMENTS = () => [
  OPEN,
  ...ACTS.flatMap((act) => [
    s(act.cardSeconds),
    ...act.beats.map((b) => s(b.seconds)),
  ]),
  CLOSE,
];

export const fullDuration = () =>
  SEGMENTS().reduce((a, b) => a + b, 0) - XFADE * (SEGMENTS().length - 1);

/** The recorded line for one segment, started a beat after the cut so it does
 *  not begin under the outgoing crossfade. */
const Line: React.FC<{ id: string }> = ({ id }) => (
  <Audio src={sf(`voice/${id}.mp3`)} from={XFADE} />
);

/** The score, well under the narration. Lyria was briefed to stay even and
 *  undramatic precisely so a single low gain works for the whole cut — see
 *  scripts/music.mjs. Raise VOLUME if you want it more present; there is
 *  nothing else to balance. */
const VOLUME = 0.12;

const Score: React.FC<{ durationInFrames: number }> = ({ durationInFrames }) => (
  <Audio
    src={sf("music/score.mp3")}
    volume={(f) =>
      VOLUME *
      interpolate(
        f,
        [0, s(2), durationInFrames - s(3), durationInFrames],
        [0, 1, 1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      )
    }
  />
);

const Ground: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(120% 100% at 50% 0%, ${c.gray800} 0%, ${c.gray950} 60%)`,
    }}
  >
    {children}
  </AbsoluteFill>
);

const OpenCard: React.FC = () => (
  <Ground>
    <Statement
      durationInFrames={OPEN}
      accent={2}
      lines={[
        "Running a conference is six spreadsheets,",
        "400 emails, and a $40,000 tool he called slow.",
        "Here is the same job, start to finish.",
      ]}
    />
  </Ground>
);

const CloseCard: React.FC = () => (
  <Ground>
    {/* Ending on the full rail, every stage lit, is the whole pitch in one
        frame: that was one event, one afternoon, one product. */}
    <Rail active={STAGES[STAGES.length - 1]} />
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        gap: 36,
      }}
    >
      <Img src={staticFile("brand/logo-inverse.svg")} style={{ width: 560 }} />
      <div
        style={{
          fontFamily: font.display,
          fontSize: 46,
          color: c.gray400,
          letterSpacing: -0.5,
          textAlign: "center",
          maxWidth: 1200,
          lineHeight: 1.3,
        }}
      >
        One event, end to end. Open source, self-hostable, no per-event pricing.
      </div>
      <div
        style={{
          fontFamily: font.mono,
          fontSize: 34,
          color: c.amber400,
          marginTop: 8,
        }}
      >
        stagestack.dev
      </div>
    </AbsoluteFill>
  </Ground>
);

export const Full: React.FC = () => (
  <AbsoluteFill style={{ background: c.gray950 }}>
    <Score durationInFrames={fullDuration()} />
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={OPEN} name="Cold open">
        <OpenCard />
        <Line id="open" />
      </TransitionSeries.Sequence>

      {ACTS.flatMap((act, ai) => {
        const cardDur = s(act.cardSeconds);
        return [
          <TransitionSeries.Transition
            key={`ct${ai}`}
            presentation={fade()}
            timing={linearTiming({ durationInFrames: XFADE })}
          />,
          <TransitionSeries.Sequence
            key={`c${ai}`}
            durationInFrames={cardDur}
            name={`Act ${ai + 1} — ${act.stage}`}
          >
            <Ground>
              <ActCard
                stage={act.stage}
                title={act.title}
                usually={act.usually}
                durationInFrames={cardDur}
              />
              <Line id={`act-${act.stage}`} />
            </Ground>
          </TransitionSeries.Sequence>,
          ...act.beats.flatMap((beat, bi) => {
            const dur = s(beat.seconds);
            return [
              <TransitionSeries.Transition
                key={`t${ai}-${bi}`}
                presentation={fade()}
                timing={linearTiming({ durationInFrames: XFADE })}
              />,
              <TransitionSeries.Sequence
                key={`b${ai}-${bi}`}
                durationInFrames={dur}
                name={beat.shot}
              >
                <Ground>
                  <Rail active={act.stage} />
                  {beat.kind === "split" ? (
                    <Split durationInFrames={dur} />
                  ) : beat.kind === "clip" ? (
                    <Clip
                      clip={beat.shot}
                      durationInFrames={dur}
                      url={beat.url}
                    />
                  ) : beat.kind === "detail" ? (
                    <Detail
                      shot={beat.shot}
                      durationInFrames={dur}
                      scale={beat.scale}
                    />
                  ) : (
                    <Screen
                      shot={beat.shot}
                      from={beat.from}
                      to={beat.to}
                      url={beat.url}
                      durationInFrames={dur}
                      // Narrower than the default so the rail above and the
                      // caption below both sit in clear ground rather than on
                      // top of the screenshot.
                      cardWidth={1520}
                      marginTop={122}
                    />
                  )}
                  <Caption
                    text={beat.caption}
                    eyebrow={beat.eyebrow}
                    durationInFrames={dur}
                    delay={6}
                  />
                  <Line id={`beat-${beat.shot}`} />
                </Ground>
              </TransitionSeries.Sequence>,
            ];
          }),
        ];
      })}

      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: XFADE })}
      />
      <TransitionSeries.Sequence durationInFrames={CLOSE} name="Close">
        <CloseCard />
        <Line id="close" />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);
