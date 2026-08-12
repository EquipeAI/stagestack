// 1080x1350 cut for X / LinkedIn.
//
// Same source beats, re-laid out for a portrait feed: persistent brand bar at
// the top, the browser card in the middle, and the caption in its own block
// underneath where it stays readable at phone size.

import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { ACTS, BEATS, Beat } from "./beats";
import { Screen } from "./components/Screen";
import { Detail } from "./components/Detail";
import { Clip } from "./components/Clip";
import { c, font, s } from "./theme";

export const SOCIAL_W = 1080;
export const SOCIAL_H = 1350;
const XFADE = 8;

/** The beats that read well small — detail-heavy tables are dropped. */
const KEEP = [
  "d-import-2-plan",
  "d-cfp-conditional",
  "19-reviewer-scoring",
  "d-scorecard",
  "12b-comms-log",
  "agenda-drag",
  "08-speaker-portal",
  "d-ops-warning",
  "28-public-event-page",
];

const REEL: Beat[] = KEEP.map(
  (shot) => BEATS.find((b) => b.shot === shot) as Beat,
).filter(Boolean);

/** The lifecycle rail doesn't fit portrait, so the stage becomes the eyebrow —
 *  a scroller still sees the beats belong to stages of one job. */
const stageOf = (shot: string) =>
  ACTS.find((a) => a.beats.some((b) => b.shot === shot))?.stage;

const EACH = s(3.6);
const OUTRO = s(4);

export const socialDuration = () =>
  REEL.length * EACH + OUTRO - XFADE * REEL.length;

const Ground: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(120% 80% at 50% 0%, ${c.gray800} 0%, ${c.gray950} 62%)`,
    }}
  >
    {children}
  </AbsoluteFill>
);

const BrandBar: React.FC = () => (
  <div
    style={{
      position: "absolute",
      top: 64,
      left: 0,
      right: 0,
      display: "flex",
      justifyContent: "center",
    }}
  >
    <Img src={staticFile("brand/logo-inverse.svg")} style={{ width: 300 }} />
  </div>
);

const SocialBeat: React.FC<{ beat: Beat }> = ({ beat }) => (
  <Ground>
    <BrandBar />
    {/* Portrait plays on a phone, so start already pushed in — the wide
        organizer layout is unreadable at this width otherwise. */}
    <div style={{ position: "absolute", inset: 0, top: 200, bottom: 470 }}>
      {beat.kind === "clip" ? (
        <Clip
          clip={beat.shot}
          durationInFrames={EACH}
          cardWidth={1000}
          marginTop={0}
        />
      ) : beat.kind === "detail" ? (
        <Detail shot={beat.shot} durationInFrames={EACH} scale={1} />
      ) : (
        <Screen
          shot={beat.shot}
          from={beat.to ?? beat.from}
          url={beat.url}
          durationInFrames={EACH}
          cardWidth={1000}
          marginTop={0}
        />
      )}
    </div>
    <div
      style={{
        position: "absolute",
        left: 72,
        right: 72,
        top: 920,
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      {stageOf(beat.shot) ? (
        <div
          style={{
            alignSelf: "flex-start",
            fontFamily: font.mono,
            fontSize: 22,
            letterSpacing: 2.4,
            textTransform: "uppercase",
            color: c.gray950,
            background: c.amber400,
            padding: "7px 16px",
            borderRadius: 6,
            fontWeight: 600,
          }}
        >
          {stageOf(beat.shot)}
        </div>
      ) : null}
      <div
        style={{
          fontFamily: font.display,
          fontWeight: 600,
          fontSize: 54,
          lineHeight: 1.18,
          letterSpacing: -1,
          color: c.gray0,
        }}
      >
        {beat.caption}
      </div>
    </div>
    <div
      style={{
        position: "absolute",
        left: 72,
        bottom: 76,
        fontFamily: font.mono,
        fontSize: 30,
        color: c.amber400,
      }}
    >
      stagestack.dev
    </div>
  </Ground>
);

const Outro: React.FC = () => (
  <Ground>
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", gap: 40 }}
    >
      <Img src={staticFile("brand/logo-inverse.svg")} style={{ width: 520 }} />
      <div
        style={{
          fontFamily: font.display,
          fontSize: 44,
          color: c.gray400,
          textAlign: "center",
          lineHeight: 1.35,
          maxWidth: 820,
        }}
      >
        Open-source speaker &amp; program management.
      </div>
      <div
        style={{ fontFamily: font.mono, fontSize: 38, color: c.amber400 }}
      >
        stagestack.dev
      </div>
    </AbsoluteFill>
  </Ground>
);

export const Social: React.FC = () => (
  <AbsoluteFill style={{ background: c.gray950 }}>
    <TransitionSeries>
      {REEL.flatMap((beat, i) => {
        const seq = (
          <TransitionSeries.Sequence
            key={`b${i}`}
            durationInFrames={EACH}
            name={beat.shot}
          >
            <SocialBeat beat={beat} />
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
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: XFADE })}
      />
      <TransitionSeries.Sequence durationInFrames={OUTRO} name="Outro">
        <Outro />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);
